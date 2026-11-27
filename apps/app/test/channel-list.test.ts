import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ChannelSummary, Member } from '@phon/api-types'
import { channelListView, mayCompose } from '../src/channel-list.ts'

/** The clock every preview reads: noon on Wednesday 25 November 2026, a 24 hour clock. */
const AT = { now: new Date(2026, 10, 25, 12, 0), uses24hourClock: true }

describe('the channel list while it loads or fails', () => {
  it('shows loading while the channels load', () => {
    assert.deepEqual(channelListView({ state: 'loading' }, null, AT), { kind: 'loading' })
  })

  it('shows the failure message unchanged', () => {
    const message = 'Channels could not be loaded. Pull down to try again.'
    assert.deepEqual(channelListView({ state: 'failed', message }, null, AT), {
      kind: 'failed',
      message,
    })
  })
})

/** A member with no permissions; each test turns on what it needs. */
function member(overrides: Partial<Member> = {}): Member {
  return {
    personId: 'p1',
    name: 'Sam Rivera',
    role: 'member',
    canCreate: [],
    canAssignRoles: false,
    canReadOversight: false,
    canMarkUrgent: false,
    canManageBirthdates: false,
    canModerate: false,
    ...overrides,
  }
}

const EMPTY_TITLE = 'No channels yet'
const EMPTY_BODY =
  'Phon shows the channels of the teams and groups you serve with in Planning Center, and none include you yet. Ask your team leader or a church admin to add you, then pull down to check again.'
const COMPOSE_SENTENCE = 'You can also start a channel with the New channel button.'

describe('the channel list with no channels', () => {
  const empty = { state: 'loaded', channels: [] } as const

  it('says why it is empty and what to do, before the member has loaded', () => {
    assert.deepEqual(channelListView(empty, null, AT), {
      kind: 'empty',
      title: EMPTY_TITLE,
      body: EMPTY_BODY,
    })
  })

  it('does not offer New channel to a member who may not create channels', () => {
    assert.deepEqual(channelListView(empty, member({ canCreate: [] }), AT), {
      kind: 'empty',
      title: EMPTY_TITLE,
      body: EMPTY_BODY,
    })
  })

  it('points a member who may create channels at the New channel button', () => {
    assert.deepEqual(channelListView(empty, member({ canCreate: ['open'] }), AT), {
      kind: 'empty',
      title: EMPTY_TITLE,
      body: `${EMPTY_BODY} ${COMPOSE_SENTENCE}`,
    })
  })
})

function channel(id: string, name: string, extra: Partial<ChannelSummary> = {}): ChannelSummary {
  return { id, name, kind: 'open', canPost: true, ...extra }
}

/** Each section as its key, its title and the names of its channels, in order. */
function outline(view: ReturnType<typeof channelListView>) {
  assert.equal(view.kind, 'channels')
  if (view.kind !== 'channels') return []
  return view.sections.map((section) => ({
    key: section.key,
    title: section.title,
    names: section.rows.map((row) => row.channel.name),
  }))
}

describe('the channel list sections', () => {
  it("keeps the member's own channels in the server's order, under no heading", () => {
    const channels = [
      channel('c1', 'Worship'),
      channel('c2', 'Announcements'),
      channel('c3', 'Kids'),
    ]
    assert.deepEqual(outline(channelListView({ state: 'loaded', channels }, null, AT)), [
      { key: 'own', title: null, names: ['Worship', 'Announcements', 'Kids'] },
    ])
  })

  it('puts oversight channels under their own heading after the own ones, each in server order', () => {
    const channels = [
      channel('c1', 'Youth', { oversight: true }),
      channel('c2', 'Worship'),
      channel('c3', 'Elders', { oversight: true }),
      channel('c4', 'Band'),
    ]
    assert.deepEqual(outline(channelListView({ state: 'loaded', channels }, null, AT)), [
      { key: 'own', title: null, names: ['Worship', 'Band'] },
      { key: 'oversight', title: 'Oversight', names: ['Youth', 'Elders'] },
    ])
  })

  it('shows only the oversight section when every channel is overseen', () => {
    const channels = [
      channel('c1', 'Youth', { oversight: true }),
      channel('c2', 'Elders', { oversight: true }),
    ]
    assert.deepEqual(outline(channelListView({ state: 'loaded', channels }, null, AT)), [
      { key: 'oversight', title: 'Oversight', names: ['Youth', 'Elders'] },
    ])
  })
})

/** The one row a list of one channel draws. */
function onlyRow(summary: ChannelSummary) {
  const view = channelListView({ state: 'loaded', channels: [summary] }, null, AT)
  assert.equal(view.kind, 'channels')
  if (view.kind !== 'channels') throw new Error('no rows')
  const row = view.sections[0]?.rows[0]
  if (row === undefined) throw new Error('no rows')
  return row
}

