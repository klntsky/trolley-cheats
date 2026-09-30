import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);

test('observes versions and Elo without starting rounds', { timeout: 40_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trolley-observer-'));
  let defense = 'First defense';
  let playRequests = 0;
  let gameRequests = 0;
  const server = createServer((req, res) => {
    if (req.method !== 'GET') playRequests++;
    res.setHeader('content-type', 'text/html');
    if (req.url === '/leaderboard') res.end('<main class="leaderboard"><dl class="leaderboard-totals"><div><dt>Players</dt><dd>42</dd></div><div><dt>Rounds</dt><dd>900</dd></div></dl><table><tbody><tr><td>1</td><th><span class="who"><img src="https://avatars.githubusercontent.com/u/42?v=4"><a href="https://github.com/alice">Alice</a></span></th><td class="elo">1700</td><td>12</td></tr></tbody></table></main>');
    else {
      gameRequests++;
      setTimeout(() => {
        res.end(`<div class="matchup"><section class="defense"><h2>Their defense</h2><p class="defense-who">Alice, on the upper track</p><blockquote>${defense}</blockquote></section></div>`);
      }, 500);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  await writeFile(join(dir, 'session.json'), JSON.stringify({ cookies: [], origins: [] }));
  const child = spawn(process.execPath, ['src/start.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, TROLLEY_URL: url, OBSERVER_DATA_DIR: dir, OBSERVER_INTERVAL_MS: '2000',
      OBSERVER_PORT: '0', OBSERVER_LEADERBOARD_REFRESH_MS: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  async function until(check) {
    const end = Date.now() + 25_000;
    while (Date.now() < end) {
      const raw = await readFile(join(dir, 'history.json'), 'utf8').catch(() => null);
      if (raw && check(JSON.parse(raw))) return JSON.parse(raw);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(`Timed out waiting for history: ${output}`);
  }
  let dashboardBrowser;
  try {
    await until(db => db.people[0]?.versions[0]?.observations[0]?.leaderboard?.elo === 1700);
    for (let attempt = 0; gameRequests < 3 && attempt < 40; attempt++)
      await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(gameRequests >= 3, `Expected three game tabs; received ${gameRequests} requests`);
    assert.match(output, /Observing .* with 3 tabs/);
    const dashboardPort = Number(output.match(/Leaderboard dashboard: http:\/\/127\.0\.0\.1:(\d+)\//)?.[1]);
    assert.ok(dashboardPort > 0, output);
    const initialHtml = await (await fetch(`http://127.0.0.1:${dashboardPort}/`)).text();
    assert.match(initialHtml, /<tbody id="rows"><tr>/);
    assert.match(initialHtml, /First defense/);
    assert.match(initialHtml, /avatars\.githubusercontent\.com\/u\/42/);
    assert.match(initialHtml, /href="https:\/\/github\.com\/alice"/);
    assert.match(initialHtml, /<dt>Players<\/dt><dd>42<\/dd>/);
    assert.match(initialHtml, /Install an autoclicker \+ dataminer userscript/);
    assert.match(initialHtml, /aria-label="GitHub source"/);
    const mark = await fetch(`http://127.0.0.1:${dashboardPort}/github-mark.png`);
    assert.equal(mark.headers.get('content-type'), 'image/png');
    assert.ok((await mark.arrayBuffer()).byteLength > 1000);
    assert.doesNotMatch(initialHtml, /Live Elo with observed defense history|Leaderboard fetched|Historical scores were observed/);
    dashboardBrowser = await chromium.launch();
    const dashboardPage = await dashboardBrowser.newPage();
    await dashboardPage.goto(`http://127.0.0.1:${dashboardPort}/`);
    await dashboardPage.getByRole('button', { name: 'History (1)' }).waitFor();
    assert.match(await dashboardPage.locator('#rows tr').first().locator('img').getAttribute('src'), /avatars\.githubusercontent\.com\/u\/42/);
    assert.equal(await dashboardPage.locator('#rows tr').first().locator('a').getAttribute('href'), 'https://github.com/alice');
    const playerWidth = (await dashboardPage.locator('#rows tr').first().locator('.player').boundingBox()).width;
    const defenseWidth = (await dashboardPage.locator('#rows tr').first().locator('.defense').boundingBox()).width;
    assert.ok(defenseWidth > playerWidth * 2, `Defense width ${defenseWidth} should exceed twice player width ${playerWidth}`);
    assert.match(await dashboardPage.locator('body').evaluate(el => getComputedStyle(el).fontFamily), /Georgia/);
    const install = dashboardPage.getByRole('link', { name: 'Install an autoclicker + dataminer userscript' });
    assert.equal(await install.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(17, 17, 17)');
    assert.equal(await dashboardPage.getByRole('link', { name: 'GitHub source' }).evaluate(el => getComputedStyle(el).position), 'absolute');
    await dashboardPage.getByRole('button', { name: 'History (1)' }).click();
    await dashboardPage.locator('#history-dialog').getByText('First defense').waitFor();
    assert.match(await dashboardPage.locator('#history-dialog').innerText(), /1700 Elo/);
    await dashboardPage.getByRole('button', { name: 'Close' }).click();

    const importFile = join(dir, 'export.json');
    await writeFile(importFile, JSON.stringify({ schema: 1, pending: [], people: [{ name: 'Alice', versions: [{
      text: 'Imported defense', firstSeen: '2030-01-01T00:00:00.000Z', lastSeen: '2030-01-01T00:00:00.000Z',
      observations: [{ id: 'imported-1', seenAt: '2030-01-01T00:00:00.000Z', source: 'Matchup',
        path: '/', completedAt: null, outcome: null, leaderboard: { state: 'listed', score: '1600',
          metric: 'elo', elo: 1600, rounds: 3, rank: 5, fetchedAt: '2030-01-01T00:00:00.000Z' } }],
    }] }] }));
    await execFileAsync(process.execPath, ['src/import.mjs', importFile], {
      cwd: new URL('../', import.meta.url), env: { ...process.env, TROLLEY_URL: url, OBSERVER_DATA_DIR: dir },
    });
    await dashboardPage.reload();
    await dashboardPage.getByText('Imported defense', { exact: true }).waitFor();
    await dashboardPage.getByRole('button', { name: 'History (2)' }).click();
    assert.match(await dashboardPage.locator('#history-dialog').innerText(), /1600 Elo/);
    await dashboardPage.getByRole('button', { name: 'Close' }).click();

    defense = 'Second defense';
    const changed = await until(db => db.people[0]?.versions.length === 3 && db.people[0]?.versions[2]?.observations[0]?.leaderboard?.elo === 1700);
    assert.deepEqual(changed.people[0].versions.map(item => item.text), ['First defense', 'Imported defense', 'Second defense']);
    assert.equal(changed.people[0].versions[0].observations.length, 1);
    defense = 'First defense';
    const reverted = await until(db => db.people[0]?.versions.length === 3
      && db.people[0].versions[0].lastSeen > db.people[0].versions[2].lastSeen);
    assert.equal(reverted.people[0].versions[0].observations.length, 1);
    assert.equal(reverted.people[0].versions[2].observations.length, 1);
    assert.equal(playRequests, 0);
  } finally {
    if (dashboardBrowser) await dashboardBrowser.close();
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await new Promise(resolve => server.close(resolve));
  }
});
