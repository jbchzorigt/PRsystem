import { describe, expect, it } from 'vitest';
import type { BlockerFact, EntityState } from './lifecycle';
import {
  CREATABLE_STATES,
  ENTITY_STATES,
  canTransition,
  deactivationOutcome,
  deletionBlockers,
  isCreatableState,
  operationalBlockers,
  unavailableEvidence,
} from './lifecycle';

/** `RML-DEC-001`: the edges of doc 26 §2, and nothing else. */
describe('the lifecycle edges', () => {
  const allowed: [EntityState, EntityState][] = [
    ['ACTIVE', 'RETIRING'],
    ['ACTIVE', 'INACTIVE'],
    ['RETIRING', 'INACTIVE'],
    ['RETIRING', 'ACTIVE'],
    ['INACTIVE', 'ACTIVE'],
  ];

  it('draws exactly the five edges of the decision', () => {
    for (const from of ENTITY_STATES) {
      for (const to of ENTITY_STATES) {
        const expected = allowed.some(([a, b]) => a === from && b === to);
        expect({ from, to, allowed: canTransition(from, to) }).toEqual({
          from,
          to,
          allowed: expected,
        });
      }
    }
  });

  it('INACTIVE never goes to RETIRING, and nothing goes to itself', () => {
    expect(canTransition('INACTIVE', 'RETIRING')).toBe(false);
    for (const state of ENTITY_STATES) expect(canTransition(state, state)).toBe(false);
  });

  it('a creating actor may name ACTIVE or INACTIVE, never RETIRING', () => {
    expect([...CREATABLE_STATES]).toEqual(['ACTIVE', 'INACTIVE']);
    expect(isCreatableState('RETIRING')).toBe(false);
    expect(isCreatableState('DELETED')).toBe(false);
  });
});

function fact(
  sourceId: string,
  kind: BlockerFact['kind'],
  state: BlockerFact['state'],
  count?: number,
): BlockerFact {
  return {
    sourceId,
    owningPhase: '08',
    kind,
    state,
    ...(count === undefined ? {} : { count }),
  };
}

describe('RML-DEC-003 — what a deactivation request resolves to', () => {
  it('is INACTIVE when nothing operational is outstanding', () => {
    expect(
      deactivationOutcome([
        fact('room.active_stay', 'operational', 'clear', 0),
        fact('room.future_booking', 'operational', 'not_yet_provisioned'),
        fact('room.stay_history', 'historical', 'blocked', 12),
      ]),
    ).toBe('INACTIVE');
  });

  it('is RETIRING when an operational dependency is outstanding', () => {
    expect(
      deactivationOutcome([
        fact('room.active_stay', 'operational', 'blocked', 1),
        fact('room.stay_history', 'historical', 'clear', 0),
      ]),
    ).toBe('RETIRING');
  });

  it('history never blocks a deactivation and always blocks a deletion', () => {
    const facts = [
      fact('room.active_stay', 'operational', 'clear', 0),
      fact('room.stay_history', 'historical', 'blocked', 3),
    ];
    expect(operationalBlockers(facts)).toEqual([]);
    expect(deletionBlockers(facts).map((f) => f.sourceId)).toEqual(['room.stay_history']);
  });

  it('unavailable evidence is reported apart, never folded into clear', () => {
    const facts = [
      fact('room.active_stay', 'operational', 'unavailable'),
      fact('room.cleaning_task', 'operational', 'clear', 0),
    ];
    expect(unavailableEvidence(facts).map((f) => f.sourceId)).toEqual(['room.active_stay']);
    // The outcome function alone would say INACTIVE — which is exactly why the
    // service consults `unavailableEvidence` first and refuses.
    expect(operationalBlockers(facts)).toEqual([]);
  });
});
