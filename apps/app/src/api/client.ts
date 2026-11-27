import type {
  AlertLevel,
  BirthdateRequestList,
  BirthdateStatus,
  ChannelAlerts,
  ChannelHistory,
  ChannelList,
  ChannelPeople,
  ChannelSummary,
  CreateChannelRequest,
  GifSearchResults,
  GroupTypeList,
  ImagePosted,
  Member,
  OversightLog,
  OversightNotice,
  PeopleList,
  PeopleWithoutBirthdate,
  QuietHours,
  QuietHoursSetting,
  ReadMarkerRequest,
  RegisterDeviceRequest,
  ReportList,
  Role,
  SetAlertLevelRequest,
  SetBirthdateRequest,
  SetGroupTypeSyncRequest,
  SetRoleRequest,
  SignInRequest,
  SignOutRequest,
} from '@phon/api-types'
import { fetch as expoFetch } from 'expo/fetch'
import { File } from 'expo-file-system'
import { apiOrigin } from './config'
import { imagePart } from './image-part'
import { authorizationHeader, bearerToken, clearSession, subscribeSession } from './session'

/**
 * What went wrong with a server call, as the server said it. The app shows it and decides nothing
 * from it: a 401 is "not signed in", a 403 "not allowed", a 404 "not found", a 400 "invalid", a
 * 409 "conflict", a 413 "too large", a 415 "unsupported", and anything else is "unavailable".
 */
export type ServerProblem =
  | 'not-signed-in'
  | 'not-allowed'
  | 'not-found'
  | 'invalid'
  | 'conflict'
  | 'too-large'
  | 'unsupported'
  | 'unavailable'

export class ServerError extends Error {
  constructor(
    readonly problem: ServerProblem,
    message: string,
  ) {
    super(message)
    this.name = 'ServerError'
  }
}

/** The problem for each status the server refuses with. */
const REFUSALS: Record<number, ServerProblem> = {
  400: 'invalid',
  403: 'not-allowed',
  404: 'not-found',
  409: 'conflict',
  413: 'too-large',
  415: 'unsupported',
}

/**
 * One authenticated call. A 401 clears the session; any other refusal becomes a `ServerError`.
 * Answers the response, for the caller to read.
 */
