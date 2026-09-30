import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dashboardPort, leaderboardRefreshMs, origin } from './config.mjs';
import { loadHistory } from './storage.mjs';
import { readLeaderboard } from './site.mjs';

const assets = new Map([
  ['/', { file: new URL('../public/index.html', import.meta.url), type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: new URL('../public/app.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/style.css', { file: new URL('../public/style.css', import.meta.url), type: 'text/css; charset=utf-8' }],
]);

export async function startDashboard(context) {
  const page = await context.newPage();
  let cache = { entries: [], fetchedAt: null, error: null };
  let inFlight = null;
  function refresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const response = await page.goto(`${origin}/leaderboard`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        if (!response?.ok()) throw new Error(`Leaderboard HTTP ${response?.status() ?? 'unknown'}`);
        cache = { entries: await readLeaderboard(page), fetchedAt: new Date().toISOString(), error: null };
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
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'");
    if (req.method !== 'GET') { res.writeHead(405); res.end('Method not allowed'); return; }
    try {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
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
  void refresh();
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
