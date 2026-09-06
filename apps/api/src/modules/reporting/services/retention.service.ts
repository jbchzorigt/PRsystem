import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { ReportingRepository } from '../repositories/reporting.repository';
import { DEFAULT_RETENTION_DAYS, retentionExpiry } from '../domain/reporting';
import type { CommandActor, ReportingDependencies, RequestContext } from './reporting-context';
import {
  REGISTRY_VIEW,
  ReportingServiceBase,
  claim,
  newReportingRequest,
} from './reporting-context';

/**
 * Guest-data retention and the legal hold that suspends it (`GUEST-DEC-008`,
 * doc 12 §9).
 *
 * Three properties, and the requirements are unusually precise about each.
 *
 * **The countdown starts at checkout, and the terms are snapshotted then.** An
 * active stay has no deadline at all. The policy version, the day count and the
 * expiry are written when the stay completes, so a later policy edit cannot
 * quietly move a row that was already written — doc 12 §9 asks for exactly
 * that, and the table's guard enforces it.
 *
 * **A hold stops the purge without stopping the clock.** The resolver excludes
 * a held stay from the sweep entirely, so a held stay is never offered to the
 * job; when the hold is released or lapses, the same stay becomes due again
 * with the deadline it always had.
 *
 * **Anonymisation is one-way, and it is not a delete.** doc 12 §9 removes the
 * raw identity from product access and keeps the non-identifying reference a
 * financial or audit event needs. The stay row, its charges and its payments
 * are untouched.
 */

export interface HoldView {
  readonly holdId: string;
  readonly stayId: string | null;
  readonly reason: string;
  readonly authorityReference: string;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
}

export class RetentionService extends ReportingServiceBase {
  constructor(deps: ReportingDependencies) {
    super(deps);
  }

  /**
   * The snapshot a completed checkout writes.
   *
   * Called from the checkout's own transaction through the stay module's
   * contract, so a stay cannot complete without its retention terms — and the
   * `ON CONFLICT DO NOTHING` makes a replayed checkout idempotent rather than a
   * second, differently-dated deadline.
   */
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

  /** doc 12 §9: a hold, with its authority, its reason and its window. */
  async placeHold(
    input: {
      hotelId: string;
      stayId?: string;
      reason: string;
      authorityReference: string;
      endsAt?: Date;
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<HoldView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      REGISTRY_VIEW,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'reporting.legal_hold', input.idempotencyKey, {
          stayId: input.stayId ?? 'hotel',
        });
        if (claimed.kind === 'replay') return claimed.body as HoldView;
        await authorize();
        const repository = new ReportingRepository(uow);
        const holdId = await repository.createHold({
          hotelId: input.hotelId,
          stayId: input.stayId ?? null,
          reason: input.reason,
          authorityReference: input.authorityReference,
          imposedByAccountId: gate.principal.accountId,
          endsAt: input.endsAt ?? null,
        });
        const now = this.now(uow);
        await recordPlatformAudit(uow, {
          action: 'retention.hold_placed',
          outcome: 'allowed',
          targetType: 'stay',
          targetRef: input.stayId ?? input.hotelId,
          payload: {
            holdId,
            authorityReference: input.authorityReference,
            by: gate.principal.accountId,
          },
        });
        const view: HoldView = {
          holdId,
          stayId: input.stayId ?? null,
          reason: input.reason,
          authorityReference: input.authorityReference,
          startsAt: now,
          endsAt: input.endsAt ?? null,
        };
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, view);
        return view;
      },
    );
  }

  /** doc 12 §9: releasing a hold puts the stay back in the sweep's reach. */
  async releaseHold(
    input: { hotelId: string; holdId: string; reason: string; idempotencyKey: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ holdId: string; released: true }> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      REGISTRY_VIEW,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'reporting.hold_release', input.idempotencyKey, {
          holdId: input.holdId,
        });
        if (claimed.kind === 'replay') return claimed.body as { holdId: string; released: true };
        await authorize();
        const repository = new ReportingRepository(uow);
        const released = await repository.releaseHold({
          holdId: input.holdId,
          // The hold is read and released in one statement guarded by its own
          // revision, so a second release finds nothing to release.
          expectedRevision: await revisionOf(uow, input.holdId),
          releasedByAccountId: gate.principal.accountId,
          reason: input.reason,
          at: this.now(uow),
        });
        if (!released) throw new ApiError('CONFLICT', 'that hold is already released');
        await recordPlatformAudit(uow, {
          action: 'retention.hold_released',
          outcome: 'allowed',
          targetType: 'retention_legal_hold',
          targetRef: input.holdId,
          payload: { by: gate.principal.accountId },
        });
        const view = { holdId: input.holdId, released: true as const };
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, view);
        return view;
      },
    );
  }

  /**
   * `GUEST-DEC-008`: the purge sweep.
   *
   * The resolver has already excluded every stay under a live hold, so the job
   * never sees one — the hold is not a condition this code remembers to check.
   * It re-reads the hold under the row lock anyway, because a hold placed
   * between the resolver and the lock must still win.
   */
  async sweepRetention(
    limit = 100,
    request: RequestContext = newReportingRequest(),
  ): Promise<number> {
    const now = this.wallClock();
    const due = await this.deps.pool.query<{ stay_id: string; hotel_id: string }>(
      `SELECT stay_id, hotel_id FROM platform.due_retention_purges($1::integer, $2::timestamptz)`,
      [limit, now],
    );
    let purged = 0;
    for (const row of due.rows) {
      if (await this.purgeOne(row.hotel_id, row.stay_id, request)) purged += 1;
    }
    return purged;
  }

  async purgeOne(
    hotelId: string,
    stayId: string,
    request: RequestContext = newReportingRequest(),
  ): Promise<boolean> {
    return this.inHotelScope(hotelId, request, async (uow) => {
      const repository = new ReportingRepository(uow);
      const retention = await repository.lockRetention(stayId);
      if (retention === undefined || retention.anonymizedAt !== null) return false;
      const now = this.now(uow);
      if (retention.retentionExpiresAt.getTime() > now.getTime()) return false;
      // Re-read under the lock: a hold placed a moment ago wins over a sweep
      // that was already looking at this row.
      const hold = await repository.liveHoldFor(stayId, now);
      if (hold !== undefined) return false;

      const anonymized = await this.deps.registry.anonymize(uow, stayId, now);
      const marked = await repository.markAnonymized({
        stayId,
        expectedRevision: retention.revision,
        at: now,
        reason: `retention policy version ${String(retention.policyVersion)}`,
      });
      if (!marked) return false;
      await recordPlatformAudit(uow, {
        action: 'retention.anonymized',
        outcome: 'allowed',
        targetType: 'stay',
        targetRef: stayId,
        // The identity that was removed is not recorded here: an audit payload
        // holding it would be the copy the purge exists to remove.
        payload: {
          policyVersion: retention.policyVersion,
          retentionDays: retention.retentionDays,
          identityCleared: anonymized,
        },
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'stay',
        aggregateId: stayId,
        eventType: 'retention.anonymized',
        payload: { stayId, hotelId },
      });
      return true;
    });
  }
}

async function revisionOf(uow: UnitOfWork, holdId: string): Promise<number> {
  const result = await uow.query<{ revision: number }>(
    `SELECT revision FROM platform.retention_legal_hold WHERE hold_id = $1 FOR UPDATE`,
    [holdId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiError('NOT_FOUND', 'no such hold');
  return Number(row.revision);
}
