import type { Port, PortContext, PortMode, PortResult } from './port';
import { fail, isNonProductionEnv, ok } from './port';

/**
 * `INT-MAIL-01` — the email delivery port (CLAUDE.md §9, doc 19 §4 and §6,
 * doc 16 §4.1; docs/architecture/16-external-port-catalog.md `EmailPort`).
 *
 * No email provider is contracted, so there is no production adapter: the
 * typed port and a deterministic simulator exist, the production path fails
 * closed, and `INT-MAIL-01` records the blocker.
 *
 * Bodies are server-side templates: every message is a typed *kind* with the
 * model that template needs, never free text. A one-time secret reaches this
 * port and nothing else — it is never stored, never logged, never returned to
 * the inviter, and never placed in an outbox payload. The durable intent
 * carries only the identifiers a delivery needs to be reconstructed and
 * audited.
 *
 * Two surfaces, deliberately. `send` is the catalog contract — a typed result,
 * never a throw. `deliver` is the Phase 04 shape its accepted callers were
 * written against and stays exactly as it was: it throws
 * `StaffNotificationUnavailableError` where `send` would answer an error.
 */

export interface StaffInvitationMessage {
  readonly kind: 'staff_invitation';
  readonly hotelId: string;
  readonly invitationId: string;
  readonly emailNormalized: string;
  readonly expiresAt: Date;
  /** The plaintext token. Held only for the duration of the delivery call. */
  readonly token: string;
}

export interface PasswordResetMessage {
  readonly kind: 'password_reset';
  /**
   * The stable identity of this delivery.
   *
   * A retry after a lost acknowledgement carries the same value, so a provider —
   * and the simulator standing in for one — can recognise that it has already
   * sent this message and not send a second visible copy.
   */
  readonly deliveryId: string;
  readonly accountId: string;
  readonly resetId: string;
  readonly emailNormalized: string;
  readonly expiresAt: Date;
  readonly token: string;
}

/**
 * doc 16 §4.1 step 7: the receipt, sent only after it officially exists.
 *
 * The template's model is the receipt itself — its number and its QR or link
 * data — plus the identifiers an audit needs. Nothing in it is a secret: a
 * receipt number is the reference a taxpayer quotes.
 */
export interface EBarimtReceiptMessage {
  readonly kind: 'ebarimt_receipt';
  readonly deliveryId: string;
  readonly hotelId: string;
  readonly paymentId: string;
  readonly emailNormalized: string;
  readonly receiptNumber: string;
  readonly receiptQr: string;
  /** Whole MNT, as a string so the model survives serialisation unchanged. */
  readonly totalMnt: string;
  readonly issuedAt: Date;
}

/**
 * doc 15 §3.1 proof (2), when the owner's stored verified channel is an email:
 * the challenge code, held only for the duration of the delivery call.
 */
export interface OwnerChallengeMessage {
  readonly kind: 'owner_challenge';
  readonly deliveryId: string;
  /** The application the challenge belongs to. Never a person's name. */
  readonly subjectRef: string;
  readonly emailNormalized: string;
  readonly expiresAt: Date;
  readonly code: string;
}

export type NotificationMessage =
  StaffInvitationMessage | PasswordResetMessage | EBarimtReceiptMessage | OwnerChallengeMessage;
/** The Phase 04 name for the same union. */
export type StaffNotification = NotificationMessage;

export interface NotificationDelivery {
  readonly providerMessageId: string;
}

export interface NotificationPort extends Port<NotificationMessage, NotificationDelivery> {
  send(message: NotificationMessage, ctx?: PortContext): Promise<PortResult<NotificationDelivery>>;
  /** The Phase 04 surface: resolves on delivery, throws on refusal. */
  deliver(message: NotificationMessage): Promise<void>;
}

/** The Phase 04 name for the port. */
export type StaffNotificationPort = NotificationPort;

export class StaffNotificationUnavailableError extends Error {
  override readonly name = 'StaffNotificationUnavailableError';

  constructor() {
    super('no staff email adapter is configured (INT-MAIL-01 is not cleared)');
  }
}

const NO_CONTEXT: PortContext = { correlationId: 'unattributed' };

abstract class NotificationBase implements NotificationPort {
  readonly id = 'email';
  abstract readonly mode: PortMode;

  abstract send(
    message: NotificationMessage,
    ctx?: PortContext,
  ): Promise<PortResult<NotificationDelivery>>;

  execute(
    message: NotificationMessage,
    ctx: PortContext,
  ): Promise<PortResult<NotificationDelivery>> {
    return this.send(message, ctx);
  }

  async deliver(message: NotificationMessage): Promise<void> {
    const result = await this.send(message, NO_CONTEXT);
    if (!result.ok) throw new StaffNotificationUnavailableError();
  }
}

/**
 * The production path: refuse.
 *
 * A command that cannot deliver its one-time link has not completed, so the
 * refusal aborts the transaction and no invitation or reset exists. That is the
 * fail-closed behaviour CLAUDE.md §9 requires of an ungated external system.
 */
export class UnavailableNotification extends NotificationBase {
  readonly mode: PortMode = 'adapter';

  send(
    _message: NotificationMessage,
    _ctx?: PortContext,
  ): Promise<PortResult<NotificationDelivery>> {
    return Promise.resolve(fail({ kind: 'DISABLED', gate: 'INT-MAIL-01' }));
  }
}

