import type { UnitOfWork } from '@prsystem/db';
import type { RetentionPort } from '../../stay/contracts/retention';
import { ReportingRepository } from '../repositories/reporting.repository';
import { DEFAULT_RETENTION_DAYS, retentionExpiry } from '../domain/reporting';

/**
 * The reporting module's answer to a completed checkout (`GUEST-DEC-008`).
 *
 * Writes the retention snapshot inside the checkout's own transaction, on the
 * hotel's own scope, so a stay and its deadline are committed together. The
 * policy is the hotel's current one, created at the MVP default on first use —
 * doc 12 §9 makes 365 days the product default and a written legal or ЦЕГ
 * override a *new version* rather than an edit of this one.
 */
export class RepositoryRetention implements RetentionPort {
  async recordCheckout(
    uow: UnitOfWork,
    input: { hotelId: string; stayId: string; checkoutAt: Date },
  ): Promise<void> {
    const repository = new ReportingRepository(uow);
    const policy = await repository.currentPolicy(
      input.hotelId,
      DEFAULT_RETENTION_DAYS,
      input.checkoutAt,
    );
    await repository.recordRetention({
      stayId: input.stayId,
      hotelId: input.hotelId,
      policyVersion: policy.version,
      retentionDays: policy.retentionDays,
      checkoutAt: input.checkoutAt,
      retentionExpiresAt: retentionExpiry(input.checkoutAt, policy.retentionDays),
    });
  }
}
