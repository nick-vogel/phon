import type {
  BirthdateRequestList,
  BirthdateStatus,
  ChannelAlerts,
  ChannelHistory,
  ChannelList,
  ChannelMembers,
  ChannelPeople,
  ChannelSummary,
  GroupTypeList,
  ImagePosted,
  Member,
  OversightLog,
  OversightNotice,
  PeopleList,
  PeopleWithoutBirthdate,
  QuietHoursSetting,
} from '@phon/api-types'
import { approveBirthdate, enterBirthdate, type WriteRefusal } from './birthdates.ts'
import { refuseLimitedCaller } from './caller-limits.ts'
import { channelObjectName, HOLDER_HEADERS, type PostRefusal } from './channel.ts'
import type { NewChannel, PostFlags, Refusal } from './church-directory.ts'
import { type ChurchListCache, churchListRoute } from './church-list.ts'
import { REGISTRY_NAME } from './church-registry.ts'
import { connectRoute } from './connect.ts'
import { emailSignInRoute } from './email-sign-in.ts'
import { searchGifs } from './gifs.ts'
import type { Authenticate, Identity } from './identity.ts'
import { acceptImage, type ImageRefusal, imageKey, MAX_IMAGE_BYTES } from './images.ts'
import type { Mailer } from './mailer.ts'
import { closeReport, listReports, removeMessage, reportMessage, setPin } from './moderation.ts'
import { isCreatableKind, isRole } from './permissions.ts'
import { channelList, markRead } from './read-markers.ts'
import { closeLostSockets, syncAllChurches } from './roster-sync.ts'
import { signOutRoute } from './session.ts'
import { signInRoute } from './sign-in.ts'

export interface WorkerDeps {
  authenticate: Authenticate
  /** How the Worker sends email: the email sign-in code. */
  mailer: Mailer
  /** The church list cache `GET /churches` reads through: the isolate's own unless given one. */
  churchList?: ChurchListCache
}

const CHANNEL_ROUTE = /^\/channels\/([^/]+)\/(messages|socket|members|alerts|people|read)$/
/** A message, and the moderation actions on it: `remove`, `pin` and `reports`. */
const MESSAGE_ROUTE = /^\/channels\/([^/]+)\/messages\/([^/]+)(?:\/(remove|pin|reports))?$/
const IMAGE_ROUTE = /^\/channels\/([^/]+)\/images(?:\/([^/]+))?$/
const ROLE_ROUTE = /^\/people\/([^/]+)\/role$/
const PERSON_SIGN_OUT_ROUTE = /^\/people\/([^/]+)\/sign-out$/
const GROUP_TYPE_SYNC_ROUTE = /^\/group-types\/([^/]+)\/sync$/
const BIRTHDATE_REQUEST_ROUTE = /^\/birthdate-requests\/([^/]+)(\/approval)?$/
const REPORT_CLOSE_ROUTE = /^\/reports\/([^/]+)\/close$/

/** An Expo push token, the only kind of device token Phon sends to. */
const EXPO_PUSH_TOKEN = /^Expo(?:nent)?PushToken\[[^\]]+\]$/

/**
 * Builds the Worker. The church always comes from the caller's identity, never from the URL, so a
 * member cannot even address another church's channel. Its scheduled handler is the roster sync.
 */
