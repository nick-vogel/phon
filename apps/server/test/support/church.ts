import { exports } from 'cloudflare:workers'
import type {
  AlertLevel,
  BirthdateRequestList,
  BirthdateStatus,
  ChannelAlerts,
  ChannelHistory,
  ChannelList,
  ChannelPeople,
  ClientFrame,
  Member,
  Message,
  OversightLog,
  OversightNotice,
  PeopleWithoutBirthdate,
  QuietHoursSetting,
  ReadMarkerRequest,
  ReportList,
  Role,
  ServerFrame,
} from '@phon/api-types'
import type { ChurchSeed } from '../../src/church-directory.ts'
import { ADULT_BIRTHDATE } from './people.ts'

const ORIGIN = 'https://phon.test'

/** The test identity header for one person in one church. Only the test entry accepts it. */
export function testIdentity(churchId: string, personId: string): string {
  return `Bearer test:${churchId}:${personId}`
}

/**
 * Seeds a church through the test entry's seed route. Each call gets a fresh church ID unless
 * the seed names one, because the WebSocket tests share storage across test files. A person whose
 * seed has no `birthdate` gets an adult's (`ADULT_BIRTHDATE`); `null` seeds none on file.
 */
export async function seedChurch(seed: Omit<ChurchSeed, 'churchId'> & { churchId?: string }) {
  const church: ChurchSeed = {
    churchId: `church-${crypto.randomUUID()}`,
    ...seed,
    people: seed.people.map((person) =>
      person.birthdate === undefined ? { ...person, birthdate: ADULT_BIRTHDATE } : person,
    ),
  }
  const response = await exports.default.fetch(`${ORIGIN}/__test/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(church),
  })
  if (response.status !== 204) {
    throw new Error(`Seeding ${church.churchId} answered ${response.status}`)
  }
  return church
}

/** A person's request to a channel route, as the given church member. */
export function asMember(churchId: string, personId: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('authorization', testIdentity(churchId, personId))
  return exports.default.fetch(`${ORIGIN}${path}`, { ...init, headers })
}

/** Reads a channel's history as a member. Fails when the route does not answer 200. */
export async function readHistory(
  churchId: string,
  personId: string,
  channelId: string,
): Promise<ChannelHistory> {
  const response = await asMember(churchId, personId, `/channels/${channelId}/messages`)
  if (response.status !== 200) {
    throw new Error(`History for ${channelId} answered ${response.status}`)
  }
  return response.json()
}

/** Reads who the server says the signed-in member is. Fails when the route does not answer 200. */
export async function readMe(churchId: string, personId: string): Promise<Member> {
  const response = await asMember(churchId, personId, '/me')
  if (response.status !== 200) throw new Error(`/me answered ${response.status}`)
  return response.json()
}

/** Lists the channels a member may open. Fails when the route does not answer 200. */
export async function listChannels(churchId: string, personId: string): Promise<ChannelList> {
  const response = await asMember(churchId, personId, '/channels')
  if (response.status !== 200) throw new Error(`/channels answered ${response.status}`)
  return response.json()
}

/** Sets a person's role as the caller, through `PUT /people/:personId/role`. */
export function setRole(churchId: string, callerId: string, personId: string, role: Role) {
  return asMember(churchId, callerId, `/people/${personId}/role`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role }),
  })
}

/** Deletes a message as the caller, through `DELETE /channels/:channelId/messages/:messageId`. */
export function deleteMessage(
  churchId: string,
  callerId: string,
  channelId: string,
  messageId: string,
) {
  return asMember(churchId, callerId, `/channels/${channelId}/messages/${messageId}`, {
    method: 'DELETE',
  })
}

/** Removes a message as a moderator, through `POST /channels/:channelId/messages/:messageId/remove`. */
export function removeMessage(
  churchId: string,
  callerId: string,
  channelId: string,
  messageId: string,
) {
  return asMember(churchId, callerId, `/channels/${channelId}/messages/${messageId}/remove`, {
    method: 'POST',
  })
}

/** Pins a message as the caller, through `PUT /channels/:channelId/messages/:messageId/pin`. */
export function pinMessage(
  churchId: string,
  callerId: string,
  channelId: string,
  messageId: string,
) {
  return asMember(churchId, callerId, `/channels/${channelId}/messages/${messageId}/pin`, {
    method: 'PUT',
  })
}

/** Unpins a message as the caller, through `DELETE /channels/:channelId/messages/:messageId/pin`. */
export function unpinMessage(
  churchId: string,
  callerId: string,
  channelId: string,
  messageId: string,
) {
  return asMember(churchId, callerId, `/channels/${channelId}/messages/${messageId}/pin`, {
    method: 'DELETE',
  })
}

/** Reports a message as the caller, through `POST /channels/:channelId/messages/:messageId/reports`. */
export function reportMessage(
  churchId: string,
  callerId: string,
  channelId: string,
  messageId: string,
) {
  return asMember(churchId, callerId, `/channels/${channelId}/messages/${messageId}/reports`, {
    method: 'POST',
  })
}

/** Reads the open reports as a moderator. Fails when the route does not answer 200. */
export async function readReports(churchId: string, personId: string): Promise<ReportList> {
  const response = await asMember(churchId, personId, '/reports')
  if (response.status !== 200) throw new Error(`/reports answered ${response.status}`)
  return response.json()
}

/** Closes a report as the caller, through `POST /reports/:reportId/close`. */
export function closeReport(churchId: string, callerId: string, reportId: string) {
  return asMember(churchId, callerId, `/reports/${reportId}/close`, { method: 'POST' })
}

/** Reads the oversight log as an admin. Fails when the route does not answer 200. */
export async function readOversightLog(churchId: string, personId: string): Promise<OversightLog> {
  const response = await asMember(churchId, personId, '/oversight')
  if (response.status !== 200) throw new Error(`/oversight answered ${response.status}`)
  return response.json()
}

/** Reads whether a person has seen the oversight notice. Fails when it does not answer 200. */
export async function readOversightNotice(
  churchId: string,
  personId: string,
): Promise<OversightNotice> {
  const response = await asMember(churchId, personId, '/me/oversight-notice')
  if (response.status !== 200) throw new Error(`/me/oversight-notice answered ${response.status}`)
  return response.json()
}

/** Records that a person saw the oversight notice, through `PUT /me/oversight-notice`. */
export function acknowledgeOversightNotice(churchId: string, personId: string) {
  return asMember(churchId, personId, '/me/oversight-notice', { method: 'PUT' })
}

/** Registers a device's Expo push token for a person, through `POST /devices`. */
export function registerDevice(churchId: string, personId: string, token: string) {
  return asMember(churchId, personId, '/devices', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
}

/** Reads a person's alert level for a channel. Fails when the route does not answer 200. */
export async function readAlerts(
  churchId: string,
  personId: string,
  channelId: string,
): Promise<ChannelAlerts> {
  const response = await asMember(churchId, personId, `/channels/${channelId}/alerts`)
  if (response.status !== 200) {
    throw new Error(`Alerts for ${channelId} answered ${response.status}`)
  }
  return response.json()
}

/** Sets a person's alert level for a channel, through `PUT /channels/:channelId/alerts`. */
export function setAlertLevel(
  churchId: string,
  personId: string,
  channelId: string,
  level: AlertLevel | string,
) {
  return asMember(churchId, personId, `/channels/${channelId}/alerts`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level }),
  })
}

/** Moves a person's read marker in a channel, through `PUT /channels/:channelId/read`. */
export function markRead(churchId: string, personId: string, channelId: string, messageId: string) {
  return asMember(churchId, personId, `/channels/${channelId}/read`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messageId } satisfies ReadMarkerRequest),
  })
}

/** Reads a person's quiet hours. Fails when the route does not answer 200. */
export async function readQuietHours(
  churchId: string,
  personId: string,
): Promise<QuietHoursSetting> {
  const response = await asMember(churchId, personId, '/me/quiet-hours')
  if (response.status !== 200) throw new Error(`/me/quiet-hours answered ${response.status}`)
  return response.json()
}

/** Sets a person's quiet hours, through `PUT /me/quiet-hours`, with any body. */
export function setQuietHours(churchId: string, personId: string, body: unknown) {
  return asMember(churchId, personId, '/me/quiet-hours', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Reads a person's own birthdate status. Fails when the route does not answer 200. */
export async function readBirthdate(churchId: string, personId: string): Promise<BirthdateStatus> {
  const response = await asMember(churchId, personId, '/me/birthdate')
  if (response.status !== 200) throw new Error(`/me/birthdate answered ${response.status}`)
  return response.json()
}

/** Enters a person's own birthdate, through `PUT /me/birthdate`, with any value. */
export function enterBirthdate(churchId: string, personId: string, birthdate: unknown) {
  return asMember(churchId, personId, '/me/birthdate', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ birthdate }),
  })
}

/** Reads the birthdates waiting for approval, as an admin. Fails unless it answers 200. */
export async function readBirthdateRequests(
  churchId: string,
  personId: string,
): Promise<BirthdateRequestList> {
  const response = await asMember(churchId, personId, '/birthdate-requests')
  if (response.status !== 200) throw new Error(`/birthdate-requests answered ${response.status}`)
  return response.json()
}

/** Approves a person's pending birthdate as the caller. */
export function approveBirthdate(churchId: string, callerId: string, personId: string) {
  return asMember(churchId, callerId, `/birthdate-requests/${personId}/approval`, {
    method: 'POST',
  })
}

/** Declines a person's pending birthdate as the caller. */
export function declineBirthdate(churchId: string, callerId: string, personId: string) {
  return asMember(churchId, callerId, `/birthdate-requests/${personId}`, { method: 'DELETE' })
}

/** Reads the people with no birthdate on file, as an admin. Fails unless it answers 200. */
export async function readPeopleWithoutBirthdate(
  churchId: string,
  personId: string,
): Promise<PeopleWithoutBirthdate> {
  const response = await asMember(churchId, personId, '/people/without-birthdate')
  if (response.status !== 200) {
    throw new Error(`/people/without-birthdate answered ${response.status}`)
  }
  return response.json()
}

/** Reads who may be @mentioned in a channel. Fails when the route does not answer 200. */
export async function readChannelPeople(
  churchId: string,
  personId: string,
  channelId: string,
): Promise<ChannelPeople> {
  const response = await asMember(churchId, personId, `/channels/${channelId}/people`)
  if (response.status !== 200) {
    throw new Error(`People of ${channelId} answered ${response.status}`)
  }
  return response.json()
}

/** A member's open socket on a channel, with the frames it has received. */
export interface MemberSocket {
  send(frame: ClientFrame): void
  /** Sends text as is, for frames a well-behaved app would never send. */
  sendRaw(text: string): void
  /** Resolves with the next frame this socket receives that it has not handed out yet. */
  nextFrame(timeoutMs?: number): Promise<ServerFrame>
  /** Every frame received so far. */
  received(): ServerFrame[]
  /** Resolves with the close code and reason once the server closes this socket. */
  closed(timeoutMs?: number): Promise<{ code: number; reason: string }>
  close(): void
}

/** Opens a channel's WebSocket as a member. Fails when the upgrade is refused. */
export async function openSocket(
  churchId: string,
  personId: string,
  channelId: string,
): Promise<MemberSocket> {
  const response = await asMember(churchId, personId, `/channels/${channelId}/socket`, {
    headers: { upgrade: 'websocket' },
  })
  return acceptSocket(response, channelId)
}

/**
 * Accepts the WebSocket of an answer to a channel's socket route, whichever entry answered it.
 * Fails when the upgrade was refused.
 */
export function acceptSocket(response: Response, channelId: string): MemberSocket {
  const socket = response.webSocket
  if (response.status !== 101 || socket === null) {
    throw new Error(`Socket for ${channelId} answered ${response.status}`)
  }
  socket.accept()

  const frames: ServerFrame[] = []
  let handedOut = 0
  const closing = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }))
  })
  const waiters: Array<() => void> = []
  socket.addEventListener('message', (event) => {
    frames.push(JSON.parse(String(event.data)) as ServerFrame)
    for (const wake of waiters.splice(0)) wake()
  })

  return {
    send(frame) {
      socket.send(JSON.stringify(frame))
    },
    sendRaw(text) {
      socket.send(text)
    },
    async nextFrame(timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      while (handedOut >= frames.length) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error(`No frame arrived within ${timeoutMs}ms`)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining)
          waiters.push(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
      const frame = frames[handedOut] as ServerFrame
      handedOut += 1
      return frame
    },
    received() {
      return [...frames]
    },
    closed(timeoutMs = 2000) {
      return Promise.race([
        closing,
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error(`The socket was not closed within ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ])
    },
    close() {
      socket.close(1000, 'test done')
    },
  }
}

