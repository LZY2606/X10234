import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function load(name: string): string {
  return readFileSync(join(here, name), 'utf8');
}

export const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: 1, sql: load('001_init.sql') },
  { version: 2, sql: load('002_entity_origin.sql') },
];

export const LATEST_SCHEMA_VERSION = 2;
