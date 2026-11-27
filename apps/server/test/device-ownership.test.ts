import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { REGISTRY_NAME } from '../src/church-registry.ts'
import type { Identity } from '../src/identity.ts'
import { envWithDirectory, envWithFailingClaim, registerDeviceWith } from './support/bindings.ts'
import { postMessage, registerDevice, seedChurch } from './support/church.ts'
import { fakeExpoPush, tokenOf } from './support/expo-push.ts'

const ana = { personId: 'ana', name: 'Ana Ortiz', role: 'admin' as const }
const ben = { personId: 'ben', name: 'Ben Okafor' }
const cy = { personId: 'cy', name: 'Cy Park' }
const staff = {
  channelId: 'staff',
  name: 'Staff',
  kind: 'private' as const,
  members: ['ana', 'ben', 'cy'],
}

/** Three churches of Ana, Ben and Cy, each with a staff channel and Ben's own device registered. */
async function threeChurches() {
  const a = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
  const b = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
  const c = await seedChurch({ people: [ana, ben, cy], channels: [staff] })
  for (const [church, token] of [
    [a, 'ben-a'],
    [b, 'ben-b'],
    [c, 'ben-c'],
  ] as const) {
    expect((await registerDevice(church.churchId, 'ben', tokenOf(token))).status).toBe(204)
  }
  return { a, b, c }
}

/**
 * The devices a staff post in a church pushes to, sorted. A marker post follows it, so an answer
 * without the shared phone means the post did not push to it.
 */
async function pushedTo(expo: ReturnType<typeof fakeExpoPush>, churchId: string) {
  const message = await postMessage(churchId, 'ana', 'staff', 'Staff only')
  const marker = await postMessage(churchId, 'ana', 'staff', 'Marker')
  return (await expo.pushesFor(message.id, { after: marker.id })).map((p) => p.to).sort()
}

