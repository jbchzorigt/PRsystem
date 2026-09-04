import type { UnitOfWork } from '@prsystem/db';

/**
 * What a checkout needs to know about the payment attempt it locked a report
 * version for, from the module that will own payments (Phase 10), through a
 * contract rather than a table (CLAUDE.md §3, §7).
 *
 * One question, and it is the only one that may unlock a report: what does the
 * provider say about this attempt? doc 21 §5 refuses to take the answer from a
 * screen, a client field or a Reception's word — a confirmed failure without
 * funds releases the version for correction, and anything pending or unknown
 * keeps the hold until reconciliation answers.
 *
 * Until Phase 10 registers an implementation, `platform.payment_attempt` does
 * not exist, and the reconciliation of an attempt this platform cannot yet
 * query answers `UNKNOWN` — which holds, exactly as the requirement wants.
 * Once the relation exists, this default refuses rather than inventing a
 * status from a table it does not read.
 */

export type AttemptStatus = 'PENDING' | 'UNKNOWN' | 'FAILED_NO_FUNDS' | 'SUCCEEDED';

export interface PaymentAttemptFacts {
  readonly attemptRef: string;
  readonly status: AttemptStatus;
  /** The amount the provider says it took, when it says it took one. */
  readonly capturedAmountMnt: bigint | null;
}

export interface PaymentAttemptsPort {
  /** The provider's own answer about this attempt, re-queried at reconciliation. */
  statusOf(uow: UnitOfWork, attemptRef: string): Promise<PaymentAttemptFacts>;
}

export class PaymentAttemptsUnavailableError extends Error {
  override readonly name = 'PaymentAttemptsUnavailableError';
  constructor() {
    super('platform.payment_attempt exists but no payment-attempt implementation is registered');
  }
}

/**
 * The default until Phase 10: no relation, no provider to ask, so the status is
 * `UNKNOWN` and the lock stays held. A relation with no implementation behind
 * it is a refusal, never a status.
 */
export class UnprovisionedPaymentAttempts implements PaymentAttemptsPort {
  async statusOf(uow: UnitOfWork, attemptRef: string): Promise<PaymentAttemptFacts> {
    const result = await uow.query<{ present: boolean }>(
      `SELECT to_regclass('platform.payment_attempt') IS NOT NULL AS present`,
    );
    if (result.rows[0]?.present === true) throw new PaymentAttemptsUnavailableError();
    return { attemptRef, status: 'UNKNOWN', capturedAmountMnt: null };
  }
}

/** A deterministic in-memory implementation for the module's own tests. */
export class SimulatedPaymentAttempts implements PaymentAttemptsPort {
  private readonly attempts = new Map<string, PaymentAttemptFacts>();

  set(attemptRef: string, status: AttemptStatus, capturedAmountMnt: bigint | null = null): void {
    this.attempts.set(attemptRef, { attemptRef, status, capturedAmountMnt });
  }

  clear(): void {
    this.attempts.clear();
  }

  statusOf(_uow: UnitOfWork, attemptRef: string): Promise<PaymentAttemptFacts> {
    return Promise.resolve(
      this.attempts.get(attemptRef) ?? { attemptRef, status: 'UNKNOWN', capturedAmountMnt: null },
    );
  }
}
