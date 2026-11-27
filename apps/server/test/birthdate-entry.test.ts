import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  approveBirthdate,
  asMember,
  declineBirthdate,
  enterBirthdate,
  listChannels,
  openSocket,
  postMessage,
  readBirthdate,
  readBirthdateRequests,
  readPeopleWithoutBirthdate,
  registerDevice,
  seedChurch,
  setRole,
} from './support/church.ts'
import { runScheduled } from './support/deployed.ts'
import { EXPO_PUSH_ENDPOINT, fakeExpoPush, tokenOf } from './support/expo-push.ts'
import { connectSyncAccount, pcoChurchId } from './support/flows.ts'
import { network } from './support/network.ts'
import { birthdateFor, fakePeople } from './support/people.ts'
import {
  type FakePlanningCenterOptions,
  fakePlanningCenter,
  newOrganizationId,
  PLANNING_CENTER,
} from './support/planning-center.ts'
import { type FakeTeam, fakeServices } from './support/services.ts'

const ada = { id: 'ada', name: 'Ada Brandt', birthdate: birthdateFor(44) }
const gil = { id: 'gil', name: 'Gil Sato', birthdate: null }
const lou = { id: 'lou', name: 'Lou Varga', birthdate: birthdateFor(38) }
const kai = { id: 'kai', name: 'Kai Moreno', birthdate: birthdateFor(35) }
const ned = { id: 'ned', name: 'Ned Achebe', birthdate: null }
const pia = { id: 'pia', name: 'Pia Lund', birthdate: birthdateFor(29) }
const max = { id: 'max', name: 'Max Ferreira', birthdate: birthdateFor(52) }

/**
 * Two Services teams. Ned, who has no birthdate, serves on Worship with Ada (an admin) and Pia,
 * and Lou leads Worship. Gil, the other admin, serves on Kids, which Kai leads.
 */
const TEAMS: FakeTeam[] = [
  { id: '31', name: 'Worship', members: [ada, ned, pia], leaders: [lou] },
  { id: '32', name: 'Kids', members: [gil, max], leaders: [kai] },
]

const EVERYONE = ['ada', 'gil', 'lou', 'kai', 'ned', 'pia', 'max']

/**
 * A fresh Planning Center organization with its sync account connected, Ada and Gil named its
 * admins through the test seed under the same church ID, synced once, and every person's device
 * registered. A birthdate the fake People API takes shows in Services from the next sync.
 */
async function syncedChurch(options: FakePlanningCenterOptions = {}) {
  const planningCenter = fakePlanningCenter(options)
  const organizationId = newOrganizationId()
  const services = fakeServices(planningCenter, { syncPersonId: 'sync', teams: TEAMS })
  const people = fakePeople(planningCenter, {
    syncPersonId: 'sync',
    personIds: EVERYONE,
    onBirthdate: (personId, birthdate) => services.setBirthdate(personId, birthdate),
  })
  const connect = await connectSyncAccount(planningCenter, {
    organizationId,
    personId: 'sync',
    administrator: true,
  })
  expect(connect.session.status).toBe(204)
  const churchId = pcoChurchId(organizationId)
  await seedChurch({
    churchId,
    people: [
      { personId: 'ada', name: 'Ada Brandt', role: 'admin' },
      { personId: 'gil', name: 'Gil Sato', role: 'admin' },
    ],
    channels: [],
  })
  await runScheduled()
  for (const personId of EVERYONE) {
    expect((await registerDevice(churchId, personId, tokenOf(personId))).status).toBe(204)
  }
  return { planningCenter, services, people, churchId }
}

/** The Planning Center People calls made so far. */
function peopleCalls() {
  return network
    .calls()
    .filter((call) => call.url.startsWith(`${PLANNING_CENTER}/people/v2/people/`))
}

async function statusOf(response: Response) {
  return { status: response.status, body: await response.json() }
}

