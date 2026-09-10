import type { UnitOfWork } from '@prsystem/db';
import type {
  PaymentAttemptFacts,
  PaymentAttemptsPort,
} from '../../stay/contracts/payment-attempts';

/**
 * The stay module's payment-attempt facts, answered by the folio's own money.
 *
 * doc 21 §5 locks the exact minibar report version a payment attempt charges
 * and settles it only on the attempt's confirmed success. Phase 09 wrote that
 * contract against a "payment attempt" and Phase 10 recorded every payment a
 * stay receives as a `platform.payment_transaction` — but nothing had ever
 * joined the two, so a production deployment answered `UNKNOWN` for every
 * attempt and no minibar report could settle (Phase 22, `A-P22-2`).
 *
 * An attempt reference is the reference a folio payment carries: the provider's
 * reference for a QPay or card payment, the approval reference typed for a
 * manual POS receipt, or the transaction id itself for a cash receipt. A
 * payment that exists is a captured attempt; one that does not is `UNKNOWN`,
 * and the lock holds — a refusal never comes from here, because the folio has
 * no record of a provider's refusal, only of money that arrived.
 */
export class BillingPaymentAttempts implements PaymentAttemptsPort {
  async statusOf(uow: UnitOfWork, attemptRef: string): Promise<PaymentAttemptFacts> {
    const result = await uow.query<{ captured: string | null; matches: string }>(
      `SELECT sum(amount_mnt)::text AS captured, count(*)::text AS matches
         FROM platform.payment_transaction
        WHERE kind = 'FOLIO_PAYMENT' AND direction = 'IN'
          AND (provider_reference = $1 OR transaction_id::text = $1)`,
      [attemptRef],
    );
    const row = result.rows[0];
    if (row === undefined || Number(row.matches) === 0 || row.captured === null) {
      return { attemptRef, status: 'UNKNOWN', capturedAmountMnt: null };
    }
    return { attemptRef, status: 'SUCCEEDED', capturedAmountMnt: BigInt(row.captured) };
  }
}
