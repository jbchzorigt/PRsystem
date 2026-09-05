import type { Pool } from 'pg';
import type { EMongoliaAuthPort, KeyManagementPort, PhoneVerificationPort } from '@prsystem/ports';
import { newCorrelationId } from '@prsystem/contracts';
import type { TenantContext, UnitOfWork } from '@prsystem/db';
import { withTenantTransaction } from '@prsystem/db';
import { PLATFORM_SCOPE } from '@prsystem/db';
import type { GuestAccountsPort } from '../../iam/contracts/guest-accounts.port';

/**
 * The one transaction shape the guest module runs in (doc 09 §6).
 *
 * Every command here is account-global: a guest belongs to no hotel, so there
 * is no tenant to bind and no membership to gate. What replaces the hotel gate
 * is the realm itself — these endpoints are the Guest realm's front door, and
 * nothing they do can reach a hotel's rows, because the scope they run in
 * carries the platform sentinel and every tenant policy matches nothing there.
 *
 * Most of them are also unauthenticated by design: doc 09 §6 makes search and
 * registration public, and an authenticated guest command carries its account
 * from the verified session rather than from anything the caller sent.
 */

export interface GuestParameters {
  /** How long a one-time code stays usable. P1, doc 09 §6.2. */
  readonly otpTtlSeconds: number;
  /** The shortest interval between two codes to the same number and purpose. */
  readonly otpResendSeconds: number;
  /** Wrong guesses before the challenge locks. */
  readonly otpMaxAttempts: number;
  /** How long a dual-channel link request stays open (doc 09 §6.3). */
  readonly linkTtlSeconds: number;
}

/**
 * Provisional values, held here rather than scattered through the services.
 *
 * doc 09 §6.2 leaves the exact minutes, the resend interval and the attempt
 * count to a later decision. What is not provisional is that each exists, so
 * they are parameters with a default rather than constants in a branch.
 */
export const GUEST_PARAMETERS: GuestParameters = {
  otpTtlSeconds: 10 * 60,
  otpResendSeconds: 60,
  otpMaxAttempts: 5,
  linkTtlSeconds: 15 * 60,
};

export interface GuestDependencies {
  readonly pool: Pool;
  readonly keys: KeyManagementPort;
  /** The account kernel, through Phase 04's contract (CLAUDE.md §3). */
  readonly accounts: GuestAccountsPort;
  /** INT-OTP-01. Simulated outside production; never a real message in a test. */
  readonly otp: PhoneVerificationPort;
  /** EXT-02. Disabled outside local, CI and test. */
  readonly emongolia: EMongoliaAuthPort;
  readonly parameters?: GuestParameters;
  /** Tests only: the server's now. Production reads the transaction's time. */
  readonly clock?: () => Date;
}

export interface RequestContext {
  readonly correlationId: string;
  /** The authenticated guest, where there is one. Never taken from a body. */
  readonly accountId?: string;
}

export function newGuestRequest(accountId?: string): RequestContext {
  return {
    correlationId: newCorrelationId(),
    ...(accountId === undefined ? {} : { accountId }),
  };
}

/**
 * The account scope, exactly as Phase 04 binds it: the platform sentinel as the
 * hotel, so no tenant policy matches, and an opaque actor reference.
 */
export function guestScope(request: RequestContext): TenantContext {
  return {
    hotelId: PLATFORM_SCOPE,
    realm: 'guest',
    actorRef: request.accountId ?? 'anonymous',
    ...(request.accountId === undefined ? {} : { accountId: request.accountId }),
    correlationId: request.correlationId,
  };
}

export function sqlState(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export abstract class GuestServiceBase {
  protected constructor(protected readonly deps: GuestDependencies) {}

  protected get parameters(): GuestParameters {
    return this.deps.parameters ?? GUEST_PARAMETERS;
  }

  protected now(uow: UnitOfWork): Date {
    return this.deps.clock === undefined ? uow.serverNow : this.deps.clock();
  }

  protected inGuestScope<T>(
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.deps.pool, guestScope(request), work);
  }
}
