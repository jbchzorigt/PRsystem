/**
 * eBarimt receipting (doc 16 §4.1, `SUB-DEC-005`, `SUB-DEC-008`).
 *
 * EXT-11 is blocked: no contract, no credentials, no approved issuance flow. So
 * there is a typed port, a deterministic simulator, and no production adapter.
 *
 * The rule this port's shape enforces is doc 16 §4.1's sharpest one: **the
 * operator never writes a receipt field**. A number, a QR, a tax figure and an
 * issue time arrive together from the issuer or not at all, so a retry has
 * nothing to fabricate — the only thing a permissioned operator can do is ask
 * the issuer again.
 */

export interface EBarimtIssueRequest {
  /** The confirmed payment this receipt belongs to. */
  readonly paymentId: string;
  readonly providerPaymentId: string;
  readonly merchantRef: string;
  /** Whole MNT, VAT-inclusive, exactly what was collected. */
  readonly grossAmountMnt: bigint;
  readonly vatAmountMnt: bigint;
  readonly currency: 'MNT';
  /**
   * Stable across retries, so a re-issue is recognised by the issuer as the
   * same request rather than producing a second receipt for one payment.
   */
  readonly idempotencyKey: string;
}

/** Everything a receipt is. All of it comes from here; none of it is typed in. */
export interface EBarimtReceipt {
  readonly receiptNumber: string;
  readonly qr: string;
  readonly amountMnt: bigint;
  readonly vatAmountMnt: bigint;
  readonly issuedAt: Date;
}

export type EBarimtIssueResult =
  | { readonly outcome: 'issued'; readonly receipt: EBarimtReceipt }
  /** Worth another attempt: an outage, a timeout, a rate limit. */
  | { readonly outcome: 'retryable'; readonly reason: string }
  /** Not worth another automatic attempt; an operator has to look. */
  | { readonly outcome: 'permanent'; readonly reason: string };

export interface EBarimtPort {
  issue(request: EBarimtIssueRequest): Promise<EBarimtIssueResult>;
}

export class EBarimtUnavailableError extends Error {
  override readonly name = 'EBarimtUnavailableError';

  constructor() {
    super('no eBarimt adapter is configured (EXT-11 is not cleared)');
  }
}

/**
 * The production path: refuse.
 *
 * Refusing is not the same as blocking activation. doc 16 §5 is explicit that a
 * missing receipt never rolls back a confirmed subscription, so the service
 * treats this as a queue entry for an operator — which is exactly the flow
 * `SUB-DEC-008` describes, reached here by the gate being closed rather than by
 * the issuer being down.
 */
export class UnavailableEBarimt implements EBarimtPort {
  issue(): Promise<EBarimtIssueResult> {
    return Promise.reject(new EBarimtUnavailableError());
  }
}

/** A deterministic simulator for local, CI and test use. */
export class SimulatedEBarimt implements EBarimtPort {
  private readonly issued = new Map<string, EBarimtReceipt>();
  private outcomes: EBarimtIssueResult['outcome'][] = [];
  private sequence = 0;

  /**
   * Queues the next outcomes, in order. Anything beyond the queue succeeds, so a
   * test declares only the failures it is about.
   */
  failNext(...outcomes: ('retryable' | 'permanent')[]): void {
    this.outcomes.push(...outcomes);
  }

  issue(request: EBarimtIssueRequest): Promise<EBarimtIssueResult> {
    const next = this.outcomes.shift();
    if (next === 'retryable' || next === 'permanent') {
      return Promise.resolve({ outcome: next, reason: `simulated-${next}` });
    }

    // Idempotent by the caller's key: a retry after a lost acknowledgement gets
    // the receipt that already exists rather than a second one.
    const existing = this.issued.get(request.idempotencyKey);
    if (existing !== undefined) return Promise.resolve({ outcome: 'issued', receipt: existing });

    this.sequence += 1;
    const receipt: EBarimtReceipt = {
      receiptNumber: `SIM-${String(this.sequence).padStart(10, '0')}`,
      qr: `sim-qr-${String(this.sequence)}`,
      amountMnt: request.grossAmountMnt,
      vatAmountMnt: request.vatAmountMnt,
      // Fixed offset from the request rather than a wall clock, so a test can
      // assert the value the port produced instead of a moving one.
      issuedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, this.sequence)),
    };
    this.issued.set(request.idempotencyKey, receipt);
    return Promise.resolve({ outcome: 'issued', receipt });
  }

  /** How many distinct receipts exist. A second one per payment is the bug. */
  get receiptCount(): number {
    return this.issued.size;
  }
}

const NON_PRODUCTION = new Set(['local', 'ci', 'test']);

export function selectEBarimt(appEnv: string): EBarimtPort {
  if (NON_PRODUCTION.has(appEnv)) return new SimulatedEBarimt();
  return new UnavailableEBarimt();
}
