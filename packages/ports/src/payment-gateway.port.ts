import { createHash, timingSafeEqual } from 'node:crypto';
import type { Port, PortContext, PortError, PortMode, PortResult } from './port';
import { fail, isNonProductionEnv, ok } from './port';

/**
 * EXT-03 / EXT-04 — `PaymentGatewayPort`
 * (docs/architecture/16-external-port-catalog.md §2).
 *
 * One interface, two implementations, so the domain is provider-agnostic
 * (`PAY-DEC-005`, `SUB-DEC-004`). QPay and Khaan Bank are both blocked: no
 * contract, no credentials, no signature rule. So the production adapter is
 * `UnavailablePaymentGateway`, which answers `DISABLED` and never makes a
 * network call, and the deterministic simulator is what local, CI and test run
 * against. The adapters are Phase 20.
 *
 * Nothing here decides a domain transition. The port reports what the provider
 * says — an invoice, a status, a verified callback — and the service decides,
 * always re-querying status where the requirements demand it (`PAY-DEC-006`,
 * `ONB-DEC-008`).
 */

export const PAYMENT_PROVIDERS = ['QPAY', 'KHAAN'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export function isPaymentProvider(value: string): value is PaymentProvider {
  return (PAYMENT_PROVIDERS as readonly string[]).includes(value);
}

export const PAYMENT_GATE_BY_PROVIDER: Record<PaymentProvider, 'EXT-03' | 'EXT-04'> = {
  QPAY: 'EXT-03',
  KHAAN: 'EXT-04',
};

export interface CreateInvoiceCommand {
  /** The platform's own intent or attempt the invoice pays for. */
  readonly intentId: string;
  /** Whole MNT. Never a float, never a client-supplied figure. */
  readonly amountMnt: bigint;
  readonly currency: 'MNT';
  /** The platform's reference. Opaque to the provider, unique per attempt. */
  readonly merchantRef: string;
  readonly expiresAt: Date;
  /**
   * Stable across retries of the same business request, so a provider that
   * already created this invoice returns it rather than a second one.
   */
  readonly idempotencyKey: string;
}

export interface CreatedInvoice {
  readonly providerInvoiceId: string;
  /** Where the payer is sent. Carries no secret and no identifier. */
  readonly payUrl?: string;
  readonly qr?: string;
}

export type InvoiceState = 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';

/** What the provider says about an invoice. `PAID` carries the settlement facts. */
export interface InvoiceStatus {
  readonly state: InvoiceState;
  readonly providerPaymentId?: string;
  readonly paidAmountMnt?: bigint;
  readonly currency?: string;
  readonly merchantRef?: string;
  readonly paidAt?: Date;
  /** The fee the provider retained, when it reports one (doc 16 §4). */
  readonly providerFeeMnt?: bigint;
  readonly failureCode?: string;
}

export interface RefundCommand {
  readonly providerPaymentId: string;
  readonly amountMnt: bigint;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface RefundResult {
  readonly providerRefundId: string;
  readonly state: 'PENDING' | 'REFUNDED' | 'FAILED';
}

/**
 * A callback as it arrives, before anything has been verified. Deliberately
 * untyped as to authenticity: `verifyCallback` is what turns it into something
 * the service may act on.
 */
export interface RawCallback {
  readonly provider: PaymentProvider;
  readonly providerInvoiceId: string;
  readonly providerPaymentId?: string;
  readonly merchantRef?: string;
  readonly amountMnt?: string;
  readonly currency?: string;
  readonly signature?: string;
  readonly status?: string;
}

export interface VerifiedCallback {
  readonly valid: true;
  /** The provider event identity a duplicate delivery repeats. */
  readonly providerEventId: string;
  readonly payload: {
    readonly providerInvoiceId: string;
    readonly providerPaymentId?: string;
  };
}

export type PaymentCommand =
  | { readonly kind: 'createInvoice'; readonly input: CreateInvoiceCommand }
  | { readonly kind: 'queryStatus'; readonly input: { readonly providerInvoiceId: string } }
  | { readonly kind: 'refund'; readonly input: RefundCommand }
  | { readonly kind: 'verifyCallback'; readonly input: RawCallback };

export type PaymentResponse = CreatedInvoice | InvoiceStatus | RefundResult | VerifiedCallback;

export interface PaymentGatewayPort extends Port<PaymentCommand, PaymentResponse> {
  readonly provider: PaymentProvider;
  createInvoice(cmd: CreateInvoiceCommand, ctx: PortContext): Promise<PortResult<CreatedInvoice>>;
  queryStatus(
    cmd: { readonly providerInvoiceId: string },
    ctx: PortContext,
  ): Promise<PortResult<InvoiceStatus>>;
  refund(cmd: RefundCommand, ctx: PortContext): Promise<PortResult<RefundResult>>;
  /**
   * Authenticity, and the provider's own claims checked against the invoice it
   * names. Whether the callback matches the *stored attempt* — amount, currency,
   * merchant reference — is still decided by the service against its own row.
   */
  verifyCallback(raw: RawCallback, ctx: PortContext): Promise<PortResult<VerifiedCallback>>;
}

abstract class PaymentGatewayBase implements PaymentGatewayPort {
  abstract readonly id: string;
  abstract readonly mode: PortMode;

  protected constructor(readonly provider: PaymentProvider) {}

  abstract createInvoice(
    cmd: CreateInvoiceCommand,
    ctx: PortContext,
  ): Promise<PortResult<CreatedInvoice>>;
  abstract queryStatus(
    cmd: { readonly providerInvoiceId: string },
    ctx: PortContext,
  ): Promise<PortResult<InvoiceStatus>>;
  abstract refund(cmd: RefundCommand, ctx: PortContext): Promise<PortResult<RefundResult>>;
  abstract verifyCallback(
    raw: RawCallback,
    ctx: PortContext,
  ): Promise<PortResult<VerifiedCallback>>;

  execute(cmd: PaymentCommand, ctx: PortContext): Promise<PortResult<PaymentResponse>> {
    switch (cmd.kind) {
      case 'createInvoice':
        return this.createInvoice(cmd.input, ctx);
      case 'queryStatus':
        return this.queryStatus(cmd.input, ctx);
      case 'refund':
        return this.refund(cmd.input, ctx);
      case 'verifyCallback':
        return this.verifyCallback(cmd.input, ctx);
    }
  }
}

/**
 * The production path until EXT-03 / EXT-04 clear: refuse, typed, without a
 * network call. A subscription that cannot be invoiced has not been sold.
 */
export class UnavailablePaymentGateway extends PaymentGatewayBase {
  readonly id: string;
  readonly mode: PortMode = 'adapter';

  constructor(provider: PaymentProvider) {
    super(provider);
    this.id = provider.toLowerCase();
  }

  private disabled<T>(): Promise<PortResult<T>> {
    return Promise.resolve(
      fail({ kind: 'DISABLED', gate: PAYMENT_GATE_BY_PROVIDER[this.provider] }),
    );
  }

  createInvoice(
    _cmd: CreateInvoiceCommand,
    _ctx: PortContext,
  ): Promise<PortResult<CreatedInvoice>> {
    return this.disabled();
  }

  queryStatus(
    _cmd: { readonly providerInvoiceId: string },
    _ctx: PortContext,
  ): Promise<PortResult<InvoiceStatus>> {
    return this.disabled();
  }

  refund(_cmd: RefundCommand, _ctx: PortContext): Promise<PortResult<RefundResult>> {
    return this.disabled();
  }

  verifyCallback(_raw: RawCallback, _ctx: PortContext): Promise<PortResult<VerifiedCallback>> {
    return this.disabled();
  }
}

export interface SimulatedInvoice {
  readonly providerInvoiceId: string;
  readonly intentId: string;
  readonly merchantRef: string;
  readonly amountMnt: bigint;
  readonly currency: string;
  readonly expiresAt: Date;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  status: InvoiceStatus;
}

function hashCommand(cmd: CreateInvoiceCommand): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        intentId: cmd.intentId,
        amountMnt: cmd.amountMnt.toString(),
        currency: cmd.currency,
        merchantRef: cmd.merchantRef,
      }),
    )
    .digest('hex');
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The deterministic simulator for local, CI and test.
 *
 * It holds invoices in memory and answers exactly what a test put there. Its
 * signature rule is a stand-in and documented as one: a real provider's rule is
 * part of a contract nobody has, so the simulator checks a shape rather than
 * pretending to know one. Every failure a real provider can produce — a lost
 * acknowledgement, a timeout, an outage, a held connection — can be armed here,
 * because those are the cases the domain's idempotency has to survive.
 */
