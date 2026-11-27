# phon#138: the device registration matrix's shared stall

**Question:** why do concurrent copies of `apps/server/test/device-ownership.test.ts` stall for seconds at the same wall-clock moment, when a case takes about 100 ms?
**Date:** 2026-11-14, on an Apple M4 Pro (14 cores, 48 GB), macOS, APFS internal SSD, at the integration tip `1608143`.
**Answer:** where the copies' Durable Object storage lives. That storage is SQLite files in miniflare's directory under `os.tmpdir()`. With the storage of many concurrent copies on the internal disk, cases stall for seconds. Move the same copies' storage to a RAM disk, with everything else the same, and the stall is gone; move it back and it returns. The loop proves that location, under that concurrent load. How the disk holds the writes up is a hypothesis: the leading one is `fsync` latency on that disk, but the loop matches only one stall in time to a slow `fsync`, and one copy alone does not stall under heavy `F_FULLFSYNC` traffic (see "The mechanism is a hypothesis").

## The cause, and the evidence that moves it both ways

The lever is each copy's `TMPDIR`, which is where miniflare keeps Durable Object storage (`miniflare-<hex>/do/...` under `os.tmpdir()`). The loop either leaves it on the internal disk or points it at a 4 GB APFS RAM disk (`hdiutil attach -nomount ram://8388608`, then `diskutil erasevolume APFS phon138ram <device>`). Nothing else changes: the same copies, the same CPU and memory load, the same loopback sockets, the same Vite cache in `node_modules/.vite`. A probe process beside the copies fsyncs a 4 KB file on the internal disk every 20 ms and logs every fsync over 100 ms.

| Run                       | Copies, stagger | Storage on                          | Batches stalled (a case at or over 1 s) | Slowest case                    | Probe fsyncs over 1 s |
| ------------------------- | --------------- | ----------------------------------- | --------------------------------------- | ------------------------------- | --------------------- |
| baseline                  | 10, 2 s         | disk                                | 9 of 12                                 | 10,329 ms                       | not yet probed        |
| traced (scratch worktree) | 10, 2 s         | disk                                | 4 of 4                                  | 6,971 ms                        | 3, up to 4,119 ms     |
| RAM disk                  | 10, 2 s         | RAM disk                            | 0 of 8                                  | 155 ms                          | 0                     |
| alternation, 3 rounds     | 10, 2 s         | disk, then RAM disk, 3 batches each | disk 1 of 9, RAM disk 0 of 9            | disk 3,555 ms, RAM disk 123 ms  | 0                     |
| alternation, 2 rounds     | 16, 1 s         | disk, then RAM disk, 3 batches each | disk 3 of 6, RAM disk 0 of 6            | disk 20,354 ms, RAM disk 160 ms | 2                     |

All told: storage on the disk stalled 17 of 31 batches, with the slowest case at 20.4 s. Storage on the RAM disk stalled 0 of 23, with the slowest case at 160 ms. The two 16-copy rounds went disk (a stall, 11.3 s), RAM disk (none), disk (a stall, 20.4 s), RAM disk (none), back to back. The longest probe fsync in a disk run was 4,119 ms, and in a RAM disk run 236 ms: the probe stayed on the internal disk throughout, so with the copies' writes moved off it, the disk's own fsyncs are fast again. The disk is slow because of the copies' writes, not because of something else on the machine.

Where the stall sits inside a case was found in a detached scratch worktree, with temporary timing around every step of the matrix case and of `afterEach` (never committed). In the traced run's longest stall, eight copies stopped within 0.4 s of each other (22:46:19.8 to 22:46:20.2 UTC) for 4.1 to 5.1 s, each in whatever step it happened to be in: waiting for the pushes of a post, between two posts, or between two `seedChurch` calls. Every one of those steps writes Durable Object storage. The probe's fsync that began at 22:46:20.174 took 4,087 ms, in the same window. The timer probe, a process that asks for a 5 ms `setTimeout` again and again, saw nothing at that moment: only 2 timers fired over 100 ms late in all the runs, the latest 224 ms late.

During a stall the copies go idle: workerd's total CPU falls from 150 to 220% to between 0 and 30%, and disk throughput drops with it (9 transactions a second at 22:40:13 UTC in the baseline run). They are blocked waiting for storage, not competing for CPU.

The disk does not always stall under the copies' load. Of the disk runs, three first stalled on their third batch (the baseline, alternation round 3, 16-copy round 1), one on its second (16-copy round 2), and two not at all (alternation rounds 1 and 2): the stall seems to need writes sustained over a minute or more. The rate was also higher when another lane's server suite was running on the same machine (the baseline and traced runs saw up to 12 workerd processes, against 7 or 8 in the quieter alternation rounds). That is the "low and unstable rate" phon#138 started from. Why the internal disk slows under those sustained writes is below what an unprivileged loop can see (`fs_usage` and `dtrace` need root). What the loop does show is that the stall needs the copies' storage on that disk, and with it off the disk the stall does not happen at all.

## The mechanism is a hypothesis

The loop proves where the stall comes from, not how. Moving the copies' storage moves the stall both ways, so the cause is the storage location under the copies' concurrent load. What on the disk holds the writes up is not shown.

