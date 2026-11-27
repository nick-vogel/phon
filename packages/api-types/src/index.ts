/**
 * The wire types the server and the phone app share. Types only: nothing here runs.
 */

/** One stored message in one church's channel. */
export interface Message {
  id: string
  churchId: string
  channelId: string
  /** The person who sent it. */
  authorId: string
  body: string
  /** ISO 8601 timestamp, set by the server when it stores the message. */
  sentAt: string
  /**
   * The people this message @mentions, as the server kept them: distinct current people who may
   * open the channel as members, in the order sent. Empty when it mentions no one.
   */
  mentions: string[]
  /**
   * Present only on a message its author deleted, or an admin or chat admin removed (`by` tells
   * which), and only admins ever receive one: members and chat admins never see a deleted message.
   */
  deleted?: { at: string; by: string }
  /** Present only on a pinned message: when it was pinned and by whom. */
  pinned?: { at: string; by: string }
  /** The image posted with it, or null for a text message. The body is then its caption. */
  image: MessageImage | null
  /** Its reactions, each emoji in the order it was first used. Empty when it has none. */
  reactions: Reaction[]
  /**
   * Present only on a team announcement: a team leader's post in their own team channel, which
   * alerts the whole team.
   */
  teamAnnouncement?: true
  /**
   * Present only on an urgent message, from an admin or chat admin, which alerts everyone in the
   * channel, even during quiet hours.
   */
  urgent?: true
}

/**
 * An image posted in a channel. The app fetches its bytes from
 * `GET /channels/:channelId/images/:id` with the same `Authorization` header as every call.
 */
export interface MessageImage {
  id: string
  /** One of `image/jpeg`, `image/png`, `image/webp` or `image/gif`. */
  contentType: string
}

/** One emoji on a message, and the people who reacted with it, in the order they reacted. */
export interface Reaction {
  emoji: string
  personIds: string[]
}

/**
 * The answer to `POST /channels/:channelId/images` (201): the message it posted. The upload is a
 * `multipart/form-data` body with one `image` file part, an optional `body` caption part, and an
 * optional `teamAnnouncement` or `urgent` part, which asks for that option only when it is `true`.
 */
export interface ImagePosted {
  message: Message
}

/** One file of a GIF on KLIPY's CDN, at one size. */
export interface GifRendition {
  /** An `https://` URL the app downloads with no `Authorization` header. */
  url: string
  width: number
  height: number
}

/**
 * One GIF from a search: a G-rated GIF from KLIPY. `preview` is the small file the picker shows;
 * `send` is the file the app downloads and posts with `POST /channels/:channelId/images` as an
 * `image/gif`, like any image. The server picks a `send` file within the image route's size limit.
 */
export interface Gif {
  /** KLIPY's slug for the GIF. */
  id: string
  title: string
  preview: GifRendition
  send: GifRendition
}

/**
 * The answer to `GET /gifs?q=<text>&page=<n>`: one page of a GIF search, `page` counted from 1, and
 * whether a later page exists.
 */
export interface GifSearchResults {
  gifs: Gif[]
  page: number
  hasNext: boolean
}

/**
 * A channel's history, oldest message first, with the name of each of its authors who is a current
 * person of the church, in the order each first posted. An author who left the church is not in
 * `authors`.
 */
export interface ChannelHistory {
  messages: Message[]
  authors: ChannelAuthor[]
}

/** One author in a channel's history: a current person of the church who posted in it. */
export interface ChannelAuthor {
  personId: string
  name: string
  /**
   * A URL the app can load for the person's photo, or null. Null for a minor (13 to 17, or no
   * birthdate on file) and for a person with no uploaded photo in Planning Center. It changes after
   * the next roster sync. When the URL is on Phon's own server, the app sends the same
   * `Authorization` header as every call.
   */
  avatar?: string | null
}

/**
 * A frame the app sends over a channel's WebSocket. `mentions` names the people the body
 * @mentions, by person ID; the server keeps only those who may open the channel.
 * `teamAnnouncement` asks to post a team announcement, which only the team's leaders may, and
 * `urgent` an urgent message, which only admins and chat admins may. A send that asks for one its
 * sender may not post is refused with an `error` frame and stored nowhere.
 */
