import type { UnitOfWork } from '@prsystem/db';

/**
 * What the guest registry needs from the module that owns a stay
 * (CLAUDE.md §3).
 *
 * doc 12 §3 defines one row as *one primary guest of one stay*, which is three
 * of the stay module's tables and one of the catalog's — the stay, its current
 * guest record, the room it used, and the latest approved actual-time
 * amendment. The reporting module never names any of them: it asks this
 * contract, and the stay module answers with the six approved columns and
 * nothing else.
 *
 * That is not only tidiness. doc 12 §5 lists exactly what a registry row may
 * carry, and the safest way to keep a registration number off the screen is for
 * the query that builds the row never to select one.
 */

export interface RegistryFilter {
  readonly hotelId: string;
  /** doc 12 §8: mandatory, and half-open on the effective check-in. */
  readonly from: Date;
  readonly to: Date;
  /** doc 12 §8: `ACTIVE` or `COMPLETED`, or both when unset. */
  readonly stayState?: 'ACTIVE' | 'COMPLETED';
  readonly roomId?: string;
  /** Case-insensitive partial match on family or given name. */
  readonly nameSearch?: string;
}

export interface RegistryRow {
  readonly stayId: string;
  readonly familyName: string;
  readonly givenName: string;
  /** `GUEST-DEC-003`: the snapshot taken at check-in, or `null` for unknown. */
  readonly ageAtCheckIn: number | null;
  readonly roomNumber: string;
  /** The latest approved effective actual check-in, or the original. */
  readonly effectiveCheckInAt: Date;
  /** doc 12 §5: planned for an active stay, actual for a completed one. */
  readonly periodEndAt: Date;
  readonly stayState: string;
}

export interface RegistryPage {
  readonly rows: readonly RegistryRow[];
  readonly totalRows: number;
}

export interface RegistryFactsPort {
  /** One page of the filtered result, and the total the page came from. */
  page(
    uow: UnitOfWork,
    filter: RegistryFilter,
    page: { readonly offset: number; readonly limit: number },
  ): Promise<RegistryPage>;

  /** The whole filtered result, for an export. Bounded by the caller's cap. */
  all(uow: UnitOfWork, filter: RegistryFilter, cap: number): Promise<readonly RegistryRow[]>;

  /** How many rows the filter selects, before a job is started at all. */
  count(uow: UnitOfWork, filter: RegistryFilter): Promise<number>;

  /**
   * `GUEST-DEC-008`: removes one stay's raw identity from product access.
   *
   * The stay module owns `stay_guest`, so the purge is its write. What survives
   * is the non-identifying reference a financial or audit event needs, which
   * doc 12 §9 keeps under its own retention policy.
   */
  anonymize(uow: UnitOfWork, stayId: string, at: Date): Promise<boolean>;
}

export class RegistryFactsUnavailableError extends Error {
  override readonly name = 'RegistryFactsUnavailableError';
  constructor() {
    super('platform.stay_guest exists but no registry implementation is registered');
  }
}

/**
 * The default when the stay module is not registered.
 *
 * `platform.stay_guest` has existed since Phase 08, so this refuses rather than
 * answering "no guests": a registry wired without its source would otherwise
 * show every hotel an empty list and look correct.
 */
export class UnprovisionedRegistryFacts implements RegistryFactsPort {
  async page(uow: UnitOfWork): Promise<RegistryPage> {
    await this.refuseIfProvisioned(uow);
    return { rows: [], totalRows: 0 };
  }

  async all(uow: UnitOfWork): Promise<readonly RegistryRow[]> {
    await this.refuseIfProvisioned(uow);
    return [];
  }

  async count(uow: UnitOfWork): Promise<number> {
    await this.refuseIfProvisioned(uow);
    return 0;
  }

  async anonymize(uow: UnitOfWork): Promise<boolean> {
    await this.refuseIfProvisioned(uow);
    return false;
  }

  private async refuseIfProvisioned(uow: UnitOfWork): Promise<void> {
    const result = await uow.query<{ present: boolean }>(
      `SELECT to_regclass('platform.stay_guest') IS NOT NULL AS present`,
    );
    if (result.rows[0]?.present === true) throw new RegistryFactsUnavailableError();
  }
}