describe('a birthdate a person enters that makes them 13 to 17', () => {
  it("applies at once and is written to their Planning Center profile with the sync account's token", async () => {
    const { planningCenter, people, churchId } = await syncedChurch()
    const birthdate = birthdateFor(15)

    const response = await enterBirthdate(churchId, 'ned', birthdate)

    expect(await statusOf(response)).toEqual({
      status: 200,
      body: { birthdate, pendingBirthdate: null, ageGroup: 'minor' },
    })
    const calls = peopleCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: `${PLANNING_CENTER}/people/v2/people/ned`,
      headers: {
        authorization: `Bearer ${planningCenter.accessTokenOf('sync')}`,
        'content-type': 'application/json',
        'user-agent': expect.stringMatching(/\S/),
      },
    })
    expect(JSON.parse(calls[0]?.body ?? 'null')).toEqual({
      data: { type: 'Person', id: 'ned', attributes: { birthdate } },
    })
    expect(people.writes()).toEqual([
      {
        personId: 'ned',
        birthdate,
        authorization: `Bearer ${planningCenter.accessTokenOf('sync')}`,
      },
    ])
    expect(await readBirthdate(churchId, 'ned')).toEqual({
      birthdate,
      pendingBirthdate: null,
      ageGroup: 'minor',
    })
    expect(
      (await readPeopleWithoutBirthdate(churchId, 'ada')).people.map((p) => p.personId),
    ).toEqual(['gil'])

    await runScheduled()

    expect((await readBirthdate(churchId, 'ned')).birthdate).toBe(birthdate)
    expect(
      (await readPeopleWithoutBirthdate(churchId, 'ada')).people.map((p) => p.personId),
    ).toEqual(['gil'])
  })

  it("refreshes the sync account's token first when it is about to expire, and writes with the new one", async () => {
    const { planningCenter, people, churchId } = await syncedChurch({
      codeTokenLifetime: 60,
      refreshTokenLifetime: 60,
    })
    const before = planningCenter.accessTokenOf('sync')

    expect((await enterBirthdate(churchId, 'ned', birthdateFor(16))).status).toBe(200)

    const after = planningCenter.accessTokenOf('sync')
    expect(after).not.toBe(before)
    expect(people.writes().map((write) => write.authorization)).toEqual([`Bearer ${after}`])
  })

  it('answers 502 and stores nothing when Planning Center refuses the write', async () => {
    const { people, churchId } = await syncedChurch()
    people.refuseNext()

    expect((await enterBirthdate(churchId, 'ned', birthdateFor(15))).status).toBe(502)

    expect(people.writes()).toEqual([])
    expect(await readBirthdate(churchId, 'ned')).toEqual({
      birthdate: null,
      pendingBirthdate: null,
      ageGroup: 'minor',
    })
    expect(
      (await readPeopleWithoutBirthdate(churchId, 'ada')).people.map((p) => p.personId),
    ).toEqual(['gil', 'ned'])
  })

  it('answers 503 and stores nothing in a church with no sync connection', async () => {
    const { churchId } = await seedChurch({
      people: [{ personId: 'ned', name: 'Ned Achebe', birthdate: null }],
      channels: [],
    })

    expect((await enterBirthdate(churchId, 'ned', birthdateFor(15))).status).toBe(503)

    expect((await readBirthdate(churchId, 'ned')).birthdate).toBeNull()
    expect(peopleCalls()).toEqual([])
  })

  it('answers 409 to a person who already has a birthdate on file, and writes nothing', async () => {
    const { people, churchId } = await syncedChurch()
    expect((await enterBirthdate(churchId, 'ned', birthdateFor(15))).status).toBe(200)

    expect((await enterBirthdate(churchId, 'ned', birthdateFor(16))).status).toBe(409)
    expect((await enterBirthdate(churchId, 'pia', birthdateFor(17))).status).toBe(409)

    expect(people.writes()).toHaveLength(1)
    expect((await readBirthdate(churchId, 'ned')).birthdate).toBe(birthdateFor(15))
  })

  it.each([
    ['a day that does not exist', '2010-02-30'],
    ['a date in the future', birthdateFor(0, 1)],
    ['a date before 1900', '1899-12-31'],
    ['a date not written YYYY-MM-DD', '2010-2-3'],
    ['a number', 20100203],
    ['nothing', undefined],
  ])('answers 400 to %s, and writes nothing', async (_label, value) => {
    const { churchId } = await syncedChurch()

    expect((await enterBirthdate(churchId, 'ned', value)).status).toBe(400)

    expect(peopleCalls()).toEqual([])
    expect((await readBirthdate(churchId, 'ned')).birthdate).toBeNull()
  })

  it('answers 400 to a body that is not a JSON object, 404 to a person Phon does not know, 405 to a POST and 401 to no one', async () => {
    const { churchId } = await syncedChurch()

    const notJson = await asMember(churchId, 'ned', '/me/birthdate', {
      method: 'PUT',
      body: 'birthdate',
    })
    expect(notJson.status).toBe(400)
    expect((await enterBirthdate(churchId, 'stranger', birthdateFor(15))).status).toBe(404)
    expect((await asMember(churchId, 'ned', '/me/birthdate', { method: 'POST' })).status).toBe(405)
    const anonymous = await exports.default.fetch('https://phon.test/me/birthdate', {
      method: 'PUT',
      body: JSON.stringify({ birthdate: birthdateFor(15) }),
    })
    expect(anonymous.status).toBe(401)
    expect(peopleCalls()).toEqual([])
  })
})

