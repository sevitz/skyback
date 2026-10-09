// skyback -- an archive of what went through your Bluesky feeds, and a search
// over it. Cloudflare Worker, plain JavaScript, no bundler of its own (wrangler's
// esbuild inlines the imports).
//
// Two entry points:
//   scheduled  every ten minutes: pull what is new from Following and any feeds
//              switched on, into D1 (src/worker/sync.js)
//   fetch      the search page and its JSON API, behind the family sign-on
//
// Gate order (app-ops docs/SSO-PORTAL.md, "Order of the gates"): icons and
// /api/health are public; everything else needs a sev_id identity for this app,
// then an admin role, because this is one person's reading history, not a
// family app. POSTs must also come from this origin: the identity cookie is
// SameSite=Lax on .sevitz.com, so it rides along on same-site POSTs from any
// other *.sevitz.com host, including third-party software like Paperless.
//
// Bindings (wrangler.toml): DB, the D1 database. Secrets (app-ops.toml):
// BSKY_HANDLE, BSKY_APP_PASSWORD, GITHUB_ISSUES_TOKEN.

import pkg from '../../package.json' with { type: 'json' };
// Vendored from app-ops with bin/lib-sync.sh. Do not edit these directories
// here; edit them in app-ops and re-run the script.
import { requireIdentity } from './auth-client/client.js';
import { mountBugReport, bugReportScriptTag } from './bug-report/index.js';
import { mountWhoami, whoamiScriptTag } from './whoami/index.js';
import * as icons from './icon-data.js';
import PAGE_HTML from './ui/page.html';
import APP_JS from './ui/app.client.js';
import DEMO_DATA from './ui/demo-data.json' with { type: 'json' };
import { Store } from './store.js';
import { runSync, backfillStep, config } from './sync.js';
import { search, status } from './search.js';
import { listFeeds, reloadSavedFeeds, setFeedEnabled } from './feeds.js';

const ACCENT = '#1083fe';

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

const PAGE_CSP = [
  "default-src 'self'",
  "img-src 'self' https: data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const WEB_MANIFEST = JSON.stringify({
  name: 'skyback',
  short_name: 'skyback',
  icons: [
    { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
    { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
    { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
  ],
  theme_color: '#1083fe',
  background_color: '#1083fe',
  display: 'standalone',
});

const ICON_LINKS = `<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">`;

const ICONS = {
  '/favicon.ico': ['image/x-icon', icons.FAVICON_ICO_B64],
  '/favicon-32x32.png': ['image/png', icons.FAVICON_32_B64],
  '/favicon-16x16.png': ['image/png', icons.FAVICON_16_B64],
  '/android-chrome-192x192.png': ['image/png', icons.ANDROID_192_B64],
  '/android-chrome-512x512.png': ['image/png', icons.ANDROID_512_B64],
  '/apple-touch-icon.png': ['image/png', icons.APPLE_TOUCH_ICON_B64],
  '/apple-touch-icon-precomposed.png': ['image/png', icons.APPLE_TOUCH_ICON_B64],
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS },
  });
}

// The page has two faces from one file. Blocks between <!--owner:start--> and
// <!--owner:end--> are the signed-in app (status, filters, feeds, backfill);
// blocks between <!--demo:start--> and <!--demo:end--> are only for /demo. The
// block that does not apply is removed from the HTML, not hidden, so the public
// demo has no owner controls in its DOM at all.
const OWNER_BLOCK = /<!--owner:start-->[\s\S]*?<!--owner:end-->\n?/g;
const DEMO_BLOCK = /<!--demo:start-->[\s\S]*?<!--demo:end-->\n?/g;
const MARKERS = /<!--(?:owner|demo):(?:start|end)-->\n?/g;

