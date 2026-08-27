import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from './migrate';

/**
 * Journal integrity — no database required.
 *
 * Guards the properties a versioned-migration strategy depends on (ADR-0004):
 * the journal and the folder agree, ordering is contiguous, and no file
 * undoes a previous one.
 */

interface Journal {
  readonly version: string;
  readonly dialect: string;
  readonly entries: readonly { idx: number; tag: string }[];
}

const journal = JSON.parse(
  readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
) as Journal;

const sqlFiles = readdirSync(MIGRATIONS_FOLDER)
  .filter((name) => name.endsWith('.sql'))
  .sort();

describe('migration journal', () => {
  it('targets PostgreSQL', () => {
    expect(journal.dialect).toBe('postgresql');
    expect(journal.entries.length).toBeGreaterThan(0);
  });

  it('lists every migration file exactly once', () => {
    const tags = journal.entries.map((entry) => `${entry.tag}.sql`).sort();

    expect(tags).toEqual(sqlFiles);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('orders migrations contiguously from zero', () => {
    const indexes = journal.entries.map((entry) => entry.idx);

    expect(indexes).toEqual(indexes.map((_value, position) => position));
  });

  it('contains no down-migration or destructive statement', () => {
    // ADR-0004: migrations only move forward. A mistake is corrected by a new
    // migration, never by dropping or rewriting an applied one.
    for (const file of sqlFiles) {
      const sql = readFileSync(join(MIGRATIONS_FOLDER, file), 'utf8');
      const statements = sql.replace(/^\s*--.*$/gm, '');

      expect(statements).not.toMatch(/\bDROP\s+(TABLE|SCHEMA|COLUMN|TYPE)\b/i);
      expect(statements).not.toMatch(/\bTRUNCATE\b/i);
    }
  });

  it('creates no table before Phase 03', () => {
    for (const file of sqlFiles) {
      const sql = readFileSync(join(MIGRATIONS_FOLDER, file), 'utf8').replace(/^\s*--.*$/gm, '');

      expect(sql).not.toMatch(/\bCREATE\s+(UNLOGGED\s+)?TABLE\b/i);
    }
  });
});
