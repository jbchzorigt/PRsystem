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
    //
    // Matched at the start of a statement, not anywhere in the text: a trigger
    // that *rejects* TRUNCATE mentions the word while doing the opposite, and
    // flagging it would train the reader to ignore this check.
    const destructive = /(^|;)\s*(DROP\s+(TABLE|SCHEMA|TYPE)|TRUNCATE)\b/im;
    const dropColumn = /\bALTER\s+TABLE\s+[^;]*\bDROP\s+COLUMN\b/i;

    for (const file of sqlFiles) {
      const sql = readFileSync(join(MIGRATIONS_FOLDER, file), 'utf8')
        .replace(/^\s*--.*$/gm, '')
        .replace(/-->\s*statement-breakpoint/g, ';');

      expect({ file, destructive: destructive.test(sql) }).toEqual({ file, destructive: false });
      expect({ file, dropColumn: dropColumn.test(sql) }).toEqual({ file, dropColumn: false });
    }
  });

  it('creates tables only in the kernel schemas', () => {
    // Phase 03 introduces kernel tables. Business-domain tables belong to Phase 04
    // and later, so any CREATE TABLE outside platform/audit/police_audit — or any
    // table named after a business entity — has landed in the wrong phase.
    const businessWords =
      /\b(hotel|guest|room|staff|subscription|booking|restaurant|wanted|stay|folio|deposit|drawer|minibar)\b/i;

    for (const file of sqlFiles) {
      const sql = readFileSync(join(MIGRATIONS_FOLDER, file), 'utf8').replace(/^\s*--.*$/gm, '');

      for (const [, qualified] of sql.matchAll(
        /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w.]*)/gi,
      )) {
        const [schema, table] = (qualified ?? '').split('.');
        expect({ file, schema }).toEqual({
          file,
          schema: expect.stringMatching(/^(platform|audit|police_audit)$/),
        });
        expect({ file, businessNamed: businessWords.test(table ?? '') }).toEqual({
          file,
          businessNamed: false,
        });
      }
    }
  });

  it('enables and forces row level security on every tenant-scoped kernel table', () => {
    // ADR-0017 §1: ENABLE alone leaves the table owner exempt.
    for (const file of sqlFiles) {
      const sql = readFileSync(join(MIGRATIONS_FOLDER, file), 'utf8');
      const enabled = [...sql.matchAll(/ALTER TABLE\s+(\S+)\s+ENABLE ROW LEVEL SECURITY/gi)].map(
        (match) => match[1],
      );
      const forced = new Set(
        [...sql.matchAll(/ALTER TABLE\s+(\S+)\s+FORCE ROW LEVEL SECURITY/gi)].map(
          (match) => match[1],
        ),
      );
      for (const table of enabled) {
        expect({ file, table, forced: forced.has(table) }).toEqual({ file, table, forced: true });
      }
    }
  });
});
