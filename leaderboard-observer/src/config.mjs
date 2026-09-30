import { resolve } from 'node:path';

export const origin = new URL(process.env.TROLLEY_URL || 'https://trolley.typememetics.institute/').origin;
export const dataDir = resolve(process.env.OBSERVER_DATA_DIR || new URL('../data/', import.meta.url).pathname);
export const intervalMs = Number(process.env.OBSERVER_INTERVAL_MS || 2_000);
if (!Number.isInteger(intervalMs) || intervalMs < 2_000) throw new Error('OBSERVER_INTERVAL_MS must be an integer of at least 2000');
export const historyKey = 'trolley-defense-history-v1';
export const dashboardPort = Number(process.env.OBSERVER_PORT ?? 9871);
if (!Number.isInteger(dashboardPort) || dashboardPort < 0 || dashboardPort > 65535)
  throw new Error('OBSERVER_PORT must be between 0 and 65535');
export const leaderboardRefreshMs = Number(process.env.OBSERVER_LEADERBOARD_REFRESH_MS ?? 90_000);
if (!Number.isInteger(leaderboardRefreshMs) || leaderboardRefreshMs < 1000)
  throw new Error('OBSERVER_LEADERBOARD_REFRESH_MS must be at least 1000');
