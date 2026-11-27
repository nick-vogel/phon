import type { Report, ReportList } from '@phon/api-types'
import { channelObjectName } from './channel.ts'
import { reportPushMessages, sendPushes } from './expo-push.ts'
import type { Identity } from './identity.ts'

/**
 * The moderation routes: a moderator removes and pins messages, anyone who may open a channel
 * reports a message in it, and a moderator reads and closes the open reports. The Worker only dispatches here,
 * once it has authenticated the caller and checked the method, so no request that reads nothing
 * leaves an oversight row.
 *
 * A channel the caller may not open answers 404, the same as a message that is not there, never
 * 403: a 403 would confirm that a private channel exists. A caller who may open the channel but
 * does not moderate gets 403.
 */

/** `POST /channels/:channelId/messages/:messageId/remove`: a moderator removes a message. */
export async function removeMessage(
  env: Env,
  identity: Identity,
  channelId: string,
  messageId: string,
): Promise<Response> {
  const access = await env.CHURCH_DIRECTORY.getByName(identity.churchId).moderationAccess(
    identity,
    channelId,
  )
  if (access !== 'granted') return refusedModeration(access)
  const removed = await env.CHANNEL.getByName(
    channelObjectName(identity.churchId, channelId),
  ).removeMessage(identity.churchId, channelId, messageId, identity.personId)
  return removed === 'removed' ? status(204) : status(404)
}

/**
 * `PUT` (pin) and `DELETE` (unpin) `/channels/:channelId/messages/:messageId/pin`: a moderator
 * pins or unpins a message. Both are idempotent.
 */
export async function setPin(
  env: Env,
  identity: Identity,
  channelId: string,
  messageId: string,
  pinned: boolean,
): Promise<Response> {
  const access = await env.CHURCH_DIRECTORY.getByName(identity.churchId).moderationAccess(
    identity,
    channelId,
  )
  if (access !== 'granted') return refusedModeration(access)
  const channel = env.CHANNEL.getByName(channelObjectName(identity.churchId, channelId))
  const set = pinned
    ? await channel.pin(identity.churchId, channelId, messageId, identity.personId)
    : await channel.unpin(identity.churchId, channelId, messageId)
  return set === 'done' ? status(204) : status(404)
}

/**
 * `POST /channels/:channelId/messages/:messageId/reports`: a person reports a message in a channel
 * they may open, and every admin and chat admin who may open it is pushed. The pushes are sent
 * before the answer, and a failed push is logged and dropped: the report is already stored.
 */
export async function reportMessage(
  env: Env,
  identity: Identity,
  channelId: string,
  messageId: string,
): Promise<Response> {
  const directory = env.CHURCH_DIRECTORY.getByName(identity.churchId)
  if ((await directory.channelAccess(identity, channelId)) !== 'granted') return status(404)
  const message = await env.CHANNEL.getByName(
    channelObjectName(identity.churchId, channelId),
  ).message(identity.churchId, channelId, messageId)
  if (message === null) return status(404)
  const filed = await directory.fileReport(identity, channelId, {
    messageId,
    authorId: message.authorId,
  })
  if (typeof filed === 'string') return status(404)
  try {
    await sendPushes(
      env,
      identity.churchId,
      reportPushMessages(
        filed.channelName,
        { reportId: filed.reportId, channelId, messageId },
        filed.devices,
      ),
    )
  } catch (error) {
    console.error(`Alerting about report ${filed.reportId} failed`, error)
  }
  return status(204)
}

/**
 * `GET /reports`: the open reports a moderator may see, newest first, each with the reported
 * message as they may see it now. An admin sees one deleted since, marked; a chat admin gets null.
 * Each reported channel is opened through `openChannel` before its messages are read, so an admin
 * reading reports from a private channel they are not in leaves an oversight record.
 */
export async function listReports(env: Env, identity: Identity): Promise<Response> {
  const directory = env.CHURCH_DIRECTORY.getByName(identity.churchId)
  const open = await directory.openReports(identity)
  if (open === 'forbidden') return status(403)
  if (typeof open === 'string') return status(404)

  const idsByChannel = new Map<string, string[]>()
  for (const report of open.reports) {
    idsByChannel.set(report.channelId, [
      ...(idsByChannel.get(report.channelId) ?? []),
      report.messageId,
    ])
  }
  const messages = new Map<string, Record<string, Report['message']>>()
  for (const [channelId, messageIds] of idsByChannel) {
    if ((await directory.openChannel(identity, channelId)) === 'denied') continue
    messages.set(
      channelId,
      await env.CHANNEL.getByName(channelObjectName(identity.churchId, channelId)).messagesById(
        identity.churchId,
        channelId,
        messageIds,
        { withDeleted: open.seesDeleted },
      ),
    )
  }
  const reports: Report[] = open.reports.map(({ messageId, ...report }) => ({
    ...report,
    message: messages.get(report.channelId)?.[messageId] ?? null,
  }))
  return Response.json({ reports } satisfies ReportList)
}

/** `POST /reports/:reportId/close`: a moderator who may see a report closes it. */
export async function closeReport(
  env: Env,
  identity: Identity,
  reportId: string,
): Promise<Response> {
  const closed = await env.CHURCH_DIRECTORY.getByName(identity.churchId).closeReport(
    identity,
    reportId,
  )
  if (closed === 'closed') return status(204)
  return closed === 'forbidden' ? status(403) : status(404)
}

/** The status for a moderation gate that refused: 404 when denied, 403 when forbidden. */
function refusedModeration(access: 'forbidden' | 'denied'): Response {
  return access === 'denied' ? status(404) : status(403)
}

const STATUS_TEXT: Record<number, string | null> = {
  204: null,
  403: 'Forbidden',
  404: 'Not found',
}

function status(code: 204 | 403 | 404): Response {
  return new Response(STATUS_TEXT[code] ?? null, { status: code })
}
