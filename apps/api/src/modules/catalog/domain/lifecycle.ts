/**
 * The entity lifecycle room, category, minibar product and template share
 * (`RML-DEC-001`, doc 26 §2).
 *
 * ```
 * CREATE          → ACTIVE | INACTIVE          (never RETIRING)
 * ACTIVE          → RETIRING | INACTIVE
 * RETIRING        → INACTIVE | ACTIVE
 * INACTIVE        → ACTIVE
 * ```
 *
 * `RETIRING` is not an error state. It is the server's record of a deactivation
 * request that was accepted while something still depends on the entity: new
 * operational use stops immediately, and what is already under way finishes.
 */

export const ENTITY_STATES = ['ACTIVE', 'RETIRING', 'INACTIVE'] as const;
export type EntityState = (typeof ENTITY_STATES)[number];

export const ENTITY_KINDS = [
  'ROOM',
  'ROOM_CATEGORY',
  'MINIBAR_PRODUCT',
  'MINIBAR_TEMPLATE',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** The states a creating actor may name (doc 26 §2). */
export const CREATABLE_STATES: readonly EntityState[] = ['ACTIVE', 'INACTIVE'];

export function isEntityState(value: string): value is EntityState {
  return (ENTITY_STATES as readonly string[]).includes(value);
}

export function isEntityKind(value: string): value is EntityKind {
  return (ENTITY_KINDS as readonly string[]).includes(value);
}

export function isCreatableState(value: string): value is EntityState {
  return (CREATABLE_STATES as readonly string[]).includes(value);
}

const EDGES: Readonly<Record<EntityState, readonly EntityState[]>> = {
  ACTIVE: ['RETIRING', 'INACTIVE'],
  RETIRING: ['INACTIVE', 'ACTIVE'],
  INACTIVE: ['ACTIVE'],
};

export function canTransition(from: EntityState, to: EntityState): boolean {
  return EDGES[from].includes(to);
}

/**
 * One outstanding reason an entity cannot leave the lifecycle yet.
 *
 * `unavailable` is a third answer and never folded into "no blockers": a
 * dependency whose evidence could not be obtained blocks the transition,
 * because "nobody could tell" and "nothing depends on it" are different facts
 * (`RML-DEC-003`).
 */
export interface BlockerFact {
  readonly sourceId: string;
  readonly owningPhase: string;
  readonly kind: 'operational' | 'historical';
  readonly state: 'blocked' | 'clear' | 'not_yet_provisioned' | 'unavailable';
  readonly count?: number;
  readonly detail?: string;
}

export function operationalBlockers(facts: readonly BlockerFact[]): readonly BlockerFact[] {
  return facts.filter((fact) => fact.kind === 'operational' && fact.state === 'blocked');
}

export function unavailableEvidence(facts: readonly BlockerFact[]): readonly BlockerFact[] {
  return facts.filter((fact) => fact.state === 'unavailable');
}

/** Every reference — operational or historical — that refuses a hard delete. */
export function deletionBlockers(facts: readonly BlockerFact[]): readonly BlockerFact[] {
  return facts.filter((fact) => fact.state === 'blocked');
}

/**
 * What a deactivation request resolves to.
 *
 * The request always stops new operational use at once. Whether the entity can
 * go straight to `INACTIVE` depends only on whether an operational dependency
 * is still outstanding (doc 26 §2, §§4–7).
 */
export function deactivationOutcome(facts: readonly BlockerFact[]): EntityState {
  return operationalBlockers(facts).length === 0 ? 'INACTIVE' : 'RETIRING';
}