/**
 * Posts one message as a person: opens their socket on the channel, sends, and waits for the
 * message to come back stored. Fails when the channel answers anything else.
 */
export async function postMessage(
  churchId: string,
  personId: string,
  channelId: string,
  body: string,
  mentions?: unknown,
): Promise<Message> {
  const socket = await openSocket(churchId, personId, channelId)
  try {
    socket.sendRaw(
      JSON.stringify(
        mentions === undefined ? { type: 'send', body } : { type: 'send', body, mentions },
      ),
    )
    const frame = await socket.nextFrame()
    if (frame.type !== 'message') {
      throw new Error(`Posting in ${channelId} answered ${JSON.stringify(frame)}`)
    }
    return frame.message
  } finally {
    socket.close()
  }
}

/**
 * Sends one raw frame as a person on a fresh socket, and answers the first frame back: the stored
 * `message`, or an `error`.
 */
export async function postFrame(
  churchId: string,
  personId: string,
  channelId: string,
  frame: Record<string, unknown>,
): Promise<ServerFrame> {
  const socket = await openSocket(churchId, personId, channelId)
  try {
    socket.sendRaw(JSON.stringify(frame))
    return await socket.nextFrame()
  } finally {
    socket.close()
  }
}

/**
 * An image to upload: its bytes, the type its part declares, an optional caption, and the send
 * options, each sent as a `true` part when set.
 */