export function createWorker(deps: WorkerDeps): ExportedHandler<Env> {
  return {
    async scheduled(_controller, env) {
      await syncAllChurches(env)
    },

    async fetch(request, env, ctx) {
      // Sign-in, connecting the sync account, the church list, email code sign-in and signing out
      // come before anyone is authenticated: signing out ends the session it is sent with. The
      // caller limits come before all of them, so a limited caller costs no route any work.
      const callerLimited = await refuseLimitedCaller(request, env)
      if (callerLimited !== null) return callerLimited
      const signIn =
        (await signInRoute(request, env)) ??
        (await connectRoute(request, env)) ??
        (await churchListRoute(request, env, deps.churchList)) ??
        (await emailSignInRoute(request, env, deps.mailer, ctx)) ??
        (await signOutRoute(request, env))
      if (signIn !== null) return signIn

      const url = new URL(request.url)
      if (url.pathname === '/me') {
        const identity = await deps.authenticate(request, env)
        if (identity === null) return signInFirst()
        if (request.method !== 'GET') return methodNotAllowed()
        const member = await env.CHURCH_DIRECTORY.getByName(identity.churchId).member(identity)
        return member === null ? notFound() : Response.json(member satisfies Member)
      }

      if (url.pathname === '/me/oversight-notice') {
        const identity = await deps.authenticate(request, env)
        if (identity === null) return signInFirst()
        const directory = env.CHURCH_DIRECTORY.getByName(identity.churchId)
        if (request.method === 'PUT') {
          const set = await directory.acknowledgeOversightNotice(identity)
          return set === 'set' ? noContent() : refused(set)
        }
        if (request.method !== 'GET') return methodNotAllowed()
        const notice = await directory.oversightNotice(identity)
        return typeof notice === 'string'
          ? refused(notice)
          : Response.json(notice satisfies OversightNotice)
      }

      if (url.pathname === '/me/quiet-hours') {
        const identity = await deps.authenticate(request, env)
        if (identity === null) return signInFirst()
        const directory = env.CHURCH_DIRECTORY.getByName(identity.churchId)
        if (request.method === 'PUT') {
          const body = await readJsonObject(request)
          if (body === null) return badRequest()
          // A body without `quietHours` reads as undefined, which is invalid, never a clear.
          const set = await directory.setQuietHours(identity, body.quietHours)
          return set === 'set' ? noContent() : refused(set)
        }
        if (request.method !== 'GET') return methodNotAllowed()
        const setting = await directory.quietHours(identity)
        return typeof setting === 'string'
          ? refused(setting)
          : Response.json(setting satisfies QuietHoursSetting)
      }

      if (url.pathname === '/me/birthdate') {
        const identity = await deps.authenticate(request, env)
        if (identity === null) return signInFirst()
        if (request.method === 'PUT') {
          const body = await readJsonObject(request)
          if (body === null) return badRequest()
          const status = await enterBirthdate(env, identity, body.birthdate)
          return typeof status === 'string'
            ? refusedOrUnwritten(status)
            : Response.json(status satisfies BirthdateStatus)
        }
        if (request.method !== 'GET') return methodNotAllowed()
        const status = await env.CHURCH_DIRECTORY.getByName(identity.churchId).birthdateStatus(
          identity,
        )
        return typeof status === 'string'
          ? refused(status)
          : Response.json(status satisfies BirthdateStatus)
      }

      if (url.pathname === '/birthdate-requests') {
        const identity = await deps.authenticate(request, env)
        if (identity === null) return signInFirst()
        if (request.method !== 'GET') return methodNotAllowed()
        const list = await env.CHURCH_DIRECTORY.getByName(identity.churchId).birthdateRequests(
          identity,
        )
        return typeof list === 'string'
          ? refused(list)
          : Response.json(list satisfies BirthdateRequestList)
      }

      const birthdateRequestRoute = BIRTHDATE_REQUEST_ROUTE.exec(url.pathname)
      if (birthdateRequestRoute !== null) {
        const identity = await deps.authenticate(request, env)
        if (identity === null) return signInFirst()
        const personId = decodeURIComponent(birthdateRequestRoute[1] as string)
        if (birthdateRequestRoute[2] !== undefined) {
          if (request.method !== 'POST') return methodNotAllowed()
          const approved = await approveBirthdate(env, identity, personId)
          return approved === 'approved' ? noContent() : refusedOrUnwritten(approved)
        }
        if (request.method !== 'DELETE') return methodNotAllowed()
        const declined = await env.CHURCH_DIRECTORY.getByName(identity.churchId).declineBirthdate(
          identity,
          personId,
        )
        return declined === 'declined' ? noContent() : refused(declined)
      }

      if (url.pathname === '/people/without-birthdate') {
        const identity = await deps.authenticate(request, env)
        if (identity === null) return signInFirst()
        if (request.method !== 'GET') return methodNotAllowed()
        const people = await env.CHURCH_DIRECTORY.getByName(
          identity.churchId,
        ).peopleWithoutBirthdate(identity)
        return typeof people === 'string'
          ? refused(people)
          : Response.json(people satisfies PeopleWithoutBirthdate)
      }

      if (url.pathname === '/channels') {
        const identity = await deps.authenticate(request, env)
        if (identity === null) return signInFirst()
        if (request.method === 'POST') return createChannel(request, env, identity)
        if (request.method !== 'GET') return methodNotAllowed()
        const list = await channelList(env, identity)
        return list === null ? notFound() : Response.json(list satisfies ChannelList)
      }

      if (url.pathname === '/devices') {
        const identity = await deps.authenticate(request, env)
        if (identity === null) return signInFirst()
        if (request.method !== 'POST') return methodNotAllowed()
        const body = await readJsonObject(request)
        const token = body?.token
        if (typeof token !== 'string' || !EXPO_PUSH_TOKEN.test(token)) return badRequest()
        return registerDevice(env, identity, token)
      }

      if (url.pathname === '/gifs') {
        const identity = await deps.authenticate(request, env)
        if (identity === null) return signInFirst()
        return searchGifs(request, env, identity)
      }

      if (url.pathname === '/people') {
        const identity = await deps.authenticate(request, env)
        if (identity === null) return signInFirst()
        if (request.method !== 'GET') return methodNotAllowed()
        const people = await env.CHURCH_DIRECTORY.getByName(identity.churchId).people(identity)
        return typeof people === 'string'
          ? refused(people)
          : Response.json(people satisfies PeopleList)
      }

      if (url.pathname === '/oversight') {
        const identity = await deps.authenticate(request, env)
        if (identity === null) return signInFirst()
        if (request.method !== 'GET') return methodNotAllowed()
        const log = await env.CHURCH_DIRECTORY.getByName(identity.churchId).oversightLog(identity)
        return typeof log === 'string' ? refused(log) : Response.json(log satisfies OversightLog)
      }

      if (url.pathname === '/reports') {
        const identity = await deps.authenticate(request, env)
        if (identity === null) return signInFirst()
        if (request.method !== 'GET') return methodNotAllowed()
        return listReports(env, identity)
      }

      const reportCloseRoute = REPORT_CLOSE_ROUTE.exec(url.pathname)
      if (reportCloseRoute !== null) {
        const identity = await deps.authenticate(request, env)
        if (identity === null) return signInFirst()
        if (request.method !== 'POST') return methodNotAllowed()
        return closeReport(env, identity, decodeURIComponent(reportCloseRoute[1] as string))
      }

      const roleRoute = ROLE_ROUTE.exec(url.pathname)
      if (roleRoute !== null) {
        const identity = await deps.authenticate(request, env)
        if (identity === null) return signInFirst()
        if (request.method !== 'PUT') return methodNotAllowed()
        const body = await readJsonObject(request)
        if (body === null || !isRole(body.role)) return badRequest()
        const personId = decodeURIComponent(roleRoute[1] as string)
        const directory = env.CHURCH_DIRECTORY.getByName(identity.churchId)
        const set = await directory.setRole(identity, personId, body.role)
        if (set !== 'set') return refused(set)
        // A demoted admin stops reading by oversight now; a failed close stays pending.
        await closeLostSockets(env, directory, identity.churchId)
        return noContent()
      }

      const personSignOutRoute = PERSON_SIGN_OUT_ROUTE.exec(url.pathname)
      if (personSignOutRoute !== null) {
        const identity = await deps.authenticate(request, env)
        if (identity === null) return signInFirst()
        if (request.method !== 'POST') return methodNotAllowed()
        return endPersonSessions(env, identity, decodeURIComponent(personSignOutRoute[1] as string))
      }

      const messageRoute = MESSAGE_ROUTE.exec(url.pathname)
      if (messageRoute !== null) {
        const identity = await deps.authenticate(request, env)
        if (identity === null) return signInFirst()
        const channelId = decodeURIComponent(messageRoute[1] as string)
        const messageId = decodeURIComponent(messageRoute[2] as string)
        switch (messageRoute[3]) {
          case undefined:
            if (request.method !== 'DELETE') return methodNotAllowed()
            return deleteMessage(env, identity, channelId, messageId)
          case 'remove':
            if (request.method !== 'POST') return methodNotAllowed()
            return removeMessage(env, identity, channelId, messageId)
          case 'pin':
            if (request.method !== 'PUT' && request.method !== 'DELETE') return methodNotAllowed()
            return setPin(env, identity, channelId, messageId, request.method === 'PUT')
          case 'reports':
            if (request.method !== 'POST') return methodNotAllowed()
            return reportMessage(env, identity, channelId, messageId)
          default:
            return notFound()
        }
      }

      const imageRoute = IMAGE_ROUTE.exec(url.pathname)
      if (imageRoute !== null) {
        const identity = await deps.authenticate(request, env)
        if (identity === null) return signInFirst()
        const channelId = decodeURIComponent(imageRoute[1] as string)
        if (imageRoute[2] === undefined) {
          if (request.method !== 'POST') return methodNotAllowed()
          return postImage(request, env, identity, channelId)
        }
        if (request.method !== 'GET') return methodNotAllowed()
        return getImage(env, identity, channelId, decodeURIComponent(imageRoute[2]))
      }

      if (url.pathname === '/group-types') {
        const identity = await deps.authenticate(request, env)
        if (identity === null) return signInFirst()
        if (request.method !== 'GET') return methodNotAllowed()
        const types = await env.CHURCH_DIRECTORY.getByName(identity.churchId).groupTypes(identity)
        return typeof types === 'string'
          ? refused(types)
          : Response.json(types satisfies GroupTypeList)
      }

      const groupTypeRoute = GROUP_TYPE_SYNC_ROUTE.exec(url.pathname)
      if (groupTypeRoute !== null) {
        const identity = await deps.authenticate(request, env)
        if (identity === null) return signInFirst()
        if (request.method !== 'PUT') return methodNotAllowed()
        const body = await readJsonObject(request)
        if (body === null || typeof body.enabled !== 'boolean') return badRequest()
        const groupTypeId = decodeURIComponent(groupTypeRoute[1] as string)
        // Takes effect at the next roster sync, which stays the one writer of synced memberships.
        const set = await env.CHURCH_DIRECTORY.getByName(identity.churchId).setGroupTypeSync(
          identity,
          groupTypeId,
          body.enabled,
        )
        return set === 'set' ? noContent() : refused(set)
      }

      const route = CHANNEL_ROUTE.exec(url.pathname)
      if (route === null) return notFound()
      const [, encodedChannelId, action] = route as unknown as [string, string, string]

      const identity = await deps.authenticate(request, env)
      if (identity === null) return signInFirst()

      const channelId = decodeURIComponent(encodedChannelId)
      if (action === 'members') return channelMembers(request, env, identity, channelId)
      if (action === 'alerts') return channelAlerts(request, env, identity, channelId)
      if (action === 'read') {
        if (request.method !== 'PUT') return methodNotAllowed()
        const body = await readJsonObject(request)
        if (typeof body?.messageId !== 'string') return badRequest()
        return markRead(env, identity, channelId, body.messageId)
      }
      if (action === 'people') {
        if (request.method !== 'GET') return methodNotAllowed()
        const people = await env.CHURCH_DIRECTORY.getByName(identity.churchId).channelPeople(
          identity,
          channelId,
        )
        return typeof people === 'string'
          ? refused(people)
          : Response.json(people satisfies ChannelPeople)
      }
      if (request.method !== 'GET') return methodNotAllowed()
      // The read gate, which records an admin's look at a private channel they are not in.
      const opened = await env.CHURCH_DIRECTORY.getByName(identity.churchId).openChannel(
        identity,
        channelId,
      )
      // Not found, never forbidden: a 403 would confirm that another church's channel exists.
      if (opened === 'denied') return notFound()

      const channel = env.CHANNEL.getByName(channelObjectName(identity.churchId, channelId))
      if (action === 'messages') {
        const { messages } = await channel.history(identity.churchId, channelId, {
          withDeleted: opened.seesDeleted,
        })
        const authors = await env.CHURCH_DIRECTORY.getByName(identity.churchId).authorNames(
          identity.churchId,
          messages.map((message) => message.authorId),
        )
        return Response.json({ messages, authors } satisfies ChannelHistory)
      }
      if (action === 'socket') {
        if (request.headers.get('upgrade') !== 'websocket') {
          return new Response('Expected a WebSocket upgrade', { status: 426 })
        }
        return channel.fetch('https://channel.internal/socket', {
          headers: {
            upgrade: 'websocket',
            [HOLDER_HEADERS.churchId]: identity.churchId,
            [HOLDER_HEADERS.channelId]: channelId,
            [HOLDER_HEADERS.personId]: identity.personId,
          },
        })
      }
      return methodNotAllowed()
    },
  }
}

