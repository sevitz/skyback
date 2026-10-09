// GENERATED FILE -- do not edit here.
//
// Source of truth: app-ops/lib/whoami/index.js
// Refresh with:   zsh ~/Code/app-ops/bin/lib-sync.sh --install
// Check drift:    zsh ~/Code/app-ops/bin/lib-sync.sh
//
// ---------------------------------------------------------------------------
//
// The "who is signed in" pill, for every app in the family.
//
// A small two-tone emoji pill fixed in a corner of the page: the person's face
// on their own accent colour, their name beside it. The identity counterpart to
// the version number every app already shows -- "reload and tell me what it
// says" works for who as well as for which build.
//
// Two routes, one call. GET /whoami-widget.js serves the pill as browser JS;
// GET /api/whoami answers it with the identity the app passes in.
//
// This module owns the pill and nothing else. Like bug-report, it never looks
// up the person itself: the app passes what requireIdentity() already gave it.
// That is why this file does NOT import auth-client -- an app can vendor one
// without the other, and the identity is the app's to hand over, not this
// library's to fetch. It holds nothing secret and needs no [vars].
//
// Typical use, one call covering both routes, right after the identity gate:
//
//   const who = await requireIdentity(request, env);
//   if (who instanceof Response) return who;
//   const whoami = await mountWhoami(request, env, { identity: who });
//   if (whoami) return whoami;        // null when the request is neither route
//
// A Worker that renders its own HTML also drops whoamiScriptTag() into the page
// shell. A Vite SPA instead injects the script from index.html and lists
// "/whoami-widget.js" in run_worker_first, so the asset handler does not
// swallow it -- same footnote as bug-report.
//
// KEEPING THE FACES AND COLOURS IN SYNC. PEOPLE below is a copy of auth's
// PERSON_FACE (src/worker/visuals.js) and its --who-* colours
// (src/worker/styles.js). The auth repo is the source of truth; this copy
// exists so a person's face and colour look the same wherever they meet them --
// the same reason auth's own journal notes its --kid-* colours are copied from
// another app. If auth changes a face or an accent, change it here too and re-run
// bin/lib-sync.sh --all.

const WIDGET_PATH = '/whoami-widget.js';
const API_PATH = '/api/whoami';

// emoji + accent, light / dark. Keyed by identity.sub.
// TRIMMED FOR THE PUBLIC REPO: the family copy of this file lists every household
// member. skyback only admits its owner, so only the owner is kept here and anyone
// else falls back to the muted default. Re-running app-ops's lib-sync.sh would
// restore the full roster; do not let that reach a public copy (see the journal).
const PEOPLE = {
  sev:    { emoji: '👨🏻‍💻',       light: '#c8102e', dark: '#ff6b7d' },
};

