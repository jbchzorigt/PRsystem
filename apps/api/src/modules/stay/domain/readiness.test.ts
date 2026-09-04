import { describe, expect, it } from 'vitest';
import { canTransitionCleaning, readinessBlockers } from './readiness';

describe('RC-DEC-017 / STAY-DEC-008 — the composite readiness gate', () => {
  const at = new Date('2026-08-14T12:00:00Z');
  const ready = {
    at,
    roomState: 'ACTIVE' as const,
    categoryState: 'ACTIVE' as const,
    cleaningStateAt: 'CLEAN' as const,
    occupied: false,
    readyNotBefore: new Date('2026-08-14T11:30:00Z'),
    minibarBlockers: [],
  };

  it('passes only when every axis passes at the instant asked', () => {
    expect(readinessBlockers(ready)).toEqual([]);
    expect(
      readinessBlockers({ ...ready, readyNotBefore: new Date('2026-08-14T12:00:01Z') }),
    ).toEqual(['CLEANING_BUFFER_PENDING']);
    expect(readinessBlockers({ ...ready, cleaningStateAt: 'CLEANING' })).toEqual(['NOT_CLEAN']);
    expect(readinessBlockers({ ...ready, cleaningStateAt: null })).toEqual(['NOT_CLEAN']);
    expect(readinessBlockers({ ...ready, occupied: true })).toEqual(['ROOM_OCCUPIED']);
    expect(
      readinessBlockers({ ...ready, roomState: 'RETIRING', categoryState: 'INACTIVE' }),
    ).toEqual(['ROOM_NOT_ACTIVE', 'CATEGORY_NOT_ACTIVE']);
    expect(
      readinessBlockers({ ...ready, minibarBlockers: ['MINIBAR_SHORT_WITHOUT_OVERRIDE'] }),
    ).toEqual(['MINIBAR_SHORT_WITHOUT_OVERRIDE']);
  });

  it('a buffer that has passed does not stand in for cleaning, nor cleaning for the buffer', () => {
    expect(readinessBlockers({ ...ready, cleaningStateAt: 'NEEDS_CLEANING' })).toEqual([
      'NOT_CLEAN',
    ]);
    expect(
      readinessBlockers({
        ...ready,
        readyNotBefore: new Date('2026-08-14T13:00:00Z'),
        cleaningStateAt: 'CLEAN',
      }),
    ).toEqual(['CLEANING_BUFFER_PENDING']);
  });
});

describe('doc 06 §4 — who may move the cleaning axis where', () => {
  it('the Cleaner walks needs-cleaning → cleaning → clean; the 20,000₮ Manager marks clean directly', () => {
    expect(canTransitionCleaning('NEEDS_CLEANING', 'CLEANING', 'CLEANER')).toBe(true);
    expect(canTransitionCleaning('CLEANING', 'CLEAN', 'CLEANER')).toBe(true);
    expect(canTransitionCleaning('NEEDS_CLEANING', 'CLEAN', 'CLEANER')).toBe(true);
    expect(canTransitionCleaning(null, 'CLEAN', 'CLEANER')).toBe(true);
    expect(canTransitionCleaning('CLEAN', 'CLEAN', 'CLEANER')).toBe(false);
    expect(canTransitionCleaning('NEEDS_CLEANING', 'CLEAN', 'MANAGER_P20')).toBe(true);
    expect(canTransitionCleaning('NEEDS_CLEANING', 'CLEANING', 'MANAGER_P20')).toBe(false);
    expect(canTransitionCleaning('CLEAN', 'CLEAN', 'MANAGER_P20')).toBe(false);
  });

  it('only the system puts a room back to needs-cleaning, at checkout', () => {
    expect(canTransitionCleaning('CLEAN', 'NEEDS_CLEANING', 'SYSTEM')).toBe(true);
    expect(canTransitionCleaning('CLEAN', 'NEEDS_CLEANING', 'CLEANER')).toBe(false);
    expect(canTransitionCleaning('CLEAN', 'CLEAN', 'SYSTEM')).toBe(false);
  });
});