export type ClientFrame =
  | {
      type: 'send'
      body: string
      mentions?: string[]
      teamAnnouncement?: boolean
      urgent?: boolean
    }
  /** Adds the sender's reaction with this emoji to a message. A repeat changes nothing. */
  | { type: 'react'; messageId: string; emoji: string }
  /** Takes the sender's reaction with this emoji off a message. A missing one changes nothing. */
  | { type: 'unreact'; messageId: string; emoji: string }

/** A frame the server sends over a channel's WebSocket. */
export type ServerFrame =
  | { type: 'message'; message: Message }
  /** Take this message out of view: its author deleted it, or a moderator removed it. */
  | { type: 'removed'; messageId: string }
  /**
   * Replace the message with this ID by this one, such as an admin's copy marked as deleted, or a
   * message pinned or unpinned.
   */
  | { type: 'updated'; message: Message }
  /** A message's reactions changed: replace them with these, its whole set after the change. */
  | { type: 'reactions'; messageId: string; reactions: Reaction[] }
  | { type: 'error'; reason: string }

/**
 * How a channel is reached: `open` and `announcements` by everyone who serves, `team` and
 * `team-leads` by their synced members only, `small-group` by the synced members of a Planning
 * Center Group once it has three or more, and `private` by the members an admin sets.
 *
 * There is no direct message kind, and there never will be: no request can create a channel for
 * one or two people.
 */
export type ChannelKind =
  | 'announcements'
  | 'open'
  | 'private'
  | 'small-group'
  | 'team'
  | 'team-leads'

/** The only kinds a request can create. Every other kind is made by the roster sync. */
export type CreatableChannelKind = 'open' | 'private'

/** A person's role in their church: set by admins in Phon, never synced. */
export type Role = 'member' | 'chat-admin' | 'admin'

/**
 * One channel as the channel bar shows it. A channel the signed-in person reads through oversight
 * (`oversight: true`) carries only `id`, `name`, `kind`, `canPost` and `oversight`.
 */
export interface ChannelSummary {
  id: string
  name: string
  kind: ChannelKind
  /** Whether the signed-in person may post here. The server decides; the app only shows it. */
  canPost: boolean
  /**
   * Present only when the signed-in person reads this channel as an admin and is not one of its
   * members. Opening a private channel this way is recorded for the other admins.
   */
  oversight?: true
  /**
   * Present only on a team channel the signed-in person leads in Planning Center Services, where
   * they may post team announcements.
   */
  leads?: true
  /**
   * Whether the channel has a message newer than the signed-in person's read marker that is not
   * their own and not deleted. Sent on each of the person's own channels; an oversight channel
   * carries none.
   */
  unread?: boolean
  /**
   * How many unread messages @mention the signed-in person, 0 when none. A deleted message never
   * counts. Sent on each of the person's own channels; an oversight channel carries none.
   */
  mentions?: number
  /**
   * The channel's newest message that is not deleted, or null for a channel with no messages yet.
   * Sent on each of the person's own channels; an oversight channel carries none.
   */
  lastMessage?: LastMessage | null
  /**
   * The signed-in person's alert level for the channel, so the app shows the muted style for
   * `off`. Sent on each of the person's own channels; an oversight channel carries none.
   */
  alertLevel?: AlertLevel
}

/** A channel's newest message, as its row in the channel bar previews it. */
export interface LastMessage {
  /**
   * The author's first name, or null when the author is no longer a current person of the church.
   */
  authorFirstName: string | null
  /** The text, or the caption of a photo or GIF, which may be empty. */
  body: string
  /** `gif` for an image of `image/gif`, `photo` for any other image, null for a text message. */
  image: 'photo' | 'gif' | null
  /** ISO 8601, as `Message.sentAt`. */
  sentAt: string
}

/** The channels the signed-in member may open, sorted by name. */
export interface ChannelList {
  channels: ChannelSummary[]
}

