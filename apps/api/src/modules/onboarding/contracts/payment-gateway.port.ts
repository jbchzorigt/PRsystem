/**
 * The subscription payment gateway (doc 16 `SUB-DEC-004`, doc 15 §4).
 *
 * QPay and Khaan Bank are EXT-03 and EXT-04, both blocked: no contract, no
 * credentials, no signature rule. So there is one provider-neutral port, a
 * deterministic simulator behind it, and no production adapter at all. The
 * adapters are Phase 20.
 *
 * The shape is what doc 15 §4 requires of *any* provider: an invoice is created
 * server-side, a callback is authenticated and matched on provider, merchant,
 * reference, amount and currency before it is applied, and the provider's own
 * status can be re-queried when a result is uncertain. Nothing in this file
 * decides a domain transition — it reports what the provider says, and the
 * service decides.
 */

export const PAYMENT_PROVIDERS = ['QPAY', 'KHAAN'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export function isPaymentProvider(value: string): value is PaymentProvider {
  return (PAYMENT_PROVIDERS as readonly string[]).includes(value);
}

export interface CreateInvoiceInput {
  readonly provider: PaymentProvider;
  /** The platform's own reference. Opaque to the provider, unique per attempt. */
  readonly merchantRef: string;
  /** Whole MNT. Never a float, never a client-supplied figure. */
  readonly amountMnt: bigint;
  readonly currency: 'MNT';
  readonly expiresAt: Date;
}

export interface CreatedInvoice {
  readonly providerInvoiceId: string;
  /** Where the payer is sent. Carries no secret and no identifier. */
  readonly checkoutUrl: string;
}

/**
 * What the provider says about an invoice.
 *
 * `uncertain` is a first-class answer, not an error: doc 15 §4 forbids treating
 * an indeterminate result as success, and a port that could only say paid or
 * failed would force the service to guess.
 */
export type ProviderPaymentStatus =
  | {
      readonly outcome: 'paid';
      readonly providerPaymentId: string;
      readonly paidAmountMnt: bigint;
      readonly currency: string;
      readonly merchantRef: string;
      readonly confirmedAt: Date;
    }
  | { readonly outcome: 'pending' }
  | { readonly outcome: 'failed'; readonly reason: string }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'uncertain'; readonly reason: string };

/**
 * A callback as it arrives, before anything has been verified.
 *
 * Deliberately untyped as to authenticity: `verifyCallback` is what turns it
 * into something the service may act on, and the service never reads these
 * fields except through that result.
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

export type CallbackVerification =
  | { readonly verified: true; readonly providerEventId: string }
  | { readonly verified: false; readonly reason: string };

export interface PaymentGatewayPort {
  readonly provider: PaymentProvider;
  createInvoice(input: CreateInvoiceInput): Promise<CreatedInvoice>;
  /**
   * Authenticity only. Whether the callback *matches* the attempt — provider,
   * merchant, reference, amount, currency — is decided by the service against
   * the stored attempt, never by the provider's own claim about itself.
   */
  verifyCallback(callback: RawCallback): Promise<CallbackVerification>;
  /** The provider's own current answer. Used to resolve an uncertain result. */
  queryStatus(providerInvoiceId: string): Promise<ProviderPaymentStatus>;
}

export class PaymentGatewayUnavailableError extends Error {
  override readonly name = 'PaymentGatewayUnavailableError';

  constructor(provider: PaymentProvider) {
    super(`no ${provider} adapter is configured (EXT-03/EXT-04 are not cleared)`);
  }
}

/**
 * The production path: refuse.
 *
 * A subscription that cannot be invoiced has not been sold. Failing closed here
 * is what keeps an unpaid hotel from being provisioned by an adapter that
 * guessed (CLAUDE.md §9).
 */
export class UnavailablePaymentGateway implements PaymentGatewayPort {
  constructor(readonly provider: PaymentProvider) {}

  createInvoice(): Promise<CreatedInvoice> {
    return Promise.reject(new PaymentGatewayUnavailableError(this.provider));
  }

  verifyCallback(): Promise<CallbackVerification> {
    return Promise.reject(new PaymentGatewayUnavailableError(this.provider));
  }

  queryStatus(): Promise<ProviderPaymentStatus> {
    return Promise.reject(new PaymentGatewayUnavailableError(this.provider));
  }
}

interface SimulatedInvoice {
  readonly merchantRef: string;
  readonly amountMnt: bigint;
  readonly currency: string;
  readonly expiresAt: Date;
  status: ProviderPaymentStatus;
}

/**
 * A deterministic simulator for local, CI and test use.
 *
 * It holds invoices in memory and answers exactly what a test put there. The
 * signature rule is a stand-in and is documented as one: a real provider's rule
 * is part of a contract nobody has, so the simulator checks a shape rather than
 * pretending to know one.
 */
