// HTML renderer for the read-only status dashboard served at GET /.
'use strict';

const fs = require('node:fs');

const DEFAULT_PATH = '/hooks/github';

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function repositoryHtml(repo, fallback) {
    const value = String(repo || '');
    const parts = value.split('/');
    if (parts.length !== 2 || parts.some((part) => !part)) return escapeHtml(fallback);

    const href = `https://github.com/${parts.map(encodeURIComponent).join('/')}`;
    return `<a class="repo-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="Open ${escapeHtml(value)} on GitHub">${escapeHtml(value)}</a>`;
}

function repositoryHooksLink(repo, fallback) {
    const value = String(repo || '');
    const parts = value.split('/');
    if (parts.length !== 2 || parts.some((part) => !part)) return escapeHtml(fallback);

    const href = `https://github.com/${parts.map(encodeURIComponent).join('/')}/settings/hooks`;
    return `<a class="repo-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="Open webhook settings for ${escapeHtml(value)}">${escapeHtml(value)}</a>`;
}

function duration(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    if (total < 60) return `${total}s`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
}

function hookReadiness(hook, secrets, options) {
    const secretEnv = hook.secretEnv || 'GITHUB_WEBHOOK_SECRET';
    if (!secrets.has(secretEnv)) return { label: 'Secret missing', tone: 'warning' };

    try {
        fs.accessSync(hook.run, fs.constants.X_OK);
    } catch {
        return { label: 'Script unavailable', tone: 'warning' };
    }

    if (options.dryRun) return { label: 'Dry run', tone: 'neutral' };
    return { label: 'Ready', tone: 'ready' };
}

