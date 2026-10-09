// Realistic Bluesky shapes (as in @atproto/api's lexicons) and a fake Bluesky
// server to sync against. The fake honours getTimeline's `since` bound the way
// the lexicon describes it: only items newer than `since`, newest first, and a
// cursor equal to `since` once that range is exhausted.

let n = 0;

export function author(handle, name = handle.split('.')[0]) {
  return {
    did: `did:plc:${handle.replace(/[^a-z0-9]/g, '')}`,
    handle,
    displayName: name,
    avatar: `https://cdn.bsky.app/img/avatar/plain/did:plc:${handle.replace(/[^a-z0-9]/g, '')}/x@jpeg`,
    labels: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    viewer: { muted: false, blockedBy: false, following: 'at://did:plc:me/app.bsky.graph.follow/abc' },
  };
}

export function post({ by = author('alice.bsky.social', 'Alice'), text = 'hello', at, embed, record = {}, facets, uri } = {}) {
  n += 1;
  const when = at || new Date(Date.UTC(2026, 9, 9, 8, 0, 0) - n * 60000).toISOString();
  const rkey = `3m${n.toString(36).padStart(11, '0')}`;
  return {
    $type: 'app.bsky.feed.defs#postView',
    uri: uri || `at://${by.did}/app.bsky.feed.post/${rkey}`,
    cid: `bafyrei${n}`,
    author: by,
    record: {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: when,
      langs: ['en'],
      ...(facets ? { facets } : {}),
      ...record,
    },
    ...(embed ? { embed } : {}),
    bookmarkCount: 0,
    replyCount: 2,
    repostCount: 3,
    likeCount: 10,
    quoteCount: 0,
    indexedAt: when,
    viewer: { bookmarked: false, threadMuted: false, embeddingDisabled: false },
    labels: [],
  };
}

export const images = (...alts) => ({
  $type: 'app.bsky.embed.images#view',
  images: alts.map((alt, i) => ({
    $type: 'app.bsky.embed.images#viewImage',
    thumb: `https://cdn.bsky.app/img/feed_thumbnail/plain/x/${i}@jpeg`,
    fullsize: `https://cdn.bsky.app/img/feed_fullsize/plain/x/${i}@jpeg`,
    alt,
    aspectRatio: { width: 1000, height: 750 },
  })),
});

export const gallery = (...alts) => ({
  $type: 'app.bsky.embed.gallery#view',
  items: alts.map((alt, i) => ({
    $type: 'app.bsky.embed.gallery#viewImage',
    thumbnail: `https://cdn.bsky.app/img/feed_thumbnail/plain/g/${i}@jpeg`,
    fullsize: `https://cdn.bsky.app/img/feed_fullsize/plain/g/${i}@jpeg`,
    alt,
    aspectRatio: { width: 1, height: 1 },
  })),
});

export const video = (alt) => ({
  $type: 'app.bsky.embed.video#view',
  cid: 'bafyvid',
  playlist: 'https://video.bsky.app/watch/x/playlist.m3u8',
  thumbnail: 'https://video.bsky.app/watch/x/thumbnail.jpg',
  alt,
});

export const external = (uri, title, description) => ({
  $type: 'app.bsky.embed.external#view',
  external: { $type: 'app.bsky.embed.external#viewExternal', uri, title, description, thumb: 'https://cdn.bsky.app/img/x/thumb@jpeg' },
});

export const quote = (pv) => ({
  $type: 'app.bsky.embed.record#view',
  record: {
    $type: 'app.bsky.embed.record#viewRecord',
    uri: pv.uri,
    cid: pv.cid,
    author: pv.author,
    value: pv.record,
    embeds: pv.embed ? [pv.embed] : [],
    indexedAt: pv.indexedAt,
  },
});

export const quoteWithMedia = (pv, media) => ({
  $type: 'app.bsky.embed.recordWithMedia#view',
  record: quote(pv),
  media,
});

export const item = (pv, extra = {}) => ({ $type: 'app.bsky.feed.defs#feedViewPost', post: pv, ...extra });

export const repostBy = (by, at) => ({
  reason: {
    $type: 'app.bsky.feed.defs#reasonRepost',
    by,
    uri: `at://${by.did}/app.bsky.feed.repost/r${(n += 1)}`,
    cid: 'bafyrepost',
    indexedAt: at,
  },
});

export const replyTo = (parent, root = parent) => ({
  reply: { $type: 'app.bsky.feed.defs#replyRef', root, parent },
});

