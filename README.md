# Phon

A church team chat for iPhone and Android, built on Planning Center, with no direct messages of any kind.

Phon starts with one church. Every record carries a church ID, so any church on Planning Center can use it later.

The spec is [phon#1](https://github.com/nick-vogel/phon/issues/1).

## Layout

A pnpm workspace:

- `apps/server`: the server, a Cloudflare Worker. One Durable Object per church holds its directory (people and channels), and one per channel holds that channel's messages and its live WebSockets.
- `packages/api-types`: `@phon/api-types`, the wire types the server and the phone app share. Types only.
- `apps/app`: `@phon/app`, the phone app. An Expo app (React Native, expo-router) that opens on the member's channel list, with a Settings screen and a channel screen built on `@kesha-antonov/react-native-chat`. It holds no rules: it shows what the server sends.

## Scripts

Run these from the root after `pnpm install`:

- `pnpm lint`: Biome over the whole workspace.
- `pnpm typecheck`: TypeScript in every package.
- `pnpm test`: the tests in every package.
- `pnpm build`: the Worker's `wrangler deploy --dry-run`, which bundles it without deploying, and an Expo export of the app for iOS and Android into `apps/app/dist`.
- `pnpm dev:server`: `wrangler dev` for the Worker, with the local env (see "Local development").
- `pnpm dev:app`: `expo start` for the phone app, with the local env.
- `pnpm env:check`: checks that the local env delivers every name in `.env.example`, and that no package holds an env file of its own. It prints names only.

CI runs `lint`, `typecheck` and `test` on every pull request.

## Local development

Run the Worker with `pnpm dev:server` and the app with `pnpm dev:app`. Both go through `scripts/with-env.mjs`, which builds their environment from one of two sources (eng-pipeline#54):

- Nick's Mac reads `phon/local.env` from the private secrets repo, cloned at `~/.config/sops/envs` (`SOPS_ENV_DIR` overrides it), encrypted with SOPS. The wrapper decrypts it for each run. Never run `sops` yourself; the standard is `~/.claude/docs/secrets.md`.
- A clone with no secrets repo copies `.env.example` to `.env` at the repo root (git-ignored) and fills it in. It needs no SOPS and no age.

The order, highest first, is the SOPS file, then the root `.env`, then the shell. The wrapper fails, and names each one, when a name in `.env.example` is not set at all (an empty value is fine). It also refuses to run while a package holds an env file of its own (`apps/server/.dev.vars`, `apps/server/.env*`, `apps/app/.env*`), because `wrangler dev` and Expo read those ahead of the wrapper's environment. `wrangler dev` reads the four secrets that `wrangler.jsonc` names in `secrets.required` from that environment, and a missing one only logs a warning. A missing `EMAIL_HASH_KEY` fails `POST /auth/email/code` and `POST /auth/email/session` with an error that names it.

The tests need no env: `apps/server/vitest.config.ts` sets fixed test values for the four secrets.

## The phone app's settings

The app reads one variable when it is bundled, from the same local env as the Worker:

- `EXPO_PUBLIC_PHON_API_URL`: the Worker's origin, such as `https://phon.example.workers.dev`. The app derives the WebSocket origin from it.

## Sign-in

A volunteer signs in with their Planning Center account: OAuth 2.0 with PKCE and the `openid` scope, through one confidential OAuth application. The Worker keeps no state between the three routes:

1. `GET /auth/start?code_challenge&state&nonce`: the app makes the PKCE verifier, the state and the nonce, and opens this route in an auth session. The Worker redirects to Planning Center's authorize page with its client ID and its redirect URL, `<worker origin>/auth/callback`.
2. `GET /auth/callback`: Planning Center sends the browser here, and the Worker sends only the `code` and the `state` (or the `error` and the `state`) back to the app at `phon://sign-in`.
3. `POST /auth/session` with the code, the verifier and the nonce: the Worker exchanges the code with the client secret, reads `organization_id` and `sub` from the ID token, and answers a Phon session when that church knows the person. A person the church does not know gets 403 `{ "problem": "not-known" }`, and a failed exchange gets 400 `{ "problem": "sign-in-failed" }`.

Planning Center tokens never leave the server: the Worker drops them after it reads the ID token, and stores none. The app sends its Phon session as `Authorization: Bearer <token>`, and keeps it in the phone's secure storage.

The Worker needs four secrets: `PCO_CLIENT_ID` and `PCO_CLIENT_SECRET`, `EMAIL_HASH_KEY`, and `KLIPY_API_KEY`. Their deployed values live in `phon/prod.env` in the private secrets repo, and Nick pushes them from there with `pnpm secrets:push phon`, in his own terminal (eng-pipeline#54). Creating the real OAuth application and registering its redirect URL, `<worker origin>/auth/callback`, is [phon#14](https://github.com/nick-vogel/phon/issues/14).

`EMAIL_HASH_KEY` is the HMAC key of the hashes email code sign-in stores in place of an address and a code, so a leaked church directory confirms no guessed address and no code. Make one with `openssl rand -hex 32`; the Worker uses the string's bytes as the key, as it is. Email code sign-in does not work on the deployed Worker until it has its own `EMAIL_HASH_KEY`, never the local one. Agents never run `wrangler secret`. `wrangler deploy` refuses while it is unset. Changing it voids every live email code and starts every address's send counts over.

`KLIPY_API_KEY` is the KLIPY app key the GIF search sends (see GIFs below). It stays on the Worker and never reaches the app. A Testing-mode key allows 100 requests an hour; production access is requested in KLIPY's Partner Panel. `wrangler deploy` refuses while it is unset.

Every request to Planning Center goes through one function, `planningCenterFetch` in `apps/server/src/planning-center.ts`, which sends `User-Agent: Phon (https://phon.chat)`, as Planning Center asks.

### Limits for each caller

Every route the Worker answers before sign-in (`GET /churches`, the `/auth/*` and `/connect*` routes, and `POST /me/sign-out`) has limits for each caller, through the Workers Rate Limiting binding. A caller is the address in `CF-Connecting-IP`: one IPv4 address, or one IPv6 /64. Each caller may make 100 such requests a minute, 10 `POST /auth/email/code` and 1 `POST /auth/email/session`. A caller past a limit gets 429 `{ "problem": "try-again" }` with `Retry-After: 60`, before the request's body is read. `apps/server/wrangler.jsonc` holds the values and the reason for each. The limits are approximate and counted in each Cloudflare location on its own. `wrangler dev` and the tests use a local simulation of the binding.

## Roles and channels

A person has one of three roles in their church: `member` (the default), `chat-admin` or `admin`. Roles are set in Phon, never synced. The rules live in one file, `apps/server/src/permissions.ts`:

- No member can create any channel, and there is no direct message kind, so a direct message or a room for two cannot exist.
- A chat admin creates open channels (`POST /channels` with `kind: 'open'`).
- An admin creates open and private channels, and sets a private channel's members (`GET` and `PUT /channels/:channelId/members`). A private channel has at least three members. A person taken out loses the channel and its history, and any socket they hold on it closes with code 4403. No one else can read or change its members: a chat admin outside it gets 404, and one inside it gets 403, so a chat admin cannot add themselves.
- Only admins and chat admins post in announcements. The channel checks on every send, so a role change takes effect on the next message.
- An admin lists the church's people (`GET /people`) and sets roles (`PUT /people/:personId/role`). The church's last admin cannot be demoted.

`GET /me` carries the person's `role`, the kinds they may create (`canCreate`) and `canAssignRoles`, and each channel in `GET /channels` carries `canPost`, so the app shows the right screens and holds no rules.

### Read markers

Each channel's object keeps one read marker per person, the newest message they have seen there. `PUT /channels/:channelId/read` with `{ "messageId": "..." }` moves it and answers 204. A marker only moves forward: marking an older message answers 204 and leaves it where it is. It is the person's, not the session's, so a read on one phone shows on every other. A message not in the channel answers 404, as does a channel the person may not open. An admin who reads the channel only by oversight gets 204, and nothing is stored: no marker and no oversight row.

Each of the person's own channels in `GET /channels` carries `unread`, whether any message after their marker is someone else's and not deleted, and `mentions`, how many of those @mention them. A person with no marker has read nothing yet. Each also carries `lastMessage`, the channel's newest message that is not deleted, whoever wrote it: the author's first name (null once they leave the church), the text or the caption, `photo` or `gif` for an image or null for text, and the sent time. It is null for a channel with no messages, and a deleted or removed message is never the last one. And each carries `alertLevel`, the person's level for the channel, stored or the kind's default, the same level `GET /channels/:channelId/alerts` answers. An oversight channel carries none of the four.

The church's directory keeps each person's unread mention total across their channels, the number the app icon's badge shows. A message that @mentions them adds one, even when their alerts let no push through. A read marker that passes mentions takes them away, as do a deleted or removed message they had not read yet and their removal from the channel. Each `GET /channels` sets the total to the sum of the `mentions` it lists, which corrects any drift. Every push carries the recipient's total as Expo's `badge`: messages, team announcements, urgent messages, birthdate requests and reports.

The app asks for the badge with the notification permission, sets the icon's badge to the sum of the list's `mentions` on each `GET /channels` it loads, and lets a push set it, in the foreground too. On Android the app never sets the badge itself, because Expo's set of 0 there dismisses every notification in the shade; the launcher counts the notifications. The list loads again, even under another screen, when the app comes to the foreground and when a read marker is taken. A read sends no push, so another phone keeps its badge until its next push or list load.

### Connecting a church

Connecting a church names its first admin. It is the sign-in flow with the People scope added: `GET /auth/connect/start` (scopes `openid people`, the same `<worker origin>/auth/callback` and `phon://sign-in`), then `POST /auth/connect` with the code, the verifier and the nonce. The Worker asks `isOrganizationAdministrator` with the person's own access token and then drops the tokens. A Planning Center organization administrator of a church with no admin yet becomes its admin and gets a Phon session. Anyone else gets 403 `{ "problem": "not-administrator" }`; once the church has an admin, a later connect gets 409 `{ "problem": "already-connected" }`; a failed exchange gets 400 `{ "problem": "sign-in-failed" }`. The sign-in screen offers "Connect your church" when Phon does not know the person.

### Moderation and reports

Admins and chat admins moderate (`mayModerate`). They do it in any channel they may open, so an admin may moderate a private channel they read by oversight, and a chat admin only the channels they are in or that are open to everyone:

- `POST /channels/:channelId/messages/:messageId/remove` removes anyone's message. It is kept and marked like an author's delete, with the remover as `deleted.by`: members and chat admins lose it from history and get a `removed` frame, and admins keep it in history and get an `updated` frame with it marked. `DELETE /channels/:channelId/messages/:messageId` stays the author's own delete.
- `PUT` and `DELETE /channels/:channelId/messages/:messageId/pin` pin and unpin a message. A pinned message carries `pinned: { at, by }`, and every socket gets the message as an `updated` frame. A second pin keeps the first. Removing a pinned message clears its pin.
- A member gets 403 for each, and a channel the caller may not open answers 404.

Anyone who may open a channel reports a message in it with `POST /channels/:channelId/messages/:messageId/reports`. The report pushes every device of every admin, and of every chat admin who may open the channel, but the reporter's own: "Message reported", "A message in #<channel> was reported.", with no names and no text. A second report of the same message by the same person, while the first is open, files nothing and pushes no one. `GET /reports` lists the open reports a moderator may see, newest first, with the message as they may see it now: an admin sees one removed since, marked, and a chat admin gets `message: null`. A chat admin sees no report from a channel they may not open. `POST /reports/:reportId/close` closes one for everyone. `GET /me` carries `canModerate`, and the app's Settings shows "Reports" in its Admin section when it is set.

## Reactions and images

A person who may open a channel as a member reacts to any message in it, in announcements too, with one emoji at a time: a `react` or `unreact` frame on the channel's socket. The server answers every socket in the channel with the message's whole reaction set, as a `reactions` frame. An admin who reads a private channel only by oversight cannot react, because oversight is read only.

A member posts an image with `POST /channels/:channelId/images`, a `multipart/form-data` body with one `image` file part, an optional `body` caption, and an optional `teamAnnouncement` or `urgent` part set to `true`. It goes through the same post gate as a text message, those two options included. The server takes JPEG, PNG, WebP and GIF up to 10 MiB, checks each file's first bytes against its type, keeps it in R2 under `<churchId>/<channelId>/<imageId>`, and posts the message, which every open socket receives. `GET /channels/:channelId/images/:imageId` serves it to whoever may read the channel's history, admins included, and to no one else. The image of a deleted message is hidden from members, as the message is.

The Worker binds the bucket `phon-images` as `IMAGES` (`apps/server/wrangler.jsonc`). The bucket has to exist on the Cloudflare account before the first deploy.

### GIFs

The composer's GIF button opens a GIF keyboard, whose search field reads "Search KLIPY", the attribution KLIPY requires. The app searches with `GET /gifs?q=<text>&page=<n>`, open to any current person of the church. The server searches KLIPY with its own key and fixed parameters: `content_filter=high` (G rated only) and `format_filter=gif` on every request, whatever the app's query says. It answers only allow-listed fields, each GIF's slug, title, a preview file and the file to post, and drops any GIF whose kept strings carry the key. A KLIPY failure answers 502 with Phon's own body. The app downloads the picked GIF's file from KLIPY's CDN and posts it with `POST /channels/:channelId/images` like any image, so the post gate, the send options and the 10 MiB limit apply as they do to a photo.

## Roster sync

Planning Center Services, and the Groups of the Group types an admin turns on, are the source of truth for who is in which channel. The sync reads with one dedicated Planning Center account per church, the sync account, and never with a volunteer's token: sign-in drops every volunteer token, as above.

### Connecting the sync account

An administrator connects the sync account through the same three-step flow as sign-in, on its own routes:

1. `GET /connect/start?code_challenge&state&nonce` redirects to Planning Center's authorize page with the scopes `openid people services groups` and the redirect URL `<worker origin>/connect/callback`. Services is read now, Groups is for small groups (phon#7), and People is for birthdates (phon#13) and the administrator check.
2. `GET /connect/callback` sends only the `code` and the `state` (or the `error` and the `state`) back to the app at `phon://connect`.
3. `POST /connect` with the code, the verifier and the nonce exchanges the code and answers 204. Only a Planning Center organization administrator may connect or replace a church's sync account: the Worker asks `GET /people/v2/me` with the new access token, and stores the connection only when it answers `site_administrator: true`. Anyone else gets 403 `{ "problem": "not-administrator" }` and nothing is stored, and a failed exchange gets 400 `{ "problem": "connect-failed" }`. The check is one function, `isOrganizationAdministrator` in `apps/server/src/planning-center.ts`.

The sync account's access token, refresh token and expiry stay on the server, in the church's own directory, with the person ID of the administrator who connected it. No token reaches the app. The church is also listed in the `ChurchRegistry` Durable Object, which the sync walks. That redirect URL, `<worker origin>/connect/callback`, has to be registered on the OAuth application alongside the sign-in one.

The app's connect screen (`apps/app/app/connect.tsx`), linked from the sign-in screen as "Connect your church's sync account" and reachable signed out, plays these three steps and saves no session, because connecting the sync account signs no one in.

### What a sync does

A Cron Trigger runs the sync every 15 minutes (`*/15 * * * *` in `apps/server/wrangler.jsonc`), for every connected church in turn. For each church it:

1. Refreshes the sync account's access token when it expires within 5 minutes, and stores the new access and refresh tokens before anything else, because Planning Center issues a new refresh token on every refresh.
2. Reads `GET /services/v2/teams`, then each team's `people` and `team_leaders`, 100 records a page, skipping archived or deleted teams and archived people. A leader counts as a member of their own team. Each person's `birthdate` comes from the same Services person records.
3. Reads `GET /groups/v2/group_types`, then, for each Group type whose sync an admin turned on, its Groups that are not archived (`/groups/v2/group_types/<id>/groups?where[archive_status]=not_archived`) and each Group's `memberships?include=person&fields[Person]=first_name,last_name,child`. A Group leader counts as a member. A Group type that is off is never read past the type list.
4. Reads the birthdate of each person in a synced Group who is on no Services team and whom Groups does not mark as a child, from Planning Center People (`GET /people/v2/people/<id>`).
5. Applies what it read in one transaction, and only once all of it was read. A failed read, a refused refresh or a 429 past the retry limit leaves everything as it was.

Applying writes one `team` channel per Services team (`team-<team id>`, named and renamed after the team), a `team-leads` channel holding exactly the leaders of every team, and the church-wide channels `general`, `off-topic`, `prayer-requests` and `announcements`, which everyone on any team can open, and so can every admin and chat admin (below). A person removed from a team loses that channel and its history, and any socket they hold on it closes with code 4403. A person on no team any more, and in no synced Group, can no longer sign in, and their sessions stop working. Their row is kept, so the messages they wrote keep their name. An admin or chat admin is the exception: they stay a current person on no team and in no Group, because church office staff often hold a role without serving on a team. Every admin and chat admin counts as serving, whether or not they are on a team and whether or not they are in a synced Group, so they open the church-wide channels as a member and post where their role allows, announcements included. Once an admin makes them a member, the plain member rule applies: they open the church-wide channels only while they serve on a team, a person only in a Group keeps just their small group channels, and the next sync takes out a person on no team and in no Group like anyone else. The age rule still takes out anyone under 13 whatever their role, but only by a birthdate it can see: one the sync reads for a person on a team or in a Group, or one entered in Phon. The sync never reads the age of an admin or chat admin on no team and in no Group. A team gone from Planning Center keeps its channel and history, with no members.

### Small groups

Each Group of a Group type whose sync is on gets a `small-group` channel (`group-<group id>`, named and renamed after the Group) holding exactly the Group's members. The channel opens only when the Group has three or more members: below three, none of its members lists or opens it, and a Group that drops to two closes it for the two who remain, whose sockets close with code 4403. A person removed from a Group loses its channel and its history, like a person removed from a team. A Group type turned off, a Group archived, or a Group gone from Planning Center keeps its channel and history, with no members.

A person in a synced Group who serves on no Services team is a current person of the church, so they can sign in, but they see only their small group channels: `general`, `off-topic`, `prayer-requests` and `announcements` are for people who serve. An admin or chat admin in a Group is the exception, since every role holder counts as serving. A person on a team and in a Group sees both, under their Services name.

Group sync is off for every Group type until an admin turns it on, in the app's "Group sync" screen:

- `GET /group-types` lists the church's Group types the latest sync saw, sorted by name, each with `syncEnabled`. A type new to Planning Center starts off, and no type shows before the first sync.
- `PUT /group-types/:groupTypeId/sync` with `{ "enabled": true }` or `{ "enabled": false }` answers 204, or 404 for a type the latest sync did not see. The change takes effect at the next sync, within 15 minutes.
- Only admins may use either route: anyone else, a chat admin included, gets 403.

The sync paces itself from Planning Center's own headers and hard-codes no limit: once `X-PCO-API-Request-Rate-Count` reaches `X-PCO-API-Request-Rate-Limit`, it waits `X-PCO-API-Request-Rate-Period` seconds, and on a 429 it waits `Retry-After` seconds and repeats the call, up to 5 times.

## Age rules and birthdates

The age rule lives once, in `apps/server/src/age.ts`, counted on today's UTC date. The sync skips anyone under 13, and anyone Groups marks as a child: they are dropped from the people, every team, the team leads and every small group before anything is applied, so they are never synced, cannot sign in, and someone already in Phon whose Planning Center birthdate turns out to be under 13 is taken out on the next sync, live sockets closed. A person with no birthdate on file is a minor, and so is anyone 13 to 17; 18 or older is an adult. A person on a Services team takes the birthdate Services reads, and a person only in small groups the one Planning Center People holds, so both follow the same age rules. The birthdate the sync last read is the one on file, and none in Planning Center is none in Phon.

- `GET /me/birthdate` answers the person's `BirthdateStatus`: the birthdate on file, a pending one, and the age group.
- `PUT /me/birthdate` with `{ "birthdate": "YYYY-MM-DD" }` enters the person's own birthdate, only while none is on file (409 otherwise). A date that is not a real calendar date, in the future, or before 1900 answers 400. A birthdate that makes them 13 to 17 is written to their Planning Center profile at once (`PATCH /people/v2/people/:id`, with the sync account's token, refreshed first when it is about to expire, never the person's own), and stored once Planning Center takes it. One under 13 is written the same way and takes the person out of Phon. One that makes them 18 or older waits for an admin's approval and pushes a "Birthdate to approve" alert to every admin and to the leaders of the person's Services teams. A refused write answers 502 and a church with no sync connection 503, and both change nothing.
- `GET /birthdate-requests` lists the pending birthdates, oldest first. `POST /birthdate-requests/:personId/approval` writes one to Planning Center and stores it (204), and `DELETE /birthdate-requests/:personId` declines it, writing nothing. Admins only, and never their own.
- `GET /people/without-birthdate` lists every current person with no birthdate on file, for admins.

A minor opens fewer channels than an adult (phon#17): announcements while they count as serving, and the team and team leads channels they are a synced member of. They open no open channel, no small group and no private channel, whatever their role, and an admin's oversight never widens that, so a minor admin or chat admin reads only what any minor reads and creates no channel. A private channel refuses a minor: a create or a member change that names one answers 400 and changes nothing. Only adults count toward the three a small group or a private channel needs, so a Group of two adults and a minor stays closed to everyone. A pending 18+ birthdate changes nothing until an admin approves it. When a sync takes an adult's birthdate away, or corrects it to 13 to 17, the channels a minor cannot open close to them on that sync, live sockets included. The sync never reads the birthdate of an admin or chat admin on no team and in no Group, so one with none on file is a minor until an 18+ birthdate they enter is approved by another admin.

## Tests

The server's tests run inside Cloudflare's Vitest integration (`@cloudflare/vitest-plugin`), against the Worker's public surface: its HTTP routes and its WebSockets. Every outgoing fetch goes through one recorder, `apps/server/test/support/network.ts`, which answers only the calls a test stubs and fails the test on any other. The R2 bucket is Miniflare's local simulation: the `IMAGES` binding in `wrangler.jsonc` has no `remote` key, and `apps/server/vitest.config.ts` replaces it with a local bucket in any case, so no test reaches a real one.

The tests run against a test entry, `apps/server/test/support/test-worker.ts`, which accepts seeded test identities and has a seed route. The deployed entry, `apps/server/src/index.ts`, has neither. The sign-in, connect and roster sync tests drive the deployed entry against a fake Planning Center, `apps/server/test/support/planning-center.ts`, fake Services and Groups APIs, `apps/server/test/support/services.ts` and `apps/server/test/support/groups.ts`, which page and throttle the same way through `apps/server/test/support/json-api.ts`, and a fake People API for birthdate reads and writes, `apps/server/test/support/people.ts`. The GIF search tests run against a fake KLIPY, `apps/server/test/support/klipy.ts`, which records every search's query. The roster sync tests run the deployed entry's `scheduled` handler, and assert only on what people can list and open afterwards and on the recorded Planning Center calls. In the fakes and the seed, a person whose fixture names no birthdate has an adult's (`ADULT_BIRTHDATE` in `apps/server/test/support/people.ts`), and `null` is none on file.

## License

Phon is source-available under the Functional Source License, version 1.1, with Apache 2.0 as its future license (FSL-1.1-ALv2). The full terms are in [LICENSE.md](LICENSE.md). Copyright 2026 NLVogel, LLC.

You can read the code, run it, change it and share it, for any purpose except a competing use. Running Phon for your own church or organization is fine. So is non-commercial education or research, and so is setting it up or supporting it for a church that runs it under these terms.

A competing use is offering Phon, or something built from it, to others as a commercial product or service that does the job Phon does. It is also a competing use to offer one that replaces another NLVogel, LLC product built on Phon, if that product exists when the version of Phon is published. You cannot host a copy of Phon and charge churches for it.

Two years after each version of Phon is published, that version is also yours under the Apache License, Version 2.0, with no competing-use limit.

FSL is not an OSI-approved open source license. Phon takes no outside code contributions for now.
