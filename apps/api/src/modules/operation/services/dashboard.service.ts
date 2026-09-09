import { OperationRepository } from '../repositories/operation.repository';
import type {
  ApplicationQueueRow,
  KpiRow,
  SubscriptionFilters,
  SubscriptionListRow,
} from '../repositories/operation.repository';
import { graceHoursRemaining, remainingDays } from '../domain/operation';
import type { CommandActor, OperationDependencies, RequestContext } from './operation-context';
import { OPERATION_READ, OperationServiceBase } from './operation-context';

/**
 * The dashboard: the KPI partition, the subscription list, and the queue of
 * applications that are not hotels yet (doc 14 §3, `OPS-DEC-011`–`OPS-DEC-014`).
 *
 * Everything here is a read, and every read goes through a resolver rather than
 * a query of its own. That is what makes two of doc 14's rules structural:
 *
 *  - **One `as_of`.** The five status counts and the three package counts are
 *    arms of one expression evaluated at one instant, so the partition sums to
 *    the total by construction rather than by two queries happening to agree.
 *  - **The address is masked before it is read.** `operation_subscription_page`
 *    returns `email_masked` and compares `p_email` inside the function, so the
 *    registered address never reaches this process — an operator may confirm one
 *    they already hold and can never read one they do not.
 */

export interface KpiView {
  readonly asOf: Date;
  readonly totalHotels: number;
  readonly status: {
    readonly active: number;
    readonly expiringSoon: number;
    readonly grace: number;
    readonly expired: number;
    readonly suspended: number;
  };
  readonly packages: { readonly P20: number; readonly P25: number; readonly P30: number };
  /** `OPS-DEC-013`: paid, not provisioned, and deliberately outside the total. */
  readonly inactiveApplications: number;
  readonly sms: {
    readonly sent: number;
    readonly delivered: number;
    readonly failed: number;
  };
}

export interface SubscriptionRowView extends Omit<SubscriptionListRow, 'totalRows'> {
  readonly remainingDays: number;
  readonly graceHoursRemaining: number | undefined;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export class OperationDashboardService extends OperationServiceBase {
  constructor(deps: OperationDependencies) {
    super(deps);
  }

  /** `OPS-DEC-014`. Reading the dashboard is itself audited (doc 14 §7). */
  async kpi(actor: CommandActor, request: RequestContext, asOf?: Date): Promise<KpiView> {
    return this.runOperationCommand(
      actor,
      OPERATION_READ,
      { targetType: 'operation_kpi', targetRef: 'dashboard' },
      request,
      async (uow) => {
        const repository = new OperationRepository(uow);
        const row: KpiRow = await repository.kpi(asOf);
        const sms = await repository.smsMonthCounts(asOf);
        await this.audit(uow, {
          action: 'operation.dashboard.kpi_read',
          outcome: 'allowed',
          targetType: 'operation_kpi',
          targetRef: 'dashboard',
        });
        return {
          asOf: row.asOf,
          totalHotels: row.totalHotels,
          status: {
            active: row.statusActive,
            expiringSoon: row.statusExpiringSoon,
            grace: row.statusGrace,
            expired: row.statusExpired,
            suspended: row.statusSuspended,
          },
          packages: { P20: row.packageP20, P25: row.packageP25, P30: row.packageP30 },
          inactiveApplications: row.inactiveApplications,
          sms,
        };
      },
    );
  }

  /**
   * `OPS-DEC-011`, `OPS-DEC-012`: the thirteen columns, expiry-ascending, with
   * every filter applied server-side.
   *
   * doc 14 §3.3 requires an exact phone or email search to be audited *with its
   * user*, and requires the raw term to stay out of ordinary logs — so the
   * audit records that an exact search happened and how many rows it matched,
   * never the term itself.
   */
  async subscriptions(
    actor: CommandActor,
    input: { filters: SubscriptionFilters; limit?: number; offset?: number; asOf?: Date },
    request: RequestContext,
  ): Promise<Page<SubscriptionRowView>> {
    const limit = this.pageSize(input.limit);
    const offset = Math.max(0, input.offset ?? 0);
    return this.runOperationCommand(
      actor,
      OPERATION_READ,
      { targetType: 'hotel_subscription', targetRef: 'list' },
      request,
      async (uow) => {
        const rows = await new OperationRepository(uow).subscriptionPage(input.filters, {
          limit,
          offset,
          ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
        });
        const asOf = input.asOf ?? this.now(uow);
        const exactSearch = input.filters.phone !== undefined || input.filters.email !== undefined;
        await this.audit(uow, {
          action: exactSearch
            ? 'operation.dashboard.exact_search'
            : 'operation.dashboard.subscription_list',
          outcome: 'allowed',
          targetType: 'hotel_subscription',
          targetRef: 'list',
          payload: {
            // Which *kinds* of filter were used, never their values.
            filters: Object.keys(input.filters).sort(),
            matched: rows.length,
            limit,
            offset,
          },
        });
        return {
          items: rows.map((row) => ({
            ...withoutTotal(row),
            remainingDays: remainingDays(row.expiresAt, asOf),
            graceHoursRemaining: graceHoursRemaining(row.expiresAt, asOf),
          })),
          total: rows[0]?.totalRows ?? 0,
          limit,
          offset,
        };
      },
    );
  }

  /**
   * `OPS-DEC-013`: the onboarding queue, and its `Идэвхжээгүй` group.
   *
   * A `PROVISIONED` application is not returned by the resolver at all, which
   * is what stops one application being counted here and in the hotel KPI.
   */
  async applications(
    actor: CommandActor,
    input: { group?: 'UNPAID' | 'INACTIVE'; limit?: number; offset?: number },
    request: RequestContext,
  ): Promise<Page<Omit<ApplicationQueueRow, 'totalRows'>>> {
    const limit = this.pageSize(input.limit);
    const offset = Math.max(0, input.offset ?? 0);
    return this.runOperationCommand(
      actor,
      OPERATION_READ,
      { targetType: 'onboarding_application', targetRef: input.group ?? 'all' },
      request,
      async (uow) => {
        const rows = await new OperationRepository(uow).applicationQueue(input.group, {
          limit,
          offset,
        });
        await this.audit(uow, {
          action: 'operation.dashboard.application_queue',
          outcome: 'allowed',
          targetType: 'onboarding_application',
          targetRef: input.group ?? 'all',
          payload: { matched: rows.length, limit, offset },
        });
        return {
          items: rows.map(({ totalRows: _total, ...rest }) => rest),
          total: rows[0]?.totalRows ?? 0,
          limit,
          offset,
        };
      },
    );
  }

  private pageSize(requested: number | undefined): number {
    const size = requested ?? this.parameters.defaultPageSize;
    return Math.min(Math.max(1, size), this.parameters.maxPageSize);
  }
}

function withoutTotal(row: SubscriptionListRow): Omit<SubscriptionListRow, 'totalRows'> {
  const { totalRows: _total, ...rest } = row;
  return rest;
}
