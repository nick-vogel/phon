import { describe, expect, it } from 'vitest'
import { asMember, openSocket, readHistory, seedChurch, testIdentity } from './support/church.ts'
import { fetchDeployed } from './support/deployed.ts'
import { fakeKlipy, klipyCalls } from './support/klipy.ts'

describe('the deployed Worker and the seeded test identities', () => {
  it.each([
    ['history', '/channels/sunday-team/messages', {}],
    ['socket', '/channels/sunday-team/socket', { upgrade: 'websocket' }],
    ['who-am-I', '/me', {}],
    ['channel list', '/channels', {}],
    ['people', '/people', {}],
    ['members', '/channels/staff/members', {}],
    ['oversight log', '/oversight', {}],
    ['oversight notice', '/me/oversight-notice', {}],
    ['quiet hours', '/me/quiet-hours', {}],
    ['alert level', '/channels/sunday-team/alerts', {}],
    ['channel people', '/channels/sunday-team/people', {}],
    ['birthdate', '/me/birthdate', {}],
    ['birthdate requests', '/birthdate-requests', {}],
    ['people without a birthdate', '/people/without-birthdate', {}],
    ['GIF search', '/gifs?q=hi', {}],
  ])('refuses a test identity on the %s route', async (_label, path, headers) => {
    fakeKlipy()
    const { churchId } = await seedChurch({
      people: [
        { personId: 'ana', name: 'Ana Ortiz', role: 'admin' },
        { personId: 'ben', name: 'Ben Okafor' },
        { personId: 'cy', name: 'Cy Park' },
      ],
      channels: [
        { channelId: 'sunday-team', name: 'Sunday team', kind: 'open' },
        { channelId: 'staff', name: 'Staff', kind: 'private', members: ['ana', 'ben', 'cy'] },
      ],
    })
    // The test entry accepts the identity, so the refusal below is the deployed entry's own.
    const viaTestEntry = await asMember(churchId, 'ana', path, { headers })
    expect(viaTestEntry.status).toBe(path.endsWith('socket') ? 101 : 200)
    viaTestEntry.webSocket?.accept()
    viaTestEntry.webSocket?.close(1000, 'test done')
    const klipyCallsBefore = klipyCalls().length

    const response = await fetchDeployed(path, {
      headers: { ...headers, authorization: testIdentity(churchId, 'ana') },
    })

    expect(response.status).toBe(401)
    expect(klipyCalls()).toHaveLength(klipyCallsBefore)
  })

  it.each([
    ['create a channel', 'POST', '/channels', { name: 'Coffee', kind: 'open' }],
    ['set a role', 'PUT', '/people/ben/role', { role: 'admin' }],
    ["end a person's sessions", 'POST', '/people/ben/sign-out', {}],
    ['set members', 'PUT', '/channels/staff/members', { personIds: ['ana', 'ben', 'cy'] }],
    ['acknowledge the oversight notice', 'PUT', '/me/oversight-notice', {}],
    ['register a device', 'POST', '/devices', { token: 'ExponentPushToken[ana]' }],
    ['enter a birthdate', 'PUT', '/me/birthdate', { birthdate: '2000-01-01' }],
    ['approve a birthdate', 'POST', '/birthdate-requests/ben/approval', {}],
    ['decline a birthdate', 'DELETE', '/birthdate-requests/ben', {}],
    ['set an alert level', 'PUT', '/channels/staff/alerts', { level: 'off' }],
    ['mark a channel read', 'PUT', '/channels/staff/read', { messageId: 'any' }],
    [
      'set quiet hours',
      'PUT',
      '/me/quiet-hours',
      { quietHours: { start: '22:00', end: '07:00', timeZone: 'Etc/GMT' } },
    ],
  ])('refuses a test identity that tries to %s', async (_label, method, path, body) => {
    const { churchId } = await seedChurch({
      people: [
        { personId: 'ana', name: 'Ana Ortiz', role: 'admin' },
        { personId: 'ben', name: 'Ben Okafor' },
        { personId: 'cy', name: 'Cy Park' },
      ],
      channels: [
        { channelId: 'staff', name: 'Staff', kind: 'private', members: ['ana', 'ben', 'cy'] },
      ],
    })

    const response = await fetchDeployed(path, {
      method,
      headers: { 'content-type': 'application/json', authorization: testIdentity(churchId, 'ana') },
      body: JSON.stringify(body),
    })

    expect(response.status).toBe(401)
    const people = await asMember(churchId, 'ana', '/people')
    expect(await people.json()).toEqual({
      people: [
        { personId: 'ana', name: 'Ana Ortiz', role: 'admin' },
        { personId: 'ben', name: 'Ben Okafor', role: 'member' },
        { personId: 'cy', name: 'Cy Park', role: 'member' },
      ],
    })
  })

  it('refuses a test identity that tries to delete a message, and keeps it', async () => {
    const { churchId } = await seedChurch({
      people: [{ personId: 'ana', name: 'Ana Ortiz', role: 'admin' }],
      channels: [{ channelId: 'sunday-team', name: 'Sunday team', kind: 'open' }],
    })
    const socket = await openSocket(churchId, 'ana', 'sunday-team')
    socket.send({ type: 'send', body: 'Keep me' })
    const frame = await socket.nextFrame()
    socket.close()
    const messageId = frame.type === 'message' ? frame.message.id : ''

    const response = await fetchDeployed(`/channels/sunday-team/messages/${messageId}`, {
      method: 'DELETE',
      headers: { authorization: testIdentity(churchId, 'ana') },
    })

    expect(response.status).toBe(401)
    expect((await readHistory(churchId, 'ana', 'sunday-team')).messages).toMatchObject([
      { id: messageId, body: 'Keep me' },
    ])
    expect((await readHistory(churchId, 'ana', 'sunday-team')).messages[0]?.deleted).toBeUndefined()
  })

  it('has no seed route, and a seed sent to it creates nothing', async () => {
    const churchId = `church-${crypto.randomUUID()}`
    const response = await fetchDeployed('/__test/seed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        churchId,
        people: [{ personId: 'ana', name: 'Ana Ortiz' }],
        channels: [{ channelId: 'sunday-team', name: 'Sunday team', kind: 'open' }],
      }),
    })

    expect(response.status).toBe(404)
    await expect(readHistory(churchId, 'ana', 'sunday-team')).rejects.toThrow('answered 404')
  })
})
