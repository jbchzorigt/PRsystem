/**
 * Staff email delivery (CLAUDE.md §9, doc 19 §4 and §6).
 *
 * No email provider is contracted, so there is no production adapter: the
 * typed port and a deterministic simulator exist, the production path fails
 * closed, and `INT-MAIL-01` records the blocker.
 *
 * The one-time secret reaches this port and nothing else. It is never stored,
 * never logged, never returned to the inviter, and never placed in the outbox
 * payload — the durable intent carries only the identifiers a delivery needs to
 * be reconstructed and audited.
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
   * sent this message and not send a second visible copy. It is minted with the
   * reset it belongs to and never changes.
   */
  readonly deliveryId: string;
  readonly accountId: string;
  readonly resetId: string;
  readonly emailNormalized: string;
  readonly expiresAt: Date;
  readonly token: string;
}

export type StaffNotification = StaffInvitationMessage | PasswordResetMessage;

export interface StaffNotificationPort {
  deliver(message: StaffNotification): Promise<void>;
}

export class StaffNotificationUnavailableError extends Error {
  override readonly name = 'StaffNotificationUnavailableError';

  constructor() {
    super('no staff email adapter is configured (INT-MAIL-01 is not cleared)');
  }
}

/**
 * The production path: refuse.
 *
 * A command that cannot deliver its one-time link has not completed, so the
 * refusal aborts the transaction and no invitation or reset exists. That is the
 * fail-closed behaviour CLAUDE.md §9 requires of an ungated external system.
 */
export class UnavailableStaffNotification implements StaffNotificationPort {
  deliver(): Promise<void> {
    return Promise.reject(new StaffNotificationUnavailableError());
  }
}

/**
 * A deterministic simulator for local, CI and test use.
 *
 * It keeps the most recent message per subject so a test can complete the flow
 * the way a recipient would — by opening the link — instead of reaching into
 * the database for a value the database deliberately does not hold.
 */
export class SimulatedStaffNotification implements StaffNotificationPort {
  private readonly delivered: StaffNotification[] = [];
  private readonly attempted: PasswordResetMessage[] = [];
  private readonly sent = new Set<string>();
  private failures = 0;
  private blocked: Promise<void> | undefined;

  /**
   * Makes the next delivery fail.
   *
   * Exists so a test can show that an unreachable provider changes nothing a
   * caller can observe on the self-service reset path — the surface must not
   * become an account oracle by way of an error body.
   */
  failNext(times = 1): void {
    this.failures += times;
  }

  /**
   * Holds every delivery open until the returned function is called.
   *
   * A slow provider is the sharpest test of a boundary that claims not to wait
   * for one: if the public reset path still delivered synchronously, a request
   * for a *known* address could not return while this is held, and a request for
   * an unknown one could — which is the timing oracle in its purest form.
   */
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

  async deliver(message: StaffNotification): Promise<void> {
    if (this.blocked !== undefined) await this.blocked;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new StaffNotificationUnavailableError();
    }
    // A retry of a delivery this provider has already made is acknowledged and
    // not repeated. That is what makes "at least once" safe to build on: the
    // sender may lose an acknowledgement and try again, and the recipient still
    // sees one message.
    if (message.kind === 'password_reset') {
      this.attempted.push(message);
      if (this.sent.has(message.deliveryId)) return;
      this.sent.add(message.deliveryId);
    }
    this.delivered.push(message);
  }

  /** How many messages a recipient actually saw, ignoring accepted retries. */
  visibleCount(): number {
    return this.delivered.filter((message) => message.kind === 'password_reset').length;
  }

  /** Every attempt, including the ones this provider recognised as retries. */
  attempts(): readonly PasswordResetMessage[] {
    return [...this.attempted];
  }

  /** Every message delivered so far, oldest first. */
  all(): readonly StaffNotification[] {
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

  reset(): void {
    this.delivered.length = 0;
    this.attempted.length = 0;
    this.sent.clear();
    this.failures = 0;
    this.blocked = undefined;
  }
}

const NON_PRODUCTION = new Set(['local', 'ci', 'test']);

export function selectStaffNotification(appEnv: string): StaffNotificationPort {
  if (NON_PRODUCTION.has(appEnv)) return new SimulatedStaffNotification();
  return new UnavailableStaffNotification();
}