describe('a birthdate a person enters that makes them under 13', () => {
  it('is written to Planning Center and takes the person out of Phon, live socket included', async () => {
    const { people, churchId } = await syncedChurch()
    const socket = await openSocket(churchId, 'ned', 'team-31')
    const birthdate = birthdateFor(10)

    const response = await enterBirthdate(churchId, 'ned', birthdate)

    expect(await statusOf(response)).toEqual({
      status: 200,
      body: { birthdate, pendingBirthdate: null, ageGroup: 'under-13' },
    })
    expect(people.writes().map((write) => [write.personId, write.birthdate])).toEqual([
      ['ned', birthdate],
    ])
    expect(await socket.closed()).toEqual({ code: 4403, reason: 'No longer a member' })
    expect((await asMember(churchId, 'ned', '/me')).status).toBe(404)
    expect((await asMember(churchId, 'ned', '/channels/general/messages')).status).toBe(404)

    await runScheduled()

    expect((await asMember(churchId, 'ned', '/me')).status).toBe(404)
  })

  it('leaves each small group as it was for its adults: a minor never counted toward its three', async () => {
    const { churchId } = await syncedChurch()
    await seedChurch({
      churchId,
      people: [],
      channels: [
        {
          channelId: 'tuesday',
          name: 'Tuesday group',
          kind: 'small-group',
          members: ['ned', 'pia', 'max', 'lou'],
        },
        {
          channelId: 'thursday',
          name: 'Thursday group',
          kind: 'small-group',
          members: ['ned', 'pia', 'max'],
        },
      ],
    })
    const thursday = async () =>
      Promise.all(
        ['pia', 'max'].map(
          async (personId) =>
            (await asMember(churchId, personId, '/channels/thursday/messages')).status,
        ),
      )
    expect(await thursday()).toEqual([404, 404])
    const sockets = []
    for (const personId of ['pia', 'max', 'lou']) {
      sockets.push(await openSocket(churchId, personId, 'tuesday'))
    }

    expect((await enterBirthdate(churchId, 'ned', birthdateFor(10))).status).toBe(200)

    expect(await thursday()).toEqual([404, 404])
    sockets[0]?.send({ type: 'send', body: 'Still on for Tuesday' })
    for (const socket of sockets) {
      expect(await socket.nextFrame()).toMatchObject({
        type: 'message',
        message: { authorId: 'pia', body: 'Still on for Tuesday' },
      })
    }
    for (const socket of sockets) socket.close()
  })
})

