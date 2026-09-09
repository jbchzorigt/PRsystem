import type { Port, PortContext, PortMode, PortResult } from './port';
import { fail, isNonProductionEnv, ok } from './port';

/**
 * `EXT-05` — `SmsPort` (doc 13 §10.2, doc 14 §5.6;
 * docs/architecture/16-external-port-catalog.md).
 *
 * One-way send only. `OPS-DEC-004` refuses an inbound SMS inbox, so there is no
 * receive surface here and no webhook that could carry a reply; what the
 * provider may tell us is a delivery status, which is a query and a signed
 * callback about a message we sent.
 *
 * **What this port must never be handed.** doc 13 §10.2 puts exactly one
 * sensitive value in a Match SMS — the full registration number — and forbids
 * it in application logs, delivery logs and provider callback records alike.
 * So the body crosses this boundary and is never stored by the caller: what a
 * delivery row keeps is the provider's message id and a masked identifier. A
 * portal link, if a production adapter ever carries one, may not put a Match
 * id, a registration number or a session token in its URL.
 *
 * **The gate.** No CallPro endpoint, authentication scheme, IP allowlist,
 * callback signature, segment-billing rule or production credential is
 * approved, and none may be invented (doc 14 §5.6). The production adapter is
 * therefore disabled and answers `DISABLED` behind `EXT-05`; local, CI and test
 * get the deterministic simulator below.
 */

/** One recipient of one job. The phone is an approved, verified official number. */
export interface SmsRecipient {
  /** Opaque reference to the recipient row. Never a person's name. */
  readonly recipientRef: string;
  readonly phone: string;
}

export interface SmsMessage {
  /**
   * The job this send belongs to, stable across retries, so a provider and a
   * simulator both recognise a repeat rather than sending twice.
   */
  readonly jobId: string;
  readonly recipients: readonly SmsRecipient[];
  /** The body, in full. Held for the duration of this call and not stored. */
  readonly body: string;
}

export interface SmsDelivery {
  /** One provider message id per recipient, in the order they were given. */
  readonly messages: readonly {
    readonly recipientRef: string;
    readonly providerMessageId: string;
  }[];
}

export type SmsStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED' | 'UNKNOWN';

export interface SmsPort extends Port<SmsMessage, SmsDelivery> {
  send(message: SmsMessage, ctx: PortContext): Promise<PortResult<SmsDelivery>>;
  /** The provider's own view of one message. */
  queryStatus(
    providerMessageId: string,
    ctx: PortContext,
  ): Promise<PortResult<{ status: SmsStatus }>>;
  /**
   * Whether a delivery-status callback really came from the provider.
   *
   * The signature scheme is not approved, so no adapter may accept one yet:
   * this exists to keep the shape of the eventual verification in the contract
   * rather than to let an unverified payload through.
   */
  verifyCallback(
    payload: unknown,
    ctx: PortContext,
  ): Promise<PortResult<{ providerMessageId: string; status: SmsStatus }>>;
}

const DISABLED = { kind: 'DISABLED', gate: 'EXT-05' } as const;

/** The production path until CallPro is contracted: `DISABLED`, and nothing sent. */
export class UnavailableSms implements SmsPort {
  readonly id = 'sms';
  readonly mode: PortMode = 'adapter';

  send(_message: SmsMessage, _ctx: PortContext): Promise<PortResult<SmsDelivery>> {
    return Promise.resolve(fail(DISABLED));
  }

  queryStatus(
    _providerMessageId: string,
    _ctx: PortContext,
  ): Promise<PortResult<{ status: SmsStatus }>> {
    return Promise.resolve(fail(DISABLED));
  }

  verifyCallback(
    _payload: unknown,
    _ctx: PortContext,
  ): Promise<PortResult<{ providerMessageId: string; status: SmsStatus }>> {
    return Promise.resolve(fail(DISABLED));
  }