/** The Phase 04 name. */
export class UnavailableStaffNotification extends UnavailableNotification {}

/**
 * A deterministic simulator for local, CI and test use.
 *
 * It keeps every message so a test can complete the flow the way a recipient
 * would — by opening the link, or reading the receipt — instead of reaching
 * into the database for a value the database deliberately does not hold.
 */
export class SimulatedNotification extends NotificationBase {
  readonly mode: PortMode = 'simulator';

  private readonly delivered: NotificationMessage[] = [];
  private readonly attempted: PasswordResetMessage[] = [];
  private readonly sent = new Map<string, string>();
  private failures = 0;
  private lostAcknowledgements = 0;
  private blocked: Promise<void> | undefined;

  /** Makes the next delivery fail. */
  failNext(times = 1): void {
    this.failures += times;
  }

  /**
   * Accepts and records the next delivery, then reports failure.
   *
   * The failure mode a retrying sender must survive: the provider *did* send
   * the message and the acknowledgement was lost on the way back. A sender that
   * treats this as "not sent" and mints a fresh link sends the recipient two.
   */
  failAcknowledgementNext(times = 1): void {
    this.lostAcknowledgements += times;
  }

  /** Holds every delivery open until the returned function is called. */
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

  async send(
    message: NotificationMessage,
    _ctx?: PortContext,
  ): Promise<PortResult<NotificationDelivery>> {
    if (this.blocked !== undefined) await this.blocked;
    if (this.failures > 0) {
      this.failures -= 1;
      return fail({ kind: 'UNAVAILABLE', retryable: true });
    }
    // A retry of a delivery this provider has already made is acknowledged and
    // not repeated. That is what makes "at least once" safe to build on.
    if (message.kind !== 'staff_invitation') {
      if (message.kind === 'password_reset') this.attempted.push(message);
      const existing = this.sent.get(message.deliveryId);
      if (existing !== undefined) {
        if (this.lostAcknowledgements > 0) {
          this.lostAcknowledgements -= 1;
          return fail({ kind: 'TIMEOUT', retryable: true });
        }
        return ok({ providerMessageId: existing });
      }
      const providerMessageId = `sim-mail-${String(this.delivered.length + 1)}`;
      this.sent.set(message.deliveryId, providerMessageId);
      this.delivered.push(message);
      if (this.lostAcknowledgements > 0) {
        this.lostAcknowledgements -= 1;
        return fail({ kind: 'TIMEOUT', retryable: true });
      }
      return ok({ providerMessageId });
    }
    this.delivered.push(message);
    return ok({ providerMessageId: `sim-mail-${String(this.delivered.length)}` });
  }

  /** How many reset messages a recipient actually saw, ignoring accepted retries. */
  visibleCount(): number {
    return this.delivered.filter((message) => message.kind === 'password_reset').length;
  }

  /** Every reset attempt, including the ones this provider recognised as retries. */
  attempts(): readonly PasswordResetMessage[] {
    return [...this.attempted];
  }

  /** Every message delivered so far, oldest first. */
  all(): readonly NotificationMessage[] {
    return [...this.delivered];
  }

  lastInvitationFor(emailNormalized: string): StaffInvitationMessage | undefined {
    for (let index = this.delivered.length - 1; index >= 0; index -= 1) {
      const message = this.delivered[index];
      if (message?.kind === 'staff_invitation' && message.emailNormalized === emailNormalized) {
        return message;
      }
    }
    return undefined;
  }

  lastResetForEmail(emailNormalized: string): PasswordResetMessage | undefined {
    for (let index = this.delivered.length - 1; index >= 0; index -= 1) {
      const message = this.delivered[index];
      if (message?.kind === 'password_reset' && message.emailNormalized === emailNormalized) {
        return message;
      }
    }
    return undefined;
  }

  lastResetFor(accountId: string): PasswordResetMessage | undefined {
    for (let index = this.delivered.length - 1; index >= 0; index -= 1) {
      const message = this.delivered[index];
      if (message?.kind === 'password_reset' && message.accountId === accountId) return message;
    }
    return undefined;
  }

  lastChallengeFor(subjectRef: string): OwnerChallengeMessage | undefined {
    for (let index = this.delivered.length - 1; index >= 0; index -= 1) {
      const message = this.delivered[index];
      if (message?.kind === 'owner_challenge' && message.subjectRef === subjectRef) return message;
    }
    return undefined;
  }

  lastReceiptFor(emailNormalized: string): EBarimtReceiptMessage | undefined {
    for (let index = this.delivered.length - 1; index >= 0; index -= 1) {
      const message = this.delivered[index];
      if (message?.kind === 'ebarimt_receipt' && message.emailNormalized === emailNormalized) {
        return message;
      }
    }
    return undefined;
  }

  reset(): void {
    this.delivered.length = 0;
    this.attempted.length = 0;
    this.sent.clear();
    this.failures = 0;
    this.lostAcknowledgements = 0;
    this.blocked = undefined;
  }
}

/** The Phase 04 name. */
export class SimulatedStaffNotification extends SimulatedNotification {}

export function selectNotification(appEnv: string): NotificationPort {
  return isNonProductionEnv(appEnv) ? new SimulatedNotification() : new UnavailableNotification();
}

/** The Phase 04 name. */
export function selectStaffNotification(appEnv: string): NotificationPort {
  return isNonProductionEnv(appEnv)
    ? new SimulatedStaffNotification()
    : new UnavailableStaffNotification();
}