/** A promise and the functions that settle it, for holding a call until the test lets it go. */
function gate() {
  let open = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

describe('a move that does not finish', () => {
  it("leaves the phone with church A when church B's claim fails before it lands, until B registers again", async () => {
    const expo = fakeExpoPush()
    const { a, b } = await threeChurches()
    const shared = tokenOf('shared-phone')
    expect((await registerDevice(a.churchId, 'cy', shared)).status).toBe(204)

    await expect(
      registerDeviceWith(envWithFailingClaim('before'), b.churchId, 'cy', shared),
    ).rejects.toThrow()
    expect(await pushedTo(expo, a.churchId)).toEqual([tokenOf('ben-a'), shared].sort())
    expect(await pushedTo(expo, b.churchId)).toEqual([tokenOf('ben-b')])

    expect((await registerDevice(b.churchId, 'cy', shared)).status).toBe(204)
    expect(await pushedTo(expo, a.churchId)).toEqual([tokenOf('ben-a')])
    expect(await pushedTo(expo, b.churchId)).toEqual([tokenOf('ben-b'), shared].sort())
  })

  it("moves the phone to church B when B's claim fails after it lands", async () => {
    const expo = fakeExpoPush()
    const { a, b } = await threeChurches()
    const shared = tokenOf('shared-phone')
    expect((await registerDevice(a.churchId, 'cy', shared)).status).toBe(204)

    await expect(
      registerDeviceWith(envWithFailingClaim('after'), b.churchId, 'cy', shared),
    ).rejects.toThrow()

    expect(await pushedTo(expo, a.churchId)).toEqual([tokenOf('ben-a')])
    expect(await pushedTo(expo, b.churchId)).toEqual([tokenOf('ben-b'), shared].sort())
  })
})

describe('a refused registration has no side effects', () => {
  it('leaves the token with church A when church B refuses it after the knows check', async () => {
    const expo = fakeExpoPush()
    const { a, b } = await threeChurches()
    const shared = tokenOf('shared-phone')
    expect((await registerDevice(a.churchId, 'cy', shared)).status).toBe(204)

    const leftMeanwhile = envWithDirectory(b.churchId, {
      knows: async () => true,
      registerDevice: async () => 'not-known',
    })
    expect((await registerDeviceWith(leftMeanwhile, b.churchId, 'cy', shared)).status).toBe(404)

    expect(await pushedTo(expo, a.churchId)).toEqual([tokenOf('ben-a'), shared].sort())
  })
})

describe('a registration that throws leaves the phone where it was', () => {
  it('keeps church A pushing to the phone when church B fails to write its row', async () => {
    const expo = fakeExpoPush()
    const { a, b } = await threeChurches()
    const shared = tokenOf('shared-phone')
    expect((await registerDevice(a.churchId, 'cy', shared)).status).toBe(204)

    const real = env.CHURCH_DIRECTORY.getByName(b.churchId)
    const throwing = envWithDirectory(b.churchId, {
      knows: (identity: Identity) => real.knows(identity),
      registerDevice: async () => {
        throw new Error('Durable Object reset')
      },
    })
    await expect(registerDeviceWith(throwing, b.churchId, 'cy', shared)).rejects.toThrow()

    expect(await pushedTo(expo, a.churchId)).toEqual([tokenOf('ben-a'), shared].sort())
    expect(await pushedTo(expo, b.churchId)).toEqual([tokenOf('ben-b')])
  })
})

/**
 * The matrix. Church A holds the shared phone, and two registrations of it run at the same time:
 * registration B moves it to church B, and the other moves it to church C or registers it in church
 * A again. Either may be refused by its church after its `knows` check, as when a sync takes the
 * person out in between. Every Durable Object call the two make runs in an order the case sets, and
 * at one call of one registration a fault may land:
 *
 * - `fail-before`: the call throws, and has no effect.
 * - `fail-after`: the call takes effect, then throws.
 * - `cancel-after`: the call takes effect, and the route never resumes, as when the runtime cancels
 *   it once the phone's connection drops.
 *
 * Each case says what each registration answers and which church pushes to the phone at the end,
 * from the requirement and not from a model of the route: a refusal moves nothing, and the last
 * claim to take effect decides, so the church whose claim took effect last pushes, and church A
 * when none did. Every order of the two registrations' calls is run once up to swapping calls that
 * cannot see each other: calls to different Durable Objects, and two reads of one. Churches B and C
 * start alike, so a case with B and C swapped is the same case: between them, a fault lands on
 * either registration only when one is refused and the other is not.
 */
type Church = 'A' | 'B' | 'C'
type Registrant = Church
type Outcome = 'fail-before' | 'fail-after' | 'cancel-after'
type Answer = 204 | 404 | 'failed' | 'cancelled'
type Method = 'knows' | 'registerDevice' | 'claimDevice'

interface Fault {
  who: Registrant
  at: number
  outcome: Outcome
}

/** One Durable Object call of a registration: its `n`th, on `object`. */
interface Call {
  who: Registrant
  n: number
  method: Method
  object: string
  reads: boolean
  label: string
}

/** Two registrations that run at once, and which of them their church refuses. */
interface Path {
  name: string
  registrants: [Registrant, Registrant]
  refused: Registrant[]
  faulted: Registrant[]
}

interface MatrixCase {
  name: string
  registrants: [Registrant, Registrant]
  refused: Registrant[]
  fault: Fault | null
  calls: Call[]
  answers: Partial<Record<Registrant, Answer>>
  pushing: Church[]
}

const PATHS: Path[] = [
  { name: 'B and C register', registrants: ['B', 'C'], refused: [], faulted: ['B'] },
  { name: 'B and C refused', registrants: ['B', 'C'], refused: ['B', 'C'], faulted: ['B'] },
  { name: 'B refused, C registers', registrants: ['B', 'C'], refused: ['B'], faulted: ['B', 'C'] },
  {
    name: 'B registers, A registers again',
    registrants: ['B', 'A'],
    refused: [],
    faulted: ['B', 'A'],
  },
  {
    name: 'B refused, A registers again',
    registrants: ['B', 'A'],
    refused: ['B'],
    faulted: ['B', 'A'],
  },
  {
    name: 'B registers, A refused again',
    registrants: ['B', 'A'],
    refused: ['A'],
    faulted: ['B', 'A'],
  },
]

/** The route's calls for one registration, up to the fault that ends it, and what it answers. */
function route(who: Registrant, refused: boolean, fault: Fault | null) {
  const steps: Omit<Call, 'who' | 'n'>[] = [
    { method: 'knows', object: `directory ${who}`, reads: true, label: 'knows' },
    { method: 'registerDevice', object: `directory ${who}`, reads: refused, label: 'register' },
  ]
  if (!refused)
    steps.push({ method: 'claimDevice', object: 'registry', reads: false, label: 'claim' })
  const calls: Call[] = []
  for (const step of steps) {
    const n = calls.length + 1
    calls.push({ who, n, ...step })
    if (fault?.who === who && fault.at === n) {
      return { calls, answer: fault.outcome === 'cancel-after' ? 'cancelled' : 'failed' } as const
    }
  }
  return { calls, answer: refused ? 404 : 204 } as const
}

/** Every merge of two registrations' calls that keeps each one's own order. */
function interleavings(first: Call[], second: Call[]): Call[][] {
  if (first.length === 0) return [second]
  if (second.length === 0) return [first]
  const [a, ...restA] = first as [Call, ...Call[]]
  const [b, ...restB] = second as [Call, ...Call[]]
  return [
    ...interleavings(restA, second).map((order) => [a, ...order]),
    ...interleavings(first, restB).map((order) => [b, ...order]),
  ]
}

/** Two calls of different registrations see each other only on one object, and not as two reads. */
function dependent(a: Call, b: Call): boolean {
  return a.who === b.who || (a.object === b.object && !(a.reads && b.reads))
}

/** One order of the calls for each set of orders that differ only by swapping calls that cannot see each other. */
function canonical(calls: Call[]): string {
  const remaining = [...calls]
  const order: string[] = []
  while (remaining.length > 0) {
    const ready = remaining.filter((call, i) =>
      remaining.slice(0, i).every((earlier) => !dependent(earlier, call)),
    )
    const first = ready.reduce((least, call) =>
      `${call.who}${call.n}` < `${least.who}${least.n}` ? call : least,
    )
    order.push(`${first.who}${first.n}`)
    remaining.splice(remaining.indexOf(first), 1)
  }
  return order.join(' ')
}

/** The church whose claim took effect last, or church A when none did. */
function lastClaim(calls: Call[], fault: Fault | null): Church {
  const landed = calls.filter(
    (call) =>
      call.method === 'claimDevice' &&
      !(fault?.who === call.who && fault.at === call.n && fault.outcome === 'fail-before'),
  )
  return landed.at(-1)?.who ?? 'A'
}

function matrixCases(): MatrixCase[] {
  const cases: MatrixCase[] = []
  for (const path of PATHS) {
    const faults: (Fault | null)[] = [null]
    for (const who of path.faulted) {
      for (const outcome of ['fail-before', 'fail-after', 'cancel-after'] as const) {
        for (let at = 1; at <= 3; at += 1) faults.push({ who, at, outcome })
      }
    }
    for (const fault of faults) {
      const [one, two] = path.registrants.map((who) =>
        route(who, path.refused.includes(who), fault),
      ) as [ReturnType<typeof route>, ReturnType<typeof route>]
      const all = [...one.calls, ...two.calls]
      if (fault !== null && !all.some((c) => c.who === fault.who && c.n === fault.at)) continue
      const seen = new Set<string>()
      for (const calls of interleavings(one.calls, two.calls)) {
        const key = canonical(calls)
        if (seen.has(key)) continue
        seen.add(key)
        const faultName =
          fault === null ? 'no fault' : `${fault.who} ${fault.outcome} at its call ${fault.at}`
        cases.push({
          name: `${path.name}, ${faultName}: ${calls.map((c) => `${c.who} ${c.label}`).join(', ')}`,
          registrants: path.registrants,
          refused: path.refused,
          fault,
          calls,
          answers: { [path.registrants[0]]: one.answer, [path.registrants[1]]: two.answer },
          pushing: [lastClaim(calls, fault)],
        })
      }
    }
  }
  return cases
}

/** The Durable Object calls `POST /devices` makes, which the matrix orders. */
const ROUTE_CALLS = new Set<string>(['knows', 'registerDevice', 'claimDevice'])

/**
 * The Worker's bindings for one registration: every route call on the registry and on every
 * directory goes through `step`, which runs it.
 */
function steppedEnv(
  base: Env,
  step: (method: string, call: () => Promise<unknown>) => Promise<unknown>,
): Env {
  const counted = <Stub extends object>(stub: Stub): Stub =>
    new Proxy(stub, {
      get: (target, property) => {
        if (typeof property !== 'string' || !ROUTE_CALLS.has(property)) {
          return Reflect.get(target, property)
        }
        // `Reflect.apply`: an RPC method is not a plain function, and has no `apply` of its own.
        const method = Reflect.get(target, property) as (...args: unknown[]) => Promise<unknown>
        return (...args: unknown[]) => step(property, () => Reflect.apply(method, target, args))
      },
    })
  const namespace = <Namespace extends { getByName: (name: string) => object }>(
    target: Namespace,
  ): Namespace =>
    new Proxy(target, {
      get: (inner, property) =>
        property === 'getByName'
          ? (name: string) => counted(inner.getByName(name))
          : Reflect.get(inner, property),
    })
  const directories = namespace(base.CHURCH_DIRECTORY)
  const registries = namespace(base.CHURCH_REGISTRY)
  return new Proxy(base, {
    get: (target, property) =>
      property === 'CHURCH_DIRECTORY'
        ? directories
        : property === 'CHURCH_REGISTRY'
          ? registries
          : Reflect.get(target, property),
  })
}

// A case takes about 100 ms, but under load it can stall for seconds (PR #137 timed out at 5 s on a
// commit that passed CI an hour before). Durable Object storage is SQLite files in miniflare's
// directory under os.tmpdir(). Sixteen copies of this file at once, with that storage on the
// internal disk, stalled a case for up to 20 s; the same sixteen with their storage on a RAM disk
// never passed 200 ms. So the stall follows where that storage lives, under concurrent load, and
// not the route. How the disk holds the writes up is not proven: fsync latency is the leading
// hypothesis (phon#138, docs/investigations/phon-138/matrix-stall.md). The timeout stays above the
// stall. A case whose calls break their planned order still fails at once; only a real hang waits
// out the 30 s.
describe('a device registered by two churches at once, with a failure or cancellation at any call', {
  timeout: 30_000,
}, () => {
  for (const matrixCase of matrixCases()) {
    it(matrixCase.name, async () => {
      const { registrants, refused, fault, calls } = matrixCase
      const expo = fakeExpoPush()
      const { a, b, c } = await threeChurches()
      const churches: Record<Church, string> = { A: a.churchId, B: b.churchId, C: c.churchId }
      const shared = tokenOf('shared-phone')
      expect((await registerDevice(a.churchId, 'cy', shared)).status).toBe(204)

      let base: Env = env
      for (const who of refused) {
        const real = env.CHURCH_DIRECTORY.getByName(churches[who])
        base = envWithDirectory(
          churches[who],
          {
            knows: (identity: Identity) => real.knows(identity),
            registerDevice: async () => 'not-known',
          },
          base,
        )
      }

      // Each call waits for its turn in `calls`. A call the case did not plan, or a registration
      // that stops before its planned calls, breaks the order: every call then fails at once, and
      // the test reports it rather than hanging.
      let turn = 0
      let broken = false
      const off: string[] = []
      const ran: string[] = []
      const waiting = new Map<string, () => void>()
      const cancelled = { A: gate(), B: gate(), C: gate() }
      const wakeNext = () => {
        const next = calls[turn]
        if (next !== undefined) waiting.get(`${next.who}${next.n}`)?.()
      }
      const breakOrder = (why: string) => {
        off.push(why)
        broken = true
        for (const go of waiting.values()) go()
      }
      const stepFor = (who: Registrant) => {
        let n = 0
        return async (method: string, call: () => Promise<unknown>) => {
          n += 1
          const mine = n
          const at = calls.findIndex((planned) => planned.who === who && planned.n === mine)
          if (broken || calls[at]?.method !== method) {
            breakOrder(`${who}'s call ${mine} is ${method}, not ${calls[at]?.method ?? 'planned'}`)
            throw new Error('A call the case did not plan')
          }
          if (turn !== at) await new Promise<void>((go) => waiting.set(`${who}${mine}`, go))
          if (broken) throw new Error('A call the case did not plan')
          ran.push(`${who} ${calls[at]?.label}`)
          const outcome = fault?.who === who && fault.at === mine ? fault.outcome : null
          try {
            if (outcome === 'fail-before') throw new Error('Durable Object reset')
            const result = await call()
            if (outcome === 'fail-after') throw new Error('Durable Object reset')
            if (outcome === 'cancel-after') {
              cancelled[who].open()
              return new Promise(() => {})
            }
            return result
          } finally {
            turn += 1
            wakeNext()
          }
        }
      }
      const register = async (who: Registrant): Promise<Answer> => {
        const response = registerDeviceWith(
          steppedEnv(base, stepFor(who)),
          churches[who],
          'cy',
          shared,
        )
        const answer = await Promise.race([
          response.then(
            (r) => r.status as Answer,
            () => 'failed' as const,
          ),
          cancelled[who].opened.then(() => 'cancelled' as const),
        ])
        if (answer !== 'cancelled' && calls.slice(turn).some((planned) => planned.who === who)) {
          breakOrder(`${who} answered ${answer} before its planned calls ran`)
        }
        return answer
      }
      const [first, second] = registrants
      const [answerFirst, answerSecond] = await Promise.all([register(first), register(second)])

      expect(off).toEqual([])
      expect(ran).toEqual(calls.map((planned) => `${planned.who} ${planned.label}`))
      expect({ [first]: answerFirst, [second]: answerSecond }).toEqual(matrixCase.answers)
      const registry = env.CHURCH_REGISTRY.getByName(REGISTRY_NAME)
      const pushers = async () => {
        const pushing: string[] = []
        for (const church of [a, b, c]) {
          if ((await pushedTo(expo, church.churchId)).includes(shared))
            pushing.push(church.churchId)
        }
        return pushing
      }

      const pushing = await pushers()
      // Every church the registry lists for the phone holds a row for it, so pushes to it.
      const listed: string[] = []
      for (const church of [a, b, c]) {
        if ((await registry.ownedBy(church.churchId, [shared])).length > 0) {
          listed.push(church.churchId)
        }
      }
      expect(listed).toEqual(pushing)
      expect(pushing.length).toBeLessThanOrEqual(1)
      // Where the phone's pushes end up once both stop, faulted or not: a church that should have
      // it and does not is a phone that hears nothing until its next launch.
      expect(pushing).toEqual(matrixCase.pushing.map((church) => churches[church]))

      expect((await registerDevice(c.churchId, 'cy', shared)).status).toBe(204)
      expect(await pushers()).toEqual([c.churchId])
    })
  }
})
