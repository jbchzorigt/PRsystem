import type { BlockerFact, EntityKind } from '../domain/lifecycle';
import type { DependencySource } from '../contracts/dependency-sources';
import { sourcesFor } from '../contracts/dependency-sources';
import type { CatalogRepository } from '../repositories/catalog.repository';

/**
 * Turns the dependency registry into evidence about one entity.
 *
 * Each source is probed in turn and reports one of four answers. Three of them
 * are facts about the database — `blocked`, `clear`, `not_yet_provisioned` —
 * and the fourth, `unavailable`, is the fact that no answer could be obtained.
 * Nothing here decides what the answers mean: `lifecycle.ts` does, and it
 * treats `unavailable` as a reason to stop (`RML-DEC-003`).
 *
 * `relationExists` cannot fail — `to_regclass` answers NULL for a name it does
 * not know — and `countReferences` runs under a savepoint, so a probe that
 * raises leaves the transaction usable for the caller to refuse cleanly.
 */
export async function probeDependencies(
  catalog: CatalogRepository,
  kind: EntityKind,
  entityId: string,
): Promise<readonly BlockerFact[]> {
  const facts: BlockerFact[] = [];
  for (const source of sourcesFor(kind)) {
    facts.push(await probe(catalog, source, entityId));
  }
  return facts;
}

async function probe(
  catalog: CatalogRepository,
  source: DependencySource,
  entityId: string,
): Promise<BlockerFact> {
  const base = {
    sourceId: source.id,
    owningPhase: source.owningPhase,
    kind: source.kind,
    detail: source.detail,
  };
  if (!(await catalog.relationExists(source.relation))) {
    return { ...base, state: 'not_yet_provisioned' };
  }
  const count = await catalog.countReferences({
    relation: source.relation,
    column: source.column,
    ...(source.predicate === undefined ? {} : { predicate: source.predicate }),
    entityId,
  });
  if (count === 'unavailable') return { ...base, state: 'unavailable' };
  return { ...base, state: count > 0 ? 'blocked' : 'clear', count };
}
