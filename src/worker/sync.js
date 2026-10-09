// One sync run: called by the daily cron, by the page when it opens after a
// quiet spell, and by its "Sync now" and "Fetch now" buttons.
//
// Order matters, because each run has a small budget (MAX_ITEMS_PER_RUN feed
// items, MAX_FETCHES_PER_RUN requests) to fit the free plan's 10ms CPU and 50
// subrequests per invocation, and what is left over goes to the next stage:
//
//   1. catch up    the Following timeline, newest first, down to what is
//                  already archived. Uses getTimeline's `since` cursor, so
//                  Bluesky only sends what is new. Always runs at least one page.
//   2. gaps        if a catch up ever ran out of budget before reaching the
//                  archive, the unread stretch is remembered and drained here.
//   3. feeds       other feeds switched on in the page, one page each, at most
//                  every FEED_INTERVAL_MINUTES.
//
// Going further back is not part of a run. "Search further back" on the page
// calls backfillStep (below) in a loop, a day at a time, so nothing pages
// backwards unless you asked it to.
//
// Before any of it, skyback's own D1 usage for today is checked against
// DAILY_WRITE_BUDGET; see store.js for why that guard exists.

import { Store } from './store.js';
import { Bsky, BskyError, BudgetSpent } from './bsky.js';
import { ingestPage } from './ingest.js';

const LOCK_SECONDS = 120;
const MAX_GAPS = 5;

