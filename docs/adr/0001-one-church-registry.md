# 1. One church registry for every church

Date: 2026-11-14

Status: accepted (phon#136)

## Context

Every church shares one `ChurchRegistry` Durable Object, named `all` (`apps/server/src/church-registry.ts`). It lists the churches the roster sync walks, and for each push token the church it is registered in. Every push batch of every church asks it which tokens that church may push to, and every `POST /devices` writes to it. So its request rate grows with the number of churches, and one object has a ceiling.

Cloudflare's Durable Objects limits page (https://developers.cloudflare.com/durable-objects/platform/limits/) says: "An individual Object has a soft limit of 1,000 requests per second." A request that does more work lowers that, and Cloudflare's Rules of Durable Objects page (https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) puts operations with storage writes at about 200 to 500 requests a second. An object past its limit queues requests, then answers an overloaded error, which the runtime does not retry.

### What the code sends the registry

`apps/server/test/registry-load.test.ts` counts the calls with a proxy around the real registry:

- **A push batch: exactly 1 call**, `ownedBy`, however many devices it reaches. `sendPushes` (`apps/server/src/expo-push.ts`) asks once for the whole batch; the registry splits the tokens into SQL queries of 99 inside that one call, and Expo requests of 100 go out after it. The test pins this with a batch of 250 devices and with the report route. A message's pushes are one `sendPushes` call (`Channel.alert` in `apps/server/src/channel.ts`), and so are a report's (`apps/server/src/moderation.ts`) and a birthdate request's (`apps/server/src/birthdates.ts`).
- **A registration: at most 3 calls**, a budget the test holds. Today a registration that lands is 1 call (`claimDevice`), a phone moving from one church to another is 1, a registration the church refuses after the `knows` check is 0, and a caller the church does not know is 0 (`registerDevice` in `apps/server/src/worker.ts`). The arithmetic below uses the budget, so the code can change inside it without making this record wrong.
- **Everything else is negligible.** The roster sync reads `churches()` once per 15-minute cron tick (`apps/server/src/roster-sync.ts`), and a church's `register` runs at most twice when its sync account connects, once to list the church and once more to store the name the connect read (`apps/server/src/connect.ts`). The church list (`GET /churches`, `apps/server/src/church-list.ts`) needs no sign-in, so anyone can call it, up to 100 times a minute for each caller address (phon#176), and the app asks it once per email code sign-in start. Its answer comes through an in-isolate cache, so it costs at most one `churches()` read per Worker isolate per 60-second period, however many calls arrive (phon#160). A failed read does not undo that: the cache keeps its last answer for another period, and with no answer yet it holds the error for 5 seconds, so an overloaded registry is not read once per call. Anonymous load no longer grows with the request rate: even 1,000 live isolates would send about 17 reads a second. A church shows on the list within 60 seconds of connecting or of its name being read. The name backfill on the tick is one `nameChurch` write per church with no stored name, and none once every church has one. Neither touches a push batch or a registration, and the test pins all four counts, the church list's as one read for every list inside the period, one more once it has passed, and none more inside the period, or the 5 seconds, after a read fails.

### The expected load

No repo document states the expected load of "several churches", so this record models a pessimistic one: 10 churches of up to 500 people each, all at their peak at the same moment, as Sunday mornings in one time zone are. Each church posts 1 message a second at peak, which is one push batch a second, and its reports and birthdate requests fit inside that. Every person signs in once within a 10-minute window, which is 500 / 600, about 0.83 registrations a second.

| Per church at peak | Rate                               | Registry calls each | Calls a second |
| ------------------ | ---------------------------------- | ------------------- | -------------- |
| Push batches       | 1 a second                         | 1                   | 1.0            |
| Registrations      | 0.83 a second                      | at most 3           | 2.5            |
| Roster sync        | 1 per 15 minutes, for all churches | 1                   | about 0        |
| Total              |                                    |                     | 3.5            |

For 10 churches that is about **35 requests a second** on the budget, and about 18 on today's code (1.83 a church). That is 3.5% of the stated soft limit of 1,000, and 17.5% of the cautious 200 for writing operations.

The break-even church count, where the model reaches the limit, is 1,000 / 3.5, about **285 churches**, at the stated limit, and 200 / 3.5, about **57 churches**, at the cautious figure. On today's counts the same figures are about 546 and 109. An `ownedBy` call for a church of 500 devices runs 6 SQL queries, which is heavier than a plain read, and that is why the cautious figure is the one to watch.

## Decision

Keep the one `all` registry. At the expected load of several churches it uses a few percent of one object's capacity, and the break-even is dozens to hundreds of churches away even with every church at its peak at once. Sharding it now would add routing to every push and every registration for no measured need.

## Consequences

- The verdict rests on counted calls and Cloudflare's stated limits, not on measured platform throughput. A local Vitest pool's speed says nothing about the deployed object.
- When the registry is overloaded, `sendPushes` logs the error and sends nothing for that batch, with no retry and no alert. A load problem would show up as missing pushes, not as an error anyone is told about.
- Look at this again when any of these happens:
  - a test in `apps/server/test/registry-load.test.ts` goes red, because a push batch or a registration now costs more than this arithmetic assumes;
  - the number of churches nears the cautious break-even of about 57, or one church's peak goes well past 1 message a second;
  - phon#128 (signing in to several churches on one phone) changes how a claim works, since a claim then adds a church instead of replacing it.
