import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { reconnectDelayMs, reconnects } from '../src/channel-reconnect.ts'

describe('how long a dropped channel socket waits before it reconnects', () => {
  it('waits 1 s, then twice as long each try, up to 30 s', () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 6, 20].map(reconnectDelayMs),
      [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000],
    )
  })
})

/** A reconnect policy whose connects the test counts and whose waits the test fires by hand. */
function harness() {
  let connects = 0
  const timers: { run: () => void; ms: number; cancelled: boolean; fired: boolean }[] = []
  const policy = reconnects({
    connect: () => {
      connects += 1
    },
    schedule: (run, ms) => {
      const timer = { run, ms, cancelled: false, fired: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
  })
  /** The waits still set, as the clock passing them would fire them. */
  const waiting = () => timers.filter((timer) => !timer.cancelled && !timer.fired)
  const elapse = () => {
    for (const timer of waiting()) {
      timer.fired = true
      timer.run()
    }
  }
  return { policy, connects: () => connects, timers, waiting, elapse }
}

describe("the channel screen's reconnects after a dropped socket", () => {
  it('connects again once the wait after a drop has passed', () => {
    const { policy, connects, waiting, elapse } = harness()
    policy.dropped()
    assert.deepEqual(
      waiting().map(({ ms }) => ms),
      [1000],
    )
    assert.equal(connects(), 0)
    elapse()
    assert.equal(connects(), 1)
  })

  it('waits longer after each try that drops again, up to 30 s', () => {
    const { policy, timers, elapse } = harness()
    for (let tries = 0; tries < 7; tries += 1) {
      policy.dropped()
      elapse()
    }
    assert.deepEqual(
      timers.map(({ ms }) => ms),
      [1000, 2000, 4000, 8000, 16000, 30000, 30000],
    )
  })

  it('sets one wait at a time when a drop is reported twice', () => {
    const { policy, connects, waiting, elapse } = harness()
    policy.dropped()
    policy.dropped()
    assert.equal(waiting().length, 1)
    elapse()
    assert.equal(connects(), 1)
  })

  it('starts from 1 s again once a socket opens', () => {
    const { policy, timers, elapse } = harness()
    policy.dropped()
    elapse()
    policy.dropped()
    elapse()
    policy.opened()
    policy.dropped()
    assert.deepEqual(
      timers.map(({ ms }) => ms),
      [1000, 2000, 1000],
    )
  })

  it('connects at once without the wait when asked to now', () => {
    const { policy, connects, waiting, elapse } = harness()
    policy.dropped()
    policy.now()
    assert.equal(connects(), 1)
    assert.equal(waiting().length, 0)
    elapse()
    assert.equal(connects(), 1)
  })

  it('does nothing when asked to connect now with no drop waiting', () => {
    const { policy, connects } = harness()
    policy.now()
    assert.equal(connects(), 0)

    const reconnected = harness()
    reconnected.policy.dropped()
    reconnected.elapse()
    reconnected.policy.opened()
    reconnected.policy.now()
    assert.equal(reconnected.connects(), 1)
  })

  it('connects again at once when asked to now while a retry is still connecting', () => {
    const { policy, connects, waiting } = harness()
    policy.dropped()
    policy.now()
    assert.equal(connects(), 1)
    policy.now()
    assert.equal(connects(), 2)
    assert.equal(waiting().length, 0)
  })

  it('never connects again once stopped', () => {
    const { policy, connects, waiting, elapse } = harness()
    policy.dropped()
    policy.stop()
    assert.equal(waiting().length, 0)
    elapse()
    policy.now()
    policy.dropped()
    elapse()
    policy.now()
    assert.equal(connects(), 0)
  })
})
