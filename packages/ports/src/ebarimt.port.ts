import { createHash } from 'node:crypto';
import type { Port, PortContext, PortMode, PortResult } from './port';
import { fail, isNonProductionEnv, ok } from './port';

/**
 * EXT-11 — `EBarimtPort` (docs/architecture/16-external-port-catalog.md §2;
 * doc 16 §4.1, `SUB-DEC-005`, `SUB-DEC-008`).
 *
 * EXT-11 is blocked: no contract, no credentials, no approved issuance flow.
 * So there is a typed port, a deterministic simulator, and a production adapter
 * that answers `DISABLED`.
 *
 * The rule the shape enforces is doc 16 §4.1's sharpest one: **the operator
 * never writes a receipt field**. A number, a QR, the amounts and an issue time
 * arrive together from the issuer or not at all, so a retry has nothing to
 * fabricate — the only thing a permissioned operator can do is ask the issuer
 * again. A failure never reverses an activated subscription; it routes to the
 * manual queue.
 */

export interface EBarimtIssueCommand {
  /** The confirmed payment this receipt belongs to. */
  readonly paymentId: string;
  /** Whole MNT, VAT-inclusive, exactly what was collected. */
  readonly totalMnt: bigint;
  readonly vatBreakdown: {
    readonly vatMnt: bigint;
    readonly vatRateBp: number;
  };
  /**
   * An opaque reference to the buyer, never the identifier itself. Which buyer
   * fields the tax authority requires is part of the EXT-11 contract nobody has.
   */
  readonly buyer: {
    readonly ownerRef: string;
    readonly ownerType: 'CITIZEN' | 'ORGANIZATION';
  };
  /** Stable across retries, so the issuer recognises a repeat. */
  readonly idempotencyKey: string;
}

/** Everything a receipt is. All of it comes from here; none of it is typed in. */
export interface IssuedReceipt {
  readonly receiptId: string;
  readonly receiptNumber: string;
  readonly qr: string;
  readonly issuedAt: Date;
  readonly totalMnt: bigint;
  readonly vatMnt: bigint;
}

export interface ReceiptStatus {
  readonly state: 'ISSUED' | 'PENDING' | 'FAILED' | 'CANCELLED';
}

export type EBarimtCommand =
  | { readonly kind: 'issue'; readonly input: EBarimtIssueCommand }
  | { readonly kind: 'queryStatus'; readonly input: { readonly receiptId: string } }
  | {
      readonly kind: 'cancel';
      readonly input: { readonly receiptId: string; readonly reason: string };
    };

export type EBarimtResponse = IssuedReceipt | ReceiptStatus;

export interface EBarimtPort extends Port<EBarimtCommand, EBarimtResponse> {
  issue(cmd: EBarimtIssueCommand, ctx: PortContext): Promise<PortResult<IssuedReceipt>>;
  queryStatus(
    cmd: { readonly receiptId: string },
    ctx: PortContext,
  ): Promise<PortResult<ReceiptStatus>>;
  cancel(
    cmd: { readonly receiptId: string; readonly reason: string },
    ctx: PortContext,
  ): Promise<PortResult<ReceiptStatus>>;
}

abstract class EBarimtBase implements EBarimtPort {
  readonly id = 'ebarimt';
  abstract readonly mode: PortMode;

  abstract issue(cmd: EBarimtIssueCommand, ctx: PortContext): Promise<PortResult<IssuedReceipt>>;
  abstract queryStatus(
    cmd: { readonly receiptId: string },
    ctx: PortContext,
  ): Promise<PortResult<ReceiptStatus>>;
  abstract cancel(
    cmd: { readonly receiptId: string; readonly reason: string },
    ctx: PortContext,
  ): Promise<PortResult<ReceiptStatus>>;

  execute(cmd: EBarimtCommand, ctx: PortContext): Promise<PortResult<EBarimtResponse>> {
    switch (cmd.kind) {
      case 'issue':
        return this.issue(cmd.input, ctx);
      case 'queryStatus':
        return this.queryStatus(cmd.input, ctx);
      case 'cancel':
        return this.cancel(cmd.input, ctx);
    }
  }
}

/** The production path until EXT-11 clears: `DISABLED`, and no network call. */
export class UnavailableEBarimt extends EBarimtBase {
  readonly mode: PortMode = 'adapter';

  private disabled<T>(): Promise<PortResult<T>> {
    return Promise.resolve(fail({ kind: 'DISABLED', gate: 'EXT-11' }));
  }