function int(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function config(env) {
  return {
    dailyWriteBudget: int(env.DAILY_WRITE_BUDGET, 40000),
    dailyReadBudget: int(env.DAILY_READ_BUDGET, 1500000),
    maxItems: int(env.MAX_ITEMS_PER_RUN, 100),
    pageSize: Math.min(100, Math.max(1, int(env.TIMELINE_PAGE_SIZE, 50))),
    maxFetches: int(env.MAX_FETCHES_PER_RUN, 12),
    catchupMaxPages: Math.max(1, int(env.CATCHUP_MAX_PAGES, 3)),
    feedIntervalMinutes: int(env.FEED_INTERVAL_MINUTES, 30),
    feedPageSize: Math.min(100, Math.max(1, int(env.FEED_PAGE_SIZE, 50))),
    retentionDays: int(env.RETENTION_DAYS, 0),
  };
}

class Run {
  constructor(env, cfg, store, bsky, now) {
    this.env = env;
    this.cfg = cfg;
    this.store = store;
    this.bsky = bsky;
    this.now = now;
    this.nowIso = now.toISOString();
    this.items = 0;
  }

  // Room for another page? Two fetches of headroom, because a page can cost a
  // session refresh as well as the data call. Callers let the first page of a
  // catch up through regardless.
  room() {
    return this.items < this.cfg.maxItems && this.bsky.fetches + 2 <= this.bsky.maxFetches;
  }

  async page(fetchPage, feed) {
    const res = await fetchPage();
    const feedItems = Array.isArray(res && res.feed) ? res.feed : [];
    const r = await ingestPage(this.store, feedItems, feed, this.nowIso);
    this.items += feedItems.length;
    return { res, feedItems, r };
  }
}

// 1. Catch up.
async function catchUp(run) {
  const st = await run.store.getState(['timeline_since', 'backfill', 'gaps']);
  const since = st.timeline_since || null;
  const out = { pages: 0, new_items: 0, new_posts: 0, caught_up: false };
  let cursor;
  let lastCursor = null;
  let newSince = null;

  while (out.pages < run.cfg.catchupMaxPages && (out.pages === 0 || run.room())) {
    const { res, feedItems, r } = await run.page(
      () => run.bsky.getTimeline({ limit: run.cfg.pageSize, cursor, since }),
      'following'
    );
    out.pages += 1;
    out.new_items += r.newPrimary;
    out.new_posts += r.newPosts;
    if (out.pages === 1 && res.startCursor) newSince = res.startCursor;
    lastCursor = res.cursor || null;
    // Done when: nothing came back; the since-bounded range is exhausted (the
    // cursor comes back equal to `since`); the timeline ended; or a page held
    // nothing new, which also covers a server that ignores `since`.
    if (!feedItems.length || (since && res.cursor === since) || !res.cursor || r.newPrimary === 0) {
      out.caught_up = true;
      break;
    }
    cursor = res.cursor;
  }

  const updates = {};
  if (newSince) updates.timeline_since = newSince;
  if (!out.caught_up && lastCursor) {
    if (since || st.backfill) {
      // Ran out of budget between new and archived: remember the stretch.
      const gaps = parseJson(st.gaps, []);
      gaps.unshift({ cursor: lastCursor, since, created_at: run.nowIso });
      updates.gaps = gaps.slice(0, MAX_GAPS);
      out.gap = true;
    } else if (!st.backfill) {
      updates.backfill = { cursor: lastCursor, done: false, pages: 0, started_at: run.nowIso };
    }
  }
  if (!st.backfill && !updates.backfill && !since) {
    // First run and the whole timeline fitted: nothing to backfill.
    updates.backfill = { cursor: null, done: true, pages: 0, reason: 'timeline ended', started_at: run.nowIso };
  }
  if (Object.keys(updates).length) await run.store.setState(updates);
  return out;
}

function parseJson(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// 2. Gaps.
async function drainGaps(run) {
  const gaps = (await run.store.getJson('gaps')) || [];
  if (!gaps.length || !run.room()) return null;
  const out = { pages: 0, new_posts: 0, remaining: gaps.length };
  const gap = gaps[gaps.length - 1]; // oldest first
  let finished = false;
  while (run.room()) {
    const { res, feedItems, r } = await run.page(
      () => run.bsky.getTimeline({ limit: run.cfg.pageSize, cursor: gap.cursor, since: gap.since }),
      'following'
    );
    out.pages += 1;
    out.new_posts += r.newPosts;
    if (!feedItems.length || !res.cursor || (gap.since && res.cursor === gap.since) || r.newPrimary === 0) {
      finished = true;
      break;
    }
    gap.cursor = res.cursor;
  }
  if (finished) gaps.pop();
  out.remaining = gaps.length;
  await run.store.setState({ gaps });
  return out;
}

// 3. Feeds.
async function syncFeeds(run, onlyUri = null) {
  const cutoff = new Date(run.now.getTime() - run.cfg.feedIntervalMinutes * 60000).toISOString();
  const rows = onlyUri
    ? await run.store.all("SELECT uri, kind, name FROM feeds WHERE uri = ? AND kind != 'timeline'", onlyUri)
    : await run.store.all(
        `SELECT uri, kind, name FROM feeds
         WHERE enabled = 1 AND kind != 'timeline' AND (last_synced_at IS NULL OR last_synced_at < ?)
         ORDER BY last_synced_at IS NOT NULL, last_synced_at`,
        cutoff
      );
  const out = [];
  for (const f of rows) {
    if (!run.room()) break;
    const fetchPage = () =>
      f.kind === 'list'
        ? run.bsky.getListFeed({ list: f.uri, limit: run.cfg.feedPageSize })
        : run.bsky.getFeed({ feed: f.uri, limit: run.cfg.feedPageSize });
    try {
      const { r } = await run.page(fetchPage, f.uri);
      await run.store.run(
        "UPDATE feeds SET last_synced_at = ?, last_new = ?, last_error = NULL, updated_at = datetime('now') WHERE uri = ?",
        run.nowIso,
        r.newPrimary,
        f.uri
      );
      out.push({ uri: f.uri, name: f.name, new_items: r.newPrimary, new_posts: r.newPosts });
    } catch (err) {
      if (err instanceof BudgetSpent) break;
      if (err instanceof BskyError && (err.status === 0 || err.status === 401)) throw err; // session trouble: whole run
      // One broken feed must not stop the others. Recording last_synced_at
      // also stops it being retried every ten minutes.
      await run.store.run(
        "UPDATE feeds SET last_synced_at = ?, last_error = ?, updated_at = datetime('now') WHERE uri = ?",
        run.nowIso,
        String(err.message || err).slice(0, 300),
        f.uri
      );
      out.push({ uri: f.uri, name: f.name, error: String(err.message || err).slice(0, 300) });
    }
  }
  return out;
}

// Optional retention: at most 500 posts deleted per day, oldest first.
async function prune(run) {
  if (!run.cfg.retentionDays) return null;
  const last = (await run.store.getState(['pruned_on'])).pruned_on;
  const today = run.nowIso.slice(0, 10);
  if (last === today) return null;
  const cutoff = new Date(run.now.getTime() - run.cfg.retentionDays * 86400000).toISOString();
  const old = await run.store.all(
    'SELECT uri FROM posts WHERE created_at < ? ORDER BY created_at LIMIT 500',
    cutoff
  );
  const uris = JSON.stringify(old.map((r) => r.uri));
  await run.store.batch([
    old.length && { sql: 'DELETE FROM sightings WHERE uri IN (SELECT value FROM json_each(?))', params: [uris] },
    old.length && { sql: 'DELETE FROM posts WHERE uri IN (SELECT value FROM json_each(?))', params: [uris] },
    old.length && {
      sql: "UPDATE state SET value = MAX(0, CAST(value AS INTEGER) - CAST(? AS INTEGER)) WHERE key = 'posts_count'",
      params: [old.length],
    },
    run.store.setStatement('pruned_on', today),
  ]);
  return { deleted: old.length };
}

// Search further back. Not part of runSync: the page calls this in a loop, one
// small step per request, and decides when a day is done and when to stop.
//
// The edge is where the timeline's paging cursor has got to. Bluesky's cursor for
// getTimeline is a plain ISO time, so a day back is just that time minus 24 hours.
// It is deliberately not the oldest archived post: a repost carries its original
// post's date, which can be weeks older than the timeline position it appeared at.
//
// A step stays inside the same per-run caps as a sync (MAX_ITEMS_PER_RUN items,
// MAX_FETCHES_PER_RUN requests), so a day is usually a few steps. `target` is the
// time to reach; leave it out on the first step of a day and the response says
// which time that is (edge minus 24 hours), to be sent back on the next steps.
const DAY_MS = 86400000;

function cursorTime(cursor) {
  if (typeof cursor !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(cursor)) return null;
  const t = Date.parse(cursor);
  return Number.isNaN(t) ? null : t;
}

function isoOrNull(ms) {
  return ms === null ? null : new Date(ms).toISOString();
}

// The time Bluesky sorts a timeline item by: when it was reposted, else when the
// post was indexed. Null if the item does not say.
function itemTime(item) {
  const at = (item && item.reason && item.reason.indexedAt) || (item && item.post && item.post.indexedAt);
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : t;
}

export async function backfillStep(env, { target = null, version = '0', now = new Date() } = {}) {
  const cfg = config(env);
  const store = new Store(env.DB);
  const nowIso = now.toISOString();
  const result = { ok: true, new_posts: 0, items: 0, pages: 0, reached: false, ended: false, edge: null, target: null };
  let locked = false;
  let back = null;
  let touched = false;
  try {
    const usage = await store.usageToday();
    if (usage.rows_written >= cfg.dailyWriteBudget) {
      result.paused = `daily write budget reached (${usage.rows_written} of ${cfg.dailyWriteBudget}); resumes after midnight UTC`;
      return result;
    }
    locked = await store.acquireLock(LOCK_SECONDS);
    if (!locked) {
      result.paused = 'another sync is running';
      result.busy = true;
      return result;
    }

    // Where to resume. The old automatic backfill left its cursor in `backfill`;
    // use it once, then keep our own. With neither, start at the top of the
    // timeline: slower (it re-reads what is archived, writing nothing) but never
    // skips a stretch.
    const st = await store.getState(['back', 'backfill']);
    back = parseJson(st.back, null);
    if (!back) {
      const old = parseJson(st.backfill, null);
      if (old && old.done && !old.cursor && old.reason === 'timeline ended') {
        back = { cursor: null, ended: true, reason: 'timeline ended' };
      } else {
        back = { cursor: (old && old.cursor) || nowIso, ended: false };
      }
    }
    if (back.ended) {
      result.ended = true;
      return result;
    }

    const edgeStart = cursorTime(back.cursor);
    const targetMs = target ? Date.parse(target) : (edgeStart === null ? now.getTime() : edgeStart) - DAY_MS;
    result.target = isoOrNull(Number.isNaN(targetMs) ? null : targetMs);
    result.edge = isoOrNull(edgeStart);

    const bsky = new Bsky(env, store, { maxFetches: cfg.maxFetches, version });
    const run = new Run(env, cfg, store, bsky, now);
    try {
      while (!result.reached && !result.ended && (result.pages === 0 || run.room())) {
        const res = await bsky.getTimeline({ limit: cfg.pageSize, cursor: back.cursor });
        const feedItems = Array.isArray(res && res.feed) ? res.feed : [];
        run.items += feedItems.length;
        result.pages += 1;
        touched = true;
        const timed = cursorTime(res && res.cursor) !== null;
        // With real (time) cursors a day ends exactly at the target: keep only what
        // is newer than it and resume from the target time, so days line up with
        // the calendar however sparse the timeline is. Whatever of this page lies
        // past the target is fetched again on the next day, costing a request, not
        // a write.
        const kept = timed
          ? feedItems.filter((item) => { const at = itemTime(item); return at === null || at >= targetMs; })
          : feedItems;
        const r = kept.length ? await ingestPage(store, kept, 'following', nowIso) : { newPosts: 0 };
        result.new_posts += r.newPosts;
        if (!feedItems.length || !res.cursor) {
          back = { cursor: null, ended: true, reason: 'timeline ended', at: nowIso };
          result.ended = true;
          break;
        }
        if (timed && kept.length < feedItems.length) {
          back = { cursor: new Date(targetMs).toISOString(), ended: false, at: nowIso };
          result.edge = back.cursor;
          result.reached = true;
          break;
        }
        back = { cursor: res.cursor, ended: false, at: nowIso };
        const t = cursorTime(res.cursor);
        result.edge = isoOrNull(t);
        // A cursor that is not a time cannot be measured against the target, so
        // one step counts as the day.
        if (t === null || t <= targetMs) result.reached = true;
      }
    } catch (err) {
      if (!(err instanceof BudgetSpent)) throw err;
    }
    result.items = run.items;
    result.fetches = bsky.fetches;
  } catch (err) {
    result.ok = false;
    result.error = String((err && err.message) || err).slice(0, 500);
  } finally {
    try {
      if (touched) await store.setState({ back });
      if (locked) await store.releaseLock();
    } finally {
      await store.flushUsage(0);
    }
  }
  return result;
}

// The whole run. `only`: 'all' (cron, "Sync now") or { feed: uri } ("Fetch now"
// on one feed, which skips the other stages).
export async function runSync(env, { trigger = 'cron', only = 'all', version = '0', now = new Date() } = {}) {
  const cfg = config(env);
  const store = new Store(env.DB);
  const result = { trigger, started_at: now.toISOString(), version };
  let locked = false;
  try {
    const usage = await store.usageToday();
    if (usage.rows_written >= cfg.dailyWriteBudget) {
      result.paused = `daily write budget reached (${usage.rows_written} of ${cfg.dailyWriteBudget}); resumes after midnight UTC`;
      return result;
    }
    locked = await store.acquireLock(LOCK_SECONDS);
    if (!locked) {
      result.paused = 'another sync is running';
      return result;
    }
    const bsky = new Bsky(env, store, { maxFetches: cfg.maxFetches, version });
    const run = new Run(env, cfg, store, bsky, now);
    if (only && only.feed) {
      result.feeds = await syncFeeds(run, only.feed);
    } else {
      result.catchup = await catchUp(run);
      result.gaps = await drainGaps(run);
      result.feeds = await syncFeeds(run);
      result.prune = await prune(run);
    }
    result.items = run.items;
    result.fetches = bsky.fetches;
  } catch (err) {
    result.error = String((err && err.message) || err).slice(0, 500);
  } finally {
    result.finished_at = new Date().toISOString();
    try {
      if (!result.paused || locked) {
        await store.setState({
          last_run: result,
          ...(result.error ? { last_error: { at: result.finished_at, message: result.error } } : {}),
          ...(!result.error && !result.paused ? { last_ok_at: result.finished_at } : {}),
        });
      }
      if (locked) await store.releaseLock();
    } finally {
      await store.flushUsage(1);
    }
  }
  return result;
}
