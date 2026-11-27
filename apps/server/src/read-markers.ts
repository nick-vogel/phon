import type { ChannelList, LastMessage } from '@phon/api-types'
import { channelObjectName, type LastPost } from './channel.ts'
import type { Identity } from './identity.ts'

/**
 * The read marker routes: a member moves their read marker in a channel, and the channel list
 * carries each of their own channels' unread state, mention count, last message and alert level.
 * The Worker only dispatches here, once it has authenticated the caller and checked the method.
 *
 * A marker is the person's, never the session's or the device's, so a read on one phone shows on
 * every other. An admin who reads a channel only by oversight leaves no marker, and their list
 * carries none of those four fields for it.
 */

/**
 * `GET /channels`: the channels a person may open, sorted by name, each of their own with its
 * `unread`, `mentions` and `lastMessage` from the channel's object, one call per channel, and the
 * `alertLevel` the directory answers. The last messages' authors are named in one more call to the
 * directory, and the person's unread mention total is set there to the sum of their `mentions`.
 * An oversight channel is passed through as the directory answers it. Null when the directory does
 * not know the person.
 */
export async function channelList(env: Env, identity: Identity): Promise<ChannelList | null> {
  const directory = env.CHURCH_DIRECTORY.getByName(identity.churchId)
  const list = await directory.channelsFor(identity)
  if (list === null) return null
  const summaries = await Promise.all(
    list.channels.map(async (summary) => {
      if (summary.oversight === true) return { summary, lastPost: null }
      const { lastMessage, ...unread } = await env.CHANNEL.getByName(
        channelObjectName(identity.churchId, summary.id),
      ).summaryFor(identity.churchId, summary.id, identity.personId)
      return { summary: { ...summary, ...unread }, lastPost: lastMessage }
    }),
  )
  await setMentionTotal(
    directory,
    identity,
    summaries.reduce((total, { summary }) => total + (summary.mentions ?? 0), 0),
  )
  const authorIds = summaries.flatMap(({ lastPost }) =>
    lastPost === null ? [] : [lastPost.authorId],
  )
  const names = new Map(
    (authorIds.length === 0 ? [] : await directory.authorNames(identity.churchId, authorIds)).map(
      ({ personId, name }) => [personId, name],
    ),
  )
  return {
    channels: summaries.map(({ summary, lastPost }) =>
      summary.oversight === true
        ? summary
        : { ...summary, lastMessage: lastPost === null ? null : named(lastPost, names) },
    ),
  }
}

/**
 * Sets the person's unread mention total, the app icon's badge, to the sum the list computed. A
 * failed call is logged and the list still answers; the next load tries again.
 */
async function setMentionTotal(
  directory: ReturnType<Env['CHURCH_DIRECTORY']['getByName']>,
  identity: Identity,
  total: number,
): Promise<void> {
  try {
    await directory.setMentionTotal(identity, total)
  } catch (error) {
    console.error(`Setting ${identity.personId}'s unread mention total failed`, error)
  }
}

/** A last post with its author's first name, which is null when they are not a current person. */
function named({ authorId, ...post }: LastPost, names: Map<string, string>): LastMessage {
  const name = names.get(authorId)
  return { authorFirstName: name === undefined ? null : firstName(name), ...post }
}

/** The first whitespace-separated word of a stored full name: `Ben` for `Ben Okafor`. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name
}

/**
 * `PUT /channels/:channelId/read`: moves the caller's read marker forward to a message of the
 * channel. A channel they may not open, and a message not in it, answer 404. A person who reads the
 * channel only by oversight gets 204 and nothing is stored: no marker, and no oversight row.
 */
export async function markRead(
  env: Env,
  identity: Identity,
  channelId: string,
  messageId: string,
): Promise<Response> {
  const read = await env.CHURCH_DIRECTORY.getByName(identity.churchId).readAccess(
    identity,
    channelId,
  )
  if (read === 'denied') return status(404)
  if (read.overseeing) return status(204)
  const marked = await env.CHANNEL.getByName(
    channelObjectName(identity.churchId, channelId),
  ).markRead(identity.churchId, channelId, identity.personId, messageId)
  return marked === 'marked' ? status(204) : status(404)
}

function status(code: 204 | 404): Response {
  return new Response(code === 404 ? 'Not found' : null, { status: code })
}
