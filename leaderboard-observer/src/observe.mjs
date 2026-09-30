import { intervalMs, origin } from './config.mjs';
import { recordDefense, updateHistory } from './storage.mjs';
import { readLeaderboard, readOpponent, scoreFor } from './site.mjs';

const observerTabs = 3;

const wait = (ms, signal) => new Promise(resolve => {
  if (signal.aborted) return resolve();
  const onAbort = () => { clearTimeout(timer); resolve(); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal.addEventListener('abort', onAbort, { once: true });
});

export async function runObserver(context, signal) {
  console.log(`Observing ${origin} with ${observerTabs} tabs, each every ${intervalMs / 1000}s`);
  const pages = await Promise.all(Array.from({ length: observerTabs }, () => context.newPage()));
  try {
    await Promise.all(pages.map((page, index) => observeTab(context, page, signal, index + 1)));
  } finally {
    await Promise.allSettled(pages.map(page => page.close()));
  }
}

async function observeTab(context, game, signal, tabNumber) {
  const state = () => context.storageState({ indexedDB: true });
  let lastNavigationAt = 0;

  async function navigate(path) {
    await wait(Math.max(0, intervalMs - (Date.now() - lastNavigationAt)), signal);
    if (signal.aborted) return null;
    lastNavigationAt = Date.now();
    return game.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }

  async function cycle() {
    const response = await navigate('');
    if (!response?.ok()) throw new Error(`Game HTTP ${response?.status() ?? 'unknown'}`);
    await game.locator('.matchup').waitFor({ state: 'visible', timeout: 15_000 });
    const opponent = await readOpponent(game);
    if (!opponent) throw new Error('Signed-in matchup or opponent defense unavailable; session may have expired');
    const seenAt = new Date().toISOString();
    const { outcome, needsScore } = await updateHistory(db => {
      const outcome = recordDefense(db, { ...opponent, score: null, seenAt });
      const version = db.people.find(item => item.name === opponent.name)
        .versions.find(item => item.text === opponent.text);
      const needsScore = version.observations.some(item => !item.leaderboard && item.pendingScore);
      return { changed: outcome !== 'unchanged', result: { outcome, needsScore } };
    }, state);
    if (outcome !== 'unchanged')
      console.log(`${seenAt} [tab ${tabNumber}] ${outcome}: ${opponent.name} — ${JSON.stringify(opponent.text)}`);
    let score;
    if (needsScore) {
      const board = await navigate('/leaderboard');
      if (!board?.ok()) throw new Error(`Leaderboard HTTP ${board?.status() ?? 'unknown'}`);
      score = scoreFor(await readLeaderboard(game), opponent.name);
      await updateHistory(db => {
        const version = db.people.find(item => item.name === opponent.name)
          ?.versions.find(item => item.text === opponent.text);
        const observation = version?.observations.find(item => !item.leaderboard && item.pendingScore);
        if (!observation) return { changed: false };
        observation.leaderboard = score;
        delete observation.pendingScore;
        return { changed: true };
      }, state);
      console.log(`${new Date().toISOString()} [tab ${tabNumber}] score: ${opponent.name} — ${score.state === 'listed' ? `${score.score} Elo` : 'not on leaderboard'}`);
    }
  }

  await wait((tabNumber - 1) * Math.floor(intervalMs / observerTabs), signal);
  while (!signal.aborted) {
    try { await cycle(); }
    catch (error) { if (!signal.aborted) console.error(`${new Date().toISOString()} [tab ${tabNumber}] ${error.message}`); }
  }
}