/** The signed-in person, as their church's directory knows them. */
export interface Member {
  personId: string
  name: string
  role: Role
  /** The channel kinds this person may create, so the app knows which screens to show. */
  canCreate: CreatableChannelKind[]
  /** Whether this person may set other people's roles. */
  canAssignRoles: boolean
  /** Whether this person may read the oversight log (`GET /oversight`). */
  canReadOversight: boolean
  /** Whether this person may mark a message urgent: admins and chat admins. */
  canMarkUrgent: boolean
  /**
   * Whether this person approves self-entered birthdates and reads the list of people with no
   * birthdate: admins only.
   */
  canManageBirthdates: boolean
  /**
   * Whether this person moderates: removes and pins messages in the channels they may open, and
   * reads and closes reports. Admins and chat admins.
   */
  canModerate: boolean
  /**
   * A URL the app can load for this person's photo, or null. Null for a minor (13 to 17, or no
   * birthdate on file) and for a person with no uploaded photo in Planning Center. It changes after
   * the next roster sync. When the URL is on Phon's own server, the app sends the same
   * `Authorization` header as every call.
   */
  avatar?: string | null
}

/**
 * Which age group a birthdate puts a person in. A person with no birthdate is a `minor`, and so is
 * anyone 13 to 17; `adult` is 18 or older. `under-13` only ever answers the birthdate entry that
 * takes the person out of Phon: no one under 13 is synced.
 */
export type AgeGroup = 'under-13' | 'minor' | 'adult'

/**
 * The signed-in person's birthdate (`GET` and `PUT /me/birthdate`): the one on file, or null, and
 * a self-entered 18+ birthdate waiting for an admin's approval, or null. Dates are `YYYY-MM-DD`.
 */
export interface BirthdateStatus {
  birthdate: string | null
  pendingBirthdate: string | null
  ageGroup: AgeGroup
}

/** What the app sends to `PUT /me/birthdate`: a `YYYY-MM-DD` date. */
export interface SetBirthdateRequest {
  birthdate: string
}

/** A self-entered 18+ birthdate waiting for an admin's approval. */
export interface BirthdateRequest {
  personId: string
  name: string
  /** `YYYY-MM-DD`. */
  birthdate: string
  /** ISO 8601. */
  requestedAt: string
}

/** Every birthdate waiting for approval, oldest first (`GET /birthdate-requests`, admins only). */
export interface BirthdateRequestList {
  requests: BirthdateRequest[]
}

/**
 * Every current person of the church with no birthdate on file, sorted by name
 * (`GET /people/without-birthdate`, admins only).
 */
export interface PeopleWithoutBirthdate {
  people: Array<{ personId: string; name: string }>
}

/**
 * When a person's phone alerts them for a channel's messages.
 *
 * - `every-message`: every message anyone else posts.
 * - `mentions-and-team-announcements`: a message that @mentions them, or a team announcement.
 * - `mentions`: a message that @mentions them.
 * - `off`: never, not even for an @mention.
 *
 * Announcements always alert, whatever is set, and an urgent message alerts at every level.
 * Quiet hours hold every alert but an urgent message's.
 */
export type AlertLevel = 'every-message' | 'mentions-and-team-announcements' | 'mentions' | 'off'

/**
 * The signed-in person's alert level for one channel (`GET /channels/:channelId/alerts`), and the
 * levels they may pick. `choices` is empty when the level cannot be changed, as for announcements.
 */
export interface ChannelAlerts {
  level: AlertLevel
  choices: AlertLevel[]
}

/** What the app sends to `PUT /channels/:channelId/alerts`. */
export interface SetAlertLevelRequest {
  level: AlertLevel
}

/**
 * What the app sends to `PUT /channels/:channelId/read`: the newest message that was on screen
 * while the channel was open. The marker only moves forward. The server refuses a message that is
 * not in the channel, ignores a person who reads the channel through oversight, and answers 204.
 */
export interface ReadMarkerRequest {
  messageId: string
}

/**
 * A person's quiet hours: one window a day, from `start` to `end` on the clock in `timeZone`, during
 * which nothing pushes to them but an urgent message. `start` and `end` are `HH:MM` on a 24-hour
 * clock; `start` is in the window and `end` is not. A window whose end is before its start runs
 * past midnight. `timeZone` is an IANA time zone ID, such as `America/Los_Angeles`.
 */
export interface QuietHours {
  start: string
  end: string
  timeZone: string
}

/**
 * A person's quiet hours setting: the answer of `GET /me/quiet-hours` and the body of
 * `PUT /me/quiet-hours`. `null` is no quiet hours.
 */
export interface QuietHoursSetting {
  quietHours: QuietHours | null
}