async function call(path: string, init: { method: string; body?: unknown }): Promise<Response> {
  const token = bearerToken()
  let response: Response
  try {
    response = await fetch(`${apiOrigin()}${path}`, {
      method: init.method,
      headers:
        init.body === undefined
          ? authorizationHeader()
          : { ...authorizationHeader(), 'Content-Type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  } catch (error) {
    throw new ServerError('unavailable', `${path} could not be reached: ${String(error)}`)
  }
  return checked(path, token, response)
}

/** A response the server answered, once checked: a 401 clears the session as `call` says. */
function checked<R extends { status: number; ok: boolean }>(
  path: string,
  token: string | null,
  response: R,
): R {
  if (response.status === 401) {
    // The server no longer takes this session, so the app shows sign-in again.
    if (token !== null) void clearSession(token)
    throw new ServerError('not-signed-in', `${path} answered 401`)
  }
  const refusal = REFUSALS[response.status]
  if (refusal !== undefined) throw new ServerError(refusal, `${path} answered ${response.status}`)
  if (!response.ok) throw new ServerError('unavailable', `${path} answered ${response.status}`)
  return response
}

async function get<T>(path: string): Promise<T> {
  return (await (await call(path, { method: 'GET' })).json()) as T
}

let me: Promise<Member> | null = null

// A new session is a new member, so the cached one goes whenever the session changes.
subscribeSession(() => {
  me = null
})

/** Forgets the loaded member, so the next `getMe()` asks the server again, after a role change. */
export function forgetMe(): void {
  me = null
}

/** The signed-in member, loaded once and kept for the session. A failed load is not kept. */
export function getMe(): Promise<Member> {
  if (me === null) {
    const loading = get<Member>('/me')
    me = loading
    loading.catch(() => {
      if (me === loading) me = null
    })
  }
  return me
}

/** The channels the server says the signed-in member may open, in the server's order. */
export function getChannels(): Promise<ChannelList> {
  return get<ChannelList>('/channels')
}

const channelListeners = new Set<() => void>()

/**
 * Listens for a change to the signed-in member's channels that the app learned of, such as a
 * channel they created or read, so the channel bar can load them again. Answers the unsubscribe.
 */
export function subscribeChannelsChanged(listener: () => void): () => void {
  channelListeners.add(listener)
  return () => {
    channelListeners.delete(listener)
  }
}

/**
 * Tells the channel bar of a change to the signed-in member's channels that the app learned of,
 * such as a channel created here, a read marker the server took, or a channel the server took
 * them out of.
 */
export function channelsChanged(): void {
  for (const listener of channelListeners) listener()
}

/** Every person of the church with their role, for an admin. */
export function getPeople(): Promise<PeopleList> {
  return get<PeopleList>('/people')
}

/** Sets a person's role, as an admin. A refusal comes back as a `ServerError`. */
export async function setRole(personId: string, role: Role): Promise<void> {
  await call(`/people/${encodeURIComponent(personId)}/role`, {
    method: 'PUT',
    body: { role } satisfies SetRoleRequest,
  })
  forgetMe()
}

/**
 * Signs a person out on every phone, as an admin: the server ends all their sessions and stops
 * their phones' alerts. A refusal comes back as a `ServerError`.
 */
export async function endSessions(personId: string): Promise<void> {
  await call(`/people/${encodeURIComponent(personId)}/sign-out`, { method: 'POST' })
}

/** The church's Planning Center Group types and whether each one syncs, for an admin. */
export function getGroupTypes(): Promise<GroupTypeList> {
  return get<GroupTypeList>('/group-types')
}

/**
 * Turns a Group type's sync on or off, as an admin. The server applies it at its next roster sync.
 * A refusal comes back as a `ServerError`.
 */
export async function setGroupTypeSync(groupTypeId: string, enabled: boolean): Promise<void> {
  await call(`/group-types/${encodeURIComponent(groupTypeId)}/sync`, {
    method: 'PUT',
    body: { enabled } satisfies SetGroupTypeSyncRequest,
  })
}

/** Creates a channel, and tells the channel bar. Answers the new channel as the server made it. */
export async function createChannel(request: CreateChannelRequest): Promise<ChannelSummary> {
  const response = await call('/channels', { method: 'POST', body: request })
  const created = (await response.json()) as ChannelSummary
  channelsChanged()
  return created
}

/** A channel's history, oldest message first. */
export function getHistory(channelId: string): Promise<ChannelHistory> {
  return get<ChannelHistory>(`/channels/${encodeURIComponent(channelId)}/messages`)
}

/**
 * Deletes one of the signed-in person's own messages. Nothing changes on screen here: the channel's
 * socket tells every open screen, this one included, once the server has deleted it.
 */
export async function deleteMessage(channelId: string, messageId: string): Promise<void> {
  await call(messagePath(channelId, messageId), { method: 'DELETE' })
}

/** The path of one message, or of a moderation action on it. */
function messagePath(channelId: string, messageId: string, action?: string): string {
  const path = `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`
  return action === undefined ? path : `${path}/${action}`
}

/**
 * Removes a message, as an admin or chat admin. Nothing changes on screen here: the channel's
 * socket tells every open screen once the server has removed it.
 */
export async function removeMessage(channelId: string, messageId: string): Promise<void> {
  await call(messagePath(channelId, messageId, 'remove'), { method: 'POST' })
}

/**
 * Pins a message, as an admin or chat admin. The channel's socket sends the pinned message to every
 * open screen.
 */
export async function pinMessage(channelId: string, messageId: string): Promise<void> {
  await call(messagePath(channelId, messageId, 'pin'), { method: 'PUT' })
}

/** Unpins a message, as an admin or chat admin. The channel's socket sends it to every screen. */
export async function unpinMessage(channelId: string, messageId: string): Promise<void> {
  await call(messagePath(channelId, messageId, 'pin'), { method: 'DELETE' })
}

/**
 * Reports a message to the church's admins and chat admins. A refusal comes back as a
 * `ServerError`.
 */
export async function reportMessage(channelId: string, messageId: string): Promise<void> {
  await call(messagePath(channelId, messageId, 'reports'), { method: 'POST' })
}

/** The open reports the signed-in admin or chat admin may see, newest first. */
export function getReports(): Promise<ReportList> {
  return get<ReportList>('/reports')
}

/** Closes an open report, as an admin or chat admin. A refusal comes back as a `ServerError`. */
export async function closeReport(reportId: string): Promise<void> {
  await call(`/reports/${encodeURIComponent(reportId)}/close`, { method: 'POST' })
}

/**
 * Posts an image the person picked, with its caption, as one message, marked a team announcement
 * or urgent when asked; the server decides whether either is allowed. Nothing changes on screen
 * here: the message shows when the server's `message` frame for it arrives. The file goes as a
 * `multipart/form-data` part through `expo/fetch`, typed by its bytes rather than its extension.
 */
export async function postImage(
  channelId: string,
  image: { uri: string; mimeType?: string },
  caption: string,
  { teamAnnouncement, urgent }: { teamAnnouncement: boolean; urgent: boolean },
): Promise<ImagePosted> {
  const path = `/channels/${encodeURIComponent(channelId)}/images`
  const token = bearerToken()
  const form = new FormData()
  form.append('image', await imagePart(new File(image.uri)))
  if (caption !== '') form.append('body', caption)
  if (teamAnnouncement) form.append('teamAnnouncement', 'true')
  if (urgent) form.append('urgent', 'true')
  let response: Awaited<ReturnType<typeof expoFetch>>
  try {
    response = await expoFetch(`${apiOrigin()}${path}`, {
      method: 'POST',
      headers: authorizationHeader(),
      body: form,
    })
  } catch (error) {
    throw new ServerError('unavailable', `${path} could not be reached: ${String(error)}`)
  }
  return (await checked(path, token, response).json()) as ImagePosted
}

/**
 * One page of a GIF search, `page` counted from 1. The server searches KLIPY with its own key and
 * decides what is sent; the app shows the answer.
 */
export function searchGifs(q: string, page: number): Promise<GifSearchResults> {
  return get(`/gifs?q=${encodeURIComponent(q)}&page=${page}`)
}

/** The URL of a posted image. It needs the same `Authorization` header as every call. */
export function imageUrl(channelId: string, imageId: string): string {
  return `${apiOrigin()}/channels/${encodeURIComponent(channelId)}/images/${encodeURIComponent(imageId)}`
}

/** Registers this device's Expo push token for the signed-in person's alerts. */
export async function registerDevice(token: string): Promise<void> {
  await call('/devices', { method: 'POST', body: { token } satisfies RegisterDeviceRequest })
}

/** The signed-in person's alert level for a channel, and the levels the server lets them pick. */
export function getChannelAlerts(channelId: string): Promise<ChannelAlerts> {
  return get<ChannelAlerts>(`/channels/${encodeURIComponent(channelId)}/alerts`)
}

/** Sets the signed-in person's alert level for a channel. A refusal comes back as a `ServerError`. */
export async function setChannelAlertLevel(channelId: string, level: AlertLevel): Promise<void> {
  await call(`/channels/${encodeURIComponent(channelId)}/alerts`, {
    method: 'PUT',
    body: { level } satisfies SetAlertLevelRequest,
  })
}

/**
 * Moves the signed-in person's read marker in a channel to a message they have seen. The server
 * keeps the marker only moving forward. A refusal comes back as a `ServerError`.
 */
export async function markRead(channelId: string, messageId: string): Promise<void> {
  await call(`/channels/${encodeURIComponent(channelId)}/read`, {
    method: 'PUT',
    body: { messageId } satisfies ReadMarkerRequest,
  })
}

/** The people who may be @mentioned in a channel, sorted by name. */
export function getChannelPeople(channelId: string): Promise<ChannelPeople> {
  return get<ChannelPeople>(`/channels/${encodeURIComponent(channelId)}/people`)
}

/** Every time an admin opened a private channel they are not in, newest first, for an admin. */
export function getOversightLog(): Promise<OversightLog> {
  return get<OversightLog>('/oversight')
}

/** Whether the signed-in person has seen the oversight notice. */
export function getOversightNotice(): Promise<OversightNotice> {
  return get<OversightNotice>('/me/oversight-notice')
}

/** Records that the signed-in person saw the oversight notice. */
export async function acknowledgeOversightNotice(): Promise<void> {
  await call('/me/oversight-notice', { method: 'PUT' })
}

/** The signed-in person's quiet hours, or null for none. */
export function getQuietHours(): Promise<QuietHoursSetting> {
  return get<QuietHoursSetting>('/me/quiet-hours')
}

/**
 * Sets the signed-in person's quiet hours, or clears them with null. A refusal comes back as a
 * `ServerError`.
 */
export async function setQuietHours(quietHours: QuietHours | null): Promise<void> {
  await call('/me/quiet-hours', {
    method: 'PUT',
    body: { quietHours } satisfies QuietHoursSetting,
  })
}

/** The signed-in person's birthdate on file, any pending one, and their age group. */
export function getBirthdate(): Promise<BirthdateStatus> {
  return get<BirthdateStatus>('/me/birthdate')
}

/**
 * Enters the signed-in person's own birthdate, `YYYY-MM-DD`. Answers what the server made of it:
 * on file, waiting for an admin, or under 13. A refusal comes back as a `ServerError`.
 */
export async function setBirthdate(birthdate: string): Promise<BirthdateStatus> {
  const response = await call('/me/birthdate', {
    method: 'PUT',
    body: { birthdate } satisfies SetBirthdateRequest,
  })
  return (await response.json()) as BirthdateStatus
}

/** Every birthdate waiting for an admin's approval, oldest first, for an admin. */
export function getBirthdateRequests(): Promise<BirthdateRequestList> {
  return get<BirthdateRequestList>('/birthdate-requests')
}

/** Approves a person's pending birthdate, as an admin. A refusal comes back as a `ServerError`. */
export async function approveBirthdate(personId: string): Promise<void> {
  await call(`/birthdate-requests/${encodeURIComponent(personId)}/approval`, { method: 'POST' })
}

/** Declines a person's pending birthdate, as an admin. A refusal comes back as a `ServerError`. */
export async function declineBirthdate(personId: string): Promise<void> {
  await call(`/birthdate-requests/${encodeURIComponent(personId)}`, { method: 'DELETE' })
}

/** Every person of the church with no birthdate on file, sorted by name, for an admin. */
export function getPeopleWithoutBirthdate(): Promise<PeopleWithoutBirthdate> {
  return get<PeopleWithoutBirthdate>('/people/without-birthdate')
}

/**
 * Signs out on this phone: asks the server to end this session and, given this phone's Expo push
 * token, to stop alerting it, then forgets the session whatever the server answered or whether it
 * was reached at all, so a phone offline still signs out here. A session the server never heard
 * from ends at its lifetime, or when an admin ends it, and its phone's alerts end with it once the
 * person holds no other session.
 */
export async function signOut(deviceToken: string | null): Promise<void> {
  const token = bearerToken()
  if (token === null) return
  try {
    await fetch(`${apiOrigin()}/me/sign-out`, {
      method: 'POST',
      headers:
        deviceToken === null
          ? authorizationHeader()
          : { ...authorizationHeader(), 'Content-Type': 'application/json' },
      ...(deviceToken === null
        ? {}
        : { body: JSON.stringify({ deviceToken } satisfies SignOutRequest) }),
    })
  } catch {
    // The server could not be reached; this phone signs out all the same.
  }
  await clearSession(token)
}

/**
 * Sends a finished Planning Center sign-in to the server: to `/auth/session` to sign in, or to
 * `/auth/connect` to connect a church. Answers the status and the JSON body as the server sent
 * them, or status 0 when the server could not be reached.
 */
export async function createSession(
  request: SignInRequest,
  path: '/auth/session' | '/auth/connect' = '/auth/session',
): Promise<{ status: number; body: unknown }> {
  try {
    const response = await fetch(`${apiOrigin()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      // A body that is not JSON says nothing more than its status.
    }
    return { status: response.status, body }
  } catch {
    return { status: 0, body: null }
  }
}
