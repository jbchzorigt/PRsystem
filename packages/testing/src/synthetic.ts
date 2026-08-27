/**
 * Synthetic test data — CLAUDE.md §8.
 *
 * Development and test environments must never contain a real registration number,
 * address or case record. Every identifier produced here is drawn from a reserved
 * synthetic range that is structurally valid but cannot belong to a real person.
 */

/** Reserved century digits that no issued Mongolian registration number uses. */
const SYNTHETIC_PREFIX = '99';

export interface SyntheticIdentity {
  readonly identityType: 'MN_REG_NO';
  /** Structurally valid, reserved-range, never a real number. */
  readonly registrationNumber: string;
  readonly surname: string;
  readonly givenName: string;
  /** ISO date, YYYY-MM-DD. */
  readonly dateOfBirth: string;
  readonly synthetic: true;
}

/** Deterministic pseudo-random source, so fixtures are reproducible across runs. */
function seeded(seed: number): () => number {
  let state = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SURNAMES = ['Batbold', 'Ganbold', 'Dorjsuren', 'Enkhtuya', 'Munkhbat'] as const;
const GIVEN_NAMES = ['Temuulen', 'Naranbaatar', 'Oyunchimeg', 'Bilguun', 'Saruul'] as const;

function pick<T>(items: readonly T[], random: () => number): T {
  const index = Math.floor(random() * items.length) % items.length;
  return items[index] as T;
}

/**
 * Build a synthetic identity. The same seed always yields the same identity.
 *
 * The registration number is `99` + MMDD + four digits: it parses as a registration
 * number and exercises exact-match logic, but the reserved `99` prefix guarantees it
 * cannot collide with a real one.
 */
export function syntheticIdentity(seed: number): SyntheticIdentity {
  const random = seeded(seed);
  const month = 1 + Math.floor(random() * 12);
  const day = 1 + Math.floor(random() * 28);
  const tail = String(Math.floor(random() * 10000)).padStart(4, '0');
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');

  return {
    identityType: 'MN_REG_NO',
    registrationNumber: `${SYNTHETIC_PREFIX}${mm}${dd}${tail}`,
    surname: pick(SURNAMES, random),
    givenName: pick(GIVEN_NAMES, random),
    dateOfBirth: `19${80 + (seed % 20)}-${mm}-${dd}`,
    synthetic: true,
  };
}

/** True when a registration number came from the reserved synthetic range. */
export function isSyntheticRegistrationNumber(value: string): boolean {
  return /^99[01]\d[0-3]\d\d{4}$/.test(value);
}

/** A deterministic batch of distinct synthetic identities. */
export function syntheticIdentities(count: number, startSeed = 1): SyntheticIdentity[] {
  return Array.from({ length: count }, (_, index) => syntheticIdentity(startSeed + index));
}
