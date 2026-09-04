import type { BlockerFact, EntityKind } from '../domain/lifecycle';
import { sourcesFor } from '../contracts/dependency-sources';
import { probeSources } from '../contracts/dependency-probe';
import type { CatalogRepository } from '../repositories/catalog.repository';

/**
 * Turns the dependency registry into evidence about one catalog entity.
 *
 * The probe itself lives in the contracts surface (`dependency-probe.ts`) so
 * the minibar module can ask its own questions the same way; what this file
 * adds is the selection of sources for a kind. `lifecycle.ts` decides what the
 * answers mean, and it treats `unavailable` as a reason to stop
 * (`RML-DEC-003`).
 */
export async function probeDependencies(
  catalog: CatalogRepository,
  kind: EntityKind,
  entityId: string,
): Promise<readonly BlockerFact[]> {
  return probeSources(catalog.unitOfWork, sourcesFor(kind), entityId);
}
