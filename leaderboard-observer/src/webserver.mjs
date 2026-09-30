import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dashboardPort, leaderboardRefreshMs, origin } from './config.mjs';
import { loadHistory } from './storage.mjs';
import { readLeaderboard, readLeaderboardTotals } from './site.mjs';

const assets = new Map([
  ['/app.js', { file: new URL('../public/app.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/style.css', { file: new URL('../public/style.css', import.meta.url), type: 'text/css; charset=utf-8' }],
  ['/github-mark.png', { file: new URL('../public/github-mark.png', import.meta.url), type: 'image/png' }],
]);
const template = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

function renderPage(data) {
  const people = new Map(data.history.people.map(person => [person.name, person]));
  const rows = data.entries.map(entry => {
    const person = people.get(entry.name);
    const latest = person?.versions.reduce((a, b) => !a || b.lastSeen > a.lastSeen ? b : a, null);
    const avatar = entry.avatar ? `<img src="${escapeHtml(entry.avatar)}" alt="" width="28" height="28">` : '';
    const name = entry.github
      ? `<a href="${escapeHtml(entry.github)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.name)}</a>`
      : escapeHtml(entry.name);
    const history = person
      ? `<button class="btn" type="button" data-history-name="${escapeHtml(entry.name)}">History (${person.versions.length})</button>` : '';
    return `<tr><td>${escapeHtml(entry.rank)}</td><th scope="row" class="player"><span class="who">${avatar}${name}</span></th>`
      + `<td class="elo">${escapeHtml(entry.elo)}</td><td>${escapeHtml(entry.rounds)}</td>`
      + `<td class="defense">${escapeHtml(latest?.text || 'Not observed')}</td><td class="history-col">${history}</td></tr>`;
  }).join('');
  const totals = data.totals ? `<dl class="leaderboard-totals"><div><dt>Players</dt><dd>${escapeHtml(data.totals.players)}</dd></div>`
    + `<div><dt>Rounds</dt><dd>${escapeHtml(data.totals.rounds)}</dd></div></dl>` : '';
  const status = data.error ? (data.fetchedAt ? 'Leaderboard refresh failed; showing previous results.'
    : 'The leaderboard is temporarily unavailable.') : '';
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return template
    .replace('<tbody id="rows"></tbody>', `<tbody id="rows">${rows}</tbody>`)
    .replace('<div id="totals"></div>', `<div id="totals">${totals}</div>`)
    .replace('<p id="status" class="notice" role="status"></p>',
      `<p id="status" class="notice" role="status">${escapeHtml(status)}</p>`)
    .replace('<script id="initial-data" type="application/json"></script>',
      `<script id="initial-data" type="application/json">${json}</script>`);
}

export async function startDashboard(context) {
  const page = await context.newPage();
  let cache = { entries: [], totals: null, fetchedAt: null, error: null };
  let inFlight = null;
  function refresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const response = await page.goto(`${origin}/leaderboard`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        if (!response?.ok()) throw new Error(`Leaderboard HTTP ${response?.status() ?? 'unknown'}`);
        const [entries, totals] = await Promise.all([readLeaderboard(page), readLeaderboardTotals(page)]);
        cache = { entries, totals, fetchedAt: new Date().toISOString(), error: null };
      } catch (error) {
        cache = { ...cache, error: error.message };
        console.error(`Leaderboard refresh failed: ${error.message}`);
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; base-uri 'none'; form-action 'none'");
    if (req.method !== 'GET') { res.writeHead(405); res.end('Method not allowed'); return; }
    try {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (path === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(renderPage({ ...cache, history: await loadHistory() }));
        return;
      }
      if (path === '/api/leaderboard') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ...cache, history: await loadHistory() }));
        return;
      }
      const asset = assets.get(path);
      if (!asset) { res.writeHead(404); res.end('Not found'); return; }
      res.setHeader('Content-Type', asset.type);
      res.end(await readFile(asset.file));
    } catch (error) {
      console.error(`Dashboard request failed: ${error.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end('Dashboard unavailable');
    }
  });
  await refresh();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(dashboardPort, '127.0.0.1', resolve);
    });
  } catch (error) {
    await page.close();
    throw error;
  }
  console.log(`Leaderboard dashboard: http://127.0.0.1:${server.address().port}/`);
  const timer = setInterval(() => { void refresh(); }, leaderboardRefreshMs);
  return {
    close: async () => {
      clearInterval(timer);
      await page.close();
      if (inFlight) await inFlight;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
