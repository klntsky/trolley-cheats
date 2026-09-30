import { intervalMs, origin } from './config.mjs';
import { recordDefense, updateHistory } from './storage.mjs';
import { readLeaderboard, readOpponent, scoreFor } from './site.mjs';

const wait = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

export async function runObserver(context, signal) {
  const game = await context.newPage();
  const leaderboard = await context.newPage();
  const state = () => context.storageState({ indexedDB: true });

  async function cycle() {
    const response = await game.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!response?.ok()) throw new Error(`Game HTTP ${response?.status() ?? 'unknown'}`);
    await game.locator('.matchup').waitFor({ state: 'visible', timeout: 15_000 });
    const opponent = await readOpponent(game);
    if (!opponent) throw new Error('Signed-in matchup or opponent defense unavailable; session may have expired');
    const seenAt = new Date().toISOString();
    const { outcome, needsScore } = await updateHistory(db => {
      const outcome = recordDefense(db, { ...opponent, score: null, seenAt });
      const version = db.people.find(item => item.name === opponent.name)
        .versions.find(item => item.text === opponent.text);
      const needsScore = version.observations.some(item => item.source === 'Observer' && !item.leaderboard);
      return { changed: outcome !== 'unchanged', result: { outcome, needsScore } };
    }, state);
    let score;
    if (needsScore) {
      const board = await leaderboard.goto(`${origin}/leaderboard`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (!board?.ok()) throw new Error(`Leaderboard HTTP ${board?.status() ?? 'unknown'}`);
      score = scoreFor(await readLeaderboard(leaderboard), opponent.name);
      await updateHistory(db => {
        const version = db.people.find(item => item.name === opponent.name)
          ?.versions.find(item => item.text === opponent.text);
        const observation = version?.observations.find(item => item.source === 'Observer' && !item.leaderboard);
        if (!observation) return { changed: false };
        observation.leaderboard = score;
        return { changed: true };
      }, state);
    }
    console.log(`${seenAt} ${outcome}: ${opponent.name}${score?.state === 'listed' ? ` (${score.score} Elo)` : ''}`);
  }

  try {
    console.log(`Observing ${origin} every ${intervalMs / 1000}s`);
    while (!signal.aborted) {
      try { await cycle(); }
      catch (error) { if (!signal.aborted) console.error(`${new Date().toISOString()} ${error.message}`); }
      if (!signal.aborted) await wait(intervalMs, signal);
    }
  } finally {
    await Promise.allSettled([game.close(), leaderboard.close()]);
  }
}
