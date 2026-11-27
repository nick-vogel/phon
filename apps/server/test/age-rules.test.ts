import { exports } from 'cloudflare:workers'
import type { PeopleList } from '@phon/api-types'
import { describe, expect, it } from 'vitest'
import {
  asMember,
  openSocket,
  readBirthdate,
  readChannelPeople,
  readPeopleWithoutBirthdate,
  seedChurch,
  setRole,
} from './support/church.ts'
import { runScheduled } from './support/deployed.ts'
import { connectSyncAccount, pcoChurchId, signIn } from './support/flows.ts'
import { birthdateFor } from './support/people.ts'
import { fakePlanningCenter, newOrganizationId } from './support/planning-center.ts'
import { type FakeTeam, fakeServices } from './support/services.ts'

const ada = { id: 'ada', name: 'Ada Brandt', birthdate: birthdateFor(30) }
const tess = { id: 'tess', name: 'Tess Okafor', birthdate: birthdateFor(15) }
const kit = { id: 'kit', name: 'Kit Mensah', birthdate: birthdateFor(10) }
const nobi = { id: 'nobi', name: 'Nobi Park', birthdate: null }
const max = { id: 'max', name: 'Max Ferreira', birthdate: birthdateFor(41) }

/**
 * Two Services teams. Worship has an adult (Ada, who leads it), a 15-year-old, a 10-year-old and
 * a person with no birthdate. Kit, the 10-year-old, also leads Kids.
 */