  execute(message: SmsMessage, ctx: PortContext): Promise<PortResult<SmsDelivery>> {
    return this.send(message, ctx);
  }
}

/**
 * A deterministic simulator for local, CI and test use.
 *
 * It keeps what was sent so a test can assert the one thing doc 13 §10.2 makes
 * a rule — that the body carries the registration number and carries no name,
 * no hotel, no room and no case detail — without a provider and without a
 * network. Statuses advance only when a test advances them, so a delivery
 * callback is something a test performs rather than something that happens.
 */
export class SimulatedSms implements SmsPort {
  readonly id = 'sms';
  readonly mode: PortMode = 'simulator';

  private readonly jobs = new Map<string, SmsDelivery>();
  private readonly sent: { readonly message: SmsMessage; readonly providerMessageIds: string[] }[] =
    [];
  private readonly statuses = new Map<string, SmsStatus>();
  private failures = 0;
  private sequence = 0;

  /** Arms the next `times` sends to fail before recording anything. */
  failNext(times = 1): void {
    this.failures += times;
  }

  send(message: SmsMessage, _ctx?: PortContext): Promise<PortResult<SmsDelivery>> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.resolve(fail({ kind: 'UNAVAILABLE', retryable: true }));
    }
    // A repeat of a known job is not a second visible message.
    const existing = this.jobs.get(message.jobId);
    if (existing !== undefined) return Promise.resolve(ok(existing));
    const messages = message.recipients.map((recipient) => {
      this.sequence += 1;
      const providerMessageId = `sim-sms-${String(this.sequence).padStart(4, '0')}`;
      this.statuses.set(providerMessageId, 'SENT');
      return { recipientRef: recipient.recipientRef, providerMessageId };
    });
    const delivery: SmsDelivery = { messages };
    this.jobs.set(message.jobId, delivery);
    this.sent.push({ message, providerMessageIds: messages.map((one) => one.providerMessageId) });
    return Promise.resolve(ok(delivery));
  }

  queryStatus(
    providerMessageId: string,
    _ctx?: PortContext,
  ): Promise<PortResult<{ status: SmsStatus }>> {
    const status = this.statuses.get(providerMessageId);
    if (status === undefined) {
      return Promise.resolve(fail({ kind: 'REJECTED', providerCode: 'UnknownMessage' }));
    }
    return Promise.resolve(ok({ status }));
  }

  verifyCallback(
    payload: unknown,
    _ctx?: PortContext,
  ): Promise<PortResult<{ providerMessageId: string; status: SmsStatus }>> {
    const body = payload as { providerMessageId?: unknown; status?: unknown } | null;
    const id = typeof body?.providerMessageId === 'string' ? body.providerMessageId : undefined;
    const status = typeof body?.status === 'string' ? (body.status as SmsStatus) : undefined;
    if (id === undefined || status === undefined || !this.statuses.has(id)) {
      return Promise.resolve(fail({ kind: 'REJECTED', providerCode: 'UnverifiedCallback' }));
    }
    this.statuses.set(id, status);
    return Promise.resolve(ok({ providerMessageId: id, status }));
  }

  execute(message: SmsMessage, ctx?: PortContext): Promise<PortResult<SmsDelivery>> {
    return this.send(message, ctx);
  }

  /** Every message sent, in order, as a test needs to read them. */
  get deliveries(): readonly SmsMessage[] {
    return this.sent.map((entry) => entry.message);
  }

  /** The most recent body sent to a phone, as its recipient would read it. */
  bodyFor(phone: string): string | undefined {
    for (let index = this.sent.length - 1; index >= 0; index -= 1) {
      const entry = this.sent[index];
      if (entry?.message.recipients.some((recipient) => recipient.phone === phone) === true) {
        return entry.message.body;
      }
    }
    return undefined;
  }

  get size(): number {
    return this.sent.length;
  }
}

export function selectSms(appEnv: string): SmsPort {
  return isNonProductionEnv(appEnv) ? new SimulatedSms() : new UnavailableSms();
}
