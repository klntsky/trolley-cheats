import { chromium } from 'playwright';
import { origin } from './config.mjs';
import { loadHistory, saveHistory } from './storage.mjs';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
try {
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  console.log('Sign in in the browser window. Waiting for the game page...');
  await page.locator('.matchup').waitFor({ state: 'visible', timeout: 0 });
  const history = await loadHistory();
  await saveHistory(history, await context.storageState({ indexedDB: true }));
  console.log('Signed-in session saved to data/session.json. You may close the browser.');
} finally {
  await browser.close();
}