/** The read-only dashboard served at GET /. */
function dashboardPage(config, secrets, options, requestHost, recentDeliveries = [], scriptNonce = '') {
    const hooks = Array.isArray(config.hooks) ? config.hooks : [];
    const endpoint = options.path || config.path || DEFAULT_PATH;
    const address = `${requestHost || 'localhost'}${endpoint}`;
    const cards = hooks.map((hook, index) => {
        const name = hook.name || `hook-${index + 1}`;
        const repo = hook.repo === '*' || !hook.repo ? 'Any repository' : hook.repo;
        const events = Array.isArray(hook.events) && hook.events.length ? hook.events : ['push'];
        const branches = Array.isArray(hook.branches) && hook.branches.length && !hook.branches.includes('*')
            ? hook.branches.join(', ')
            : 'Any branch';
        const readiness = hookReadiness(hook, secrets, options);

        return `
          <article class="hook-card">
            <div class="hook-heading">
              <h3>${escapeHtml(name)}</h3>
              <span class="hook-state ${readiness.tone}">${escapeHtml(readiness.label)}</span>
            </div>
            <dl>
              <div><dt>Repository</dt><dd>${repositoryHooksLink(hook.repo, repo)}</dd></div>
              <div><dt>Events</dt><dd>${escapeHtml(events.join(', '))}</dd></div>
              <div><dt>Branches</dt><dd>${escapeHtml(branches)}</dd></div>
              <div><dt>Script</dt><dd><code class="script-path">${escapeHtml(hook.run || 'Not configured')}</code></dd></div>
            </dl>
          </article>`;
    }).join('');

    const hookContent = cards || `
        <div class="empty-state">
          <p>No webhooks are configured.</p>
          <span>Run <code>gift create</code> to add one.</span>
        </div>`;

    const deliveryRows = recentDeliveries.map((delivery) => {
        const receivedAt = new Date(delivery.receivedAt);
        const validTime = !Number.isNaN(receivedAt.getTime());
        const timestamp = validTime ? `${receivedAt.toISOString().slice(11, 19)} UTC` : '—';
        const datetime = validTime ? receivedAt.toISOString() : '';

        return `
            <tr>
              <td><time datetime="${escapeHtml(datetime)}">${escapeHtml(timestamp)}</time></td>
              <td><strong>${escapeHtml(delivery.event || 'Unknown event')}</strong><span class="delivery-id">${escapeHtml(delivery.id || 'No delivery ID')}</span></td>
              <td>${repositoryHtml(delivery.repo, 'Unknown repository')}</td>
              <td><span class="delivery-state ${escapeHtml(delivery.tone || 'neutral')}">${escapeHtml(delivery.outcome || 'Receiving')}</span>${delivery.detail ? `<span class="delivery-detail">${escapeHtml(delivery.detail)}</span>` : ''}</td>
            </tr>`;
    }).join('');

    const deliveryContent = deliveryRows
        ? `<div class="delivery-table"><table>
            <thead><tr><th>Received</th><th>Event</th><th>Repository</th><th>Result</th></tr></thead>
            <tbody>${deliveryRows}
            </tbody>
          </table></div>`
        : `<div class="empty-state deliveries-empty">
            <p>No deliveries received yet.</p>
            <span>New GitHub deliveries will appear here while this server is running.</span>
          </div>`;

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta http-equiv="refresh" content="30">
  <title>gift</title>
  <style>
    :root {
      color-scheme: light;
      --canvas: #f5f7f2;
      --surface: rgba(255, 255, 255, .82);
      --surface-strong: #ffffff;
      --ink: #17221b;
      --muted: #667269;
      --line: #dce3dc;
      --green: #18794e;
      --green-soft: #e5f5ec;
      --amber: #9a5b13;
      --amber-soft: #fff3d6;
      --shadow: 0 18px 50px rgba(32, 53, 40, .08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 10% 0%, rgba(120, 194, 148, .18), transparent 34rem),
        radial-gradient(circle at 100% 100%, rgba(235, 190, 94, .13), transparent 30rem),
        var(--canvas);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }
    main { width: min(1080px, calc(100% - 32px)); margin: 0 auto; padding: 36px 0 28px; }
    header { display: block; }
    .eyebrow { margin: 0 0 8px; color: var(--green); font-size: .76rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0; font: 600 clamp(1.6rem, 4vw, 2.35rem)/1 "Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: -.055em; }
    .lede { max-width: 620px; margin: 12px 0 0; color: var(--muted); font-size: .94rem; }
    .status-grid { display: grid; grid-template-columns: .8fr .8fr 1.8fr; gap: 10px; margin: 26px 0 30px; }
    .metric { min-width: 0; padding: 14px 17px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); box-shadow: var(--shadow); backdrop-filter: blur(12px); }
    .metric span, dt { color: var(--muted); font-size: .72rem; font-weight: 800; letter-spacing: .075em; text-transform: uppercase; }
    .metric strong { display: block; margin-top: 5px; font-size: .96rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    code { padding: .15em .42em; border-radius: 6px; background: #e9eee9; color: #34463a; font: .88em ui-monospace, SFMono-Regular, Menlo, monospace; }
    .script-path { word-break: break-all; }
    .repo-link { color: var(--green); font-weight: 650; text-decoration-thickness: 1px; text-underline-offset: 3px; }
    .repo-link:hover { text-decoration-thickness: 2px; }
    .repo-link:focus-visible { border-radius: 3px; outline: 2px solid currentColor; outline-offset: 3px; }
    section { margin-top: 30px; }
    section > div:first-child { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
    h2 { margin: 0; font-size: 1.2rem; letter-spacing: -.025em; }
    .count { color: var(--muted); font-size: .8rem; }
    .hooks { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 340px)); gap: 10px; }
    .hook-card { padding: 17px; border: 1px solid var(--line); border-radius: 15px; background: var(--surface-strong); box-shadow: var(--shadow); }
    .hook-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    h3 { min-width: 0; margin: 0; font-size: 1.08rem; overflow-wrap: anywhere; }
    .hook-state { flex: none; padding: 5px 9px; border-radius: 999px; font-size: .7rem; font-weight: 800; }
    .hook-state.ready { background: var(--green-soft); color: var(--green); }
    .hook-state.warning { background: var(--amber-soft); color: var(--amber); }
    .hook-state.neutral { background: #e9ecea; color: #526057; }
    .delivery-table { overflow-x: auto; border: 1px solid var(--line); border-radius: 15px; background: var(--surface-strong); box-shadow: var(--shadow); }
    table { width: 100%; min-width: 700px; border-collapse: collapse; text-align: left; }
    th { padding: 9px 14px; background: rgba(235, 240, 235, .65); color: var(--muted); font-size: .66rem; letter-spacing: .075em; text-transform: uppercase; }
    td { padding: 11px 14px; border-top: 1px solid var(--line); vertical-align: middle; font-size: .88rem; }
    td:first-child { width: 126px; color: var(--muted); font: .78rem ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
    td:nth-child(2) { width: 190px; }
    td:nth-child(3) { overflow-wrap: anywhere; }
    td:last-child { width: 210px; }
    .delivery-id, .delivery-detail { display: block; margin-top: 3px; color: var(--muted); font-size: .76rem; overflow-wrap: anywhere; }
    .delivery-state { display: inline-block; padding: 5px 9px; border-radius: 999px; font-size: .7rem; font-weight: 800; }
    .delivery-state.ready { background: var(--green-soft); color: var(--green); }
    .delivery-state.warning { background: var(--amber-soft); color: var(--amber); }
    .delivery-state.neutral { background: #e9ecea; color: #526057; }
    dl { margin: 13px 0 0; }
    dl div { display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: 10px; padding: 7px 0; border-top: 1px solid #edf0ed; font-size: .86rem; }
    dt { padding-top: 2px; }
    dd { margin: 0; overflow-wrap: anywhere; }
    .empty-state { grid-column: 1 / -1; padding: 28px 20px; border: 1px dashed #bdc9bf; border-radius: 15px; text-align: center; color: var(--muted); }
    .empty-state p { margin: 0 0 6px; color: var(--ink); font-weight: 750; }
    .deliveries-empty { background: var(--surface); }
    footer { display: flex; justify-content: space-between; gap: 20px; margin-top: 30px; padding-top: 14px; border-top: 1px solid var(--line); color: var(--muted); font-size: .76rem; }
    footer a { color: var(--green); text-decoration-thickness: 1px; text-underline-offset: 3px; }
    @media (max-width: 720px) {
      main { padding-top: 24px; }
      .status-grid { grid-template-columns: 1fr 1fr; margin: 22px 0 28px; }
      .metric:last-child { grid-column: 1 / -1; }
      .hooks { grid-template-columns: 1fr; }
      .delivery-table { margin-right: -16px; border-radius: 18px 0 0 18px; }
      footer { display: block; }
    }
    @media (prefers-color-scheme: dark) {
      :root { color-scheme: dark; --canvas: #111713; --surface: rgba(25, 34, 28, .82); --surface-strong: #19221c; --ink: #eff6f0; --muted: #a7b4aa; --line: #344139; --green: #73d59c; --green-soft: #183b29; --amber: #f0bd68; --amber-soft: #423119; --shadow: 0 18px 50px rgba(0, 0, 0, .18); }
      code { background: #29342d; color: #dce8de; }
      th { background: rgba(40, 52, 44, .8); }
      dl div { border-color: #2d3831; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <p class="eyebrow">gift webhooks</p>
        <h1>gift</h1>
        <p class="lede">This server is ready to receive signed GitHub deliveries and route them to the configured local hooks.</p>
      </div>
    </header>

    <div class="status-grid" aria-label="Server details">
      <div class="metric"><span>Status</span><strong>${options.dryRun ? 'Online · dry run' : 'Operational'}</strong></div>
      <div class="metric"><span>Uptime</span><strong id="uptime" data-seconds="${Math.floor(process.uptime())}">${escapeHtml(duration(process.uptime()))}</strong></div>
      <div class="metric"><span>Webhook endpoint</span><strong><code>POST ${escapeHtml(address)}</code></strong></div>
    </div>

    <section aria-labelledby="hooks-heading">
      <div>
        <h2 id="hooks-heading">Available webhooks</h2>
        <span class="count">${hooks.length} configured</span>
      </div>
      <div class="hooks">${hookContent}
      </div>
    </section>

    <section aria-labelledby="deliveries-heading">
      <div>
        <h2 id="deliveries-heading">Latest deliveries</h2>
        <span class="count">${recentDeliveries.length} shown</span>
      </div>
      ${deliveryContent}
    </section>

    <footer>
      <span>Refreshes every 30 seconds</span>
      <a href="/health">Health endpoint</a>
    </footer>
    <script nonce="${escapeHtml(scriptNonce)}">
      (() => {
        const uptime = document.getElementById('uptime');
        let seconds = Number(uptime.dataset.seconds);
        const format = (total) => {
          if (total < 60) return total + 's';
          const minutes = Math.floor(total / 60);
          if (minutes < 60) return minutes + 'm';
          const hours = Math.floor(minutes / 60);
          if (hours < 24) return hours + 'h ' + (minutes % 60) + 'm';
          return Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h';
        };
        setInterval(() => {
          seconds += 1;
          uptime.textContent = format(seconds);
        }, 1000);
      })();
    </script>
  </main>
</body>
</html>`;
}

module.exports = { dashboardPage };
