// The feed selector: which of your saved Bluesky feeds skyback also archives.
//
// "Reload my saved feeds" reads your preferences (savedFeedsPrefV2, or the
// older savedFeedsPref) and names each feed via getFeedGenerators and each list
// via getList. It never changes what is switched on: a feed you removed from
// Bluesky stays in the table marked saved = 0, so its archive keeps its name.

import { Store } from './store.js';
import { Bsky } from './bsky.js';

const FEED_GEN = '/app.bsky.feed.generator/';
const LIST = '/app.bsky.graph.list/';

export function savedFeedsFrom(preferences) {
  const prefs = Array.isArray(preferences) ? preferences : [];
  const v2 = prefs.find((p) => p && p.$type === 'app.bsky.actor.defs#savedFeedsPrefV2');
  if (v2 && Array.isArray(v2.items)) {
    return v2.items
      .filter((i) => i && (i.type === 'feed' || i.type === 'list') && typeof i.value === 'string')
      .map((i) => ({ uri: i.value, kind: i.type, pinned: !!i.pinned }));
  }
  const v1 = prefs.find((p) => p && p.$type === 'app.bsky.actor.defs#savedFeedsPref');
  if (v1) {
    const pinned = new Set(Array.isArray(v1.pinned) ? v1.pinned : []);
    const all = [...new Set([...(v1.pinned || []), ...(v1.saved || [])])];
    return all
      .filter((u) => typeof u === 'string' && (u.includes(FEED_GEN) || u.includes(LIST)))
      .map((u) => ({ uri: u, kind: u.includes(LIST) ? 'list' : 'feed', pinned: pinned.has(u) }));
  }
  return [];
}

export async function reloadSavedFeeds(env, version) {
  const store = new Store(env.DB);
  // Shares the sync lock: two runs refreshing the same Bluesky session at once
  // would burn its single-use refresh token.
  if (!(await store.acquireLock(60))) {
    await store.flushUsage(0);
    return { ok: false, error: 'A sync is running. Try again in a minute.' };
  }
  try {
    const bsky = new Bsky(env, store, { maxFetches: 20, version });
    const prefs = await bsky.getPreferences();
    const saved = savedFeedsFrom(prefs && prefs.preferences);

    const names = new Map();
    const feedUris = saved.filter((s) => s.kind === 'feed').map((s) => s.uri);
    for (let i = 0; i < feedUris.length; i += 25) {
      const res = await bsky.getFeedGenerators(feedUris.slice(i, i + 25));
      for (const g of (res && res.feeds) || []) {
        names.set(g.uri, { name: g.displayName || '', description: g.description || '', avatar: g.avatar || null });
      }
    }
    for (const s of saved.filter((x) => x.kind === 'list').slice(0, 10)) {
      try {
        const res = await bsky.getList(s.uri);
        const l = res && res.list;
        if (l) names.set(s.uri, { name: l.name || '', description: l.description || '', avatar: l.avatar || null });
      } catch {
        // A deleted or private list keeps its URI as its name.
      }
    }

    const rows = saved.map((s, position) => {
      const n = names.get(s.uri) || {};
      return {
        uri: s.uri,
        kind: s.kind,
        name: n.name || s.uri.split('/').pop(),
        description: (n.description || '').slice(0, 300),
        avatar: typeof n.avatar === 'string' && n.avatar.startsWith('https://') ? n.avatar : null,
        pinned: s.pinned ? 1 : 0,
        position,
      };
    });
    const json = JSON.stringify(rows);
    await store.batch([
      {
        sql: `INSERT INTO feeds (uri, kind, name, description, avatar, pinned, saved, position, updated_at)
              SELECT json_extract(j.value, '$.uri'), json_extract(j.value, '$.kind'), json_extract(j.value, '$.name'),
                     json_extract(j.value, '$.description'), json_extract(j.value, '$.avatar'),
                     json_extract(j.value, '$.pinned'), 1, json_extract(j.value, '$.position'), datetime('now')
              FROM json_each(?) AS j WHERE true
              ON CONFLICT(uri) DO UPDATE SET kind = excluded.kind, name = excluded.name,
                description = excluded.description, avatar = excluded.avatar, pinned = excluded.pinned,
                saved = 1, position = excluded.position, updated_at = excluded.updated_at`,
        params: [json],
      },
      {
        sql: `UPDATE feeds SET saved = 0 WHERE kind != 'timeline'
              AND uri NOT IN (SELECT json_extract(value, '$.uri') FROM json_each(?))`,
        params: [json],
      },
      store.setStatement('feeds_reloaded_at', new Date().toISOString()),
    ]);
    return { ok: true, count: rows.length };
  } finally {
    await store.releaseLock();
    await store.flushUsage(0);
  }
}

export async function listFeeds(store) {
  const rows = await store.all(
    `SELECT uri, kind, name, description, avatar, pinned, saved, enabled, last_synced_at, last_new, last_error
     FROM feeds ORDER BY kind != 'timeline', saved DESC, pinned DESC, position, name`
  );
  const reloaded = (await store.getState(['feeds_reloaded_at'])).feeds_reloaded_at;
  return { feeds: rows, reloaded_at: reloaded || null };
}

export async function setFeedEnabled(store, uri, enabled) {
  if (uri === 'following') return { ok: false, error: 'Following is always archived' };
  await store.run(
    "UPDATE feeds SET enabled = ?, updated_at = datetime('now') WHERE uri = ? AND kind != 'timeline'",
    enabled ? 1 : 0,
    uri
  );
  return { ok: true };
}
