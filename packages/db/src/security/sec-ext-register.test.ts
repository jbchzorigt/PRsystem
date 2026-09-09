import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProvisionedDatabase } from '../test-support/provision';
import { provisionKernelDatabase } from '../test-support/provision';

/**
 * The EXT register is a contract, not a convenience list.
 *
 * `docs/00-mvp-open-decisions.md` §4 fixes EXT-01 … EXT-11 and their subjects.
 * The seeded register is checked against that document, row for row, because a
 * gate seeded against the wrong subject would disable the wrong integration and
 * clear the wrong blocker.
 */

/** The canonical mapping, transcribed from docs/00 §4. */
const CANONICAL: readonly (readonly [string, RegExp])[] = [
  ['EXT-01', /ХУР|XYP/],
  ['EXT-02', /e-Mongolia/i],
  ['EXT-03', /QPay/i],
  ['EXT-04', /Khaan Bank/i],
  ['EXT-05', /CallPro/i],
  ['EXT-06', /Google Maps/i],
  ['EXT-07', /Платформын төв данс/],
  ['EXT-08', /Хувийн мэдээлэл/],
  ['EXT-09', /ЦЕГ/],
  ['EXT-10', /Police security/i],
  ['EXT-11', /eBarimt/i],
];

/** How the seeded description must read for each gate. */
const SEEDED: Readonly<Record<string, RegExp>> = {
  'EXT-01': /XYP|ХУР/,
  'EXT-02': /e-Mongolia/i,
  'EXT-03': /QPay/i,
  'EXT-04': /Khaan Bank/i,
  'EXT-05': /CallPro/i,
  'EXT-06': /Google Maps/i,
  'EXT-07': /central account|settlement/i,
  'EXT-08': /personal-data|privacy/i,
  'EXT-09': /ЦЕГ|police data-sharing/i,
  'EXT-10': /police security/i,
  'EXT-11': /eBarimt/i,
};

const REQUIREMENTS = resolve(__dirname, '..', '..', '..', '..', 'docs', '00-mvp-open-decisions.md');
const GATE_REGISTER = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'docs',
  'implementation',
  'external-integration-gates.md',
);

/** The status the gate register document records for one EXT gate. */
function documentedStatus(text: string, code: string): 'BLOCKED' | 'CLEARED' | undefined {
  const row = text.split('\n').find((line) => line.startsWith(`| ${code} |`));
  if (row === undefined) return undefined;
  if (row.includes('**BLOCKED**')) return 'BLOCKED';
  if (row.includes('**CLEARED**')) return 'CLEARED';
  return undefined;
}

let env: ProvisionedDatabase;

beforeAll(async () => {
  env = await provisionKernelDatabase('sec_ext');
}, 90000);

afterAll(async () => {
  await env.close();
}, 30000);

describe('EXT register', () => {
  it('matches the source document row for row', () => {
    const source = readFileSync(REQUIREMENTS, 'utf8');
    for (const [code, subject] of CANONICAL) {
      const row = source.split('\n').find((line) => line.startsWith(`| ${code} |`));
      expect({ code, found: row !== undefined }).toEqual({ code, found: true });
      expect({ code, matches: subject.test(row ?? '') }).toEqual({ code, matches: true });
    }
  });

  it('seeds exactly eleven gates, EXT-01 to EXT-11', async () => {
    const rows = await env.api.query<{ gate_code: string; description: string; enabled: boolean }>(
      'SELECT gate_code, description, enabled FROM platform.external_gate ORDER BY gate_code',
    );

    expect(rows.rows.map((r) => r.gate_code)).toEqual(CANONICAL.map(([code]) => code));
    expect(rows.rows).toHaveLength(11);
  });

  it('seeds each gate against its canonical subject', async () => {
    const rows = await env.api.query<{ gate_code: string; description: string }>(
      'SELECT gate_code, description FROM platform.external_gate ORDER BY gate_code',
    );

    for (const row of rows.rows) {
      const expected = SEEDED[row.gate_code];
      expect({ code: row.gate_code, hasRule: expected !== undefined }).toEqual({
        code: row.gate_code,
        hasRule: true,
      });
      expect({ code: row.gate_code, subject: expected!.test(row.description) }).toEqual({
        code: row.gate_code,
        subject: true,
      });
    }
  });

  it('seeds every gate closed with a recorded blocker', async () => {
    const open = await env.api.query<{ gate_code: string }>(
      'SELECT gate_code FROM platform.external_gate WHERE enabled OR blocker IS NULL',
    );
    expect(open.rows).toEqual([]);
  });

  it('agrees with the gate register document on whether each gate is enabled (Phase 20)', async () => {
    // Three registers — this table, `packages/ports` and the document — and a
    // gate enabled in one that another still records as BLOCKED is exactly the
    // drift §5 of the register forbids.
    const register = readFileSync(GATE_REGISTER, 'utf8');
    const rows = await env.api.query<{ gate_code: string; enabled: boolean }>(
      'SELECT gate_code, enabled FROM platform.external_gate ORDER BY gate_code',
    );
    for (const row of rows.rows) {
      expect({
        code: row.gate_code,
        documented: documentedStatus(register, row.gate_code),
      }).toEqual({
        code: row.gate_code,
        documented: row.enabled ? 'CLEARED' : 'BLOCKED',
      });
    }
  });

  it('never dedicates an EXT id to POS, email or key management', async () => {
    const rows = await env.api.query<{ gate_code: string; description: string }>(
      'SELECT gate_code, description FROM platform.external_gate',
    );

    for (const row of rows.rows) {
      // POS appears legitimately inside EXT-04: docs/00 §4 scopes Khaan Bank's
      // gate to "POS гарын бүртгэл болон online gateway". What must not exist is
      // a gate whose *subject* is POS, email or key management — those are
      // internal controls with their own namespace.
      expect({
        code: row.gate_code,
        dedicated: /^(POS|Email|Key management|KMS)\b/i.test(row.description),
      }).toEqual({ code: row.gate_code, dedicated: false });
    }

    const joined = rows.rows.map((r) => r.description).join(' | ');
    expect(joined).not.toMatch(/key management|\bKMS\b/i);
    expect(joined).not.toMatch(/\bemail\b/i);
  });

  it('gives POS, email and key management their own control namespace', async () => {
    const rows = await env.api.query<{
      control_code: string;
      description: string;
      enabled: boolean;
    }>(
      'SELECT control_code, description, enabled FROM platform.internal_gate ORDER BY control_code',
    );
    expect(rows.rows.map((r) => r.control_code)).toEqual([
      'INT-KMS-01',
      'INT-MAIL-01',
      // Phase 05: doc 15 §2.1 requires an OTP-verified phone and no OTP provider
      // is contracted. CallPro is EXT-05 and is an SMS *send* contract, not an
      // OTP service, so the capability gets its own internal control rather than
      // being read into an external gate that does not cover it.
      'INT-OTP-01',
      'INT-POS-01',
    ]);
    expect(rows.rows.every((r) => !r.enabled)).toBe(true);
  });
});
