/**
 * Phone one-time-password delivery (doc 15 §2.1).
 *
 * Doc 15 requires the citizen's or representative's phone to be OTP-verified
 * before an invoice exists. No OTP provider is contracted: **CallPro is EXT-05
 * and is an SMS *send* contract, not an OTP service**, so assuming it could
 * carry this would be inventing a capability nobody has approved. The blocker is
 * recorded as its own internal control, `INT-OTP-01`.
 *
 * This port is deliberately reusable and deliberately narrow. Phase 12 owns
 * Guest registration and Guest authentication and will need phone verification
 * of its own; what moves forward to Phase 05 is the port and its simulator, not
 * either of those flows.
 *
 * The code itself never reaches this file's storage. The service mints it,
 * stores only a purpose- and subject-bound keyed digest, and hands the plaintext
 * to the port for the length of the delivery call (CLAUDE.md §8).
 */

export interface OtpMessage {
  /** The application this challenge belongs to. Never a person's name. */
  readonly subjectRef: string;
  readonly phone: string;
  readonly expiresAt: Date;
  /**
   * Stable across retries of the same challenge, so a provider that already
   * sent this message can recognise it rather than sending a second copy.
   */
  readonly deliveryId: string;
  /** The plaintext code. Held only for the duration of this call. */
  readonly code: string;
}

export interface PhoneVerificationPort {
  send(message: OtpMessage): Promise<void>;
}

export class PhoneVerificationUnavailableError extends Error {
  override readonly name = 'PhoneVerificationUnavailableError';

  constructor() {
    super('no phone OTP adapter is configured (INT-OTP-01 is not cleared)');
  }
}

/**
 * The production path: refuse.
 *
 * doc 15 §2.1 makes the verified phone a precondition of the invoice, so an
 * unverifiable phone must stop the flow rather than be waved through. Failing
 * closed here is what makes that true outside local, CI and test.
 */
export class UnavailablePhoneVerification implements PhoneVerificationPort {
  send(): Promise<void> {
    return Promise.reject(new PhoneVerificationUnavailableError());
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
  private readonly messages: OtpMessage[] = [];
  private readonly sent = new Set<string>();
  private failures = 0;

  /** Arms the next `times` sends to fail before recording anything. */
  failNext(times = 1): void {
    this.failures += times;
  }

  send(message: OtpMessage): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error('simulated OTP delivery failure'));
    }
    // A repeat of a known delivery is not a second visible message.
    if (this.sent.has(message.deliveryId)) return Promise.resolve();
    this.sent.add(message.deliveryId);
    this.messages.push(message);
    return Promise.resolve();
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

const NON_PRODUCTION = new Set(['local', 'ci', 'test']);

export function selectPhoneVerification(appEnv: string): PhoneVerificationPort {
  if (NON_PRODUCTION.has(appEnv)) return new SimulatedPhoneVerification();
  return new UnavailablePhoneVerification();
}
