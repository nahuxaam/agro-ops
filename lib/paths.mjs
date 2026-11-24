import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = join(ROOT, 'data');
export const DB_PATH = join(DATA_DIR, 'baazaru.db');
export const SLIPS_DIR = join(DATA_DIR, 'slips');
export const PUBLIC_DIR = join(ROOT, 'public');
