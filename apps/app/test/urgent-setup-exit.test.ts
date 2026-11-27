import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { leaveUrgentSetup, type UrgentSetupExitRouter } from '../src/urgent-setup-exit.ts'

/** A router that records each call, with a stack that can or cannot go back. */
function router(canGoBack: boolean): { router: UrgentSetupExitRouter; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    router: {
      canGoBack: () => canGoBack,
      back: () => void calls.push('back'),
      replace: (href) => void calls.push(`replace ${String(href)}`),
    },
  }
}

describe('leaving the urgent setup screen', () => {
  it('goes back to the screen that opened it, so Settings stays on the stack under it', () => {
    const fake = router(true)
    leaveUrgentSetup(fake.router)
    assert.deepEqual(fake.calls, ['back'])
  })

  it('on first run, where it is the only screen, puts the channel list in its place as the root', () => {
    const fake = router(false)
    leaveUrgentSetup(fake.router)
    assert.deepEqual(fake.calls, ['replace /'])
  })
})