/**
 * `POST /channels`. A caller whose role may create no channel at all is refused before the body is
 * read, so the answer tells a member nothing about which kinds exist.
 */
async function createChannel(request: Request, env: Env, identity: Identity): Promise<Response> {
  const directory = env.CHURCH_DIRECTORY.getByName(identity.churchId)
  const member = await directory.member(identity)
  if (member === null) return notFound()
  if (member.canCreate.length === 0) return forbidden()

  const body = await readJsonObject(request)
  if (body === null) return badRequest()
  const { name, kind, memberIds } = body
  if (typeof name !== 'string' || !isCreatableKind(kind)) return badRequest()
  if (memberIds !== undefined && !Array.isArray(memberIds)) return badRequest()
  const channel: NewChannel = { name, kind }
  if (memberIds !== undefined) channel.memberIds = memberIds as string[]

  const created = await directory.createChannel(identity, channel)
  if (typeof created === 'string') return refused(created)
  return Response.json(created satisfies ChannelSummary, { status: 201 })
}

/**
 * `DELETE /channels/:channelId/messages/:messageId`: a person deletes their own message. A channel
 * they may not open answers 404, the same as a message that is not there.
 */
async function deleteMessage(
  env: Env,
  identity: Identity,
  channelId: string,
  messageId: string,
): Promise<Response> {
  const access = await env.CHURCH_DIRECTORY.getByName(identity.churchId).channelAccess(
    identity,
    channelId,
  )
  if (access !== 'granted') return notFound()
  const deleted = await env.CHANNEL.getByName(
    channelObjectName(identity.churchId, channelId),
  ).deleteMessage(identity.churchId, channelId, messageId, identity.personId)
  switch (deleted) {
    case 'deleted':
      return noContent()
    case 'not-found':
      return notFound()
    case 'forbidden':
      return forbidden()
  }
}

