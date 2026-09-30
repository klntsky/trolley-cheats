import { resolve } from 'node:path';
import { readJson, mergeHistory, updateHistory } from './storage.mjs';

const file = process.argv.slice(2).find(arg => arg !== '--');
if (!file) throw new Error('Usage: pnpm run import -- /path/to/trolley-defense-history.json');
const incoming = await readJson(resolve(file), null);
if (!incoming) throw new Error(`File not found: ${file}`);
const result = await updateHistory(db => ({ changed: true, result: mergeHistory(db, incoming) }));
console.log(`Imported ${result.versionsAdded} new defense versions and ${result.observationsAdded} score observations.`);
