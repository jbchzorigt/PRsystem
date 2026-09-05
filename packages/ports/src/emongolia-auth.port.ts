import type { Port, PortContext, PortMode, PortResult } from './port';
import { fail, isNonProductionEnv, ok } from './port';

/**
 * `EXT-02` — `EMongoliaAuthPort` (doc 09 §6.1;
 * docs/architecture/16-external-port-catalog.md §1;
 * docs/implementation/external-integration-gates.md).
 *
 * e-Mongolia authenticates a person and returns a provider subject: a stable
 * identifier for *that provider's* account, not a person the platform has
 * already met. No contract, field list, consent basis, token lifecycle or
 * sandbox access exists, so the production adapter answers `DISABLED` without a
 * network call.
 *
 * Two rules the gate names hold here rather than in the caller:
 *
 * - the authorization code and the provider subject cross this boundary in the
 *   command and the result, never in a URL the port builds and never in
 *   anything it logs (CLAUDE.md §8);
 * - the port reports who the provider says it is. It never decides that two
 *   accounts are the same person — doc 09 §6.3 makes that a dual-channel
 *   confirmation the domain records.
 *
 * The minimal claims are exactly what doc 09 §6.1 allows a listing account to
 * hold: a display name, and whether the provider considers the identity
 * verified. No registration number, address or document number is accepted
 * here; the check-in identity path is `EXT-01`, a different gate.
 */

export interface EMongoliaBeginCommand {
  /** Where the provider returns the person; validated by the caller. */
  readonly redirectUri: string;
  /** Single-use, bound to the browser session, replayed back on completion. */
  readonly state: string;
}

export interface EMongoliaAuthorization {
  /** The provider's authorization URL. Carries no platform token. */
  readonly authorizationUrl: string;
  readonly state: string;
}

export interface EMongoliaCompleteCommand {
  /** The provider's one-time authorization code. Never logged, never stored. */
  readonly code: string;
  readonly state: string;
  readonly redirectUri: string;
}

export interface EMongoliaMinimalClaims {
  /** A display name only; absent when the provider releases none. */
  readonly displayName?: string;
  /** Whether the provider asserts it verified the identity. */
  readonly verified: boolean;
}

export interface EMongoliaIdentity {
  /**
   * The provider's stable subject. The caller stores only a keyed token of it
   * (`lookup.guest_identity_subject`), never this value.
   */
  readonly providerSubject: string;
  readonly claims: EMongoliaMinimalClaims;
}

export type EMongoliaCommand =
  | ({ readonly step: 'begin' } & EMongoliaBeginCommand)
  | ({ readonly step: 'complete' } & EMongoliaCompleteCommand);

export type EMongoliaResult = EMongoliaAuthorization | EMongoliaIdentity;

export interface EMongoliaAuthPort extends Port<EMongoliaCommand, EMongoliaResult> {
  begin(
    command: EMongoliaBeginCommand,
    ctx: PortContext,
  ): Promise<PortResult<EMongoliaAuthorization>>;
  complete(
    command: EMongoliaCompleteCommand,
    ctx: PortContext,
  ): Promise<PortResult<EMongoliaIdentity>>;
}

/** The production path until EXT-02 clears: `DISABLED`, before any network call. */
export class UnavailableEMongoliaAuth implements EMongoliaAuthPort {
  readonly id = 'emongolia-auth';
  readonly mode: PortMode = 'adapter';

  begin(
    _command: EMongoliaBeginCommand,
    _ctx: PortContext,
  ): Promise<PortResult<EMongoliaAuthorization>> {
    return Promise.resolve(fail({ kind: 'DISABLED', gate: 'EXT-02' }));
  }

  complete(
    _command: EMongoliaCompleteCommand,
    _ctx: PortContext,
  ): Promise<PortResult<EMongoliaIdentity>> {
    return Promise.resolve(fail({ kind: 'DISABLED', gate: 'EXT-02' }));
  }

  execute(command: EMongoliaCommand, ctx: PortContext): Promise<PortResult<EMongoliaResult>> {
    return command.step === 'begin' ? this.begin(command, ctx) : this.complete(command, ctx);
  }
}

/**
 * A deterministic simulator. It knows only the synthetic identities a test
 * teaches it, it refuses a code it never issued, and it refuses a replayed
 * code — the provider's own single-use rule, so a caller that relies on it is
 * tested rather than trusted.
 */
export class SimulatedEMongoliaAuth implements EMongoliaAuthPort {
  readonly id = 'emongolia-auth';
  readonly mode: PortMode = 'simulator';

  private readonly identities = new Map<string, EMongoliaIdentity>();
  private readonly spent = new Set<string>();
  private outages = 0;
  private timeouts = 0;

  /** Teaches the simulator one synthetic identity, reachable by `code`. */
  register(code: string, identity: EMongoliaIdentity): void {
    this.identities.set(code, identity);
  }

  /** Arms the next `times` calls to answer UNAVAILABLE. */
  failNext(times = 1): void {
    this.outages += times;
  }

  /** Arms the next `times` calls to answer TIMEOUT. */
  timeoutNext(times = 1): void {
    this.timeouts += times;
  }

  private outage<T>(): PortResult<T> | undefined {
    if (this.outages > 0) {
      this.outages -= 1;
      return fail({ kind: 'UNAVAILABLE', retryable: true });
    }
    if (this.timeouts > 0) {
      this.timeouts -= 1;
      return fail({ kind: 'TIMEOUT', retryable: true });
    }
    return undefined;
  }

  begin(
    command: EMongoliaBeginCommand,
    _ctx?: PortContext,
  ): Promise<PortResult<EMongoliaAuthorization>> {
    const outage = this.outage<EMongoliaAuthorization>();
    if (outage !== undefined) return Promise.resolve(outage);
    // The simulated authorization URL carries the state the provider echoes
    // back and nothing else: no platform session, no token, no subject.
    return Promise.resolve(
      ok({
        authorizationUrl: `https://simulator.invalid/emongolia/authorize?state=${encodeURIComponent(command.state)}`,
        state: command.state,
      }),
    );
  }

  complete(
    command: EMongoliaCompleteCommand,
    _ctx?: PortContext,
  ): Promise<PortResult<EMongoliaIdentity>> {
    const outage = this.outage<EMongoliaIdentity>();
    if (outage !== undefined) return Promise.resolve(outage);
    if (this.spent.has(command.code)) {
      return Promise.resolve(fail({ kind: 'REJECTED', providerCode: 'code_already_used' }));
    }
    const identity = this.identities.get(command.code);
    if (identity === undefined) {
      return Promise.resolve(fail({ kind: 'REJECTED', providerCode: 'invalid_code' }));
    }
    this.spent.add(command.code);
    return Promise.resolve(ok(identity));
  }

  execute(command: EMongoliaCommand, ctx?: PortContext): Promise<PortResult<EMongoliaResult>> {
    return command.step === 'begin' ? this.begin(command, ctx) : this.complete(command, ctx);
  }
}

export function selectEMongoliaAuth(appEnv: string): EMongoliaAuthPort {
  return isNonProductionEnv(appEnv) ? new SimulatedEMongoliaAuth() : new UnavailableEMongoliaAuth();
}
