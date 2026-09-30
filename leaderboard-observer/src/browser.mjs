import { chromium } from 'playwright';
import { readJson, statePath } from './storage.mjs';

export async function openBrowser(headless = true) {
  const browser = await chromium.launch({ headless });
  const state = await readJson(statePath, null);
  const context = await browser.newContext(state ? { storageState: state } : {});
  return { browser, context };
}
