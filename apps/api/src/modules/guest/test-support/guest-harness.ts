import { SimulatedEMongoliaAuth, SimulatedPhoneVerification } from '@prsystem/ports';
import type { IamHarness } from '../../iam/test-support/iam-harness';
import { createIamHarness } from '../../iam/test-support/iam-harness';
import { AUTH_SECURITY_PARAMETERS } from '../../iam/contracts/security-parameters';
import { IamGuestAccounts } from '../../iam/contracts/guest-accounts.port';
import type { GuestDependencies, GuestParameters } from '../services/guest-context';
import { GUEST_PARAMETERS } from '../services/guest-context';
import { GuestRegistrationService } from '../services/registration.service';
import { GuestEMongoliaService } from '../services/emongolia.service';

/**
 * The Phase 12 Guest harness.
 *
 * Both external channels are the real simulators, reached by the same instance
 * the services hold — a test that read a code from a second simulator would be
 * asserting against a message the application never sent.
 *
 * The account kernel is the real `IamGuestAccounts`, over the same restricted
 * runtime login every command uses. Nothing here fabricates a session.
 */

export interface GuestHarness {
  readonly iam: IamHarness;
  readonly deps: GuestDependencies;
  readonly registrations: GuestRegistrationService;
  readonly providers: GuestEMongoliaService;
  readonly otp: SimulatedPhoneVerification;
  readonly emongolia: SimulatedEMongoliaAuth;
  readonly parameters: GuestParameters;
  /**
   * The server's now, as the services see it.
   *
   * Mutable on purpose: a resend interval and an expiry are configuration, and
   * a test that had to wait one out would either be slow or would be asserting
   * against a clock it does not control.
   */
  advance(seconds: number): void;
  /** The plaintext code the simulator last delivered for a challenge. */
  codeFor(verificationId: string): string | undefined;
  /** The live challenge id for a number and purpose, read as the superuser. */
  liveVerification(phone: string, purpose: string): Promise<string | undefined>;
  close(): Promise<void>;
}

export async function createGuestHarness(
  suite: string,
  parameters: GuestParameters = GUEST_PARAMETERS,
): Promise<GuestHarness> {
  const iam = await createIamHarness(suite);
  const otp = new SimulatedPhoneVerification();
  const emongolia = new SimulatedEMongoliaAuth();
  let offsetMs = 0;
  const deps: GuestDependencies = {
    pool: iam.api,
    keys: iam.deps.keys,
    accounts: new IamGuestAccounts(iam.deps.keys, AUTH_SECURITY_PARAMETERS),
    otp,
    emongolia,
    parameters,
    clock: () => new Date(Date.now() + offsetMs),
  };
  const registrations = new GuestRegistrationService(deps);
  return {
    iam,
    deps,
    registrations,
    providers: new GuestEMongoliaService(deps),
    otp,
    emongolia,
    parameters,
    advance: (seconds) => {
      offsetMs += seconds * 1000;
    },
    codeFor: (verificationId) => otp.codeFor(verificationId),
    async liveVerification(phone: string, purpose: string): Promise<string | undefined> {
      // The token, not the number: the test derives it the same way the service
      // does, which is also a check that nothing stored the digits.
      const token = await registrations.phoneToken(phone);
      const result = await iam.admin.query<{ verification_id: string }>(
        `SELECT verification_id FROM platform.guest_phone_verification
          WHERE phone_token = $1 AND purpose = $2 AND state = 'PENDING'`,
        [token.token, purpose],
      );
      return result.rows[0]?.verification_id;
    },
    close: () => iam.close(),
  };
}

/** A synthetic Mongolian mobile number, unique within a suite. */
export function syntheticPhone(n: number): string {
  return `+9769${String(n).padStart(7, '0')}`;
}

/** A synthetic passphrase, composed rather than written out. */
export const GUEST_TEST_PASSWORD = ['synthetic', 'guest', 'passphrase'].join('-');