/** What the app sends to `POST /devices`: the device's Expo push token. */
export interface RegisterDeviceRequest {
  token: string
}

/**
 * The people who may open a channel as its members, sorted by name
 * (`GET /channels/:channelId/people`), so the composer can complete an @mention and each message
 * shows its author's name. It lists current people only.
 */
export interface ChannelPeople {
  people: Array<{ personId: string; name: string }>
}

/** One time an admin opened a private channel they are not a member of. */
export interface OversightView {
  viewId: string
  adminId: string
  adminName: string
  channelId: string
  channelName: string
  /** ISO 8601. */
  openedAt: string
}

/** Every recorded oversight view of the church, newest first (`GET /oversight`, admins only). */
export interface OversightLog {
  views: OversightView[]
}

/** Whether the signed-in person has seen the oversight notice (`GET /me/oversight-notice`). */
export interface OversightNotice {
  seen: boolean
}

/** One person of the church, as an admin sees them on the roles screen. */
export interface Person {
  personId: string
  name: string
  role: Role
}

/** Every current person of the church, sorted by name (`GET /people`, admins only). */
export interface PeopleList {
  people: Person[]
}

/**
 * One Planning Center Group type, as an admin sees it on the Group sync screen. While
 * `syncEnabled` is false, the roster sync reads none of its Groups.
 */
export interface GroupType {
  id: string
  name: string
  syncEnabled: boolean
}

/**
 * The church's Group types the latest sync saw, sorted by name (`GET /group-types`, admins only).
 */
export interface GroupTypeList {
  groupTypes: GroupType[]
}

/**
 * What the app sends to `PUT /group-types/:groupTypeId/sync`. The change takes effect at the next
 * roster sync.
 */
export interface SetGroupTypeSyncRequest {
  enabled: boolean
}

/** What the app sends to `PUT /people/:personId/role`. */
export interface SetRoleRequest {
  role: Role
}

/**
 * What the app sends to `POST /channels`. A `private` channel names its members, at least three;
 * an `open` channel names none, because everyone who serves may open it. The server answers 201
 * with the new channel's `ChannelSummary`.
 */
export interface CreateChannelRequest {
  name: string
  kind: CreatableChannelKind
  memberIds?: string[]
}

/** A private channel's members (`GET` and `PUT /channels/:channelId/members`). */
export interface ChannelMembers {
  personIds: string[]
}

/**
 * What the app sends to `POST /auth/session` once Planning Center has sent the browser back to
 * `phon://sign-in`: the code it received, the PKCE verifier it made, and the nonce it sent.
 */
export interface SignInRequest {
  code: string
  codeVerifier: string
  nonce: string
}

/** A Phon session. The app sends `token` as `Authorization: Bearer <token>` on every call. */
export interface SignInSession {
  token: string
}

/**
 * What the app may send to `POST /me/sign-out`, which ends the session it is sent with and answers
 * 204: the Expo push token this phone registered, so the server stops alerting it. A token that is
 * not the signed-in person's is left alone. The body is optional; without it the person's devices
 * keep alerting.
 */
export interface SignOutRequest {
  deviceToken?: string
}

/**
 * Why a sign-in was refused: Phon does not know the person for their church yet, or the sign-in
 * itself failed and can be tried again.
 */
export interface SignInRefusal {
  problem: 'not-known' | 'sign-in-failed'
}

/**
 * What the app sends to `POST /connect` once Planning Center has sent the browser back to
 * `phon://connect`, to connect its church's sync account: the same three values as a sign-in.
 */
export type ConnectRequest = SignInRequest

/**
 * Why connecting the sync account was refused: the account is not a Planning Center organization
 * administrator, or the connect itself failed and can be tried again.
 */
export interface ConnectRefusal {
  problem: 'not-administrator' | 'connect-failed'
}

/** A church with a connected sync account, by its Phon church ID and its Planning Center name. */
export interface ConnectedChurch {
  churchId: string
  name: string
}

/**
 * Every connected church with a name, sorted by name (`GET /churches`, which needs no sign-in): the
 * church picker's data before an email code sign-in.
 */
export interface ChurchList {
  churches: ConnectedChurch[]
}