function jwt(exp) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'ES256K', typ: 'at+jwt' })}.${b64({ scope: 'com.atproto.appPass', sub: 'did:plc:me', exp })}.sig`;
}

// A fake Bluesky: entryway at https://bsky.social, PDS at https://pds.example.
// `timeline` is newest first. Tests mutate it (unshift new items) between runs.
export class FakeBluesky {
  constructor() {
    this.timeline = [];
    this.feeds = new Map(); // feed uri -> items
    this.lists = new Map();
    this.generators = new Map(); // uri -> displayName
    this.preferences = [];
    this.calls = [];
    this.accessLifetime = 7200;
    this.refreshValid = true;
    this.badPassword = false;
    this.failFeeds = new Set();
    this.ignoreSince = false;
    this.sessions = 0;
  }

  session() {
    this.sessions += 1;
    return {
      did: 'did:plc:me',
      handle: 'sev.bsky.social',
      accessJwt: jwt(Math.floor(Date.now() / 1000) + this.accessLifetime),
      refreshJwt: `refresh-${this.sessions}`,
      didDoc: {
        id: 'did:plc:me',
        service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example' }],
      },
      active: true,
    };
  }

  json(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  }

  // Real Bluesky's getTimeline cursor is a plain ISO time: the next page is the
  // items strictly older than it, and the cursor sent back is the last item's time.
  // Set `timeCursors = true` to get that instead of the index cursors below.
  pageByTime(list, { limit, cursor }) {
    const timeOf = (it) => (it.reason && it.reason.indexedAt) || it.post.indexedAt;
    const older = cursor ? list.filter((it) => timeOf(it) < cursor) : list.slice();
    const out = older.slice(0, limit);
    const more = older.length > out.length;
    return { feed: out, cursor: out.length && more ? timeOf(out[out.length - 1]) : undefined };
  }

  page(list, { limit, cursor, since }) {
    if (this.timeCursors) return this.pageByTime(list, { limit, cursor });
    // Cursor = index of the first item to return; since = index already held.
    const sinceIdx = since !== undefined && since !== null && !this.ignoreSince ? Number(since) : null;
    const total = list.length;
    // Positions are counted from the oldest item so they stay stable when new
    // items are unshifted on: position p = total - 1 - index.
    const posOf = (i) => total - 1 - i;
    const idxOf = (p) => total - 1 - p;
    let start = cursor ? idxOf(Number(cursor) - 1) : 0;
    if (start < 0) start = 0;
    const out = [];
    let i = start;
    for (; i < total && out.length < limit; i++) {
      if (sinceIdx !== null && posOf(i) <= sinceIdx) break;
      out.push(list[i]);
    }
    // A server without `since` support sends no startCursor either.
    const startCursor = total && !this.ignoreSince ? String(posOf(start)) : undefined;
    let next;
    if (sinceIdx !== null && (i >= total || posOf(i) <= sinceIdx)) next = String(sinceIdx);
    else next = i < total ? String(posOf(i) + 1) : undefined;
    return { feed: out, cursor: next, startCursor };
  }

  handler() {
    return async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const method = url.pathname.replace('/xrpc/', '');
      const auth = (init.headers && (init.headers.authorization || init.headers.Authorization)) || '';
      this.calls.push({ method, host: url.host, params: Object.fromEntries(url.searchParams), auth });

      if (method === 'com.atproto.server.createSession') {
        if (url.host !== 'bsky.social') return this.json({ error: 'WrongHost' }, 400);
        if (this.badPassword) return this.json({ error: 'AuthenticationRequired', message: 'Invalid identifier or password' }, 401);
        this.refreshValid = true;
        return this.json(this.session());
      }
      if (method === 'com.atproto.server.refreshSession') {
        if (!this.refreshValid) return this.json({ error: 'ExpiredToken', message: 'Token has expired' }, 400);
        return this.json(this.session());
      }
      if (url.host !== 'pds.example') return this.json({ error: 'WrongHost' }, 400);
      if (!auth.startsWith('Bearer ')) return this.json({ error: 'AuthMissing' }, 401);
      if ((init.headers || {})['atproto-proxy'] !== 'did:web:api.bsky.app#bsky_appview') return this.json({ error: 'NoProxy' }, 400);
      const exp = JSON.parse(Buffer.from(auth.slice(7).split('.')[1], 'base64url').toString()).exp;
      if (exp < Date.now() / 1000) return this.json({ error: 'ExpiredToken', message: 'Token has expired' }, 400);

      const p = Object.fromEntries(url.searchParams);
      const limit = Math.min(100, Number(p.limit) || 50);
      if (method === 'app.bsky.feed.getTimeline') return this.json(this.page(this.timeline, { limit, cursor: p.cursor, since: p.since }));
      if (method === 'app.bsky.feed.getFeed') {
        if (this.failFeeds.has(p.feed)) return this.json({ error: 'UnknownFeed', message: 'could not resolve feed' }, 400);
        return this.json({ feed: (this.feeds.get(p.feed) || []).slice(0, limit), cursor: 'x' });
      }
      if (method === 'app.bsky.feed.getListFeed') return this.json({ feed: (this.lists.get(p.list) || []).slice(0, limit) });
      if (method === 'app.bsky.actor.getPreferences') return this.json({ preferences: this.preferences });
      if (method === 'app.bsky.feed.getFeedGenerators') {
        const feeds = url.searchParams.getAll('feeds').map((uri) => ({
          uri, cid: 'c', did: 'did:web:feeds.example', creator: author('feedmaker.bsky.social'),
          displayName: this.generators.get(uri) || 'Unnamed', description: 'A feed', likeCount: 5, indexedAt: '2025-01-01T00:00:00Z',
        }));
        return this.json({ feeds });
      }
      if (method === 'app.bsky.graph.getList') {
        return this.json({ list: { uri: p.list, cid: 'c', name: 'Close friends', purpose: 'app.bsky.graph.defs#curatelist', creator: author('sev.bsky.social'), indexedAt: '2025-01-01T00:00:00Z' }, items: [] });
      }
      return this.json({ error: 'MethodNotImplemented' }, 501);
    };
  }
}
