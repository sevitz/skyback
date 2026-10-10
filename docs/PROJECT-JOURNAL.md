# skyback Project Journal

Continuity document for future sessions. If you are a fresh Claude picking this up from
GitHub alone, read `docs/HANDOVER.md` first for the current snapshot, then this file for
the history and reasoning behind it. Every new version adds an entry to the version log
below, records any new gotchas or decisions, and updates `docs/HANDOVER.md`'s
current-state and open-items sections.

---

## 1. What this project is

A personal archive of what passes through Sev's Bluesky feeds, with full text search, so
a post he read and half remembers can be found again. Cloudflare Worker plus D1 at
`skyback.sevitz.com`, behind the family sign-on, admin only.

---

## 2. Architecture

```
cron daily ─┐
page open ──┴► runSync ──► catch up (Following, since cursor)
                     ├──► gaps (unread stretches left by a budget-limited catch up)
                     ├──► feeds switched on (one page each, every 30 min)
                     └──► prune (only if RETENTION_DAYS > 0)
                              │
                     ingestPage: 2 selects + INSERT ... SELECT FROM json_each
                              │
D1: posts ─(triggers)─► posts_fts     sightings   feeds   state   usage

browser ──► requireIdentity (auth.sevitz.com JWKS) ──► admin? ──► same origin POST?
        ──► / (page.html + app.client.js)   /api/search   /api/status   /api/feeds*  /api/sync
        ──► /api/backfill/step  (Search further back: one small step per request)

anyone ──► /demo  /demo/app.js   (static sample posts, no D1, no Bluesky)
```

Routes and the gate order are in `src/worker/index.js`; the sync stages and every budget
in `src/worker/sync.js`.

---

## 3. Repo layout

```
src/worker/          the Worker (see CLAUDE.md for the file by file list)
src/worker/ui/       page.html and app.client.js, both imported as text
migrations/          hand authored, forward only; 0001_init.sql
test/                node:test suites, a D1 stand-in on node:sqlite, a fake Bluesky,
                     and worker.smoke.js (workerd via Miniflare)
tools/bench.js       CPU per page, the number behind the run caps
tools/preview.js     the bundle with sample data and a signed-in cookie, for UI work
app-ops.toml         secrets manifest for app-ops's secrets-sync.sh
```

---

## 4. Deploy workflow (how to ship a change)

1. `npm test` and `npm run smoke`.
2. Bump `version` in `package.json`, add an entry below, update `docs/HANDOVER.md`.
3. Push to `main`, then `npm run deploy`. A push alone does not deploy: Workers Builds is
   not connected to this repo (confirmed 2026-10-09; the repo was also recreated that day).
4. Migrations are never applied by a push or a deploy: `zsh ~/Code/app-ops/bin/migrate.sh remote`.
5. Secrets change only through 1Password and `secrets-sync.sh`.

---

## 5. Version history (what & why)

### 2026-10-10 -- v0.3.1 -- wordmark back to its original colours

The wordmark sits on a white (card coloured) tab on the band, "sky" in ink and "back" in
the accent blue, as before v0.3.0. `DESIGN.md` and its sidecar refreshed to the Sky look.

### 2026-10-10 -- v0.3.0 -- "Sky" look

Page restyle only, in `src/worker/ui/page.html`; no script, route or data change. A
blue band (`--band`) holds the wordmark, status line and, on the demo, the note. The
search box and its filters are one white rounded card that overlaps the band, with a
larger query line (20px) and the focus ring on the card. Page and hairline tones are a
little bluer, `--radius` is 16px. The wordmark's "back" is a pale blue because the
accent blue would vanish on the band. No suggestion chips: the mock showed some, they
are not built. `PRODUCT.md` and `DESIGN.md` added (DESIGN.md still describes the
earlier look until refreshed).

### 2026-10-09 -- `whoami_people` replaces the hand trim (no version bump)

The vendored `whoami` copy used to be trimmed to the owner by hand, and re-running
app-ops's `lib-sync.sh` would have restored the whole household roster. app-ops now has an
optional `whoami_people` key in `app-ops.toml`, and this repo's `app-ops.toml` sets
`whoami_people = ["sev"]`. `lib-sync.sh` (check and `--install`) renders the trimmed
file itself, byte-identical to the old hand trim, so re-running it here is safe and the
trim is no longer a manual step. The setting must stay in `app-ops.toml`. The "would
restore" wording in the trim note inside `src/worker/whoami/index.js` is generated text and
is now out of date; it was left as is so the file stays identical to what `lib-sync.sh`
writes.

