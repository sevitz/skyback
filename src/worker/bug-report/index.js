// GENERATED FILE -- do not edit here.
//
// Source of truth: app-ops/lib/bug-report/index.js
// Refresh with:   zsh ~/Code/app-ops/bin/lib-sync.sh --install
// Check drift:    zsh ~/Code/app-ops/bin/lib-sync.sh
//
// ---------------------------------------------------------------------------
//
// The in-app "report a bug" button, for every app in the family.
//
// Two routes, one call. GET /bug-report-widget.js serves the floating button and
// the panel it opens; POST /api/report-bug files what that panel collects as a
// GitHub issue in this app's own repo.
//
// This module owns the reporting mechanism and nothing else. It has no opinion
// about who may report -- mount it before the app's gate for a public app, after
// it for a private one -- and it never looks up the reporter itself: the app
// passes what it already knows. The moment this file knows what a recipe or a
// word list is, the split is wrong.
//
// Config, per app:
//   GITHUB_REPO          plain [vars] in wrangler.toml, "sevitz/<repo>", not a secret
//   GITHUB_ISSUES_TOKEN  a secret, the shared PAT at op://_code_secrets/app-ops
//
// Typical use, one call covering both routes:
//
//   const bug = await mountBugReport(request, env, {
//     app: 'example',
//     version: pkg.version,
//     accent: '#8a3324',
//     limit: 'd1',
//   });
//   if (bug) return bug;              // null when the request is neither route
//
// A Worker that renders its own HTML also drops bugReportScriptTag() into the
// page shell. A Vite SPA instead injects the script from index.html, because a
// plain <script src> would send Vite looking for a build-time file that only
// exists at runtime -- and needs "/bug-report-widget.js" in run_worker_first so
// the asset handler does not swallow it.
//
// THE MANUAL STEP NO SCRIPT CAN DO. The PAT is shared across the family and
// fine-grained, so its repository-access list lives only in GitHub's own token
// settings -- not in 1Password, not in any manifest, and nowhere secrets-sync.sh
// can see or set. A repo missing from that list gets a 404 from the issues API,
// which GitHub deliberately makes indistinguishable from a typo'd GITHUB_REPO.
// That cost a real debugging session on recaipe's first submission, which is why
// the 502 below names the likely cause out loud. See app-ops's templates/README.md
// "Bug reporting", step 5.

import { checkBugReportLimit, recordBugReport } from './limit.js';

