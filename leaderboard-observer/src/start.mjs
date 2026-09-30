import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from './config.mjs';
import { openBrowser } from './browser.mjs';
import { runObserver } from './observe.mjs';
import { startDashboard } from './webserver.mjs';
import { readJson, statePath } from './storage.mjs';

if (!await readJson(statePath, null)) throw new Error('No session. Run pnpm auth first.');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const lockPath = join(dataDir, '.observer.lock');
let lock;
try { lock = await open(lockPath, 'wx', 0o600); }
catch (error) { if (error.code === 'EEXIST') throw new Error('An observer already owns this data directory.'); throw error; }

let browser;
let dashboard;
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
try {
  const opened = await openBrowser();
  browser = opened.browser;
  dashboard = await startDashboard(opened.context);
  await runObserver(opened.context, controller.signal);
} finally {
  controller.abort();
  if (dashboard) await dashboard.close();
  if (browser) await browser.close();
  await lock.close();
  await unlink(lockPath);
}