function teams(): FakeTeam[] {
  return [
    { id: '21', name: 'Worship', members: [ada, tess, kit, nobi], leaders: [ada] },
    { id: '22', name: 'Kids', members: [max], leaders: [kit] },
  ]
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

/** A request with no identity at all. */
function anonymous(path: string) {
  return exports.default.fetch(`https://phon.test${path}`)
}

function idsOf(people: Array<{ personId: string }>): string[] {
  return people.map((person) => person.personId)
}

describe('a person under 13 in Planning Center', () => {
  it('is never synced: in no list, no team channel, not among the team leads, and cannot sign in', async () => {
    const { planningCenter, organizationId, churchId } = await connectedChurch()

    await runScheduled()

    const people = await asMember(churchId, 'ada', '/people')
    expect(idsOf(((await people.json()) as PeopleList).people)).toEqual([
      'ada',
      'max',
      'nobi',
      'tess',
    ])
    expect(idsOf((await readChannelPeople(churchId, 'ada', 'team-21')).people)).toEqual([
      'ada',
      'nobi',
      'tess',
    ])
    expect(idsOf((await readChannelPeople(churchId, 'ada', 'team-22')).people)).toEqual(['max'])
    expect(idsOf((await readChannelPeople(churchId, 'ada', 'team-leads')).people)).toEqual(['ada'])
    expect((await asMember(churchId, 'kit', '/me')).status).toBe(404)
    expect((await asMember(churchId, 'kit', '/channels')).status).toBe(404)
    const run = await signIn(planningCenter, { organizationId, personId: 'kit' })
    expect(run.session.status).toBe(403)
    expect(JSON.parse(run.sessionBody)).toEqual({ problem: 'not-known' })
  })

  it('loses every channel, live socket included, once Planning Center corrects their birthdate to under 13', async () => {
    const { services, churchId } = await connectedChurch()
    await runScheduled()
    const socket = await openSocket(churchId, 'tess', 'team-21')

    services.setBirthdate('tess', birthdateFor(12))
    await runScheduled()

    expect(await socket.closed()).toEqual({ code: 4403, reason: 'No longer a member' })
    expect((await asMember(churchId, 'tess', '/me')).status).toBe(404)
    expect((await asMember(churchId, 'tess', '/channels/general/messages')).status).toBe(404)
    expect(idsOf((await readChannelPeople(churchId, 'ada', 'team-21')).people)).toEqual([
      'ada',
      'nobi',
    ])
  })

  it('is synced on their 13th birthday, and not the day before', async () => {
    const { churchId } = await connectedChurch([
      {
        id: '21',
        name: 'Worship',
        members: [
          ada,
          { id: 'june', name: 'June Abara', birthdate: birthdateFor(13) },
          { id: 'jack', name: 'Jack Abara', birthdate: birthdateFor(13, 1) },
        ],
        leaders: [],
      },
    ])

    await runScheduled()

    expect((await asMember(churchId, 'june', '/me')).status).toBe(200)
    expect((await asMember(churchId, 'jack', '/me')).status).toBe(404)
  })
})

describe('the age group a birthdate gives a synced person', () => {
  it('treats a person with no birthdate on file as a minor', async () => {
    const { churchId } = await connectedChurch()

    await runScheduled()

    expect(await readBirthdate(churchId, 'nobi')).toEqual({
      birthdate: null,
      pendingBirthdate: null,
      ageGroup: 'minor',
    })
  })

  it('counts 13 to 17 as a minor and 18 or older as an adult, from the birthdate on file', async () => {
    const { churchId } = await connectedChurch()

    await runScheduled()

    expect(await readBirthdate(churchId, 'tess')).toEqual({
      birthdate: tess.birthdate,
      pendingBirthdate: null,
      ageGroup: 'minor',
    })
    expect(await readBirthdate(churchId, 'ada')).toEqual({
      birthdate: ada.birthdate,
      pendingBirthdate: null,
      ageGroup: 'adult',
    })
  })

  it.each([
    ['the day before their 18th birthday', 'minor', 1],
    ['on their 18th birthday', 'adult', 0],
  ])('counts a person %s as a %s', async (_label, ageGroup, days) => {
    const birthdate = birthdateFor(18, days)
    const { churchId } = await connectedChurch([
      {
        id: '21',
        name: 'Worship',
        members: [ada, { id: 'ray', name: 'Ray Lund', birthdate }],
        leaders: [],
      },
    ])

    await runScheduled()

    expect(await readBirthdate(churchId, 'ray')).toEqual({
      birthdate,
      pendingBirthdate: null,
      ageGroup,
    })
  })

  it('follows a birthdate Planning Center adds or takes away on the next sync', async () => {
    const { services, churchId } = await connectedChurch()
    await runScheduled()

    services.setBirthdate('nobi', birthdateFor(25))
    services.setBirthdate('tess', null)
    await runScheduled()

    expect((await readBirthdate(churchId, 'nobi')).ageGroup).toBe('adult')
    expect(await readBirthdate(churchId, 'tess')).toEqual({
      birthdate: null,
      pendingBirthdate: null,
      ageGroup: 'minor',
    })
  })

  it('answers 404 to a person the directory does not know, and 401 to no one', async () => {
    const { churchId } = await connectedChurch()
    await runScheduled()

    expect((await asMember(churchId, 'kit', '/me/birthdate')).status).toBe(404)
    expect((await asMember(churchId, 'stranger', '/me/birthdate')).status).toBe(404)
    expect((await anonymous('/me/birthdate')).status).toBe(401)
  })
})

describe('the list of people with no birthdate', () => {
  it('shows an admin exactly the current people with no birthdate on file, sorted by name', async () => {
    const lee = { id: 'lee', name: 'Abe Lee', birthdate: null }
    const { services, churchId } = await connectedChurch([
      { id: '21', name: 'Worship', members: [ada, tess, kit, nobi, lee], leaders: [ada] },
      {
        id: '22',
        name: 'Kids',
        members: [max, { id: 'zed', name: 'Zed Ngata', birthdate: null }],
        leaders: [],
      },
    ])
    await runScheduled()

    expect(await readPeopleWithoutBirthdate(churchId, 'ada')).toEqual({
      people: [
        { personId: 'lee', name: 'Abe Lee' },
        { personId: 'nobi', name: 'Nobi Park' },
        { personId: 'zed', name: 'Zed Ngata' },
      ],
    })

    services.setBirthdate('nobi', birthdateFor(16))
    services.removeMember('22', 'zed')
    await runScheduled()

    expect(await readPeopleWithoutBirthdate(churchId, 'ada')).toEqual({
      people: [{ personId: 'lee', name: 'Abe Lee' }],
    })
  })

  it('refuses a member and a chat admin with 403, and no one with 401', async () => {
    const { churchId } = await connectedChurch()
    await runScheduled()
    expect((await setRole(churchId, 'ada', 'max', 'chat-admin')).status).toBe(204)

    for (const personId of ['tess', 'max']) {
      const response = await asMember(churchId, personId, '/people/without-birthdate')
      expect(response.status, personId).toBe(403)
    }
    expect((await anonymous('/people/without-birthdate')).status).toBe(401)
    const put = await asMember(churchId, 'ada', '/people/without-birthdate', { method: 'PUT' })
    expect(put.status).toBe(405)
  })
})
