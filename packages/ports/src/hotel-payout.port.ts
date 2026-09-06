import type { Port, PortContext, PortError, PortMode, PortResult } from './port';
import { fail, isNonProductionEnv, ok } from './port';

/**
 * EXT-07 — `HotelPayoutPort`.
 *
 * doc 11 §2 routes every online booking payment into the platform's own
 * account and pays the hotel its net share afterwards. Whether the platform may
 * legally hold a third party's money that way, and through which merchant or
 * bank facility, is a contract and a legal opinion nobody has yet — so the
 * production adapter is `UnavailableHotelPayout`, which answers `DISABLED` and
 * makes no network call, and the deterministic simulator is what local, CI and
 * test run against.
 *
 * Nothing here decides a domain transition. The port reports what the bank
 * said; the payout batch decides what that means, and `PAY-DEC-009` is explicit
 * that a failure creates a new attempt rather than rewriting the old one.
 */

export interface PayoutInstruction {
  /** The platform's own batch. Opaque to the bank, unique per attempt. */
  readonly batchRef: string;
  readonly hotelId: string;
  /** Whole MNT, always positive: a claw-back is netted before it gets here. */
  readonly amountMnt: bigint;
  readonly currency: 'MNT';
  /** Stable across retries of the *same* attempt, never across two attempts. */
  readonly idempotencyKey: string;
}

export interface PayoutResult {
  readonly state: 'PAID' | 'FAILED';
  /** The bank's own record of the transfer. Present exactly when it paid. */
  readonly bankReference?: string;
  readonly failureCode?: string;
}

export type PayoutCommand = { readonly kind: 'transfer'; readonly input: PayoutInstruction };

export interface HotelPayoutPort extends Port<PayoutCommand, PayoutResult> {
  transfer(cmd: PayoutInstruction, ctx: PortContext): Promise<PortResult<PayoutResult>>;
}

abstract class HotelPayoutBase implements HotelPayoutPort {
  abstract readonly id: string;
  abstract readonly mode: PortMode;

  abstract transfer(cmd: PayoutInstruction, ctx: PortContext): Promise<PortResult<PayoutResult>>;

  execute(cmd: PayoutCommand, ctx: PortContext): Promise<PortResult<PayoutResult>> {
    return this.transfer(cmd.input, ctx);
  }
}

/** The production path until EXT-07 clears: refuse, typed, without a transfer. */
export class UnavailableHotelPayout extends HotelPayoutBase {
  readonly id = 'hotel-payout';
  readonly mode: PortMode = 'adapter';

  transfer(_cmd: PayoutInstruction, _ctx: PortContext): Promise<PortResult<PayoutResult>> {
    return Promise.resolve(fail({ kind: 'DISABLED', gate: 'EXT-07' }));
  }
}

/**
 * The deterministic simulator for local, CI and test.
 *
 * It remembers each instruction by its idempotency key, so a redriven attempt
 * gets the answer the first one got rather than a second transfer — the
 * property a real bank's idempotency is supposed to provide and the one the
 * batch's own logic has to survive without.
 */
export class SimulatedHotelPayout extends HotelPayoutBase {
  readonly id = 'hotel-payout';
  readonly mode: PortMode = 'simulator';

  readonly transfers: PayoutInstruction[] = [];
  private readonly answered = new Map<string, PayoutResult>();
  private armedFailures: PortError[] = [];
  private armedDeclines: string[] = [];
  private sequence = 0;

  /** The next call answers with this transport error and moves no money. */
  failNext(error: PortError): void {
    this.armedFailures.push(error);
  }

  /** The next call reaches the bank and the bank declines it. */
  declineNext(code = 'INSUFFICIENT_FUNDS'): void {
    this.armedDeclines.push(code);
  }

  transfer(cmd: PayoutInstruction, _ctx?: PortContext): Promise<PortResult<PayoutResult>> {
    const armed = this.armedFailures.shift();
    if (armed !== undefined) return Promise.resolve(fail(armed));
    const seen = this.answered.get(cmd.idempotencyKey);
    if (seen !== undefined) return Promise.resolve(ok(seen));

    const decline = this.armedDeclines.shift();
    this.transfers.push(cmd);
    if (decline !== undefined) {
      const failed: PayoutResult = { state: 'FAILED', failureCode: decline };
      this.answered.set(cmd.idempotencyKey, failed);
      return Promise.resolve(ok(failed));
    }
    this.sequence += 1;
    const paid: PayoutResult = {
      state: 'PAID',
      bankReference: `sim-payout-${String(this.sequence).padStart(6, '0')}`,
    };
    this.answered.set(cmd.idempotencyKey, paid);
    return Promise.resolve(ok(paid));
  }
}

/** Chooses the adapter for an environment, and refuses to degrade. */
export function selectHotelPayout(appEnv: string): HotelPayoutPort {
  return isNonProductionEnv(appEnv) ? new SimulatedHotelPayout() : new UnavailableHotelPayout();
}