const WIDGET_PATH = '/bug-report-widget.js';
const API_PATH = '/api/report-bug';
const DEFAULT_ACCENT = '#475569';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// The widget, as browser JS the Worker serves. Plain ES5-ish, no build step, no
// framework: it has to drop into a Vite SPA and a Worker-rendered HTML page
// alike. Only two things vary per app, both interpolated here rather than
// branched at runtime, so the served file stays cacheable.
function widgetSource({ accent, nameField }) {
  return `(function () {
  var BTN_ID = "__bugReportBtn";
  if (document.getElementById(BTN_ID)) return;

  var ACCENT = "${accent}";
  var NAME_FIELD = ${nameField ? 'true' : 'false'};

  var style = document.createElement("style");
  style.textContent =
    "#" + BTN_ID + "{position:fixed;right:16px;bottom:16px;width:44px;height:44px;" +
    "border-radius:50%;border:none;background:" + ACCENT + ";color:#fff;font-size:20px;" +
    "line-height:44px;text-align:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);" +
    "z-index:2147483000;}" +
    "#__bugReportPanel{position:fixed;right:16px;bottom:68px;width:min(320px,calc(100vw - 32px));" +
    "background:#fff;color:#111;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3);" +
    "padding:12px;z-index:2147483000;font:14px/1.4 system-ui,sans-serif;}" +
    "#__bugReportPanel textarea,#__bugReportPanel input[type=text]{width:100%;" +
    "box-sizing:border-box;font:inherit;padding:6px;border:1px solid #ccc;" +
    "border-radius:4px;}" +
    "#__bugReportPanel textarea{min-height:80px;resize:vertical;margin-top:8px;}" +
    "#__bugReportPanel label{font-size:12px;color:#555;}" +
    "#__bugReportPanel button{font:inherit;padding:6px 12px;border-radius:4px;border:none;" +
    "cursor:pointer;margin-top:8px;}" +
    "#__bugReportPanel .submit{background:" + ACCENT + ";color:#fff;margin-right:8px;}" +
    "#__bugReportPanel .cancel{background:#e5e7eb;}" +
    "#__bugReportPanel .status{margin-top:8px;font-size:12px;}";
  document.head.appendChild(style);

  var btn = document.createElement("button");
  btn.id = BTN_ID;
  btn.title = "Report a bug";
  btn.textContent = "\\uD83D\\uDC1B";
  document.body.appendChild(btn);

  var panel = null;
  var NAME_KEY = "__bugReportReporterName";

  function storedName() {
    try { return localStorage.getItem(NAME_KEY) || ""; } catch (e) { return ""; }
  }

  function rememberName(name) {
    try { localStorage.setItem(NAME_KEY, name); } catch (e) {}
  }

  function closePanel() {
    if (panel) { panel.remove(); panel = null; }
  }

  function openPanel() {
    if (panel) return;
    panel = document.createElement("div");
    panel.id = "__bugReportPanel";
    panel.innerHTML =
      "<div>What went wrong?</div>" +
      (NAME_FIELD
        ? "<label>Your name (optional)</label>" +
          "<input type=\\"text\\" class=\\"reporter\\" placeholder=\\"So we know who to follow up with\\">"
        : "") +
      "<textarea placeholder=\\"Describe the bug...\\"></textarea>" +
      "<div>" +
      "<button class=\\"submit\\">Send</button>" +
      "<button class=\\"cancel\\">Cancel</button>" +
      "</div>" +
      "<div class=\\"status\\"></div>";
    document.body.appendChild(panel);

    var reporterInput = panel.querySelector(".reporter");
    var textarea = panel.querySelector("textarea");
    var statusEl = panel.querySelector(".status");
    if (reporterInput) {
      reporterInput.value = (typeof window.__bugReportReporterName === "string" && window.__bugReportReporterName) || storedName();
    }
    textarea.focus();

    panel.querySelector(".cancel").addEventListener("click", closePanel);

    panel.querySelector(".submit").addEventListener("click", function () {
      var description = textarea.value.trim();
      if (!description) { statusEl.textContent = "Say a bit about the bug first."; return; }
      var reporterName = reporterInput ? reporterInput.value.trim() : "";
      if (reporterInput) rememberName(reporterName);

      statusEl.textContent = "Sending...";
      fetch("${API_PATH}", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description: description,
          reporterName: reporterName,
          url: location.href,
          title: document.title,
          userAgent: navigator.userAgent,
          timestamp: new Date().toISOString(),
        }),
      })
        .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (result) {
          if (result.ok) {
            statusEl.textContent = "Reported. Thanks!";
            setTimeout(closePanel, 1500);
          } else {
            statusEl.textContent = "Couldn't send: " + (result.data && result.data.error || "unknown error");
          }
        })
        .catch(function () { statusEl.textContent = "Couldn't send: network error."; });
    });
  }

  btn.addEventListener("click", function () {
    if (panel) closePanel(); else openPanel();
  });
})();
`;
}

