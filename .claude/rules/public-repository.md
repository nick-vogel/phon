# The repository is public

**Everything a commit carries is published: its files, its message, its author and committer, and the title and body of the pull request that merges it.** Phon is a team chat for real churches, built on their Planning Center data, and the maintainer runs it next to other work on the same infrastructure. None of that private material may land here.

## What never lands

- **The name of any church or other organization the maintainer works for or with, other than the LLC that operates Phon**, in any form: the name, its initials, its domain, its Cloudflare Access team domain, and an email address at its domain. A test or a fixture names an invented church, such as "Riverside Chapel". Write `example.cloudflareaccess.com` for a team domain.
- **A real church's people and what they wrote**: member and staff names, email addresses, phone numbers, birthdates, Planning Center IDs, team and group names, and any message, caption, channel name or channel content from a real church. Fixtures and seed data use invented people. A screenshot of Phon is taken against seed data, or every real name and message is cropped out before it is committed.
- **Church-internal material**: anything quoted from or said about a church's own documents, policies, finances or staff decisions.
- **Real network details**: the server's public IP address, a tailnet address, a host name that is not already in the tree. Write documentation addresses from RFC 5737 (`192.0.2.x`, `198.51.100.x`). The Cloudflare account ID and the resource names in `apps/server/wrangler.jsonc` are public by choice.
- **Secrets and their near relatives**: a token, a key, a webhook URL, a database URL with a password, a Cloudflare Access AUD tag. The private secrets repo holds those.
- **A home folder**, in any path. Write `~/` or a made-up user such as `/Users/someone`.
- **An author or committer address other than a GitHub noreply address.**
- **Files whose license forbids a public repository**: any font (a church's commercial typeface included), and screenshots of other companies' apps or of real conversations, such as the design references for phon#245, which stay outside the repository.

## The check

`pnpm check:private` fails when the tree holds a term from the maintainer's private list. With `--range origin/main..HEAD` it reads each line the commits add, their messages and their authors, since a term added and later removed is still in the public history. With `--stdin` it reads a pull request's title and body. The list lives outside the repository, at `PRIVATE_TERMS_FILE` or `~/.config/phon/private-terms.txt`, because it names what it guards: never commit it, and never quote one of its terms in a commit, a review doc or a pull request. Where no list exists, as in a contributor's clone, the check passes with a note, and this rule is the whole guard.

Run it before every push, and on every pull request before its merge. The check does not read images, so a screenshot gets the look described above. A list term is a floor, not the rule: a new name that the list does not hold yet still never lands, and it goes on the list in the same session that finds it.

## The tracker

Issues filed before the public repository stay in the private archive, since they hold the material above. A `phon#<n>` reference from before the first public commit points at the archive. When work on one of its epics starts, the epic is filed again here, and new commits refer to the issue in this repository.