describe('a birthdate a person enters that makes them 18 or older', () => {
  it("stays pending, alerts the admins and the person's team leaders, and is written only after an admin approves it", async () => {
    const expo = fakeExpoPush()
    const { planningCenter, people, churchId } = await syncedChurch()
    const birthdate = birthdateFor(30)

    const response = await enterBirthdate(churchId, 'ned', birthdate)

    expect(await statusOf(response)).toEqual({
      status: 200,
      body: { birthdate: null, pendingBirthdate: birthdate, ageGroup: 'minor' },
    })
    const payload = (to: string) => ({
      to,
      title: 'Birthdate to approve',
      body: 'Ned Achebe entered a birthdate that makes them 18 or older. An admin approves it in Phon.',
      data: { birthdateRequestFor: 'ned' },
      sound: 'default',
      priority: 'high',
      interruptionLevel: 'active',
      channelId: 'messages',
      badge: 0,
    })
    expect(expo.pushes()).toEqual([
      payload(tokenOf('ada')),
      payload(tokenOf('gil')),
      payload(tokenOf('lou')),
    ])
    expect(peopleCalls()).toEqual([])
    expect(await readBirthdateRequests(churchId, 'ada')).toEqual({
      requests: [
        { personId: 'ned', name: 'Ned Achebe', birthdate, requestedAt: expect.any(String) },
      ],
    })
    expect(await readBirthdate(churchId, 'ned')).toEqual({
      birthdate: null,
      pendingBirthdate: birthdate,
      ageGroup: 'minor',
    })

    expect((await approveBirthdate(churchId, 'gil', 'ned')).status).toBe(204)

    expect(people.writes()).toEqual([
      {
        personId: 'ned',
        birthdate,
        authorization: `Bearer ${planningCenter.accessTokenOf('sync')}`,
      },
    ])
    expect(await readBirthdate(churchId, 'ned')).toEqual({
      birthdate,
      pendingBirthdate: null,
      ageGroup: 'adult',
    })
    expect(await readBirthdateRequests(churchId, 'ada')).toEqual({ requests: [] })
  })

  it('lifts the youth rule once an admin approves it, and not while it is pending', async () => {
    fakeExpoPush()
    const { churchId } = await syncedChurch()
    const general = async () => ({
      listed: (await listChannels(churchId, 'ned')).channels.some((c) => c.id === 'general'),
      history: (await asMember(churchId, 'ned', '/channels/general/messages')).status,
    })
    expect(await general()).toEqual({ listed: false, history: 404 })

    expect((await enterBirthdate(churchId, 'ned', birthdateFor(30))).status).toBe(200)
    expect(await general()).toEqual({ listed: false, history: 404 })

    expect((await approveBirthdate(churchId, 'ada', 'ned')).status).toBe(204)

    expect(await general()).toEqual({ listed: true, history: 200 })
    expect((await postMessage(churchId, 'ned', 'general', 'Glad to be here')).body).toBe(
      'Glad to be here',
    )
  })

  it("alerts no device the registry now lists for another church, though this church's row of it is left", async () => {
    const expo = fakeExpoPush()
    const { churchId } = await syncedChurch()
    const other = await seedChurch({
      people: [{ personId: 'ada', name: 'Ada Brandt' }],
      channels: [],
    })
    expect((await registerDevice(other.churchId, 'ada', tokenOf('ada'))).status).toBe(204)

    expect((await enterBirthdate(churchId, 'ned', birthdateFor(30))).status).toBe(200)

    expect(expo.pushes().map((push) => push.to)).toEqual([tokenOf('gil'), tokenOf('lou')])
  })

  it('lists the requests oldest first', async () => {
    fakeExpoPush()
    const { churchId } = await syncedChurch()
    expect((await enterBirthdate(churchId, 'ned', birthdateFor(30))).status).toBe(200)
    expect((await enterBirthdate(churchId, 'gil', birthdateFor(40))).status).toBe(200)

    const { requests } = await readBirthdateRequests(churchId, 'ada')

    expect(requests.map((request) => [request.personId, request.birthdate])).toEqual([
      ['ned', birthdateFor(30)],
      ['gil', birthdateFor(40)],
    ])
  })

  it('refuses a member, a chat admin and a team leader with 403 on the list, the approval and the decline', async () => {
    fakeExpoPush()
    const { people, churchId } = await syncedChurch()
    expect((await enterBirthdate(churchId, 'ned', birthdateFor(30))).status).toBe(200)
    expect((await setRole(churchId, 'ada', 'max', 'chat-admin')).status).toBe(204)

    for (const personId of ['pia', 'max', 'lou']) {
      expect((await asMember(churchId, personId, '/birthdate-requests')).status, personId).toBe(403)
      expect((await approveBirthdate(churchId, personId, 'ned')).status, personId).toBe(403)
      expect((await declineBirthdate(churchId, personId, 'ned')).status, personId).toBe(403)
    }

    expect(people.writes()).toEqual([])
    expect((await readBirthdate(churchId, 'ned')).pendingBirthdate).toBe(birthdateFor(30))
  })

  it('refuses an admin approving their own birthdate, and lets another admin approve it', async () => {
    const expo = fakeExpoPush()
    const { people, churchId } = await syncedChurch()

    expect((await enterBirthdate(churchId, 'gil', birthdateFor(40))).status).toBe(200)

    expect(expo.pushes().map((push) => push.to)).toEqual([tokenOf('ada'), tokenOf('kai')])
    expect((await approveBirthdate(churchId, 'gil', 'gil')).status).toBe(403)
    expect((await declineBirthdate(churchId, 'gil', 'gil')).status).toBe(403)
    expect(people.writes()).toEqual([])
    expect((await approveBirthdate(churchId, 'ada', 'gil')).status).toBe(204)
    expect((await readBirthdate(churchId, 'gil')).ageGroup).toBe('adult')
  })

  it('is cleared by a decline, with nothing written', async () => {
    fakeExpoPush()
    const { churchId } = await syncedChurch()
    expect((await enterBirthdate(churchId, 'ned', birthdateFor(30))).status).toBe(200)

    expect((await declineBirthdate(churchId, 'ada', 'ned')).status).toBe(204)

    expect(await readBirthdateRequests(churchId, 'ada')).toEqual({ requests: [] })
    expect(await readBirthdate(churchId, 'ned')).toEqual({
      birthdate: null,
      pendingBirthdate: null,
      ageGroup: 'minor',
    })
    expect(peopleCalls()).toEqual([])
    expect((await declineBirthdate(churchId, 'ada', 'ned')).status).toBe(404)
    expect((await approveBirthdate(churchId, 'ada', 'ned')).status).toBe(404)
  })

  it('alerts no one again for the same birthdate, and again for a different one, which replaces it', async () => {
    const expo = fakeExpoPush()
    const { churchId } = await syncedChurch()
    expect((await enterBirthdate(churchId, 'ned', birthdateFor(30))).status).toBe(200)
    expect(expo.pushes()).toHaveLength(3)

    expect((await enterBirthdate(churchId, 'ned', birthdateFor(30))).status).toBe(200)
    expect(expo.pushes()).toHaveLength(3)

    expect((await enterBirthdate(churchId, 'ned', birthdateFor(31))).status).toBe(200)
    expect(expo.pushes()).toHaveLength(6)
    expect((await readBirthdateRequests(churchId, 'ada')).requests).toMatchObject([
      { personId: 'ned', birthdate: birthdateFor(31) },
    ])
  })

  it('is cleared by a 13 to 17 birthdate entered while it waits, which applies at once', async () => {
    fakeExpoPush()
    const { people, churchId } = await syncedChurch()
    expect((await enterBirthdate(churchId, 'ned', birthdateFor(30))).status).toBe(200)

    expect((await enterBirthdate(churchId, 'ned', birthdateFor(17))).status).toBe(200)

    expect(people.writes().map((write) => write.birthdate)).toEqual([birthdateFor(17)])
    expect(await readBirthdateRequests(churchId, 'ada')).toEqual({ requests: [] })
  })

  it('answers 502 to an approval Planning Center refuses, and keeps the request', async () => {
    fakeExpoPush()
    const { people, churchId } = await syncedChurch()
    expect((await enterBirthdate(churchId, 'ned', birthdateFor(30))).status).toBe(200)
    people.refuseNext()

    expect((await approveBirthdate(churchId, 'ada', 'ned')).status).toBe(502)

    expect(people.writes()).toEqual([])
    expect((await readBirthdate(churchId, 'ned')).pendingBirthdate).toBe(birthdateFor(30))
    expect((await readBirthdateRequests(churchId, 'ada')).requests).toHaveLength(1)
  })

  it('is dropped by the next sync once Planning Center has a birthdate for the person', async () => {
    fakeExpoPush()
    const { services, churchId } = await syncedChurch()
    expect((await enterBirthdate(churchId, 'ned', birthdateFor(30))).status).toBe(200)

    services.setBirthdate('ned', birthdateFor(33))
    await runScheduled()

    expect(await readBirthdateRequests(churchId, 'ada')).toEqual({ requests: [] })
    expect(await readBirthdate(churchId, 'ned')).toEqual({
      birthdate: birthdateFor(33),
      pendingBirthdate: null,
      ageGroup: 'adult',
    })
  })

  it('still waits for approval when the alert cannot reach Expo', async () => {
    network.stub('POST', EXPO_PUSH_ENDPOINT, () => new Response('down', { status: 503 }))
    const { churchId } = await syncedChurch()

    expect((await enterBirthdate(churchId, 'ned', birthdateFor(30))).status).toBe(200)

    expect((await readBirthdateRequests(churchId, 'ada')).requests).toHaveLength(1)
  })

  it('answers 405 to the wrong methods, and 401 to no one', async () => {
    const { churchId } = await syncedChurch()

    expect(
      (await asMember(churchId, 'ada', '/birthdate-requests', { method: 'POST' })).status,
    ).toBe(405)
    expect(
      (await asMember(churchId, 'ada', '/birthdate-requests/ned/approval', { method: 'GET' }))
        .status,
    ).toBe(405)
    expect(
      (await asMember(churchId, 'ada', '/birthdate-requests/ned', { method: 'GET' })).status,
    ).toBe(405)
    for (const [method, path] of [
      ['GET', '/birthdate-requests'],
      ['POST', '/birthdate-requests/ned/approval'],
      ['DELETE', '/birthdate-requests/ned'],
    ] as const) {
      const response = await exports.default.fetch(`https://phon.test${path}`, { method })
      expect(response.status, path).toBe(401)
    }
  })
})
