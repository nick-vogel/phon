import type { ChannelKind, CreatableChannelKind, Role } from '@phon/api-types'

/**
 * Who may do what, by role. Each rule lives here once, and the church directory asks these
 * functions rather than repeating them. Whether a person may open a channel at all is the
 * directory's grant rule (`mayOpen`); these rules apply on top of it.
 */

/** Every role, as the wire spells it. */
export const ROLES: readonly Role[] = ['member', 'chat-admin', 'admin']

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

/** Every kind a request can create. No direct message kind exists, so none can be created. */
export const CREATABLE_KINDS: readonly CreatableChannelKind[] = ['open', 'private']

export function isCreatableKind(value: unknown): value is CreatableChannelKind {
  return typeof value === 'string' && (CREATABLE_KINDS as readonly string[]).includes(value)
}

/**
 * The kinds a role may create: a member none, so no member can make a direct message or a room
 * for two; a chat admin open channels; an admin open and private channels.
 */
export function creatableKinds(role: Role): CreatableChannelKind[] {
  switch (role) {
    case 'admin':
      return ['open', 'private']
    case 'chat-admin':
      return ['open']
    case 'member':
      return []
  }
}

/** Whether a role may set other people's roles: admins only. */
export function mayAssignRoles(role: Role): boolean {
  return role === 'admin'
}

/**
 * Whether a role may end a person's sessions on every phone, for a lost or shared phone: admins
 * only, the role that already holds every other power over people.
 */
export function mayEndSessions(role: Role): boolean {
  return role === 'admin'
}

/**
 * Whether a role may list the church's Planning Center Group types and turn their sync on or off:
 * admins only, because turning a type on lets people who do not serve into Phon.
 */
export function mayManageGroupSync(role: Role): boolean {
  return role === 'admin'
}

/**
 * Whether a role keeps a person current when the roster sync finds them on no Services team and in
 * no synced Group: admins and chat admins, since church office staff often hold a role without
 * serving on a team. The age rule still takes out anyone it finds under 13, whatever their role.
 */
export function staysWithoutRoster(role: Role): boolean {
  return role === 'admin' || role === 'chat-admin'
}

/**
 * Whether a person counts as serving, which lets them open the church-wide channels as a member:
 * every admin and chat admin does, on a team or not and in a synced Group or not, and a member
 * does when they serve on a live Services team (`onTeam`, the `serves` the roster sync stores).
 * Read with the person's current role, so a grant or a demotion takes effect at once.
 */
export function countsAsServing(role: Role, onTeam: boolean): boolean {
  return onTeam || role === 'admin' || role === 'chat-admin'
}

/** Whether a role may set who is in a private channel: admins only, so no one adds themselves. */
export function maySetMembers(role: Role): boolean {
  return role === 'admin'
}

/**
 * Whether a role may post in a channel of a kind, once it may open it: announcements take posts
 * from admins and chat admins only, and every other kind from anyone who may open it.
 */
export function mayPost(role: Role, kind: ChannelKind): boolean {
  if (kind === 'announcements') return role === 'admin' || role === 'chat-admin'
  return true
}

/** The fewest members a private channel may have, so it can never be a direct message. */
export const PRIVATE_CHANNEL_MINIMUM = 3

/**
 * The fewest synced members a small group channel needs before anyone may open it, so a Group of
 * two never becomes a direct message.
 */
export const SMALL_GROUP_MINIMUM = 3

/**
 * Whether a role reads every channel of its church, including private channels it is not in:
 * admins only. Reading a channel this way is oversight, and it never lets the reader post.
 */
export function readsEveryChannel(role: Role): boolean {
  return role === 'admin'
}

/** Whether a role sees deleted messages, marked as deleted: admins only. */
export function seesDeleted(role: Role): boolean {
  return role === 'admin'
}

/** Whether a role may read the oversight log of who opened which private channel: admins only. */
export function mayReadOversight(role: Role): boolean {
  return role === 'admin'
}

/**
 * Whether a role may mark a message urgent, which alerts everyone in the channel through their
 * quiet hours: admins and chat admins.
 */
export function mayMarkUrgent(role: Role): boolean {
  return role === 'admin' || role === 'chat-admin'
}

/**
 * Whether a role approves or declines a self-entered 18+ birthdate and reads the list of people
 * with no birthdate: admins only.
 */
export function mayManageBirthdates(role: Role): boolean {
  return role === 'admin'
}

/**
 * Whether a role moderates: removes and pins messages in the channels it may open, is alerted to
 * reports, and reads and closes them. Admins and chat admins.
 */
export function mayModerate(role: Role): boolean {
  return role === 'admin' || role === 'chat-admin'
}
