#!/usr/bin/env node
/**
 * The phon#138 stall loop. It runs N copies of one server test file at once, staggered, samples the
 * machine beside them, and prints every case over a threshold on one wall-clock axis with the
 * sampler's readings at that moment. It repeats batches until one stalls or the batch limit is hit,
 * and reports the stall rate per batch. Findings: `matrix-stall.md` beside this file.
 *
 *   node docs/investigations/phon-138/stall-loop.mjs [options]
 *
 *   --copies N        copies per batch (10)
 *   --stagger MS      delay between copy starts (2000)
 *   --threshold MS    a case at or over this is a stall (1000)
 *   --batches N       batch limit (10)
 *   --until-stall     stop at the first batch with a stall
 *   --file PATH       test file, relative to apps/server (test/device-ownership.test.ts)
 *   --tmp-base DIR    each copy's TMPDIR is DIR/copy-<i> (a fresh directory under os.tmpdir())
 *   --shared-tmp      give every copy the same TMPDIR instead of one each
 *   --probe-dir DIR   where the fsync probe writes (TMP-BASE/probe), to watch another volume
 *   --hog-mb N        hold N MB of touched memory in a side process for the whole batch (0)
 *   --out DIR         where the raw logs go (a fresh directory under os.tmpdir())
 *
 * Unprivileged only: vm_stat, sysctl, iostat, ps and pmset. No sudo, no wrangler dev, no expo.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const server = resolve(here, '../../../apps/server')
const reporter = join(here, 'stall-reporter.ts')
const vitest = join(server, 'node_modules/.bin/vitest')

function options(argv) {
  const o = {
    copies: 10,
    stagger: 2000,
    threshold: 1000,
    batches: 10,
    untilStall: false,
    file: 'test/device-ownership.test.ts',
    tmpBase: null,
    sharedTmp: false,
    probeDir: null,
    hogMb: 0,
    out: null,
  }
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = () => argv[++i]
    if (flag === '--copies') o.copies = Number(value())
    else if (flag === '--stagger') o.stagger = Number(value())
    else if (flag === '--threshold') o.threshold = Number(value())
    else if (flag === '--batches') o.batches = Number(value())
    else if (flag === '--until-stall') o.untilStall = true
    else if (flag === '--file') o.file = value()
    else if (flag === '--tmp-base') o.tmpBase = value()
    else if (flag === '--shared-tmp') o.sharedTmp = true
    else if (flag === '--probe-dir') o.probeDir = value()
    else if (flag === '--hog-mb') o.hogMb = Number(value())
    else if (flag === '--out') o.out = value()
    else throw new Error(`Unknown option ${flag}`)
  }
  return o
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const clock = (ms) => new Date(ms).toISOString().slice(11, 23)

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

/** vm_stat's cumulative counters, in pages. */
function vmCounters() {
  const counters = {}
  for (const line of run('vm_stat', []).split('\n')) {
    const match = line.match(/^"?([^":]+)"?:\s+(\d+)\.?$/)
    if (match) counters[match[1].trim()] = Number(match[2])
  }
  return counters
}

/** Total RSS (MB) and CPU (%) of every workerd and every node process. */
function processes() {
  const totals = { workerd: { n: 0, rss: 0, cpu: 0 }, node: { n: 0, rss: 0, cpu: 0 } }
  for (const line of run('ps', ['-axo', 'rss=,%cpu=,comm=']).split('\n')) {
    const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+(.*)$/)
    if (!match) continue
    const kind = /workerd$/.test(match[3]) ? 'workerd' : /\bnode$/.test(match[3]) ? 'node' : null
    if (kind === null) continue
    totals[kind].n += 1
    totals[kind].rss += Number(match[1]) / 1024
    totals[kind].cpu += Number(match[2])
  }
  return totals
}

/**
 * Samples the machine once a second until stopped: deltas of vm_stat's paging counters, the load
 * average, the thermal line, workerd and node totals, and disk0 throughput from a streaming iostat.
 */