  issue(_cmd: EBarimtIssueCommand, _ctx: PortContext): Promise<PortResult<IssuedReceipt>> {
    return this.disabled();
  }

  queryStatus(
    _cmd: { readonly receiptId: string },
    _ctx: PortContext,
  ): Promise<PortResult<ReceiptStatus>> {
    return this.disabled();
  }

  cancel(
    _cmd: { readonly receiptId: string; readonly reason: string },
    _ctx: PortContext,
  ): Promise<PortResult<ReceiptStatus>> {
    return this.disabled();
  }
}

/** A deterministic simulator for local, CI and test use. */
export class SimulatedEBarimt extends EBarimtBase {
  readonly mode: PortMode = 'simulator';

  private readonly byKey = new Map<string, { hash: string; receipt: IssuedReceipt }>();
  private readonly byReceipt = new Map<string, ReceiptStatus>();
  private outcomes: ('retryable' | 'permanent')[] = [];
  private sequence = 0;

  /**
   * Queues the next outcomes, in order. Anything beyond the queue succeeds, so a
   * test declares only the failures it is about.
   */
  failNext(...outcomes: ('retryable' | 'permanent')[]): void {
    this.outcomes.push(...outcomes);
  }

  issue(cmd: EBarimtIssueCommand, _ctx?: PortContext): Promise<PortResult<IssuedReceipt>> {
    const next = this.outcomes.shift();
    if (next === 'retryable')
      return Promise.resolve(fail({ kind: 'UNAVAILABLE', retryable: true }));
    if (next === 'permanent') {
      return Promise.resolve(fail({ kind: 'REJECTED', providerCode: 'SIMULATED_PERMANENT' }));
    }

    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          paymentId: cmd.paymentId,
          totalMnt: cmd.totalMnt.toString(),
          vatMnt: cmd.vatBreakdown.vatMnt.toString(),
        }),
      )
      .digest('hex');
    // Idempotent by the caller's key: a retry after a lost acknowledgement gets
    // the receipt that already exists rather than a second one.
    const existing = this.byKey.get(cmd.idempotencyKey);
    if (existing !== undefined) {
      if (existing.hash !== hash) {
        return Promise.resolve(fail({ kind: 'REJECTED', providerCode: 'IDEMPOTENCY_KEY_REUSED' }));
      }
      return Promise.resolve(ok(existing.receipt));
    }

    this.sequence += 1;
    const receipt: IssuedReceipt = {
      receiptId: `sim-receipt-${String(this.sequence)}`,
      receiptNumber: `SIM-${String(this.sequence).padStart(10, '0')}`,
      qr: `sim-qr-${String(this.sequence)}`,
      // Fixed offset from the request rather than a wall clock, so a test can
      // assert the value the port produced instead of a moving one.
      issuedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, this.sequence)),
      totalMnt: cmd.totalMnt,
      vatMnt: cmd.vatBreakdown.vatMnt,
    };
    this.byKey.set(cmd.idempotencyKey, { hash, receipt });
    this.byReceipt.set(receipt.receiptId, { state: 'ISSUED' });
    return Promise.resolve(ok(receipt));
  }

  queryStatus(
    cmd: { readonly receiptId: string },
    _ctx?: PortContext,
  ): Promise<PortResult<ReceiptStatus>> {
    const status = this.byReceipt.get(cmd.receiptId);
    if (status === undefined) {
      return Promise.resolve(fail({ kind: 'REJECTED', providerCode: 'UNKNOWN_RECEIPT' }));
    }
    return Promise.resolve(ok(status));
  }

  cancel(
    cmd: { readonly receiptId: string; readonly reason: string },
    _ctx?: PortContext,
  ): Promise<PortResult<ReceiptStatus>> {
    const status = this.byReceipt.get(cmd.receiptId);
    if (status === undefined) {
      return Promise.resolve(fail({ kind: 'REJECTED', providerCode: 'UNKNOWN_RECEIPT' }));
    }
    const cancelled: ReceiptStatus = { state: 'CANCELLED' };
    this.byReceipt.set(cmd.receiptId, cancelled);
    return Promise.resolve(ok(cancelled));
  }

  /** How many distinct receipts exist. A second one per payment is the bug. */
  get receiptCount(): number {
    return this.byKey.size;
  }
}

export function selectEBarimt(appEnv: string): EBarimtPort {
  return isNonProductionEnv(appEnv) ? new SimulatedEBarimt() : new UnavailableEBarimt();
}
