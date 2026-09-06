import type { Pool } from 'pg';
import { newCorrelationId } from '@prsystem/contracts';
import type { TenantContext, UnitOfWork } from '@prsystem/db';
import { withTenantTransaction } from '@prsystem/db';
import type { HotelPayoutPort, PaymentGateways } from '@prsystem/ports';
import type { BookingRefundAxisPort } from '../contracts/booking-refund-axis';

/**
 * The transaction shape the settlement module runs in.
 *
 * Everything here is the hotel's own tenant scope. There is no guest surface
 * and no public one: a payable, a refund attempt and a payout batch are the
 * platform's record of the hotel's money, and the only paths into them are the
 * booking module's contract — running inside the booking's own transaction —
 * and two jobs, each of which finds its work through a resolver function and
 * then acts in one hotel at a time, on the row's own lock.
 */

export interface SettlementDependencies {
  readonly pool: Pool;
  /** EXT-03 / EXT-04. The only authority on whether a refund happened. */
  readonly payments: PaymentGateways;
  /** EXT-07. Disabled in production until the settlement contract clears. */
  readonly payouts: HotelPayoutPort;
  /** The booking's refund axis, from the module that owns the booking. */
  readonly bookings: BookingRefundAxisPort;
  /** Tests only: the server's now. Production reads the transaction's time. */
  readonly clock?: () => Date;
}

export interface RequestContext {
  readonly correlationId: string;
  readonly accountId?: string;
}

export function newSettlementRequest(accountId?: string): RequestContext {
  return {
    correlationId: newCorrelationId(),
    ...(accountId === undefined ? {} : { accountId }),
  };
}

export function hotelScope(hotelId: string, request: RequestContext): TenantContext {
  return {
    hotelId,
    realm: 'hotel',
    actorRef: request.accountId ?? 'system:settlement',
    ...(request.accountId === undefined ? {} : { accountId: request.accountId }),
    correlationId: request.correlationId,
  };
}

export abstract class SettlementServiceBase {
  protected constructor(protected readonly deps: SettlementDependencies) {}

  protected now(uow: UnitOfWork): Date {
    return this.deps.clock === undefined ? uow.serverNow : this.deps.clock();
  }

  /** The server's now outside a transaction, for a job choosing its work. */
  protected wallClock(): Date {
    return this.deps.clock === undefined ? new Date() : this.deps.clock();
  }

  protected inHotelScope<T>(
    hotelId: string,
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.deps.pool, hotelScope(hotelId, request), work);
  }
}

/** The hotel-local timezone, read inside the hotel's own scope. */
export async function hotelTimeZone(uow: UnitOfWork): Promise<string> {
  const result = await uow.query<{ timezone: string }>(
    `SELECT timezone FROM platform.hotel WHERE hotel_id = $1`,
    [uow.context.hotelId],
  );
  return result.rows[0]?.timezone ?? 'Asia/Ulaanbaatar';
}