export interface ImageUpload {
  bytes: Uint8Array
  type: string
  caption?: string
  teamAnnouncement?: boolean
  urgent?: boolean
}

/** Uploads an image as a person, through `POST /channels/:channelId/images`. */
export function postImage(
  churchId: string,
  personId: string,
  channelId: string,
  upload: ImageUpload,
) {
  const form = new FormData()
  form.set('image', new File([upload.bytes], 'photo', { type: upload.type }))
  if (upload.caption !== undefined) form.set('body', upload.caption)
  if (upload.teamAnnouncement === true) form.set('teamAnnouncement', 'true')
  if (upload.urgent === true) form.set('urgent', 'true')
  return asMember(churchId, personId, `/channels/${channelId}/images`, {
    method: 'POST',
    body: form,
  })
}

/** Fetches an image as a person, through `GET /channels/:channelId/images/:imageId`. */
export function fetchImage(churchId: string, personId: string, channelId: string, imageId: string) {
  return asMember(churchId, personId, `/channels/${channelId}/images/${imageId}`)
}

/** The first bytes of each image type `imageBytes` makes. */
const SIGNATURES = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
  'image/gif': [...'GIF89a'].map((character) => character.charCodeAt(0)),
}

/** Bytes that begin with an image type's signature, padded to a length. Not a viewable image. */
export function imageBytes(
  type: 'image/png' | 'image/jpeg' | 'image/gif',
  length = 64,
): Uint8Array {
  const signature = SIGNATURES[type]
  const bytes = new Uint8Array(length)
  bytes.set(signature)
  for (let index = signature.length; index < length; index += 1) bytes[index] = index % 251
  return bytes
}