/**
 * `POST /channels/:channelId/images`: a member posts an image, with an optional caption, marked a
 * team announcement or urgent as a send frame may be. The post
 * gate comes first, so a person who may not post here learns nothing from the upload: a channel
 * they may not open answers 404, and one they may only read 403. The image is checked, put in R2
 * under a key built from the caller's identity and the gated channel, then posted the way a text
 * message is.
 */
async function postImage(
  request: Request,
  env: Env,
  identity: Identity,
  channelId: string,
): Promise<Response> {
  const gate = await env.CHURCH_DIRECTORY.getByName(identity.churchId).postAccess(
    identity,
    channelId,
  )
  if (gate.access !== 'granted') return postRefused(gate.access)

  // Refused before the body is read when it says it is too large; a body that lies is cut by the
  // part's own size check below.
  if (Number(request.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES + MULTIPART_ALLOWANCE) {
    return imageRefused('too-large')
  }
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return badRequest()
  }
  const image = await acceptImage(form.get('image'))
  if (typeof image === 'string') return imageRefused(image)
  const caption = form.get('body') ?? ''
  if (typeof caption !== 'string') return badRequest()
  // Read as the send frame reads them: only `true` asks for either.
  const flags: PostFlags = {
    teamAnnouncement: form.get('teamAnnouncement') === 'true',
    urgent: form.get('urgent') === 'true',
  }
  // A flag the poster may not use is refused before the bytes go to R2.
  if (flags.teamAnnouncement || flags.urgent) {
    const flagged = await env.CHURCH_DIRECTORY.getByName(identity.churchId).postAccess(
      identity,
      channelId,
      [],
      flags,
    )
    if (flagged.access !== 'granted') return postRefused(flagged.access)
  }

  const imageId = crypto.randomUUID()
  await env.IMAGES.put(imageKey(identity.churchId, channelId, imageId), image.bytes, {
    httpMetadata: { contentType: image.contentType },
  })
  const posted = await env.CHANNEL.getByName(
    channelObjectName(identity.churchId, channelId),
  ).postImage(
    { churchId: identity.churchId, channelId, personId: identity.personId },
    caption,
    { id: imageId, contentType: image.contentType },
    flags,
  )
  if (posted.access !== 'granted') return postRefused(posted.access)
  return Response.json({ message: posted.message } satisfies ImagePosted, { status: 201 })
}

