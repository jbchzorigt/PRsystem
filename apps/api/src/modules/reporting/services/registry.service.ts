import { ApiError } from '@prsystem/contracts';
import { recordPlatformAudit } from '@prsystem/db';
import type { RegistryFilter, RegistryRow } from '../contracts/registry-facts';
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_RETENTION_DAYS,
  defaultRange,
  firstRowNumber,
  isPageSize,
  normalizeSearch,
  rangeOfLocalDates,
  refuseRange,
  totalPages,
} from '../domain/reporting';
import type { CommandActor, RequestContext, ReportingDependencies } from './reporting-context';
import { REGISTRY_VIEW, ReportingServiceBase, hotelTimeZone } from './reporting-context';

/**
 * The guest registry list (doc 12 §§2–8, `GUEST-DEC-001`–`005`).
 *
 * Three properties this service is responsible for, and the reason each is
 * here rather than in the query.
 *
 * **The range is mandatory and bounded.** doc 12 §8 defaults it to the last
 * thirty hotel-local days and refuses anything longer than the retention
 * period. Refusing here means the query is never issued for a window the
 * retention policy says no longer exists.
 *
 * **The page size is one of three.** A client that asks for anything else is
 * refused rather than quietly served twenty — doc 12 §4 says the server does
 * not accept a size outside the list, and silently substituting one would make
 * the row numbers disagree with the page the caller thinks it asked for.
 *
 * **The row number is the position in the whole result.** doc 12 §5: `Дэс
 * дугаар` continues across pages and is never a database id.
 */

export interface RegistryQuery {
  readonly hotelId: string;
  /** `YYYY-MM-DD`, hotel-local. Absent means the last thirty days. */
  readonly from?: string;
  readonly to?: string;
  readonly stayState?: 'ACTIVE' | 'COMPLETED';
  readonly roomId?: string;
  readonly nameSearch?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface RegistryEntry {
  readonly rowNumber: number;
  readonly familyName: string;
  readonly givenName: string;
  /** `GUEST-DEC-003`: `null` is `Тодорхойгүй`, never a guess. */
  readonly age: number | null;
  readonly roomNumber: string;
  readonly periodStartAt: Date;
  readonly periodEndAt: Date;
  readonly stayState: string;
}

export interface RegistryResult {
  readonly rows: readonly RegistryEntry[];
  readonly totalRows: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
  readonly appliedFilter: {
    readonly from: Date;
    readonly to: Date;
    readonly stayState?: 'ACTIVE' | 'COMPLETED';
    readonly roomId?: string;
    readonly nameSearch?: string;
  };
}

export class GuestRegistryService extends ReportingServiceBase {
  constructor(deps: ReportingDependencies) {
    super(deps);
  }

  async list(
    query: RegistryQuery,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<RegistryResult> {
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!isPageSize(pageSize)) {
      throw new ApiError('VALIDATION_FAILED', 'pageSize must be 20, 50 or 100');
    }
    const page = query.page ?? 1;
    if (!Number.isInteger(page) || page < 1) {
      throw new ApiError('VALIDATION_FAILED', 'page must be a whole number from 1');
    }

    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: query.hotelId },
      REGISTRY_VIEW,
      request,
      async (uow, gate, authorize) => {
        await authorize();
        const timeZone = await hotelTimeZone(uow);
        const filter = this.resolveFilter(query, timeZone, this.now(uow));
        const found = await this.deps.registry.page(uow, filter, {
          offset: (page - 1) * pageSize,
          limit: pageSize,
        });
        // doc 12 §9: a registry read is audited. The filter is recorded; the
        // guests it returned are not, because an audit payload holding a guest
        // list would be a second copy of the thing being protected.
        await recordPlatformAudit(uow, {
          action: 'registry.listed',
          outcome: 'allowed',
          targetType: 'hotel',
          targetRef: query.hotelId,
          payload: {
            from: filter.from.toISOString(),
            to: filter.to.toISOString(),
            page,
            pageSize,
            rows: found.rows.length,
            by: gate.principal.accountId,
          },
        });
        const start = firstRowNumber(page, pageSize);
        return {
          rows: found.rows.map((row, index) => entryOf(row, start + index)),
          totalRows: found.totalRows,
          page,
          pageSize,
          totalPages: totalPages(found.totalRows, pageSize),
          appliedFilter: {
            from: filter.from,
            to: filter.to,
            ...(filter.stayState === undefined ? {} : { stayState: filter.stayState }),
            ...(filter.roomId === undefined ? {} : { roomId: filter.roomId }),
            ...(filter.nameSearch === undefined ? {} : { nameSearch: filter.nameSearch }),
          },
        };
      },
    );
  }

  /**
   * The filter a query resolves to, refused rather than corrected.
   *
   * Public because the export service builds the very same filter from the very
   * same query — doc 12 §7 requires the file and the screen to agree, and the
   * only way to guarantee that is for one function to produce both.
   */
  resolveFilter(query: RegistryQuery, timeZone: string, now: Date): RegistryFilter {
    const range =
      query.from === undefined || query.to === undefined
        ? defaultRange(now, timeZone)
        : rangeOfLocalDates(query.from, query.to, timeZone);
    const refusal = refuseRange(range, DEFAULT_RETENTION_DAYS);
    if (refusal === 'INVERTED') {
      throw new ApiError('VALIDATION_FAILED', 'the date range ends before it starts');
    }
    if (refusal === 'TOO_LONG') {
      throw new ApiError(
        'VALIDATION_FAILED',
        `RANGE_TOO_LONG: a range may not exceed the ${String(DEFAULT_RETENTION_DAYS)}-day retention period`,
      );
    }
    const search = normalizeSearch(query.nameSearch);
    return {
      hotelId: query.hotelId,
      from: range.from,
      to: range.to,
      ...(query.stayState === undefined ? {} : { stayState: query.stayState }),
      ...(query.roomId === undefined ? {} : { roomId: query.roomId }),
      ...(search === undefined ? {} : { nameSearch: search }),
    };
  }
}

export function entryOf(row: RegistryRow, rowNumber: number): RegistryEntry {
  return {
    rowNumber,
    familyName: row.familyName,
    givenName: row.givenName,
    age: row.ageAtCheckIn,
    roomNumber: row.roomNumber,
    periodStartAt: row.effectiveCheckInAt,
    periodEndAt: row.periodEndAt,
    stayState: row.stayState,
  };
}
