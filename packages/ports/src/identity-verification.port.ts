import type { Port, PortContext, PortMode, PortResult } from './port';
import { fail, isNonProductionEnv, ok } from './port';

/**
 * `EXT-01` — `XypIdentityPort` (doc 02 §3.1, doc 13 §6.2;
 * docs/architecture/16-external-port-catalog.md §1;
 * docs/implementation/external-integration-gates.md).
 *
 * XYP / ХУР answers a structurally valid, normalized Mongolian registration
 * number with the citizen's name and date of birth. No contract, field list,
 * consent basis or network access exists, so the production adapter answers
 * `DISABLED` and the record is `MANUAL` provenance — never presented as
 * verified (`RC-DEC-007`). The simulator is deterministic and synthetic: it
 * knows only the registration numbers a test tells it about.
 *
 * The registration number is held only for the length of the call; nothing
 * here logs it, and the caller stores it encrypted (CLAUDE.md §8).
 */

export interface XypLookup {
  /** Normalized, structurally valid `MN_REG_NO`. */
  readonly registrationNumber: string;
  /** Stable across retries of one check-in attempt. */
  readonly requestRef: string;
}

export interface XypCitizen {
  readonly familyName: string;
  readonly givenName: string;
  /** ISO date, `YYYY-MM-DD`. */
  readonly dateOfBirth: string;
}

export type XypAnswer =
  { readonly found: true; readonly citizen: XypCitizen } | { readonly found: false };

export interface XypIdentityPort extends Port<XypLookup, XypAnswer> {
  lookupByRegistrationNumber(lookup: XypLookup, ctx: PortContext): Promise<PortResult<XypAnswer>>;
}

/** The production path until EXT-01 is cleared: `DISABLED`, and `MANUAL` follows. */
export class UnavailableXypIdentity implements XypIdentityPort {
  readonly id = 'xyp-identity';
  readonly mode: PortMode = 'adapter';

  lookupByRegistrationNumber(
    _lookup: XypLookup,
    _ctx: PortContext,
  ): Promise<PortResult<XypAnswer>> {
    return Promise.resolve(fail({ kind: 'DISABLED', gate: 'EXT-01' }));
  }

  execute(lookup: XypLookup, ctx: PortContext): Promise<PortResult<XypAnswer>> {
    return this.lookupByRegistrationNumber(lookup, ctx);
  }
}

/**
 * A deterministic simulator: found, not found, unavailable and timeout, each
 * chosen by the test rather than by chance, with synthetic identities only.
 */
export class SimulatedXypIdentity implements XypIdentityPort {
  readonly id = 'xyp-identity';
  readonly mode: PortMode = 'simulator';

  private readonly citizens = new Map<string, XypCitizen>();
  private readonly lookups: XypLookup[] = [];
  private outages = 0;
  private timeouts = 0;

  /** Teaches the simulator one synthetic citizen. */
  register(registrationNumber: string, citizen: XypCitizen): void {
    this.citizens.set(registrationNumber, citizen);
  }

  /** Arms the next `times` lookups to answer UNAVAILABLE. */
  failNext(times = 1): void {
    this.outages += times;
  }

  /** Arms the next `times` lookups to answer TIMEOUT. */
  timeoutNext(times = 1): void {
    this.timeouts += times;
  }

  lookupByRegistrationNumber(
    lookup: XypLookup,
    _ctx?: PortContext,
  ): Promise<PortResult<XypAnswer>> {
    this.lookups.push(lookup);
    if (this.outages > 0) {
      this.outages -= 1;
      return Promise.resolve(fail({ kind: 'UNAVAILABLE', retryable: true }));
    }
    if (this.timeouts > 0) {
      this.timeouts -= 1;
      return Promise.resolve(fail({ kind: 'TIMEOUT', retryable: true }));
    }
    const citizen = this.citizens.get(lookup.registrationNumber);
    return Promise.resolve(ok(citizen === undefined ? { found: false } : { found: true, citizen }));
  }

  execute(lookup: XypLookup, ctx?: PortContext): Promise<PortResult<XypAnswer>> {
    return this.lookupByRegistrationNumber(lookup, ctx);
  }

  /** How many lookups were made, for a test that asserts one per attempt. */
  get lookupCount(): number {
    return this.lookups.length;
  }
}

export function selectXypIdentity(appEnv: string): XypIdentityPort {
  return isNonProductionEnv(appEnv) ? new SimulatedXypIdentity() : new UnavailableXypIdentity();
}