describe('a channel row', () => {
  const spoken: [ChannelSummary['kind'], string][] = [
    ['announcements', 'Sunday, announcements channel'],
    ['open', 'Sunday, open channel'],
    ['private', 'Sunday, private channel'],
    ['small-group', 'Sunday, small group'],
    ['team', 'Sunday, team channel'],
    ['team-leads', 'Sunday, team leads channel'],
  ]
  for (const [kind, label] of spoken) {
    it(`reads a ${kind} channel's name and then its kind`, () => {
      assert.equal(onlyRow(channel('c1', 'Sunday', { kind })).accessibilityLabel, label)
    })
  }

  it('marks a team channel the member leads, and says so after the kind', () => {
    const row = onlyRow(channel('c1', 'Band', { kind: 'team', leads: true }))
    assert.equal(row.leads, true)
    assert.equal(row.accessibilityLabel, 'Band, team channel, you lead this team')
  })

  it('does not mark a team channel the member does not lead', () => {
    const row = onlyRow(channel('c1', 'Band', { kind: 'team' }))
    assert.equal(row.leads, false)
    assert.equal(row.accessibilityLabel, 'Band, team channel')
  })
})

describe("a channel row's unread state", () => {
  it('marks a channel with an unread message as unread', () => {
    assert.equal(onlyRow(channel('c1', 'Band', { unread: true })).unread, true)
  })

  it('does not mark a channel the member has read', () => {
    assert.equal(onlyRow(channel('c1', 'Band', { unread: false })).unread, false)
  })

  it('shows the count of unread mentions as the badge', () => {
    assert.equal(onlyRow(channel('c1', 'Band', { unread: true, mentions: 2 })).mentions, '2')
    assert.equal(onlyRow(channel('c1', 'Band', { unread: true, mentions: 99 })).mentions, '99')
  })

  it('shows no badge when no unread message mentions the member', () => {
    assert.equal(onlyRow(channel('c1', 'Band', { unread: true, mentions: 0 })).mentions, null)
    assert.equal(onlyRow(channel('c1', 'Band', { unread: true })).mentions, null)
  })

  it('caps the badge at 99+', () => {
    assert.equal(onlyRow(channel('c1', 'Band', { unread: true, mentions: 120 })).mentions, '99+')
  })

  it('mutes a channel with alerts off and keeps its unread state and badge', () => {
    const row = onlyRow(channel('c1', 'Band', { unread: true, mentions: 3, alertLevel: 'off' }))
    assert.equal(row.muted, true)
    assert.equal(row.unread, true)
    assert.equal(row.mentions, '3')
  })

  it('does not mute a channel with any other alert level', () => {
    for (const alertLevel of [
      'every-message',
      'mentions-and-team-announcements',
      'mentions',
    ] as const) {
      assert.equal(onlyRow(channel('c1', 'Band', { alertLevel })).muted, false)
    }
  })
})

describe("a channel row's preview", () => {
  const lastMessage = {
    authorFirstName: 'Ana',
    body: 'See you Sunday',
    image: null,
    sentAt: new Date(2026, 10, 25, 9, 5).toISOString(),
  }

  it('previews the last message and its time, read on the clock it is given', () => {
    assert.deepEqual(onlyRow(channel('c1', 'Band', { lastMessage })).preview, {
      text: 'Ana: See you Sunday',
      time: '09:05',
    })
  })

  it('shows no preview for a channel with no messages yet', () => {
    assert.equal(onlyRow(channel('c1', 'Band', { lastMessage: null })).preview, null)
  })

  it('speaks the unread state, the mention count, alerts off and the preview after the name', () => {
    const row = onlyRow(
      channel('c1', 'Band', {
        kind: 'team',
        leads: true,
        unread: true,
        mentions: 2,
        alertLevel: 'off',
        lastMessage,
      }),
    )
    assert.equal(
      row.accessibilityLabel,
      'Band, team channel, unread, 2 unread mentions, alerts off, you lead this team, Ana: See you Sunday, 09:05',
    )
  })

  it('speaks one unread mention in the singular', () => {
    const row = onlyRow(channel('c1', 'Band', { unread: true, mentions: 1 }))
    assert.equal(row.accessibilityLabel, 'Band, open channel, unread, 1 unread mention')
  })
})

describe('an oversight channel row', () => {
  it('shows only its name, even when the summary carries the member fields', () => {
    const row = onlyRow(
      channel('c1', 'Youth', {
        kind: 'private',
        oversight: true,
        unread: true,
        mentions: 4,
        alertLevel: 'off',
        lastMessage: {
          authorFirstName: 'Ana',
          body: 'Hi',
          image: null,
          sentAt: new Date(2026, 10, 25, 9, 5).toISOString(),
        },
      }),
    )
    assert.equal(row.unread, false)
    assert.equal(row.muted, false)
    assert.equal(row.mentions, null)
    assert.equal(row.preview, null)
    assert.equal(row.accessibilityLabel, 'Youth, private channel')
  })
})

describe('whether the header offers New channel', () => {
  it('does not before the member has loaded', () => {
    assert.equal(mayCompose(null), false)
  })

  it('does not for a member who may create no kind of channel', () => {
    assert.equal(mayCompose(member({ canCreate: [] })), false)
  })

  it('does for a member who may create a channel', () => {
    assert.equal(mayCompose(member({ canCreate: ['open'] })), true)
  })
})