/**
 * `GET /channels/:channelId/images/:imageId`: the read gate of the channel's history, then the
 * channel's own word that a message it shows this person has that image, then the bytes from R2.
 * Anything missing answers 404, never 403.
 */
async function getImage(
  env: Env,
  identity: Identity,
  channelId: string,
  imageId: string,
): Promise<Response> {
  const read = await env.CHURCH_DIRECTORY.getByName(identity.churchId).readAccess(
    identity,
    channelId,
  )
  if (read === 'denied') return notFound()
  const image = await env.CHANNEL.getByName(channelObjectName(identity.churchId, channelId)).image(
    identity.churchId,
    channelId,
    imageId,
    { withDeleted: read.seesDeleted },
  )
  if (image === null) return notFound()
  const object = await env.IMAGES.get(imageKey(identity.churchId, channelId, imageId))
  if (object === null) return notFound()
  return new Response(object.body, {
    headers: {
      'content-type': image.contentType,
      'x-content-type-options': 'nosniff',
      // An image ID never changes its bytes; `private` keeps shared caches from holding one.
      'cache-control': 'private, max-age=31536000, immutable',
    },
  })
}

/** Room for a multipart body's boundaries, part headers and caption around the image itself. */
const MULTIPART_ALLOWANCE = 64 * 1024