/**
 * What the app sends to `POST /auth/email/code` to ask for a sign-in code by email: the church
 * picked from `GET /churches` and the address typed. The server answers 204 to every request,
 * whatever the address, so the answer never tells whether the church knows it. Only a Planning
 * Center failure, or a church that has spent its lookups for now, answers 503 with
 * `EmailSignInRefusal` `try-again`, and a caller past its limit 429 with `CallerLimitRefusal`.
 */
export interface EmailCodeRequest {
  churchId: string
  address: string
}

/**
 * What the app sends to `POST /auth/email/session` to sign in with the 6-digit code from the
 * email. The server answers 200 with a `SignInSession` when the address belongs to one known
 * person, or 200 with an `EmailNameChoice` when several known people share it; the app tells the
 * two apart by which key is present. Every failure answers 400 with `EmailSignInRefusal`
 * `wrong-code`: a wrong code, a used one, an expired one, or one past its 5 wrong tries. A church
 * past its limit of 100 wrong codes in an hour answers every check 503 with `EmailSignInRefusal`
 * `try-again`, the right code included, until its oldest wrong code is an hour old. A caller
 * past its limit of 1 check a minute gets 429 with `CallerLimitRefusal` before the code is read,
 * so one caller alone makes about 60 checks an hour, under the church's 100 (the limit is
 * approximate, and a burst sent at once can let a few more through).
 * Known limit: only a check against a live code counts, so near that limit 503 versus 400 tells a
 * stranger whether a guessed address is held, once checks from two or more callers bring the
 * church near it.
 */
export interface EmailCodeCheck {
  churchId: string
  address: string
  code: string
}

/**
 * The answer to a right code for an address several known people share, as families often do:
 * their names, sorted by name then person ID, and a short-lived token that lets the person pick
 * their own with `POST /auth/email/choice`. The names are never answered before the code is right.
 */
export interface EmailNameChoice {
  choiceToken: string
  people: Array<{ personId: string; name: string }>
}

/**
 * What the app sends to `POST /auth/email/choice` once the person picked their name. The server
 * answers 200 with a `SignInSession`, or 400 with `EmailSignInRefusal` `start-over` for every
 * failure: a person ID not in the code's match, an expired choice token, a used one, a person the
 * church no longer knows, or a malformed request. A token that signed a person in still answers a
 * new session for that same person for a minute, so the app may retry a choice whose answer was
 * lost; for anyone else it is used.
 */
export interface EmailPersonChoice {
  churchId: string
  choiceToken: string
  personId: string
}

/**
 * Why an email code request, check or name choice was refused: Planning Center could not be
 * asked and the person can try again, the code did not work, or the name choice did not work and
 * the person starts over with a new code.
 */
export interface EmailSignInRefusal {
  problem: 'try-again' | 'wrong-code' | 'start-over'
}

/**
 * Why connecting a church (`POST /auth/connect`, which names its first admin) was refused: the
 * person is not a Planning Center organization administrator, the church already has an admin,
 * or the sign-in itself failed and can be tried again.
 */
export interface ChurchConnectRefusal {
  problem: 'not-administrator' | 'already-connected' | 'sign-in-failed'
}

/**
 * The answer, 429 with `Retry-After` in seconds, to a caller past one of its limits on a route
 * answered before sign-in (`GET /churches`, the `/auth/*` and `/connect*` routes, and
 * `POST /me/sign-out`). A caller is one IPv4 address or one IPv6 /64. Each caller may make 100
 * such requests a minute, 10 `POST /auth/email/code` and 1 `POST /auth/email/session`. Each limit
 * is checked before the request's body is read, so it is the same whatever address, code or
 * church the request names.
 */
export interface CallerLimitRefusal {
  problem: 'try-again'
}

/**
 * One open report of a message. `message` is the reported message as the reader may see it now:
 * an admin sees one deleted or removed since, marked, and a chat admin gets null for it.
 */
export interface Report {
  reportId: string
  channelId: string
  channelName: string
  reporterId: string
  reporterName: string
  /** ISO 8601. */
  reportedAt: string
  authorId: string
  authorName: string
  message: Message | null
}

/**
 * The open reports the signed-in moderator may see, newest first (`GET /reports`, admins and chat
 * admins). A chat admin sees only reports from channels they may open.
 */
export interface ReportList {
  reports: Report[]
}
