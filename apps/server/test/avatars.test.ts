import { describe, expect, it } from 'vitest'
import {
  approveBirthdate,
  asMember,
  enterBirthdate,
  postMessage,
  readHistory,
  readMe,
  seedChurch,
} from './support/church.ts'
import { runScheduled } from './support/deployed.ts'
import { connectSyncAccount, pcoChurchId } from './support/flows.ts'
import { type FakeGroupMember, fakeGroups } from './support/groups.ts'
import { birthdateFor, fakePeople, initialsImage } from './support/people.ts'
import { fakePlanningCenter, newOrganizationId } from './support/planning-center.ts'
import { type FakeServicesPerson, type FakeTeam, fakeServices } from './support/services.ts'

const ADA_PHOTO =
  'https://avatars.planningcenteronline.com/uploads/person/101-1700000000/avatar.jpg'

/** An uploaded photo's URL, as Planning Center answers one. */
function photo(personId: string, version = 1): string {
  return `https://avatars.planningcenteronline.com/uploads/person/${personId}-${version}/avatar.jpg`
}

const ada: FakeServicesPerson = {
  id: 'ada',
  name: 'Ada Brandt',
  birthdate: birthdateFor(30),
  photoUrl: ADA_PHOTO,
}

/** One Services team, Worship, which Ada leads. */
function teams(members: FakeServicesPerson[] = []): FakeTeam[] {
  return [{ id: '21', name: 'Worship', members: [ada, ...members], leaders: [ada] }]
}

/**
 * A fresh Planning Center organization with its sync account connected, and Ada named its admin
 * through the test seed under the same church ID, before the first sync.
 */
async function connectedChurch(churchTeams: FakeTeam[] = teams()) {
  const planningCenter = fakePlanningCenter()
  const organizationId = newOrganizationId()
  const services = fakeServices(planningCenter, { syncPersonId: 'sync', teams: churchTeams })
  const connect = await connectSyncAccount(planningCenter, {
    organizationId,
    personId: 'sync',
    administrator: true,
  })
  expect(connect.session.status).toBe(204)
  const churchId = pcoChurchId(organizationId)
  await seedChurch({
    churchId,
    people: [{ personId: 'ada', name: 'Ada Brandt', role: 'admin' }],
    channels: [],
  })
  return { planningCenter, services, organizationId, churchId }
}

/** The avatar each author of a channel's history carries, by person ID, as the reader reads it. */
async function authorAvatars(churchId: string, channelId: string, readerId = 'ada') {
  const { authors } = await readHistory(churchId, readerId, channelId)
  return Object.fromEntries(authors.map((author) => [author.personId, author.avatar]))
}

/** Posts one message in Worship as each of these people. */
async function postAs(churchId: string, personIds: string[]) {
  for (const personId of personIds) {
    await postMessage(churchId, personId, 'team-21', `Hello from ${personId}`)
  }
}