`fsync` latency on that disk is the leading hypothesis. For it: in the traced run's longest stall, a probe `fsync` that began inside the 0.4 s in which eight copies stopped took 4,087 ms, and with the copies' storage on the RAM disk the probe's `fsync`s on the internal disk stayed under 236 ms. Against it, or at least not shown by it: that is the only stall the loop matches in time to a probe `fsync`. The disk stall in the three alternation rounds reached 3,555 ms with no probe `fsync` over 1 s, and the 16-copy rounds reached 20.4 s with only 2. The probe is one process flushing one 4 KB file every 20 ms, so it samples the disk's flush latency rather than timing the copies' own storage calls; a stall it misses may be one it did not sample, or one an `fsync` does not cause.

phon#138 also records that one copy does not stall under four processes forcing `F_FULLFSYNC` writes. That fits the location and limits the `fsync` hypothesis: flush traffic from other processes, on its own, does not stall a copy whose storage is on the same disk. What stalled here is many copies' storage on one disk at once, the writes and syncs of 10 or 16 workerd processes' SQLite files together, sustained for a minute or more. Whether the step that blocks is an `fsync` queued behind theirs, or their writes queue on the disk some other way, needs `fs_usage` or `dtrace`, which need root.

## Hypotheses ruled out

- **Memory pressure** from N workerd and N Vitest processes. Not one swap-in, swap-out or page-out in any one-second sample of any run (1,643 samples). The RAM disk runs had the same processes and did not stall.
- **CPU load and scheduling.** The RAM disk runs had the same CPU load and did not stall, and during a stall the copies' CPU falls instead of rising. The timer probe saw no stall.
- **A host-wide power or thermal event.** `pmset -g therm` read "No thermal warning level has been recorded" and "No performance warning level has been recorded" in every sample.
- **A resource the copies share beyond the disk.** The loopback sockets between each Vitest process and its workerd, the Vite cache in `node_modules/.vite`, and the matrix file itself were the same in the RAM disk runs, and those did not stall.

The plugin's update-check file also lives under `os.tmpdir()`, so it moved to the RAM disk with the storage. It is one small file read when a copy starts, so it cannot explain a stall in the middle of a run. The probe on the internal disk saw slow `fsync`s in the disk runs, with no update-check file on it.

## The failing CI run

A lane cannot push, so the stall on a GitHub Actions runner was not reproduced. The argument from the evidence: `pnpm test` runs every server file in one Vitest process (`maxWorkers: 1`), so CI has none of the loop's concurrency. What it has instead is the runner's disk: a virtual machine's disk on shared hardware, whose storage latency the job does not control and can be far worse than a local SSD's. The failing run was slower overall (70 s against 52 s), and slower in `roster-sync` and `reports`, the other files that write Durable Object storage heavily. A slow-storage episode on the runner explains all three, where a defect in one case or in the route explains none of them. Checking it on a runner is filed as a proposal.

## The timeout

The matrix keeps `timeout: 30_000`. The cause is the disk under the test pool's Durable Object storage, not the route and not the test. Left where the pool puts it, a case under load reaches 10 s with ten copies and 20 s with sixteen, well past the 5 s default. With the storage on a RAM disk no case passed 160 ms, so the long timeout would no longer be needed, but moving the pool's storage is a harness change outside phon#138 (filed as a proposal). The comment above the matrix `describe` names the cause and points here.

## How to run the loop

From the repo root, after `pnpm install`:

```
node docs/investigations/phon-138/stall-loop.mjs                       # 10 copies, 2 s apart, 10 batches
node docs/investigations/phon-138/stall-loop.mjs --copies 16 --stagger 1000 --batches 3
node docs/investigations/phon-138/stall-loop.mjs --tmp-base /Volumes/phon138ram/run --probe-dir <a directory on the internal disk>
```

Each copy runs the matrix file with `stall-reporter.ts`, which writes one JSON line per case (its start and duration) so copies line up on one wall-clock axis. The loop prints a line per batch and, for each group of overlapping stalls, the cases, the probes' hiccups and the machine's readings around it. A stall looks like this (the traced run, batch 3, trimmed; its scratch reporter also counted its trace lines as cases, so the first line read 1980 cases there):

```
batch 3: 990 cases in 10 copies, 21 at or over 1000 ms in 8 copies, slowest 6971 ms, 0 copies failed
  22:46:14.337 to 22:46:24.993: 21 stalls in 8 copies
    copy 3 case 75 from 22:46:17.956 took 6971 ms
    copy 4 case 61 from 22:46:18.013 took 6908 ms
    copy 6 case 37 from 22:46:19.141 took 5809 ms
    copy 5 case 49 from 22:46:19.348 took 5632 ms
    copy 8 case 12 from 22:46:19.500 took 5039 ms
    ...
    probe fsync at 22:46:20.174 took 4087 ms
  probes: 0 late timers, 29 slow fsyncs over 100 ms
```

and the same loop with the storage on a RAM disk:

```
batch 3: 1584 cases in 16 copies, 0 at or over 1000 ms in 0 copies, slowest 160 ms, 0 copies failed
  probes: 0 late timers, 0 slow fsyncs over 100 ms
```

Options: `--copies`, `--stagger`, `--threshold` (1000 ms), `--batches`, `--until-stall`, `--file` (another server test file), `--tmp-base` (where each copy's `TMPDIR` goes), `--shared-tmp`, `--probe-dir`, `--hog-mb` (a side process that holds memory) and `--out` (the raw logs: each copy's cases, the probes, and the per-second samples). Its sampler uses only `vm_stat`, `sysctl`, `iostat`, `ps` and `pmset`: no `sudo`, no `wrangler dev`, no `expo start`. Detach a RAM disk with `hdiutil detach /Volumes/phon138ram` when done.
