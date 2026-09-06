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

  it('creates a business-named table only in the migration whose phase owns it', () => {
    // The kernel introduces no business-domain table at all; Phase 04 introduces
    // exactly the tenancy and IAM aggregates doc 03 assigns to `tenancy` and
    // `iam`. A blanket ban was right while only the kernel existed and would now
    // read as "Phase 04 may not create its own tables", so the rule is an
    // ownership manifest instead: each migration names what it may create, and
    // anything else — in any file — is a table that has landed in the wrong
    // phase.
    const businessWords =
      /\b(hotel|guest|room|staff|subscription|booking|restaurant|wanted|stay|folio|deposit|drawer|minibar)\b/i;

    const ALLOWED_BUSINESS_TABLES: Readonly<Record<string, readonly string[]>> = {
      // doc 03 §1: `tenancy` owns the hotel, `iam` owns membership and the
      // staff lifecycle. Both are introduced in Phase 04.
      '0002_iam_rbac_staff.sql': ['hotel', 'staff_membership', 'staff_invitation'],
      // doc 03 §1 and doc 07 §3: the catalog owns the physical room, and Phase 06
      // is the phase that introduces it. Its other tables — `room_category`,
      // `hotel_stay_configuration`, `minibar_product`, `minibar_template`,
      // `catalog_event` and `stay_rate_snapshot` — are compound names the rule
      // does not match, so only the bare one is named here.
      '0007_hotel_catalog.sql': ['room'],
      // doc 05 §2: the stay is Phase 08's. Its other tables — `reception_shift`,
      // `room_cleaning_state`, `stay_guest`, `stay_minibar_snapshot`,
      // `booking_fulfillment_conflict` and the rest — are compound names.
      '0009_stay_reception.sql': ['stay'],
      // doc 09 §7 and `RC-DEC-005`: the online booking is Phase 13's, and this
      // is the phase that introduces it. Its other tables — `booking_night`,
      // `category_night_inventory`, `booking_payment_attempt` and
      // `booking_event` — are compound names the rule does not match, so only
      // the bare one is named here.
      '0014_online_booking_inventory.sql': ['booking'],
      // doc 08 §3: the restaurant is Phase 15's, and this is the phase that
      // introduces it. Its other tables — `restaurant_order`,
      // `restaurant_menu_item`, `guest_session` and the rest — are compound
      // names the rule does not match, so only the bare one is named here.
      '0016_restaurant_ordering.sql': ['restaurant'],
    };

    for (const file of sqlFiles) {
      const sql = readFileSync(join(MIGRATIONS_FOLDER, file), 'utf8').replace(/^\s*--.*$/gm, '');
      const allowed = ALLOWED_BUSINESS_TABLES[file] ?? [];

      for (const [, qualified] of sql.matchAll(
        /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w.]*)/gi,
      )) {
        const [schema, table] = (qualified ?? '').split('.');
        expect({ file, schema }).toEqual({
          file,
          schema: expect.stringMatching(/^(platform|audit|police_audit)$/),
        });
        const named = businessWords.test(table ?? '');
        expect({ file, table, businessNamed: named && !allowed.includes(table ?? '') }).toEqual({
          file,
          table,
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