export class SimulatedPaymentGateway extends PaymentGatewayBase {
  readonly id: string;
  readonly mode: PortMode = 'simulator';

  private readonly invoices = new Map<string, SimulatedInvoice>();
  private readonly byKey = new Map<string, string>();
  private readonly refunds = new Map<string, RefundResult>();
  private sequence = 0;
  private lostAcknowledgements = 0;
  private armedFailures: PortError[] = [];
  private blocked: Promise<void> | undefined;
  /** How many times an invoice was looked up. Scenario 7 asserts it stays put. */
  lookups = 0;

  constructor(provider: PaymentProvider) {
    super(provider);
    this.id = provider.toLowerCase();
  }

  // ------------------------------------------------------------------ arming

  /** The next `createInvoice` creates the invoice and then loses the reply. */
  loseNextAcknowledgement(times = 1): void {
    this.lostAcknowledgements += times;
  }

  /**
   * The next provider call answers with this error and does nothing. Signature
   * verification is a local computation and never consumes an armed failure.
   */
  failNext(error: PortError): void {
    this.armedFailures.push(error);
  }

  /** Holds the next `createInvoice` open until the returned function is called. */
  blockNext(): () => void {
    let release = (): void => undefined;
    this.blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.blocked = undefined;
      release();
    };
  }

  /** The stand-in signature. Deterministic, and never a real provider's scheme. */
  signatureFor(providerInvoiceId: string): string {
    return `sim-${this.provider}-${providerInvoiceId}`;
  }

  /** A test says what the provider decided. */
  settle(providerInvoiceId: string, status: InvoiceStatus): void {
    const invoice = this.invoices.get(providerInvoiceId);
    if (invoice === undefined) throw new Error(`no simulated invoice ${providerInvoiceId}`);
    invoice.status = status;
  }

  /** The ordinary success: the provider collected exactly what was invoiced. */
  pay(
    providerInvoiceId: string,
    paidAt: Date,
    providerPaymentId?: string,
    providerFeeMnt?: bigint,
  ): string {
    const invoice = this.invoices.get(providerInvoiceId);
    if (invoice === undefined) throw new Error(`no simulated invoice ${providerInvoiceId}`);
    const paymentId = providerPaymentId ?? `${providerInvoiceId}-pay`;
    invoice.status = {
      state: 'PAID',
      providerPaymentId: paymentId,
      paidAmountMnt: invoice.amountMnt,
      currency: invoice.currency,
      merchantRef: invoice.merchantRef,
      paidAt,
      providerFeeMnt: providerFeeMnt ?? 0n,
    };
    return paymentId;
  }

  invoice(providerInvoiceId: string): SimulatedInvoice | undefined {
    return this.invoices.get(providerInvoiceId);
  }

  get invoiceCount(): number {
    return this.invoices.size;
  }

  // -------------------------------------------------------------- the port

  private armed<T>(): PortResult<T> | undefined {
    const next = this.armedFailures.shift();
    return next === undefined ? undefined : fail(next);
  }

  async createInvoice(
    cmd: CreateInvoiceCommand,
    _ctx?: PortContext,
  ): Promise<PortResult<CreatedInvoice>> {
    if (this.blocked !== undefined) await this.blocked;
    const armed = this.armed<CreatedInvoice>();
    if (armed !== undefined) return armed;

    const requestHash = hashCommand(cmd);
    const existingId = this.byKey.get(cmd.idempotencyKey);
    if (existingId !== undefined) {
      const existing = this.invoices.get(existingId);
      if (existing !== undefined && existing.requestHash !== requestHash) {
        return fail({ kind: 'REJECTED', providerCode: 'IDEMPOTENCY_KEY_REUSED' });
      }
      return ok({
        providerInvoiceId: existingId,
        payUrl: `https://simulator.invalid/${this.id}/${existingId}`,
      });
    }

    this.sequence += 1;
    const providerInvoiceId = `${this.id}-inv-${String(this.sequence).padStart(6, '0')}`;
    this.invoices.set(providerInvoiceId, {
      providerInvoiceId,
      intentId: cmd.intentId,
      merchantRef: cmd.merchantRef,
      amountMnt: cmd.amountMnt,
      currency: cmd.currency,
      expiresAt: cmd.expiresAt,
      idempotencyKey: cmd.idempotencyKey,
      requestHash,
      status: { state: 'PENDING' },
    });
    this.byKey.set(cmd.idempotencyKey, providerInvoiceId);

    if (this.lostAcknowledgements > 0) {
      // The provider did the work; the reply never arrived. Scenario 8.
      this.lostAcknowledgements -= 1;
      return fail({ kind: 'TIMEOUT', retryable: true });
    }
    return ok({
      providerInvoiceId,
      payUrl: `https://simulator.invalid/${this.id}/${providerInvoiceId}`,
    });
  }

  queryStatus(
    cmd: { readonly providerInvoiceId: string },
    _ctx?: PortContext,
  ): Promise<PortResult<InvoiceStatus>> {
    const armed = this.armed<InvoiceStatus>();
    if (armed !== undefined) return Promise.resolve(armed);
    this.lookups += 1;
    const invoice = this.invoices.get(cmd.providerInvoiceId);
    if (invoice === undefined) {
      return Promise.resolve(fail({ kind: 'REJECTED', providerCode: 'UNKNOWN_REFERENCE' }));
    }
    return Promise.resolve(ok(invoice.status));
  }

  refund(cmd: RefundCommand, _ctx?: PortContext): Promise<PortResult<RefundResult>> {
    const armed = this.armed<RefundResult>();
    if (armed !== undefined) return Promise.resolve(armed);
    const existing = this.refunds.get(cmd.idempotencyKey);
    if (existing !== undefined) return Promise.resolve(ok(existing));
    const result: RefundResult = {
      providerRefundId: `${cmd.providerPaymentId}-refund-${String(this.refunds.size + 1)}`,
      state: 'REFUNDED',
    };
    this.refunds.set(cmd.idempotencyKey, result);
    return Promise.resolve(ok(result));
  }

  verifyCallback(raw: RawCallback, _ctx?: PortContext): Promise<PortResult<VerifiedCallback>> {
    if (raw.provider !== this.provider) {
      return Promise.resolve(fail({ kind: 'REJECTED', providerCode: 'PROVIDER_MISMATCH' }));
    }
    // The signature first, before anything is looked up: a forged callback
    // learns nothing about which invoice ids exist (scenario 7).
    if (
      raw.signature === undefined ||
      !sameSecret(raw.signature, this.signatureFor(raw.providerInvoiceId))
    ) {
      return Promise.resolve(fail({ kind: 'INVALID_SIGNATURE' }));
    }
    this.lookups += 1;
    const invoice = this.invoices.get(raw.providerInvoiceId);
    if (invoice === undefined) {
      return Promise.resolve(fail({ kind: 'REJECTED', providerCode: 'UNKNOWN_REFERENCE' }));
    }
    if (raw.merchantRef !== undefined && raw.merchantRef !== invoice.merchantRef) {
      return Promise.resolve(fail({ kind: 'MISMATCH', field: 'merchant' }));
    }
    if (raw.amountMnt !== undefined && BigInt(raw.amountMnt) !== invoice.amountMnt) {
      return Promise.resolve(fail({ kind: 'MISMATCH', field: 'amount' }));
    }
    if (raw.currency !== undefined && raw.currency !== invoice.currency) {
      return Promise.resolve(fail({ kind: 'MISMATCH', field: 'currency' }));
    }
    return Promise.resolve(
      ok({
        valid: true,
        providerEventId: `${this.provider}:${raw.providerInvoiceId}:${raw.providerPaymentId ?? 'none'}`,
        payload: {
          providerInvoiceId: raw.providerInvoiceId,
          ...(raw.providerPaymentId === undefined
            ? {}
            : { providerPaymentId: raw.providerPaymentId }),
        },
      }),
    );
  }
}

export interface PaymentGateways {
  gateway(provider: PaymentProvider): PaymentGatewayPort;
}

export class PaymentGatewayRegistry implements PaymentGateways {
  constructor(private readonly byProvider: ReadonlyMap<PaymentProvider, PaymentGatewayPort>) {}

  gateway(provider: PaymentProvider): PaymentGatewayPort {
    const port = this.byProvider.get(provider);
    if (port === undefined) {
      // A registry with a provider missing is a wiring defect, and the safe
      // answer is the disabled adapter rather than a throw across the boundary.
      return new UnavailablePaymentGateway(provider);
    }
    return port;
  }
}

/** Chooses the adapters for an environment, and refuses to degrade. */
export function selectPaymentGateways(appEnv: string): PaymentGatewayRegistry {
  const simulated = isNonProductionEnv(appEnv);
  return new PaymentGatewayRegistry(
    new Map<PaymentProvider, PaymentGatewayPort>(
      PAYMENT_PROVIDERS.map((provider) => [
        provider,
        simulated ? new SimulatedPaymentGateway(provider) : new UnavailablePaymentGateway(provider),
      ]),
    ),
  );
}