/**
 * The status for a post the post gate refused: 404 when the channel is not theirs to open, and 403
 * for anything else it refuses them.
 */
function postRefused(access: PostRefusal): Response {
  return access === 'denied' ? notFound() : forbidden()
}

/** The status for each refused image part. */
function imageRefused(refusal: ImageRefusal): Response {
  switch (refusal) {
    case 'missing':
      return badRequest()
    case 'unsupported':
      return new Response('Unsupported image type', { status: 415 })
    case 'too-large':
      return new Response('Image too large', { status: 413 })
  }
}

/**
 * `POST /devices`: for a current person of the caller's church (404 otherwise, before anything
 * moves), registers the token to the caller in the caller's church, then lists it for that church
 * in the registry. The registry is what pushes read: a church pushes only to tokens it lists for
 * that church, whatever `devices` rows the churches hold. So a church is listed only once it holds
 * a row, and the last claim decides. A refusal comes before the claim, so it moves nothing. The row
 * a church keeps for a token listed elsewhere reaches no one, and so does a listing whose row a
 * sign-out deleted, since a church pushes only to its own rows.
 */
async function registerDevice(env: Env, identity: Identity, token: string): Promise<Response> {
  const directory = env.CHURCH_DIRECTORY.getByName(identity.churchId)
  if (!(await directory.knows(identity))) return refused('not-known')
  const registered = await directory.registerDevice(identity, token)
  if (registered !== 'registered') return refused(registered)
  await env.CHURCH_REGISTRY.getByName(REGISTRY_NAME).claimDevice(token, identity.churchId)
  return noContent()
}

