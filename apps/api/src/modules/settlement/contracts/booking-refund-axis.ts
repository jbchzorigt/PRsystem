import type { UnitOfWork } from '@prsystem/db';

/**
 * The booking's refund axis, for the module that executes refunds but does not
 * own the booking (CLAUDE.md §3).
 *
 * doc 11 §9 keeps the axes apart: a refund reaching the provider does not
 * revive a cancelled booking and does not un-capture a payment. All this
 * contract moves is `refund_state`, in the same transaction as the provider
 * result that justified it — and doc 18 §3.3 refuses every hotel and guest role
 * the power to move it by hand, so nothing but a verified result reaches here.
 */
export interface BookingRefundAxisPort {
  /**
   * Records where the booking's refund now stands.
   *
   * Returns `false` when the booking moved under the command — a lost race, not
   * an error: the caller re-reads and decides again.
   */
  setRefundState(
    uow: UnitOfWork,
    input: {
      readonly bookingId: string;
      readonly state: 'PENDING' | 'PARTIALLY_REFUNDED' | 'REFUNDED' | 'FAILED';
      readonly actorRef: string;
      readonly reason?: string;
    },
  ): Promise<boolean>;

  /** The facts a settlement needs about the booking it is settling. */
  factsOf(
    uow: UnitOfWork,
    bookingId: string,
  ): Promise<
    | {
        readonly hotelId: string;
        readonly bookingRef: string;
        readonly state: string;
        readonly paymentState: string;
        readonly refundState: string;
      }
    | undefined
  >;
}

/**
 * The default where no booking relation exists. It refuses the moment one does:
 * a refund that completed without moving the booking's axis would leave the
 * booking claiming the guest is still owed money it already has.
 */
export class UnprovisionedBookingRefundAxis implements BookingRefundAxisPort {
  async setRefundState(uow: UnitOfWork): Promise<boolean> {
    await this.refuseOnceProvisioned(uow);
    return false;
  }

  async factsOf(uow: UnitOfWork): Promise<undefined> {
    await this.refuseOnceProvisioned(uow);
    return undefined;
  }

  private async refuseOnceProvisioned(uow: UnitOfWork): Promise<void> {
    const result = await uow.query<{ present: boolean }>(
      `SELECT to_regclass('platform.booking') IS NOT NULL AS present`,
    );
    if (result.rows[0]?.present === true) {
      throw new Error(
        'platform.booking exists: a settled refund must move the booking refund axis ' +
          'through a real BookingRefundAxisPort, not this default',
      );
    }
  }
}