### 2026-10-09 -- v0.2.1 -- front door lands on the demo, login pill

Asked for: signed-out visitors go straight to `/demo`, with a `demo | login` pill top left
that leads to login. `/` now redirects to `/demo` when there is no `sev_id` cookie. A stale
cookie still goes through the portal on purpose: the page's 401 handler reloads, and the
portal renews a lapsed identity without a prompt, so sending those visitors to the demo
would have made every expired session look like a logout. `/login` is the new public route
the pill links to: signed out it returns the portal redirect with `next=/login`, signed in it
redirects to `/`. Without it the pill would loop, since `/` no longer reaches the portal.
The commit identity in this repo is set to the GitHub noreply address because the repo is
public. A Cloudflare rate-limiting rule (one free-plan rule: 30 requests per 10 seconds per IP
on `/demo`, block for 10 seconds) was turned on for the zone the same day. It is configured in
the Cloudflare dashboard, not in this repo, so it is recorded here.

### 2026-10-09 -- v0.2.0 -- Search further back, public demo, new icon, public repo

Asked for: the status line at the top where it can be seen; no continuous background
backfill ("not sure we need it to run continually"); and a way to go back a day at a time
for a word, pausing every 7 days.

**Search further back replaces the automatic backfill.** The 10-minute cron and the
14-day backfill stage are gone. `backfillStep` (sync.js) is one small step per request
under the same caps as a sync; the page loops it a day at a time (24 hours), re-runs the
search after each day, and stops after 7 to ask. State is `state.back`, seeded from the old
`backfill.cursor` (a plain ISO time) or, if there is none, from the top of the timeline so
no stretch can be skipped. A day ends exactly on its boundary: only posts newer than the
target are kept and the cursor resumes at the target time. The edge is the cursor, not
`MIN(created_at)`: a repost carries its original post's date, so created_at is not a
timeline position (the status line's "since" has the same quirk). Bluesky only pages
backwards, so day 7 costs days 1 to 6; the one-day steps are for progress and stopping.

**Cron once a day, catch up on open.** Idle runs were cheap (about 7 rows written), but
with nothing to backfill there is little reason for a ten-minute cadence. Opening the page
runs a catch-up if the last good sync is over 15 minutes old.

**Public demo at /demo.** Sample posts from The Onion's public Bluesky feed, written to
`src/worker/ui/demo-data.json` by `npm run refresh-demo` (public API, no credentials; a
short list of sensitive subjects is excluded, politics are not). They ride in the page
and are searched in the browser, so the demo has no database or Bluesky access at all.
Deliberately not Sev's data: it is his reading history, the archive keeps posts people
deleted, and a public search over the real database could be scraped or used to burn the
account-wide D1 free allowance. The page is one file with `owner` and `demo` blocks; the
block that does not apply is removed from the HTML, not hidden.

**New icon.** Sky-blue rounded square, white cloud, back arrow (`icon.svg`; `icon-small.svg`
has a bolder arrow for 16 and 32 px). Rendered through a browser canvas, packed into
`icon-data.js`.

**Public repo.** Audited before publishing: one commit, no secrets, no real handle or
account data in any commit. Found and removed: mentions of a sibling app named after the
children, and the household roster (names, emoji, colours) in the vendored `whoami`
module, now trimmed to the owner. The MIT licence was added, a GitHub link added to the
footer, and a note that bug reports are public issues. Identifiers (Cloudflare account and
D1 database id) are not credentials and were left in. History was replaced with one clean
commit before the repo was made public.

### 2026-10-09 -- v0.1.0 -- first version

Built in one session from a question: "can I search my own Bluesky feed for a post I saw,
and should that be Claude directly or a little app?"

**The research that shaped it.**
- Bluesky's own search (`from:me`, `since:`, `until:`) only finds posts by author or
  network wide; there is no "posts that were in my timeline" filter, and it matches whole
  words only.
- The official account export (Settings, Export my data) is a CAR file of the account's
  own repository: your posts, likes as pointers, follows. Other people's posts in your
  timeline are not in it at all, so it cannot answer this question.
- Existing self hosted archivers (glane, bskyarchive) cover your own posts, likes,
  bookmarks and reposts, not the timeline.
- Claude cannot do it directly from a chat: the code sandbox's network allowlist blocks
  bsky.social and public.api.bsky.app, and web fetch summarises rather than returning data.
- So: a small archiver that reads the timeline as it happens, since the timeline is only
  available live.

**Shape.** An app, not a bot (it has an interactive screen), so its own repo, scaffolded
from app-ops's templates, joined to the family sign-on, vendoring auth-client, whoami and
bug-report.

**Feeds.** Following is always archived. Sev reads other feeds too, so the page has a
selector over his saved feeds (read from `app.bsky.actor.getPreferences`, named via
`getFeedGenerators` and `getList`), each switched on individually.

---

## 6. Key decisions & hard-won gotchas (READ THIS)

**The free plan sets every number.** Measured, not guessed:
- CPU: `tools/bench.js` puts a realistic 100 item page (265 KB) at about 2ms warm and 4
  to 7ms cold for parse plus normalise. Hence pages of 50, at most 100 items a run.
- D1 writes: `npm run smoke` measured 5.2 rows written per new post (row, index entry, FTS
  shadow rows, sighting) and 7 for a run with nothing new. `DAILY_WRITE_BUDGET = 40000`
  therefore covers about 7,000 new posts a day after the ~1,000 rows of idle runs.
- Subrequests: 50 per invocation on free; `MAX_FETCHES_PER_RUN = 12`.

**Since 2026-09-01 D1 free limits are enforced account wide.** Going over 5M rows read or
100k rows written in a UTC day fails every D1 query on the account until midnight, which
would take auth (and so every sign-in) and every other app down with it. That is
why skyback tallies its own usage from query meta (`usage` table) and stops itself at its
own budgets, and why status never runs `COUNT(*)`.

**getTimeline has a `since` cursor.** Pass a previous response's `startCursor` as `since`
and Bluesky returns only newer items, newest first; when that range is exhausted the
returned cursor equals `since`. This keeps the common run tiny. Fallback if a server
ignores it: stop at the first page with nothing new. A catch up that runs out of budget
before reaching the archive records a gap (`state.gaps`), drained on later runs.

**Posts are immutable; the FTS index depends on it.** External content FTS5 kept by
insert/delete triggers only. Never UPDATE indexed columns.

**D1's `meta.changes` is not a row count.** In a probe on the real database it reported 6
for a two row insert into a table with an FTS trigger, and 5 for a one row upsert. ingest
decides what is new by selecting first.

**`INSERT ... SELECT FROM json_each(?) WHERE true ON CONFLICT ... DO NOTHING`.** One
statement per page regardless of size, so a page is four queries. The `WHERE true` is
required or SQLite parses `ON CONFLICT` as a join constraint.

**Bind numbers carefully.** A JS number can bind as REAL, so `value + ?` on a text counter
stored `'5.0'`. Both sides are `CAST(... AS INTEGER)`.

**Session routing follows the official SDK.** createSession and refreshSession go to the
entryway (`BSKY_SERVICE`), data calls to the PDS from the DID document with
`atproto-proxy: did:web:api.bsky.app#bsky_appview`. A refresh rejected with 401,
ExpiredToken or InvalidToken falls back to createSession; anything else keeps the stored
session. createSession is rate limited per account (30 per 5 minutes, 300 a day).

**Reply context is archived too.** A reply in the timeline arrives with its parent and
root posts; Sev saw those too, so they are stored as sightings of kind parent/root. When
parent and root are the same post only `parent` is recorded.

**Miniflare 5 changed its options shape.** The smoke test builds v4 style options and
passes them through `convertV4MiniflareOptions`, with the bundle given as an explicit
`modules` list (main module first) because `modulesRules` cannot be converted.

**The bundle imports package.json with `with { type: 'json' }`.** Wrangler's esbuild
accepts it, and it lets Node import the same module in tests.

---

## 7. How to continue this project (for a fresh Claude)

1. Read `docs/HANDOVER.md` for the current snapshot, then this file for how it got there.
2. Check the open items below and the repo's Issues.
3. Test changes for real: `npm test`, `npm run smoke`, and `tools/preview.js` plus a look
   at the page for anything visual.
4. Commit and push after every change, then `npm run deploy` (a push alone does not deploy).

---

## 8. Known open items / ideas (as of 2026-10-09)

- How far back getTimeline will page is not documented; Search further back will show,
  and stops with "Reached the start of what Bluesky will show".
- An MCP endpoint, crawlbot and recaipe style, so Claude can search the archive directly.
- Optional: list skyback in auth's `KNOWN_APPS` / `APP_ORDER` for a hub tab.
- Optional: Bluesky OAuth instead of an app password.
