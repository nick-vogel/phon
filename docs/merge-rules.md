# Merge rules

The merge owner (`/km:merge-owner`) reads this file before its first gate. Read from GitHub on
2026-11-24.

- **Review rules.** No review is required. `main` has no branch protection and no ruleset, so no
  rule asks for an up-to-date branch, and a push to a PR dismisses nothing.
- **Merge method.** A merge commit (`gh pr merge <n> --merge`) for every branch, epic and lane alike.
- **Together check.** CI runs it on every pull request: `pnpm install --frozen-lockfile`,
  `pnpm lint`, `pnpm typecheck`, `pnpm test`. A push to the PR costs nothing, so when `main` moved
  under a PR, update the branch and let CI test the combined tree.
- **Repo gates.** Durable Object migrations in `apps/server/wrangler.jsonc` (`migrations`, tags
  `v1`, `v2`, and so on) must stay in order across PRs: two PRs that each add the next tag
  conflict, and the second one takes the tag after the first.
- **Post-merge run.** None. CI ignores a push to `main`, and a deploy is a manual `wrangler deploy`.