function renderPage(env, { demo = false, demoData = null } = {}) {
  const repo = (env && env.GITHUB_REPO) || 'sevitz/skyback';
  const data = demo && demoData
    ? `<script type="application/json" id="demo-data">${JSON.stringify(demoData).replace(/</g, '\\u003c')}</script>\n`
    : '';
  return PAGE_HTML.replace(demo ? OWNER_BLOCK : DEMO_BLOCK, '')
    .replace(MARKERS, '')
    .replace('{{ICON_LINKS}}', ICON_LINKS)
    .replace('{{BODY_ATTR}}', demo ? ' data-demo="1"' : '')
    .replace('{{DEMO_DATA}}', data)
    .replace('{{APP_SRC}}', demo ? '/demo/app.js' : '/app.js')
    .replaceAll('{{GITHUB_URL}}', `https://github.com/${repo}`)
    .replaceAll('{{VERSION}}', pkg.version)
    .replace('{{BUG_REPORT_SCRIPT}}', demo ? '' : bugReportScriptTag())
    .replace('{{WHOAMI_SCRIPT}}', demo ? '' : whoamiScriptTag());
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

// The app's own policy, on top of the portal's "may enter skyback".
function isOwner(who) {
  return who && who.role === 'admin';
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // ---- public ----
  if (ICONS[path]) {
    const [type, b64] = ICONS[path];
    return new Response(base64ToBytes(b64), {
      headers: { 'content-type': type, 'cache-control': 'public, max-age=86400' },
    });
  }
  if (path === '/manifest.webmanifest') {
    return new Response(WEB_MANIFEST, {
      headers: { 'content-type': 'application/manifest+json', 'cache-control': 'public, max-age=86400' },
    });
  }
  if (path === '/api/health') return json({ ok: true, version: pkg.version });

  // ---- public: the demo ----
  // The only routes besides /api/health and the icons that answer without a
  // sign-in. The demo never touches D1 or Bluesky: its sample posts ride in the
  // page and the script searches them in the browser.
  if (path === '/demo' && request.method === 'GET') {
    return new Response(renderPage(env, { demo: true, demoData: DEMO_DATA }), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=3600',
        'content-security-policy': PAGE_CSP,
        ...SECURITY_HEADERS,
      },
    });
  }
  if (path === '/demo/app.js' && request.method === 'GET') {
    return new Response(APP_JS, {
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=3600',
        ...SECURITY_HEADERS,
      },
    });
  }

  // ---- the front door ----
  // A signed-out visitor to the front page lands on the public demo, whose "demo |
  // login" pill leads to /login. Anyone holding a sev_id cookie, even a lapsed one,
  // still goes through the portal, which renews it without a prompt: the page's
  // 401 handler (a reload) relies on that.
  if (path === '/' && request.method === 'GET' && !/(?:^|;\s*)sev_id=/.test(request.headers.get('cookie') || '')) {
    return Response.redirect(`${url.origin}/demo`, 302);
  }
  // The pill's target: signed out goes to the portal and returns here, signed in
  // carries on to the app.
  if (path === '/login' && request.method === 'GET') {
    const signedIn = await requireIdentity(request, env, { json: false });
    if (signedIn instanceof Response) return signedIn;
    return Response.redirect(`${url.origin}/`, 302);
  }

  // ---- identity ----
  const isApi = path.startsWith('/api/');
  const who = await requireIdentity(request, env, { json: isApi });
  if (who instanceof Response) return who;
  if (!isOwner(who)) {
    return isApi
      ? json({ ok: false, error: 'skyback is a personal archive' }, 403)
      : new Response('skyback is a personal archive', { status: 403, headers: SECURITY_HEADERS });
  }
  if (request.method === 'POST') {
    const origin = request.headers.get('origin');
    if (origin !== url.origin) return json({ ok: false, error: 'Cross-origin request refused' }, 403);
  }

  const whoami = await mountWhoami(request, env, { identity: who, corner: 'top-right' });
  if (whoami) return whoami;
  const bug = await mountBugReport(request, env, {
    app: 'skyback',
    version: pkg.version,
    accent: ACCENT,
    reporter: who.name,
    nameField: false,
    limit: 'd1',
  });
  if (bug) return bug;

  // ---- the app ----
  if (path === '/' && request.method === 'GET') {
    return new Response(renderPage(env), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': PAGE_CSP,
        ...SECURITY_HEADERS,
      },
    });
  }
  if (path === '/app.js' && request.method === 'GET') {
    return new Response(APP_JS, {
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'private, max-age=3600',
        ...SECURITY_HEADERS,
      },
    });
  }

  const cfg = config(env);

  if (path === '/api/search' && request.method === 'GET') {
    const store = new Store(env.DB);
    try {
      const usage = await store.usageToday();
      if (usage.rows_read >= cfg.dailyReadBudget) {
        return json({ ok: false, error: "Search is paused until midnight UTC: today's D1 read budget is spent." }, 503);
      }
      const p = url.searchParams;
      return json(await search(store, {
        q: p.get('q'),
        feed: p.get('feed'),
        posted: p.get('posted'),
        sort: p.get('sort'),
        offset: p.get('offset'),
      }));
    } catch (err) {
      const message = String((err && err.message) || err);
      // FTS5 rejects some inputs the parser lets through; say so plainly.
      if (/fts5|MATCH/i.test(message)) return json({ ok: false, error: 'Could not search for that. Try plainer words.' }, 400);
      if (/alongside/.test(message)) return json({ ok: false, error: message }, 400);
      throw err;
    } finally {
      await store.flushUsage(0);
    }
  }

  if (path === '/api/status' && request.method === 'GET') {
    const store = new Store(env.DB);
    try {
      return json({ version: pkg.version, ...(await status(store, cfg)) });
    } finally {
      await store.flushUsage(0);
    }
  }

  if (path === '/api/feeds' && request.method === 'GET') {
    const store = new Store(env.DB);
    try {
      return json(await listFeeds(store));
    } finally {
      await store.flushUsage(0);
    }
  }

  if (path === '/api/feeds/refresh' && request.method === 'POST') {
    return json(await reloadSavedFeeds(env, pkg.version));
  }

  if (path === '/api/feeds/toggle' && request.method === 'POST') {
    const body = await readJson(request);
    if (typeof body.uri !== 'string') return json({ ok: false, error: 'uri required' }, 400);
    const store = new Store(env.DB);
    try {
      const r = await setFeedEnabled(store, body.uri, !!body.enabled);
      return json(r, r.ok ? 200 : 400);
    } finally {
      await store.flushUsage(0);
    }
  }

  if (path === '/api/feeds/fetch' && request.method === 'POST') {
    const body = await readJson(request);
    if (typeof body.uri !== 'string' || body.uri === 'following') return json({ ok: false, error: 'a feed uri is required' }, 400);
    return json(await runSync(env, { trigger: 'fetch-now', only: { feed: body.uri }, version: pkg.version }));
  }

  if (path === '/api/sync' && request.method === 'POST') {
    return json(await runSync(env, { trigger: 'sync-now', version: pkg.version }));
  }

  if (path === '/api/backfill/step' && request.method === 'POST') {
    const body = await readJson(request);
    let target = null;
    if (body.target !== undefined && body.target !== null) {
      if (typeof body.target !== 'string' || Number.isNaN(Date.parse(body.target))) {
        return json({ ok: false, error: 'target must be a time' }, 400);
      }
      target = new Date(body.target).toISOString();
    }
    return json(await backfillStep(env, { target, version: pkg.version }));
  }

  return isApi ? json({ ok: false, error: 'Not found' }, 404) : new Response('Not found', { status: 404 });
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      console.error('skyback request failed', err && err.stack ? err.stack : err);
      return json({ ok: false, error: 'Something went wrong. Check wrangler tail.' }, 500);
    }
  },

  async scheduled(controller, env) {
    const r = await runSync(env, { trigger: 'cron', version: pkg.version });
    if (r.error) console.error('skyback sync failed', r.error);
  },
};
