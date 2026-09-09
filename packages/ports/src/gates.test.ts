import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADAPTER_SLOTS,
  EXTERNAL_GATE_IDS,
  GATE_IDS,
  GATE_REGISTER,
  INTERNAL_GATE_IDS,
  describeGates,
  gateForSlot,
  isGateCleared,
} from './gates';

/**
 * The code register and the document register say the same thing.
 *
 * `external-integration-gates.md` is what people read and Phase 23 audits;
 * `gates.ts` is what the adapter selector reads at startup. A gate cleared in
 * one and not the other would either let an adapter run that the record says
 * is blocked, or block one the record says is cleared. Neither is a state this
 * test allows to exist.
 */

const REGISTER = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'docs',
  'implementation',
  'external-integration-gates.md',
);
const DECISIONS = resolve(__dirname, '..', '..', '..', 'docs', '00-mvp-open-decisions.md');

function documentStatus(text: string, gate: string): 'BLOCKED' | 'CLEARED' | undefined {
  const row = text.split('\n').find((line) => line.startsWith(`| ${gate} |`));
  if (row === undefined) return undefined;
  if (/\*\*BLOCKED\*\*/.test(row)) return 'BLOCKED';
  if (/\*\*CLEARED\*\*/.test(row)) return 'CLEARED';
  return undefined;
}

describe('the gate register', () => {
  const register = readFileSync(REGISTER, 'utf8');

  it('names exactly the eleven EXT gates of docs/00 §4', () => {
    const decisions = readFileSync(DECISIONS, 'utf8');
    for (const gate of EXTERNAL_GATE_IDS) {
      expect({ gate, inSource: decisions.includes(`| ${gate} |`) }).toEqual({
        gate,
        inSource: true,
      });
    }
    expect(EXTERNAL_GATE_IDS).toHaveLength(11);
    expect(INTERNAL_GATE_IDS).toEqual([
      'INT-KMS-01',
      'INT-MAIL-01',
      'INT-OTP-01',
      'INT-STORAGE-01',
    ]);
  });

  it('agrees with the document, gate for gate, on whether each is cleared', () => {
    for (const gate of EXTERNAL_GATE_IDS) {
      const documented = documentStatus(register, gate);
      expect({ gate, documented }).toEqual({
        gate,
        documented: isGateCleared(gate) ? 'CLEARED' : 'BLOCKED',
      });
    }
  });

  it('records the internal controls the document lists in §4 as still open', () => {
    // §4's table names the control in prose rather than in a status cell; what
    // the register may not do is clear one the document has not.
    for (const gate of INTERNAL_GATE_IDS) {
      expect({ gate, cleared: isGateCleared(gate) }).toEqual({ gate, cleared: false });
      if (gate !== 'INT-KMS-01') {
        expect({ gate, mentioned: register.includes(gate) }).toEqual({ gate, mentioned: true });
      }
    }
  });

  it('cannot clear a gate without an artefact', () => {
    for (const gate of GATE_IDS) {
      const status = GATE_REGISTER[gate].status;
      if (status.cleared) {
        expect(status.artefact.length).toBeGreaterThan(0);
        expect(status.clearedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      } else {
        expect(status.blocker.length).toBeGreaterThan(0);
      }
    }
  });

  it('governs every adapter slot with exactly one gate', () => {
    for (const slot of ADAPTER_SLOTS) {
      const owners = GATE_IDS.filter((gate) => GATE_REGISTER[gate].slots.includes(slot));
      expect({ slot, owners }).toEqual({ slot, owners: [gateForSlot(slot)] });
    }
    // The three policy gates govern no adapter, and say so.
    expect(GATE_REGISTER['EXT-08'].slots).toEqual([]);
    expect(GATE_REGISTER['EXT-09'].slots).toEqual([]);
    expect(GATE_REGISTER['EXT-10'].slots).toEqual([]);
  });

  it('describes itself without a configuration value', () => {
    const described = describeGates();
    expect(described.map((one) => one.gate)).toEqual([...GATE_IDS]);
    expect(described.every((one) => one.cleared === false)).toBe(true);
  });
});
