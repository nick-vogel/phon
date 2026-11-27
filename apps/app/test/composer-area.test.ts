import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { composerArea } from '../src/composer-area.ts'

const OVERSIGHT_REASON =
  'You read this channel as an admin. When you open a private channel you are not in, the other admins can see that you did.'
const READ_ONLY_REASON = 'Only admins and chat admins post here.'

describe('what sits in the composer area', () => {
  it('says why an admin reading by oversight cannot post, and offers nothing', () => {
    for (const readOnly of [false, true]) {
      assert.deepEqual(
        composerArea({ overseeing: true, readOnly, leadsTeam: true, canMarkUrgent: true }),
        { kind: 'oversight', reason: OVERSIGHT_REASON },
      )
    }
  })

  it('says why a member who may not post here cannot, and offers nothing', () => {
    assert.deepEqual(
      composerArea({ overseeing: false, readOnly: true, leadsTeam: true, canMarkUrgent: true }),
      { kind: 'read-only', reason: READ_ONLY_REASON },
    )
  })

  it('offers the team announcement only to a team leader and urgent only where the role may', () => {
    for (const leadsTeam of [false, true]) {
      for (const canMarkUrgent of [false, true]) {
        assert.deepEqual(
          composerArea({ overseeing: false, readOnly: false, leadsTeam, canMarkUrgent }),
          { kind: 'compose', offerTeamAnnouncement: leadsTeam, offerUrgent: canMarkUrgent },
          `leadsTeam ${leadsTeam}, canMarkUrgent ${canMarkUrgent}`,
        )
      }
    }
  })
})
