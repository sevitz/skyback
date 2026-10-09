// GENERATED FILE -- do not edit here.
//
// Source of truth: app-ops/lib/bug-report/limit.js
// Refresh with:   zsh ~/Code/app-ops/bin/lib-sync.sh --install
// Check drift:    zsh ~/Code/app-ops/bin/lib-sync.sh
//
// ---------------------------------------------------------------------------
//
// Bug-report throttling, per IP, in D1.
//
// The widget is shown to every visitor of a public app, not just the admin,
// which makes an unlimited /api/report-bug exactly the open spam relay into the
// repo that gating it used to avoid. A fixed window per IP, in D1 rather than a
// module-level Map because Workers isolates are created and destroyed freely --
// an in-memory counter resets at exactly the moment an attacker benefits.
//
// Opt in with `limit: 'd1'` and add the migration; see index.js. Engaging this
// automatically on the presence of env.DB was rejected: an app whose migration
// had not run yet would throw on every report, whereas a forgotten opt-in merely
// leaves the app as unthrottled as it was before.
//
// Requires a table (copy migrations/0004_bug_report_limits.sql from recaipe):
//
//   CREATE TABLE bug_report_limits (
//     ip           TEXT PRIMARY KEY,
//     count        INTEGER NOT NULL DEFAULT 0,
//     window_start TEXT NOT NULL DEFAULT (datetime('now')),
//     updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
//   );

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

const BUG_REPORT_MAX = 5;
const BUG_REPORT_WINDOW_MINUTES = 60;

async function bugReportWindow(request, env) {
  const row = await env.DB.prepare(
    'SELECT count, window_start FROM bug_report_limits WHERE ip = ?'
  ).bind(clientIp(request)).first();
  if (!row) return { count: 0, expired: true };
  const expired = Date.now() - new Date(row.window_start).getTime() > BUG_REPORT_WINDOW_MINUTES * 60 * 1000;
  return { count: row.count, expired };
}

export async function checkBugReportLimit(request, env) {
  const { count, expired } = await bugReportWindow(request, env);
  return expired || count < BUG_REPORT_MAX;
}

// Called once an attempt is actually made against GitHub, successful or not --
// the limit protects the repo (and GITHUB_ISSUES_TOKEN's own rate limit) from
// the attempt itself, not just from successfully-filed issues.
export async function recordBugReport(request, env) {
  const ip = clientIp(request);
  const { expired } = await bugReportWindow(request, env);

  if (expired) {
    await env.DB.prepare(
      `INSERT INTO bug_report_limits (ip, count, window_start, updated_at)
       VALUES (?, 1, datetime('now'), datetime('now'))
       ON CONFLICT(ip) DO UPDATE SET
         count = 1, window_start = excluded.window_start, updated_at = excluded.updated_at`
    ).bind(ip).run();
  } else {
    await env.DB.prepare(
      "UPDATE bug_report_limits SET count = count + 1, updated_at = datetime('now') WHERE ip = ?"
    ).bind(ip).run();
  }
}