// For a Worker that renders its own HTML: drop this into the page shell, once
// per template. A Vite SPA injects the script from index.html instead.
export function bugReportScriptTag() {
  return `<script src="${WIDGET_PATH}" defer></script>`;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function handleReportBug(request, env, options) {
  const { app, version, reporter, limit, labels } = options;

  if (!env.GITHUB_ISSUES_TOKEN || !env.GITHUB_REPO) {
    return json({ error: 'Bug reporting is not configured for this app.' }, 501);
  }

  const payload = await readJson(request);
  if (!payload) return json({ error: 'Invalid JSON.' }, 400);

  const description = String(payload.description || '').trim().slice(0, 4000);
  if (!description) return json({ error: 'description is required.' }, 400);

  if (limit === 'd1' && !(await checkBugReportLimit(request, env))) {
    return json({ error: 'Too many reports from this address recently. Try again later.' }, 429);
  }

  // What the person typed wins, then what the app knows, then Access. This
  // ordering is deliberate and was the family's before it was the library's:
  // the field asks "who should we follow up with", which is not "who is signed
  // in". A parent reporting a bug their child hit should be able to say so, and
  // on a shared family login the session name is frequently the wrong answer.
  //
  // An app holding an authoritative identity therefore also passes
  // nameField: false, so there is no box to override it and `reporter` is what
  // gets recorded. Do not reorder these without changing that too.
  const reportedBy =
    String(payload.reporterName || '').trim().slice(0, 200) ||
    String(reporter || '').trim().slice(0, 200) ||
    request.headers.get('Cf-Access-Authenticated-User-Email') ||
    'not given';

  const title = description.length > 80 ? `${description.slice(0, 77)}...` : description;
  const body = [
    description,
    '',
    '---',
    '**Context** (for whoever picks this up, human or Claude Code):',
    `- App: ${app}${version ? ` v${version}` : ''}`,
    `- Reported by: ${reportedBy}`,
    `- Page: ${String(payload.url || 'unknown').slice(0, 500)}`,
    `- Title: ${String(payload.title || 'unknown').slice(0, 200)}`,
    `- User agent: ${String(payload.userAgent || 'unknown').slice(0, 300)}`,
    `- Reported at: ${String(payload.timestamp || new Date().toISOString())}`,
  ].join('\n');

  if (limit === 'd1') await recordBugReport(request, env);

  async function createIssue(withLabels) {
    return fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GITHUB_ISSUES_TOKEN}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': `${app}-bug-report-widget`,
      },
      body: JSON.stringify(withLabels ? { title, body, labels } : { title, body }),
    });
  }

  let response = await createIssue(labels.length > 0);
  // A label that does not yet exist on the repo (a fresh repo, or one that never
  // got the "bug-report" label created) is a 422, not something the reporter did
  // wrong -- worth a filed issue over losing the report to a cosmetic label.
  if (!response.ok && response.status === 422) {
    response = await createIssue(false);
  }

  if (!response.ok) {
    // GitHub's own message ("Bad credentials", "Not Found", a validation detail)
    // is the one thing that actually explains a 502 here -- logged for the
    // Cloudflare dashboard, and a trimmed version returned too, since without it
    // this endpoint has been undebuggable from the outside.
    const detail = await response.json().catch(() => null);
    console.error('GitHub issue creation failed', response.status, env.GITHUB_REPO, detail);
    const reason = detail?.message ? `: ${String(detail.message).slice(0, 200)}` : '';
    // A 404 here almost never means what it says. GitHub hides the existence of
    // repos a fine-grained token cannot see, so "the shared PAT was never granted
    // access to this repo" and "GITHUB_REPO is wrong" arrive identically.
    const hint =
      response.status === 404
        ? ` Check that GITHUB_REPO ("${env.GITHUB_REPO}") is right and that the shared PAT lists this repo in its repository access.`
        : '';
    return json({ error: `Failed to file the issue on GitHub (${response.status})${reason}.${hint}` }, 502);
  }

  const issue = await response.json();
  return json({ url: issue.html_url }, 201);
}

// Both routes, one call. Returns a Response, or null if this request is neither
// -- so the caller mounts it with a single `if`.
//
// options:
//   app        required. Names the app in the issue body and the User-Agent.
//   version    the running version, from package.json. Stamped into the body.
//   accent     the button's colour. Defaults to the template's slate grey.
//   reporter   who the app knows is reporting. Omit if it does not know.
//   nameField  show the "Your name" box. Defaults to true when `reporter` is
//              absent -- but pass it explicitly, because the widget response is
//              cached and must not vary per request.
//   limit      'd1' to throttle per IP. Needs the bug_report_limits table.
//   labels     defaults to ['bug-report'].
export async function mountBugReport(request, env, options = {}) {
  const url = new URL(request.url);
  const app = options.app || 'unknown';
  const accent = options.accent || DEFAULT_ACCENT;
  const nameField = options.nameField ?? !options.reporter;

  if (url.pathname === WIDGET_PATH && request.method === 'GET') {
    return new Response(widgetSource({ accent, nameField }), {
      headers: {
        'content-type': 'application/javascript',
        'cache-control': 'public, max-age=86400',
      },
    });
  }

  if (url.pathname === API_PATH && request.method === 'POST') {
    return handleReportBug(request, env, {
      app,
      version: options.version,
      reporter: options.reporter,
      limit: options.limit,
      labels: options.labels || ['bug-report'],
    });
  }

  return null;
}