/**
 * `POST /people/:personId/sign-out`: an admin ends every session of a person of their church and
 * deletes their devices, then closes the person's sockets on every channel they may open, one
 * channel at a time. A close that fails is logged and skipped: with no session left the person
 * cannot open the channel again, but that open socket stays until the phone drops it.
 */
async function endPersonSessions(
  env: Env,
  identity: Identity,
  personId: string,
): Promise<Response> {
  const ended = await env.CHURCH_DIRECTORY.getByName(identity.churchId).endPersonSessions(
    identity,
    personId,
  )
  if (typeof ended === 'string') return refused(ended)
  for (const channelId of ended.channelIds) {
    try {
      await env.CHANNEL.getByName(channelObjectName(identity.churchId, channelId)).evict(personId)
    } catch (error) {
      console.error(
        `Closing ${personId}'s sockets on ${channelId} in ${identity.churchId} failed`,
        error,
      )
    }
  }
  return noContent()
}

/** `GET` and `PUT /channels/:channelId/members`, for a private channel's members. */
async function channelMembers(
  request: Request,
  env: Env,
  identity: Identity,
  channelId: string,
): Promise<Response> {
  const directory = env.CHURCH_DIRECTORY.getByName(identity.churchId)
  if (request.method === 'GET') {
    const members = await directory.channelMembers(identity, channelId)
    return typeof members === 'string'
      ? refused(members)
      : Response.json(members satisfies ChannelMembers)
  }
  if (request.method !== 'PUT') return methodNotAllowed()
  const body = await readJsonObject(request)
  const set = await directory.setChannelMembers(identity, channelId, body?.personIds)
  if (set !== 'set') return refused(set)
  // Anyone taken out stops receiving now; a failed close stays pending for the next sync.
  await closeLostSockets(env, directory, identity.churchId)
  return noContent()
}

/**
 * `GET` and `PUT /channels/:channelId/alerts`, for the caller's own alert level. A channel they may
 * not open answers 404; announcements, which always alert, refuse a change with 403.
 */
async function channelAlerts(
  request: Request,
  env: Env,
  identity: Identity,
  channelId: string,
): Promise<Response> {
  const directory = env.CHURCH_DIRECTORY.getByName(identity.churchId)
  if (request.method === 'GET') {
    const alerts = await directory.channelAlerts(identity, channelId)
    return typeof alerts === 'string'
      ? refused(alerts)
      : Response.json(alerts satisfies ChannelAlerts)
  }
  if (request.method !== 'PUT') return methodNotAllowed()
  const body = await readJsonObject(request)
  const set = await directory.setAlertLevel(identity, channelId, body?.level)
  return set === 'set' ? noContent() : refused(set)
}

/** A request's JSON body when it is an object, or null. */
async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json()
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** The status for each refusal the church directory answers. */
function refused(refusal: Refusal): Response {
  switch (refusal) {
    case 'not-known':
    case 'not-found':
      return notFound()
    case 'forbidden':
      return forbidden()
    case 'invalid':
      return badRequest()
    case 'conflict':
      return new Response('Conflict', { status: 409 })
  }
}

/**
 * The status for a refusal, or for a birthdate Planning Center did not take: 503 when the church
 * has no sync connection, 502 when Planning Center refused the write.
 */
function refusedOrUnwritten(refusal: Refusal | WriteRefusal): Response {
  if (refusal === 'unavailable') {
    return new Response('Planning Center is not connected', { status: 503 })
  }
  if (refusal === 'write-failed') {
    return new Response('Planning Center did not take the birthdate', { status: 502 })
  }
  return refused(refusal)
}

function noContent(): Response {
  return new Response(null, { status: 204 })
}

function forbidden(): Response {
  return new Response('Forbidden', { status: 403 })
}

function badRequest(): Response {
  return new Response('Bad request', { status: 400 })
}

function signInFirst(): Response {
  return new Response('Sign in first', { status: 401 })
}

function methodNotAllowed(): Response {
  return new Response('Method not allowed', { status: 405 })
}

function notFound(): Response {
  return new Response('Not found', { status: 404 })
}
