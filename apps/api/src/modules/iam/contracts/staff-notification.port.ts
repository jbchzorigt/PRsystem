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

  deliver(message: StaffNotification): Promise<void> {
    this.delivered.push(message);
    return Promise.resolve();
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

  lastResetFor(accountId: string): PasswordResetMessage | undefined {
    for (let index = this.delivered.length - 1; index >= 0; index -= 1) {
      const message = this.delivered[index];
      if (message?.kind === 'password_reset' && message.accountId === accountId) return message;
    }
    return undefined;
  }

  reset(): void {
    this.delivered.length = 0;
  }
}

const NON_PRODUCTION = new Set(['local', 'ci', 'test']);

export function selectStaffNotification(appEnv: string): StaffNotificationPort {
  if (NON_PRODUCTION.has(appEnv)) return new SimulatedStaffNotification();
  return new UnavailableStaffNotification();
}
