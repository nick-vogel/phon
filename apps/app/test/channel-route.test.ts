import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { channelRouteParams } from '../src/channel-route.ts'

describe('the route params that open the channel screen', () => {
  it('keeps the oversight flag for a private channel its creator did not join', () => {
    // What the server answers an admin who creates a private channel without picking themselves.
    const channel = {
      id: 'c1',
      name: 'Elders',
      kind: 'private',
      canPost: false,
      oversight: true,
    } as const
    assert.deepEqual(channelRouteParams(channel), {
      channelId: 'c1',
      name: 'Elders',
      canPost: 'false',
      oversight: 'true',
      leads: 'false',
    })
  })

  it('opens an open channel its creator may post in as postable and not overseen', () => {
    const channel = { id: 'c2', name: 'General', kind: 'open', canPost: true } as const
    assert.deepEqual(channelRouteParams(channel), {
      channelId: 'c2',
      name: 'General',
      canPost: 'true',
      oversight: 'false',
      leads: 'false',
    })
  })

  it('keeps the leads flag for a team channel the person leads', () => {
    const channel = { id: 'c3', name: 'Band', kind: 'team', canPost: true, leads: true } as const
    assert.deepEqual(channelRouteParams(channel), {
      channelId: 'c3',
      name: 'Band',
      canPost: 'true',
      oversight: 'false',
      leads: 'true',
    })
  })
})
