import type { UnitOfWork } from '@prsystem/db';
import { claimConsumption } from '@prsystem/db';

/**
 * The idempotent consumer helper (ADR-0019 §2).
 *
 * `handler` runs at most once per `(consumer, dedupKey)`, in the same transaction
 * as the consumption record. A redelivery finds the record already present and
 * skips the handler, so a projection is updated once no matter how many times the
 * event arrives.
 */
export async function consumeOnce(
  uow: UnitOfWork,
  consumer: string,
  dedupKey: string,
  source: string,
  handler: (uow: UnitOfWork) => Promise<void>,
): Promise<boolean> {
  const isFirst = await claimConsumption(uow, consumer, dedupKey, source);
  if (!isFirst) return false;

  await handler(uow);
  return true;
}
