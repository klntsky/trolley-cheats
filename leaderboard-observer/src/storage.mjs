import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir, historyKey, origin } from './config.mjs';

export const statePath = join(dataDir, 'session.json');
export const historyPath = join(dataDir, 'history.json');
const writeLockPath = join(dataDir, '.history-write.lock');

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function writeJson(path, value) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export function emptyHistory() { return { schema: 1, people: [], pending: [] }; }

export function assertHistory(db) {
  if (db?.schema !== 1 || !Array.isArray(db.people) || !Array.isArray(db.pending))
    throw new Error('Unrecognized history format');
  return db;
}

function stripContext(db) {
  for (const person of db.people) for (const version of person.versions) {
    for (const observation of version.observations) {
      if (observation.source === 'Observer' && !observation.leaderboard) observation.pendingScore = true;
      delete observation.source;
      delete observation.path;
      delete observation.outcome;
      delete observation.completedAt;
    }
  }
  for (const pending of db.pending) {
    delete pending.source;
    delete pending.path;
    delete pending.outcome;
    delete pending.completedAt;
  }
  return db;
}

export async function loadHistory() {
  const file = await readJson(historyPath, null);
  if (file) return stripContext(assertHistory(file));
  const state = await readJson(statePath, null);
  const raw = state?.origins?.find(item => item.origin === origin)?.localStorage?.find(item => item.name === historyKey)?.value;
  return raw ? stripContext(assertHistory(JSON.parse(raw))) : emptyHistory();
}

export async function saveHistory(db, state) {
  stripContext(assertHistory(db));
  await writeJson(historyPath, db);
  if (!state) return;
  let site = state.origins.find(item => item.origin === origin);
  if (!site) state.origins.push(site = { origin, localStorage: [] });
  site.localStorage = site.localStorage.filter(item => item.name !== historyKey);
  site.localStorage.push({ name: historyKey, value: JSON.stringify(db) });
  await writeJson(statePath, state);
}

// The observer and the local import command can write at the same time. Always
// reread under a filesystem lock so an import cannot be lost by the next draw.
export async function updateHistory(change, stateProvider) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  let lock;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { lock = await open(writeLockPath, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (!lock) throw new Error(`History is locked; check ${writeLockPath}`);
  try {
    const db = await loadHistory();
    const { changed, result } = change(db);
    if (changed) await saveHistory(db, stateProvider ? await stateProvider() : null);
    return result;
  } finally {
    await lock.close();
    await unlink(writeLockPath);
  }
}

export function mergeHistory(target, incoming) {
  assertHistory(incoming);
  let versionsAdded = 0;
  let observationsAdded = 0;
  for (const sourcePerson of incoming.people) {
    if (typeof sourcePerson?.name !== 'string' || !Array.isArray(sourcePerson.versions))
      throw new Error('Invalid player in imported history');
    let person = target.people.find(item => item.name === sourcePerson.name);
    if (!person) target.people.push(person = { name: sourcePerson.name, versions: [] });
    for (const sourceVersion of sourcePerson.versions) {
      if (typeof sourceVersion?.text !== 'string' || !Array.isArray(sourceVersion.observations)
        || typeof sourceVersion.firstSeen !== 'string' || typeof sourceVersion.lastSeen !== 'string')
        throw new Error('Invalid defense version in imported history');
      let version = person.versions.find(item => item.text === sourceVersion.text);
      if (!version) {
        person.versions.push(version = { text: sourceVersion.text, firstSeen: sourceVersion.firstSeen,
          lastSeen: sourceVersion.lastSeen, observations: [] });
        versionsAdded++;
      } else {
        if (sourceVersion.firstSeen < version.firstSeen) version.firstSeen = sourceVersion.firstSeen;
        if (sourceVersion.lastSeen > version.lastSeen) version.lastSeen = sourceVersion.lastSeen;
      }
      for (const observation of sourceVersion.observations) {
        if (typeof observation?.id !== 'string' || typeof observation.seenAt !== 'string')
          throw new Error('Invalid score observation in imported history');
        const existing = version.observations.find(item => item.id === observation.id);
        if (!existing) { version.observations.push(structuredClone(observation)); observationsAdded++; }
        else {
          if (!existing.leaderboard && observation.leaderboard) existing.leaderboard = structuredClone(observation.leaderboard);
          if (!existing.prePlayLeaderboard && observation.prePlayLeaderboard)
            existing.prePlayLeaderboard = structuredClone(observation.prePlayLeaderboard);
        }
      }
    }
  }
  for (const job of incoming.pending) {
    if (typeof job?.id !== 'string') throw new Error('Invalid pending job in imported history');
    if (!target.pending.some(item => item.id === job.id)) target.pending.push(structuredClone(job));
  }
  return { versionsAdded, observationsAdded };
}

export function recordDefense(db, { name, text, score, seenAt = new Date().toISOString() }) {
  let person = db.people.find(item => item.name === name);
  const existing = person?.versions.find(item => item.text === text);
  if (existing) {
    const latest = person.versions.reduce((a, b) => a.lastSeen > b.lastSeen ? a : b);
    if (latest === existing) return 'unchanged';
    existing.lastSeen = seenAt;
    return 'reverted';
  }
  if (!person) db.people.push(person = { name, versions: [] });
  person.versions.push({
    text, firstSeen: seenAt, lastSeen: seenAt,
    observations: [{
      id: crypto.randomUUID(), seenAt, leaderboard: score, pendingScore: !score,
    }],
  });
  return 'new';
}
