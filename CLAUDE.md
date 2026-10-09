# CLAUDE.md

Operating guide for Claude Code working in this repo. For the full story read
`docs/PROJECT-JOURNAL.md` (history, decisions, gotchas) and `docs/HANDOVER.md` (full
snapshot). This file is the short version: what to run, how it is built, and what not to
break.

## What this is

skyback archives what goes through Sev's Bluesky feeds and lets him search it, so a post
he half remembers reading can be found again. Bluesky's own search only covers posts by
author or across the whole network; it cannot search "my timeline", and the timeline
itself is not in the account's data export. skyback reads the Following timeline (and any
saved feeds switched on in its page) into D1 with a full text index, and
serves a search page at `skyback.sevitz.com` behind the family sign-on. It is a personal
archive: only an `admin` identity gets in. A daily cron catches up, the page catches up
when opened, and Search further back goes older on demand. `/demo` is a public page of
sample posts (The Onion's public feed) that never touches D1.

## Tech stack

Plain JavaScript Cloudflare Worker at `src/worker/index.js`, bundled by wrangler's own
esbuild, no framework. Data in Cloudflare D1 (SQLite with FTS5). One cron trigger. Wrangler
v4. Secrets in 1Password item `app.skyback`, pushed with app-ops's `secrets-sync.sh`.
Tests use Node's built-in test runner and built-in SQLite (which has FTS5), plus a
workerd smoke test through Miniflare.

## Commands

- `npm test` -- unit and integration tests against real SQL and a fake Bluesky
- `npm run smoke` -- bundles, migrates a local D1 with wrangler, runs the bundle in
  workerd: sign-on gate, page, API, cron, and the D1 rows-written-per-post figure
- `npm run bench` -- CPU cost of parsing and normalising one timeline page
- `npm run refresh-demo` -- new random sample for the public demo (public API, no credentials)
- `node --no-warnings tools/preview.js` -- the real bundle on 127.0.0.1:8787 with sample
  posts and a signed-in cookie it prints (run after `npm run smoke` has built the bundle)
- `npm run dev` -- `wrangler dev`, needs the secrets in `.dev.vars`
- `zsh ~/Code/app-ops/bin/secrets-sync.sh [--check|--drift]`
- `zsh ~/Code/app-ops/bin/migrate.sh <local|remote> [--check]`
- Deploy: push to `main` (Workers Builds). `npm run deploy` is the manual fallback.

## Login / auth

Family sign-on via `auth.sevitz.com`: `[vars] AUTH_ISSUER` and `AUTH_APP = "skyback"`,
vendored `src/worker/auth-client/`, `requireIdentity()`. On top of "may enter skyback",
the app requires `role === 'admin'`, because this is one person's reading history. POSTs
must carry `Origin: https://skyback.sevitz.com`: the `sev_id` cookie is SameSite=Lax on
`.sevitz.com`, so it rides along on POSTs from any other `*.sevitz.com` host.

Bluesky access is an app password (`BSKY_HANDLE`, `BSKY_APP_PASSWORD`), never the account
password. The session it creates lives in `state.session` and is refreshed, not recreated,
because `createSession` is rate limited per account.

## Architecture and data model

```
src/worker/
  index.js         routes, gates, cron entry
  sync.js          one run: catch up, gaps, feeds, prune; backfillStep (Search further back); the budgets
  bsky.js          minimal AT Protocol client: session, getTimeline, getFeed, ...
  normalize.js     feed items to rows: text, alt text, link cards, quotes, facets
  ingest.js        one page to D1 in four queries; only new rows are written
  feeds.js         saved feeds from Bluesky preferences; the on/off selector
  search.js        query parsing to FTS5, search SQL, status
  store.js         every D1 call, with rows read/written tallied per day
  ui/page.html     the page (a Text module)
  ui/app.client.js the page script (a Text module, see [[rules]] in wrangler.toml)
  auth-client/ whoami/ bug-report/   vendored from app-ops, do not edit here
```

Tables: `posts` (one row per post, never updated), `posts_fts` (external content FTS5,
kept by insert/delete triggers), `sightings` (which feed a post turned up in, and as a
post, repost, or reply context), `feeds` (Following plus saved feeds and their on/off),
`state` (session, cursors, counters, last run), `usage` (skyback's own D1 rows per UTC
day), `bug_report_limits`.

## Conventions

Shell scripts are zsh, written for macOS. Secrets live only in 1Password, read per key
with `op read` (never `op inject`), never hardcoded, never committed. This app's
1Password item is `op://_code_secrets/app.skyback`. Every change updates
`docs/PROJECT-JOURNAL.md` (what changed and why, plus any new gotcha) and bumps `version`
in `package.json`, which is the single source of truth for the version and is read rather
than restated anywhere else. The app displays that version in the page footer and at
`/api/health`. Repo is private. No em dashes; minimal hyphens. Pasteable terminal blocks
contain no `#` comment lines (interactive zsh errors on them).

## Do not break these (intentional choices)

**The D1 budget guard.** The account is on the Workers free plan, and since 2026-09-01
exceeding D1's daily free allowance (5M rows read, 100k rows written, account wide) fails
every D1 query on the account until midnight UTC, auth included. skyback tallies its own
usage from query meta and stops at `DAILY_WRITE_BUDGET` / `DAILY_READ_BUDGET`. Anything
new that touches D1 goes through `Store` so it is counted.

**Never `COUNT(*)` on posts in a request path.** It reads every row on every page load.
`state.posts_count` is maintained by ingest and prune instead.

**Posts are written once and never updated.** `posts_fts` is an external content index
maintained only by the insert and delete triggers. An `UPDATE` of text, extra or author
columns would desynchronise it. Bluesky posts cannot be edited, which is what makes this
safe.

**"New" comes from selects, not `meta.changes`.** D1's changes count includes trigger
writes and is not a row count.

**Small runs.** Free plan: 10ms CPU and 50 subrequests per invocation. Pages of 50, at
most 100 items and 12 fetches a run, measured with `tools/bench.js`. Catch up uses
getTimeline's `since` cursor so Bluesky only sends what is new.

**One sync at a time.** Cron, "Sync now", "Fetch now" and "Reload my saved feeds" share
the `state.lock_until` lock, because two runs refreshing the same Bluesky session would
burn its single-use refresh token.

**Every user word is quoted before it reaches FTS5.** No input can be an FTS5 syntax error
or reach a column filter it did not ask for. Keep it that way in `search.js`.

**The public demo touches nothing of yours.** `GET /demo` and `/demo/app.js` are the only
routes besides `/api/health` and the icons that answer without a sign-in. The demo
never constructs `Store`, never reads `env.DB`, and never calls Bluesky; its sample posts
come from `src/worker/ui/demo-data.json` (public posts from a public account) and are
searched in the browser. Keep it that way, and keep `test/worker.smoke.js` ("the demo is
public...") green: it fails if an owner control reaches the demo DOM, if any other path
stops needing a sign-in, or if a demo request writes a row.

**A day of "Search further back" ends exactly on its boundary.** `backfillStep` keeps only
posts newer than the target and resumes from the target time, which works because
Bluesky's timeline cursor is a plain ISO time. The edge is the cursor, not
`MIN(created_at)`, because a repost carries its original post's date.

**The vendored `whoami` copy is trimmed.** The family version lists every household
member; this repo is public, so only the owner is kept. Re-running app-ops's
`lib-sync.sh` restores the full roster: do not let that happen here.

**Page content is untrusted.** The page script builds everything with `textContent`;
highlights come back as `\u0001`/`\u0002` markers and are turned into `<mark>` nodes. No
`innerHTML` for post content, ever.

## Planned work

Tracked as GitHub Issues in this repo, not here -- `enhancement` label for feature and
enhancement work, `bug` for bugs. This repo's own Project board carries the Status
workflow; no milestones (releases are continuous). See app-ops's `CLAUDE.md`, "Work
tracking (Issues, not task lists)", for the full convention.
