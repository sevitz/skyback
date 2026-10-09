# skyback Handover

Full snapshot for a fresh Claude Code session picking this up cold, from GitHub alone,
with no memory of how it was built. If you only read one document in this repo, read
this one, then `docs/PROJECT-JOURNAL.md` for the detailed history.

## Project overview

skyback archives Sev's Bluesky Following timeline, and any of his saved feeds he switches
on, and serves a full text search over it at `skyback.sevitz.com`. The
point is finding a post he read in his feed and half remembers, which Bluesky itself
cannot do. One user: Sev, signed in through the family portal with an admin identity.

## Tech stack

Cloudflare Worker, plain JavaScript, bundled by wrangler. D1 with FTS5 (`posts_fts`,
external content over `posts`, unicode61 with diacritics removed). One cron trigger,
`17 5 * * *` (daily safety net; the page catches up when opened). Family sign-on via `auth.sevitz.com` JWKS. Bluesky via an app password and
a minimal AT Protocol client (`src/worker/bsky.js`), not the SDK. Workers free plan.

## Key identifiers (verified on disk)

- GitHub repo: `sevitz/skyback` (public once the pre-publication audit passed; see the journal).
- Cloudflare Worker: `skyback`, custom domain `skyback.sevitz.com`, `workers_dev = false`.
- D1 database: `skyback`, id `3dd5393d-f9e3-4960-9baf-a39226b5db8a`, primary in WEUR.
- 1Password: `op://_code_secrets/app.skyback` (`BSKY_HANDLE`, `BSKY_APP_PASSWORD`);
  `GITHUB_ISSUES_TOKEN` from the shared `app-ops` item.
- Backup Worker: none.

## Current state

v0.2.0, 2026-10-09. Deployed. Tests: `npm test` and `npm run smoke`. New in 0.2.0: status
line at the top, Search further back instead of continuous backfill, daily cron, public
`/demo`, new icon, public repo.

## First deploy

1. Create a Bluesky app password (Settings, Privacy and security, App passwords).
2. Create 1Password item `app.skyback` in `_code_secrets` with fields `BSKY_HANDLE` and
   `BSKY_APP_PASSWORD`.
3. In Cloudflare, create the Worker by connecting Workers Builds to `sevitz/skyback`
   (root directory `/`), or run `npm run deploy` once.
4. From the repo: `zsh ~/Code/app-ops/bin/migrate.sh remote`, then
   `zsh ~/Code/app-ops/bin/secrets-sync.sh`.
5. Add `sevitz/skyback` to the shared `GITHUB_ISSUES_TOKEN` PAT's repository access list,
   or the bug button will 404.
6. Open `skyback.sevitz.com`, press Sync now, then Feeds to pick extra feeds.

## Key design decisions and reasoning

- **Live archiving, not export.** The timeline is not in Bluesky's account export (that
  is your own repository only), so it can only be captured as it happens.
- **Budgets everywhere.** Free plan: 10ms CPU and 50 subrequests a run; D1's daily
  allowance is account wide and, since 2026-09-01, enforced by failing every query on the
  account. skyback measures and caps its own share. Numbers in the journal, section 6.
- **`since` cursor catch up.** Only new posts are sent and parsed on a normal run.
- **Write once.** A post is inserted the first time it is seen and never updated; seeing
  it again costs reads only. Counts on a post are a snapshot from first sight.
- **Admin only.** The portal says who; skyback adds `role === 'admin'`.

## Conventions and patterns

Family conventions (app-ops `CLAUDE.md`): zsh, 1Password with `op read`, version in
`package.json` shown in the footer and `/api/health`, journal entry per change, no em
dashes. Shared libraries vendored with `lib-sync.sh`; do not edit `auth-client/`,
`whoami/` or `bug-report/` here. Anything that touches D1 goes through `Store`.

## Outstanding items

- The first deploy steps above.
- How far back getTimeline will page is unknown until Search further back is used live.
- Real icons (template placeholders today).
- Possible: MCP endpoint for Claude; hub tab via auth's `KNOWN_APPS`; OAuth.

## Deploy and commit workflow

Push to `main`; Workers Builds deploys. Migrations only by `migrate.sh remote`, never on
push. Secrets only by `secrets-sync.sh`. Before pushing: `npm test` and `npm run smoke`.

## Gotchas and intentional oddities

- The page script is `src/worker/ui/app.client.js`, imported as text by a `[[rules]]`
  block in `wrangler.toml`. It is browser JavaScript and is never bundled.
- `posts.like_count` and friends never change after the first sight. Deliberate.
- `state.posts_count` is a maintained counter, not a COUNT. Deliberate.
- `extra` holds alt text, link cards, quoted text, full URLs and hashtags, and is why
  searches find things that are not in the visible post text. The page shows the matching
  bit of `extra` only when the post text itself has no highlight.
- An identity with `apps: '*'` but role `parent` gets 403. Deliberate: personal archive.
