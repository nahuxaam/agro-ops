// Optional local seed data. Personal and operational records stay outside Git.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './paths.mjs';

let records = [];
try {
  records = JSON.parse(readFileSync(join(DATA_DIR, 'seed', 'boat-list.json'), 'utf8'));
  if (!Array.isArray(records)) throw new Error('Expected an array in boat-list.json');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
export const BOAT_LIST = records;
