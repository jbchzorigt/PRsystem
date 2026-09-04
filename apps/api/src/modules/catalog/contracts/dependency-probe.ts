import type { UnitOfWork } from '@prsystem/db';
import type { BlockerFact } from '../domain/lifecycle';
import type { DependencySource } from './dependency-sources';

/**
 * The probe behind every dependency question the catalog and the minibar ask
 * (`RML-DEC-003`, doc 26 §§4–8; doc 26 §15 for the safe point).
 *
 * A registry names where a consumer's reference would live; the probe reports
 * one of four answers about it, and never folds one into another:
 *
 *  - `blocked` — the relation exists and holds matching rows;
 *  - `clear` — the relation exists and holds none;
 *  - `not_yet_provisioned` — the relation does not exist, so it can hold no row;
 *    evidence, reported as such;
 *  - `unavailable` — the relation exists but could not be read. The statement
 *    runs under a savepoint so the transaction survives to refuse cleanly.
 *
 * The relation, column and predicate come from a registry — module constants,
 * never a request — and the tenant and the entity are bound parameters. This
 * lives in the contracts surface so the minibar module can ask its own
 * questions through the same discipline without reaching into the catalog's
 * repository (CLAUDE.md §3).
 */
export async function probeSources(
  uow: UnitOfWork,
  sources: readonly DependencySource[],
  entityId: string,
): Promise<readonly BlockerFact[]> {
  const facts: BlockerFact[] = [];
  for (const source of sources) facts.push(await probeSource(uow, source, entityId));
  return facts;
}

export async function probeSource(
  uow: UnitOfWork,
  source: DependencySource,
  entityId: string,
): Promise<BlockerFact> {
  const base = {
    sourceId: source.id,
    owningPhase: source.owningPhase,
    kind: source.kind,
    detail: source.detail,
  };
  if (!(await relationExists(uow, source.relation))) {
    return { ...base, state: 'not_yet_provisioned' };
  }
  const count = await countReferences(uow, source, entityId);
  if (count === 'unavailable') return { ...base, state: 'unavailable' };
  return { ...base, state: count > 0 ? 'blocked' : 'clear', count };
}

/** `to_regclass` answers NULL for a name it does not know and never raises. */
export async function relationExists(uow: UnitOfWork, relation: string): Promise<boolean> {
  const result = await uow.query<{ present: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [relation],
  );
  return result.rows[0]?.present === true;
}

async function countReferences(
  uow: UnitOfWork,
  source: DependencySource,
  entityId: string,
): Promise<number | 'unavailable'> {
  const predicate = source.predicate === undefined ? '' : ` AND (${source.predicate})`;
  await uow.query('SAVEPOINT dependency_probe');
  try {
    const result = await uow.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${source.relation}
        WHERE hotel_id = $1 AND ${source.column} = $2${predicate}`,
      [uow.context.hotelId, entityId],
    );
    await uow.query('RELEASE SAVEPOINT dependency_probe');
    const n = result.rows[0]?.n;
    return n === undefined ? 'unavailable' : Number(n);
  } catch {
    await uow.query('ROLLBACK TO SAVEPOINT dependency_probe');
    return 'unavailable';
  }
}