function sampler() {
  const samples = []
  let disk = { tps: null, mbs: null }
  const iostat = spawn('iostat', ['-d', '-w', '1', 'disk0'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  iostat.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      const fields = line.trim().split(/\s+/).map(Number)
      if (fields.length === 3 && fields.every(Number.isFinite)) {
        disk = { tps: fields[1], mbs: fields[2] }
      }
    }
  })
  let previous = vmCounters()
  let stopped = false
  const loop = (async () => {
    while (!stopped) {
      await sleep(1000)
      const counters = vmCounters()
      const delta = (key) => (counters[key] ?? 0) - (previous[key] ?? 0)
      previous = counters
      samples.push({
        at: Date.now(),
        swapins: delta('Swapins'),
        swapouts: delta('Swapouts'),
        pageouts: delta('Pageouts'),
        compressions: delta('Compressions'),
        decompressions: delta('Decompressions'),
        compressor: counters['Pages occupied by compressor'] ?? null,
        free: counters['Pages free'] ?? null,
        load: run('sysctl', ['-n', 'vm.loadavg']).trim(),
        therm: run('pmset', ['-g', 'therm'])
          .split('\n')
          .filter((l) => /=|warning/i.test(l))
          .map((l) => l.trim())
          .join('; '),
        ...disk,
        processes: processes(),
      })
    }
  })()
  return {
    samples,
    async stop() {
      stopped = true
      iostat.kill()
      await loop
    },
  }
}

/** A side process that holds `mb` MB of touched memory until killed. */
function hog(mb) {
  if (mb <= 0) return null
  const script = `const b=[];for(let i=0;i<${mb};i++){const x=Buffer.alloc(1048576);for(let j=0;j<x.length;j+=4096)x[j]=1;b.push(x)}setInterval(()=>{for(const x of b)x[0]^=1},1000)`
  return spawn(process.execPath, ['--max-old-space-size=65536', '-e', script], { stdio: 'ignore' })
}

/**
 * Two side processes started like a copy, that log each hiccup over 100 ms as a JSON line: `timer`
 * asks for a 5 ms `setTimeout` again and again and logs how late it fires; `fsync` writes 4 KB and
 * fsyncs it every 20 ms in its own TMPDIR and logs how long that took. A stall the timer probe sees
 * is the host delaying timers; one the fsync probe sees is the file system.
 */
function probes(batchDir, tmp) {
  const timer = `const fs=require('fs');const log=process.argv[1];let t=Date.now();const tick=()=>{const now=Date.now();const late=now-t-5;if(late>100)fs.appendFileSync(log,JSON.stringify({probe:'timer',at:t,late})+'\\n');t=now;setTimeout(tick,5)};setTimeout(tick,5)`
  const fsync = `const fs=require('fs');const log=process.argv[1];const f=require('path').join(process.env.TMPDIR,'probe');const b=Buffer.alloc(4096,1);setInterval(()=>{const t=Date.now();const fd=fs.openSync(f,'w');fs.writeSync(fd,b);fs.fsyncSync(fd);fs.closeSync(fd);const took=Date.now()-t;if(took>100)fs.appendFileSync(log,JSON.stringify({probe:'fsync',at:t,took})+'\\n')},20)`
  const log = join(batchDir, 'probes.jsonl')
  writeFileSync(log, '')
  mkdirSync(tmp, { recursive: true })
  const env = { ...process.env, TMPDIR: tmp }
  const children = [timer, fsync].map((script) =>
    spawn(process.execPath, ['-e', script, log], { env, stdio: 'ignore' }),
  )
  return {
    stop() {
      for (const child of children) child.kill()
      return readCases(log)
    },
  }
}