// Any other sub -- a guest (g-*), a demo -- still renders, just muted.
const FALLBACK = { emoji: '🙂', light: '#6b6a72', dark: '#9b9aa6' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function cornerCss(corner) {
  switch (corner) {
    case 'top-left': return 'top:12px;left:12px';
    case 'bottom-left': return 'bottom:12px;left:12px';
    case 'top-right':
    default: return 'top:12px;right:12px';
  }
}

// The pill's stylesheet. The per-person accents are baked in as classes rather
// than set inline, because each needs a light value and a dark one and an inline
// style cannot carry a media query. Everything here is static per `corner`, so
// the widget response stays cacheable.
function styleSheet(corner) {
  const light = [
    `.__whoami{${cornerCss(corner)};--c:${FALLBACK.light};--panel:#ffffff;--ink:#17171a}`,
  ];
  const dark = [
    `.__whoami{--c:${FALLBACK.dark};--panel:#1c1c22;--ink:#eceaf0}`,
  ];
  for (const [key, p] of Object.entries(PEOPLE)) {
    light.push(`.__whoami.p-${key}{--c:${p.light}}`);
    dark.push(`.__whoami.p-${key}{--c:${p.dark}}`);
  }

  // The two-tone "has-cap" pill, lifted from auth's .rolepill
  // (src/worker/styles.js): an emoji cap on a solid-ish accent, the label on a
  // lighter tint of the same. --panel / --ink are given fallbacks above so the
  // pill needs no CSS variables from the host page.
  return [
    light.join(''),
    `.__whoami{position:fixed;z-index:2147482000;display:inline-flex;align-items:stretch;` +
      `overflow:hidden;border-radius:999px;` +
      `border:1px solid color-mix(in srgb,var(--c) 55%,transparent);` +
      `font:700 11px/1 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}`,
    `.__whoami-cap{display:inline-flex;align-items:center;padding:3px 6px;font-size:12px;` +
      `background:color-mix(in srgb,var(--c) 30%,var(--panel))}`,
    `.__whoami-label{display:inline-flex;align-items:center;padding:3px 9px;` +
      `text-transform:uppercase;letter-spacing:.05em;` +
      `color:color-mix(in srgb,var(--c) 72%,var(--ink));` +
      `background:color-mix(in srgb,var(--c) 13%,var(--panel))}`,
    `@media (prefers-color-scheme:dark){${dark.join('')}}`,
  ].join('');
}

// The pill, as browser JS the Worker serves. Plain ES5-ish, no build step: it
// drops into a Vite SPA and a Worker-rendered HTML page alike. It fetches
// /api/whoami and renders nothing unless that says somebody is signed in, so the
// script itself carries no identity and stays cacheable.
function widgetSource({ corner } = {}) {
  const css = styleSheet(corner);
  const emoji = {};
  for (const [key, p] of Object.entries(PEOPLE)) emoji[key] = p.emoji;

  return `(function () {
  var ID = "__whoamiPill";
  if (document.getElementById(ID)) return;

  var EMOJI = ${JSON.stringify(emoji)};
  var FALLBACK_EMOJI = ${JSON.stringify(FALLBACK.emoji)};

  var style = document.createElement("style");
  style.textContent = ${JSON.stringify(css)};
  document.head.appendChild(style);

  fetch("${API_PATH}", { credentials: "same-origin", headers: { accept: "application/json" } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.signedIn) return;
      var sub = String(d.sub || "");
      var name = String(d.name || sub || "");
      if (!name) return;

      var pill = document.createElement("span");
      pill.id = ID;
      pill.className = "__whoami" + (EMOJI[sub] ? " p-" + sub : "");
      pill.title = name + (d.role ? " \\u2014 " + d.role : "");

      var cap = document.createElement("span");
      cap.className = "__whoami-cap";
      cap.setAttribute("aria-hidden", "true");
      cap.textContent = EMOJI[sub] || FALLBACK_EMOJI;

      var label = document.createElement("span");
      label.className = "__whoami-label";
      label.textContent = name;

      pill.appendChild(cap);
      pill.appendChild(label);
      (document.body || document.documentElement).appendChild(pill);
    })
    .catch(function () {});
})();
`;
}

// For a Worker that renders its own HTML: drop this into the page shell. A Vite
// SPA injects the script from index.html instead.
export function whoamiScriptTag() {
  return `<script src="${WIDGET_PATH}" defer></script>`;
}

// Both routes, one call. Returns a Response, or null if this request is neither
// -- so the caller mounts it with a single `if`.
//
// options:
//   identity   what requireIdentity(request, env) returned: { sub, name, role }.
//              Omit, or pass null, when the app has no login or nobody is signed
//              in -- /api/whoami then answers { signedIn: false } and the pill
//              renders nothing.
//   corner     where the pill sits: 'top-right' (default), 'top-left',
//              'bottom-left'. Not 'bottom-right' -- that is the bug-report
//              button's corner.
export async function mountWhoami(request, env, options = {}) {
  const url = new URL(request.url);

  if (url.pathname === WIDGET_PATH && request.method === 'GET') {
    return new Response(widgetSource({ corner: options.corner }), {
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=86400',
      },
    });
  }

  if (url.pathname === API_PATH && request.method === 'GET') {
    const id = options.identity;
    if (!id || !id.sub) return json({ signedIn: false });
    return json({
      signedIn: true,
      sub: id.sub,
      name: id.name || id.sub,
      role: id.role || null,
    });
  }

  return null;
}
