import type { Port, PortContext, PortMode, PortResult } from './port';
import { fail, isNonProductionEnv, ok } from './port';

/**
 * `INT-OTP-01` — `PhoneVerificationPort` (doc 15 §2.1;
 * docs/architecture/16-external-port-catalog.md §4).
 *
 * Doc 15 requires the citizen's or representative's phone to be OTP-verified
 * before an invoice exists. No OTP provider is contracted: **CallPro is EXT-05
 * and is an SMS *send* contract, not an OTP service**, so assuming it could
 * carry this would be inventing a capability nobody has approved.
 *
 * The port is deliberately reusable and deliberately narrow. Phase 12 owns
 * Guest registration and authentication and will take this port rather than a
 * second one. The code itself never reaches storage: the caller mints it,
 * stores only a purpose- and subject-bound keyed digest, and hands the
 * plaintext here for the length of the delivery call (CLAUDE.md §8).
 */

export interface OtpMessage {
  /** The application or subject this challenge belongs to. Never a person's name. */
  readonly subjectRef: string;
  readonly phone: string;
  readonly expiresAt: Date;
  /** Stable across retries of one challenge, so a provider recognises a repeat. */
  readonly deliveryId: string;
  /** The plaintext code. Held only for the duration of this call. */
  readonly code: string;
}

export interface OtpDelivery {
  readonly providerMessageId: string;
}

export interface PhoneVerificationPort extends Port<OtpMessage, OtpDelivery> {
  send(message: OtpMessage, ctx: PortContext): Promise<PortResult<OtpDelivery>>;
}

/** The production path until an OTP provider is contracted: `DISABLED`. */
export class UnavailablePhoneVerification implements PhoneVerificationPort {
  readonly id = 'phone-otp';
  readonly mode: PortMode = 'adapter';

  send(_message: OtpMessage, _ctx: PortContext): Promise<PortResult<OtpDelivery>> {
    return Promise.resolve(fail({ kind: 'DISABLED', gate: 'INT-OTP-01' }));
  }

  execute(message: OtpMessage, ctx: PortContext): Promise<PortResult<OtpDelivery>> {
    return this.send(message, ctx);
  }
}

/**
 * A deterministic simulator for local, CI and test use.
 *
 * It records what was sent so a test can complete the flow the way a recipient
 * would — by reading the code off the message — rather than reaching into the
 * database for a value the database deliberately does not hold.
 */
export class SimulatedPhoneVerification implements PhoneVerificationPort {
  readonly id = 'phone-otp';
  readonly mode: PortMode = 'simulator';

  private readonly messages: OtpMessage[] = [];
  private readonly sent = new Map<string, string>();
  private failures = 0;

  /** Arms the next `times` sends to fail before recording anything. */
  failNext(times = 1): void {
    this.failures += times;
  }

  send(message: OtpMessage, _ctx?: PortContext): Promise<PortResult<OtpDelivery>> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.resolve(fail({ kind: 'UNAVAILABLE', retryable: true }));
    }
    // A repeat of a known delivery is not a second visible message.
    const existing = this.sent.get(message.deliveryId);
    if (existing !== undefined) return Promise.resolve(ok({ providerMessageId: existing }));
    const providerMessageId = `sim-sms-${String(this.messages.length + 1)}`;
    this.sent.set(message.deliveryId, providerMessageId);
    this.messages.push(message);
    return Promise.resolve(ok({ providerMessageId }));
  }

  execute(message: OtpMessage, ctx?: PortContext): Promise<PortResult<OtpDelivery>> {
    return this.send(message, ctx);
  }

  /** The most recent code for a subject, as its recipient would read it. */
  codeFor(subjectRef: string): string | undefined {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message !== undefined && message.subjectRef === subjectRef) return message.code;
    }
    return undefined;
  }

  get deliveries(): readonly OtpMessage[] {
    return this.messages;
  }
}

export function selectPhoneVerification(appEnv: string): PhoneVerificationPort {
  return isNonProductionEnv(appEnv)
    ? new SimulatedPhoneVerification()
    : new UnavailablePhoneVerification();
}