function copy(o, batchDir, i, tmp) {
  const log = join(batchDir, `copy-${i}.jsonl`)
  writeFileSync(log, '')
  mkdirSync(tmp, { recursive: true })
  const child = spawn(vitest, ['run', o.file, `--reporter=${reporter}`], {
    cwd: server,
    env: { ...process.env, STALL_COPY: String(i), STALL_LOG: log, TMPDIR: tmp, FORCE_COLOR: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  return new Promise((done) =>
    child.on('exit', (code) => done({ i, code, log, stderr: stderr.slice(-2000) })),
  )
}

function readCases(log) {
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

/** Stalls whose wall-clock spans overlap, grouped. */
function overlapping(stalls) {
  const sorted = [...stalls].sort((x, y) => x.start - y.start)
  const groups = []
  for (const stall of sorted) {
    const last = groups.at(-1)
    if (last && stall.start <= last.end) {
      last.stalls.push(stall)
      last.end = Math.max(last.end, stall.start + stall.duration)
    } else groups.push({ start: stall.start, end: stall.start + stall.duration, stalls: [stall] })
  }
  return groups
}

function describeSample(s) {
  const p = s.processes
  return (
    `swapin ${s.swapins} swapout ${s.swapouts} pageout ${s.pageouts} ` +
    `compress ${s.compressions} decompress ${s.decompressions} | disk0 ${s.tps} tps ${s.mbs} MB/s | ` +
    `load ${s.load} | workerd ${p.workerd.n}x ${Math.round(p.workerd.rss)} MB ${Math.round(p.workerd.cpu)}% ` +
    `node ${p.node.n}x ${Math.round(p.node.rss)} MB ${Math.round(p.node.cpu)}%` +
    (s.therm ? ` | ${s.therm}` : '')
  )
}

async function batch(o, out, b) {
  const batchDir = join(out, `batch-${b}`)
  mkdirSync(batchDir, { recursive: true })
  const tmpBase = o.tmpBase ?? mkdtempSync(join(tmpdir(), 'phon-138-tmp-'))
  const side = hog(o.hogMb)
  const watch = sampler()
  const probe = probes(batchDir, o.probeDir ?? join(tmpBase, 'probe'))
  const runs = []
  for (let i = 0; i < o.copies; i += 1) {
    runs.push(
      copy(o, batchDir, i, o.sharedTmp ? join(tmpBase, 'shared') : join(tmpBase, `copy-${i}`)),
    )
    if (i < o.copies - 1) await sleep(o.stagger)
  }
  const exits = await Promise.all(runs)
  await watch.stop()
  const hiccups = probe.stop()
  side?.kill()
  if (o.tmpBase === null) rmSync(tmpBase, { recursive: true, force: true })
  writeFileSync(join(batchDir, 'samples.json'), JSON.stringify(watch.samples, null, 1))

  const cases = exits.flatMap((exit) => readCases(exit.log))
  const failed = exits.filter((exit) => exit.code !== 0)
  const stalls = cases.filter((c) => c.duration !== null && c.duration >= o.threshold)
  const slowest = cases.reduce((m, c) => Math.max(m, c.duration ?? 0), 0)
  const stalledCopies = new Set(stalls.map((s) => s.copy))
  console.log(
    `batch ${b}: ${cases.length} cases in ${o.copies} copies, ${stalls.length} at or over ` +
      `${o.threshold} ms in ${stalledCopies.size} copies, slowest ${slowest} ms, ` +
      `${failed.length} copies failed`,
  )
  for (const exit of failed)
    console.log(
      `  copy ${exit.i} exited ${exit.code}: ${exit.stderr.trim().split('\n').slice(-3).join(' / ')}`,
    )
  for (const group of overlapping(stalls)) {
    console.log(
      `  ${clock(group.start)} to ${clock(group.end)}: ${group.stalls.length} stalls in ` +
        `${new Set(group.stalls.map((s) => s.copy)).size} copies`,
    )
    for (const s of group.stalls) {
      console.log(
        `    copy ${s.copy} case ${s.position} from ${clock(s.start)} took ${s.duration} ms`,
      )
    }
    for (const h of hiccups) {
      if (h.at >= group.start - 1000 && h.at <= group.end + 1000) {
        const what = h.probe === 'timer' ? `fired ${h.late} ms late` : `took ${h.took} ms`
        console.log(`    probe ${h.probe} at ${clock(h.at)} ${what}`)
      }
    }
    for (const sample of watch.samples) {
      if (sample.at >= group.start - 1000 && sample.at <= group.end + 1000) {
        console.log(`    ${clock(sample.at)} ${describeSample(sample)}`)
      }
    }
  }
  const timerHiccups = hiccups.filter((h) => h.probe === 'timer').length
  const fsyncHiccups = hiccups.length - timerHiccups
  console.log(`  probes: ${timerHiccups} late timers, ${fsyncHiccups} slow fsyncs over 100 ms`)
  return {
    stalls: stalls.length,
    stalledCopies: stalledCopies.size,
    slowest,
    failed: failed.length,
  }
}

async function main() {
  const o = options(process.argv)
  const out = o.out ?? mkdtempSync(join(tmpdir(), 'phon-138-loop-'))
  mkdirSync(out, { recursive: true })
  console.log(`phon#138 stall loop: ${JSON.stringify(o)}; logs in ${out}`)
  const results = []
  for (let b = 1; b <= o.batches; b += 1) {
    const result = await batch(o, out, b)
    results.push(result)
    if (o.untilStall && result.stalls > 0) break
  }
  const stalled = results.filter((r) => r.stalls > 0).length
  console.log(
    `stall rate: ${stalled} of ${results.length} batches stalled; ` +
      `per batch: ${results.map((r) => `${r.stalls}/${r.stalledCopies}c/${r.slowest}ms`).join(' ')}`,
  )
}

await main()