describe("an adult's Planning Center photo", () => {
  it('is their avatar on /me and on the authors of a channel history', async () => {
    const { churchId } = await connectedChurch()
    await runScheduled()
    await postMessage(churchId, 'ada', 'team-21', 'Rehearsal at six')

    expect((await readMe(churchId, 'ada')).avatar).toBe(ADA_PHOTO)
    expect(await authorAvatars(churchId, 'team-21')).toEqual({ ada: ADA_PHOTO })
  })

  it("comes from the team's leaders when they lead a team without being listed on it", async () => {
    const max = {
      id: 'max',
      name: 'Max Ferreira',
      birthdate: birthdateFor(41),
      photoUrl: photo('max'),
    }
    const { churchId } = await connectedChurch([
      { id: '21', name: 'Worship', members: [ada], leaders: [ada, max] },
    ])
    await runScheduled()

    expect((await readMe(churchId, 'max')).avatar).toBe(photo('max'))
  })

  it('is no avatar for a minor of 13 to 17, nor for a person with no birthdate on file', async () => {
    const tess = {
      id: 'tess',
      name: 'Tess Okafor',
      birthdate: birthdateFor(15),
      photoUrl: photo('tess'),
    }
    const nobi = { id: 'nobi', name: 'Nobi Park', birthdate: null, photoUrl: photo('nobi') }
    const { churchId } = await connectedChurch(teams([tess, nobi]))
    await runScheduled()
    await postAs(churchId, ['ada', 'tess', 'nobi'])

    expect((await readMe(churchId, 'tess')).avatar).toBeNull()
    expect((await readMe(churchId, 'nobi')).avatar).toBeNull()
    expect(await authorAvatars(churchId, 'team-21')).toEqual({
      ada: ADA_PHOTO,
      tess: null,
      nobi: null,
    })
  })

  it("is no avatar when it is Planning Center's default initials image, or no https URL", async () => {
    const max = {
      id: 'max',
      name: 'Max Ferreira',
      birthdate: birthdateFor(41),
      photoUrl: initialsImage('Max Ferreira'),
    }
    const lee = {
      id: 'lee',
      name: 'Abe Lee',
      birthdate: birthdateFor(52),
      photoUrl: 'http://avatars.planningcenteronline.com/uploads/person/lee-1/avatar.jpg',
    }
    const { churchId } = await connectedChurch(teams([max, lee]))
    await runScheduled()
    await postAs(churchId, ['max', 'lee'])

    expect((await readMe(churchId, 'max')).avatar).toBeNull()
    expect(await authorAvatars(churchId, 'team-21')).toEqual({ max: null, lee: null })
  })

  it('is no avatar when it is no URL at all, and the rest of the roster still syncs', async () => {
    const zed = {
      id: 'zed',
      name: 'Zed Lund',
      birthdate: birthdateFor(33),
      photoUrl: 'not a url',
    }
    const { churchId } = await connectedChurch(teams([zed]))
    await runScheduled()
    await postAs(churchId, ['ada', 'zed'])

    expect((await readMe(churchId, 'zed')).avatar).toBeNull()
    expect(await authorAvatars(churchId, 'team-21')).toEqual({ ada: ADA_PHOTO, zed: null })
  })

  it('comes from their People profile when they are only in a synced Group', async () => {
    const cy: FakeGroupMember = { id: 'cy', name: 'Cy Park', avatar: photo('cy') }
    const dee: FakeGroupMember = {
      id: 'dee',
      name: 'Dee Mensah',
      birthdate: birthdateFor(16),
      avatar: photo('dee'),
    }
    const eli: FakeGroupMember = { id: 'eli', name: 'Eli Brandt' }
    const fay: FakeGroupMember = { id: 'fay', name: 'Fay Okafor', avatar: null }
    const { planningCenter, churchId } = await connectedChurch()
    fakeGroups(planningCenter, {
      syncPersonId: 'sync',
      groupTypes: [
        {
          id: '31',
          name: 'Small Groups',
          groups: [{ id: '301', name: 'Tuesday Night', members: [cy, dee, eli, fay] }],
        },
      ],
    })
    await runScheduled()
    const enabled = await asMember(churchId, 'ada', '/group-types/31/sync', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(enabled.status).toBe(204)
    await runScheduled()
    // Dee, a minor, opens no small group channel (phon#17), so only her own /me shows her avatar.
    for (const personId of ['cy', 'eli', 'fay']) {
      await postMessage(churchId, personId, 'group-301', `Hello from ${personId}`)
    }

    expect((await readMe(churchId, 'cy')).avatar).toBe(photo('cy'))
    expect((await readMe(churchId, 'dee')).avatar).toBeNull()
    expect(await authorAvatars(churchId, 'group-301', 'cy')).toEqual({
      cy: photo('cy'),
      eli: null,
      fay: null,
    })
  })
})

describe('an avatar after the next roster sync', () => {
  it('follows a new photo, a removed one, and a member who turns 18', async () => {
    const ray = { id: 'ray', name: 'Ray Lund', birthdate: birthdateFor(17), photoUrl: photo('ray') }
    const max = {
      id: 'max',
      name: 'Max Ferreira',
      birthdate: birthdateFor(41),
      photoUrl: photo('max'),
    }
    const { services, churchId } = await connectedChurch(teams([ray, max]))
    await runScheduled()
    await postAs(churchId, ['ada', 'ray', 'max'])
    expect(await authorAvatars(churchId, 'team-21')).toEqual({
      ada: ADA_PHOTO,
      ray: null,
      max: photo('max'),
    })

    services.setPhoto('ada', photo('ada', 2))
    services.setPhoto('max', undefined)
    services.setBirthdate('ray', birthdateFor(18))
    await runScheduled()

    expect((await readMe(churchId, 'ada')).avatar).toBe(photo('ada', 2))
    expect((await readMe(churchId, 'max')).avatar).toBeNull()
    expect((await readMe(churchId, 'ray')).avatar).toBe(photo('ray'))
    expect(await authorAvatars(churchId, 'team-21')).toEqual({
      ada: photo('ada', 2),
      ray: photo('ray'),
      max: null,
    })
  })

  it('is no avatar for a person whose 18+ birthdate is approved, until the next sync', async () => {
    const nobi = { id: 'nobi', name: 'Nobi Park', birthdate: null, photoUrl: photo('nobi') }
    const { planningCenter, services, churchId } = await connectedChurch(teams([nobi]))
    fakePeople(planningCenter, {
      syncPersonId: 'sync',
      personIds: ['nobi'],
      onBirthdate: (personId, birthdate) => services.setBirthdate(personId, birthdate),
    })
    await runScheduled()

    expect((await enterBirthdate(churchId, 'nobi', birthdateFor(30))).status).toBe(200)
    expect((await approveBirthdate(churchId, 'ada', 'nobi')).status).toBe(204)

    expect((await readMe(churchId, 'nobi')).avatar).toBeNull()

    await runScheduled()

    expect((await readMe(churchId, 'nobi')).avatar).toBe(photo('nobi'))
  })

  it('is taken away when Planning Center removes the photo outright', async () => {
    const { services, churchId } = await connectedChurch()
    await runScheduled()

    services.setPhoto('ada', null)
    await runScheduled()

    expect((await readMe(churchId, 'ada')).avatar).toBeNull()
  })
})