export class SimulatedPaymentGateway implements PaymentGatewayPort {
  private readonly invoices = new Map<string, SimulatedInvoice>();
  private sequence = 0;

  constructor(readonly provider: PaymentProvider) {}

  /** The stand-in signature. Deterministic, and never a real provider's scheme. */
  signatureFor(providerInvoiceId: string): string {
    return `sim-${this.provider}-${providerInvoiceId}`;
  }

  createInvoice(input: CreateInvoiceInput): Promise<CreatedInvoice> {
    if (input.provider !== this.provider) {
      return Promise.reject(new Error(`this gateway is ${this.provider}, not ${input.provider}`));
    }
    this.sequence += 1;
    const providerInvoiceId = `${this.provider.toLowerCase()}-inv-${String(this.sequence).padStart(6, '0')}`;
    this.invoices.set(providerInvoiceId, {
      merchantRef: input.merchantRef,
      amountMnt: input.amountMnt,
      currency: input.currency,
      expiresAt: input.expiresAt,
      status: { outcome: 'pending' },
    });
    return Promise.resolve({
      providerInvoiceId,
      checkoutUrl: `https://simulator.invalid/${this.provider.toLowerCase()}/${providerInvoiceId}`,
    });
  }

  /** Drives the simulator: a test says what the provider decided. */
  settle(providerInvoiceId: string, status: ProviderPaymentStatus): void {
    const invoice = this.invoices.get(providerInvoiceId);
    if (invoice === undefined) throw new Error(`no simulated invoice ${providerInvoiceId}`);
    invoice.status = status;
  }

  /** The ordinary success: the provider paid exactly what was invoiced. */
  pay(providerInvoiceId: string, confirmedAt: Date, providerPaymentId?: string): string {
    const invoice = this.invoices.get(providerInvoiceId);
    if (invoice === undefined) throw new Error(`no simulated invoice ${providerInvoiceId}`);
    const paymentId = providerPaymentId ?? `${providerInvoiceId}-pay`;
    invoice.status = {
      outcome: 'paid',
      providerPaymentId: paymentId,
      paidAmountMnt: invoice.amountMnt,
      currency: invoice.currency,
      merchantRef: invoice.merchantRef,
      confirmedAt,
    };
    return paymentId;
  }

  invoice(providerInvoiceId: string): SimulatedInvoice | undefined {
    return this.invoices.get(providerInvoiceId);
  }

  verifyCallback(callback: RawCallback): Promise<CallbackVerification> {
    if (callback.provider !== this.provider) {
      return Promise.resolve({ verified: false, reason: 'provider_mismatch' });
    }
    if (!this.invoices.has(callback.providerInvoiceId)) {
      // An unknown reference is refused before anything is looked up, so a probe
      // cannot learn which invoice ids exist by watching how long a call takes.
      return Promise.resolve({ verified: false, reason: 'unknown_reference' });
    }
    if (callback.signature !== this.signatureFor(callback.providerInvoiceId)) {
      return Promise.resolve({ verified: false, reason: 'bad_signature' });
    }
    return Promise.resolve({
      verified: true,
      // The provider event identity a duplicate callback repeats.
      providerEventId: `${this.provider}:${callback.providerInvoiceId}:${callback.providerPaymentId ?? 'none'}`,
    });
  }

  queryStatus(providerInvoiceId: string): Promise<ProviderPaymentStatus> {
    const invoice = this.invoices.get(providerInvoiceId);
    if (invoice === undefined) return Promise.resolve({ outcome: 'failed', reason: 'unknown' });
    return Promise.resolve(invoice.status);
  }
}

const NON_PRODUCTION = new Set(['local', 'ci', 'test']);

export interface PaymentGateways {
  gateway(provider: PaymentProvider): PaymentGatewayPort;
}

export class PaymentGatewayRegistry implements PaymentGateways {
  constructor(private readonly byProvider: ReadonlyMap<PaymentProvider, PaymentGatewayPort>) {}

  gateway(provider: PaymentProvider): PaymentGatewayPort {
    const port = this.byProvider.get(provider);
    if (port === undefined) throw new PaymentGatewayUnavailableError(provider);
    return port;
  }
}

/** Chooses the adapters for an environment, and refuses to degrade. */
export function selectPaymentGateways(appEnv: string): PaymentGatewayRegistry {
  const simulated = NON_PRODUCTION.has(appEnv);
  return new PaymentGatewayRegistry(
    new Map(
      PAYMENT_PROVIDERS.map((provider) => [
        provider,
        simulated
          ? (new SimulatedPaymentGateway(provider) as PaymentGatewayPort)
          : new UnavailablePaymentGateway(provider),
      ]),
    ),
  );
}
