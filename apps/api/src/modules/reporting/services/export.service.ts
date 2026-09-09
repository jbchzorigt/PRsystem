import { randomBytes } from 'node:crypto';
import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { EXPORT_KINDS, ReportingRepository } from '../repositories/reporting.repository';
import type { ExportJobRow, ExportKind } from '../repositories/reporting.repository';
import {
  DEFAULT_RETENTION_DAYS,
  EXPORT_ROW_CAP,
  EXPORT_URL_TTL_MINUTES,
  fileExpiry,
  urlExpiry,
} from '../domain/reporting';
import { buildWorkbook } from '../../../common/workbook';
import type { CommandActor, ReportingDependencies, RequestContext } from './reporting-context';
import {
  DASHBOARD_FULL,
  MINIBAR_EXCEL,
  REGISTRY_EXPORT,
  ROOM_EXCEL,
  ReportingServiceBase,
  claim,
  hotelTimeZone,
  newReportingRequest,
} from './reporting-context';
import { GuestRegistryService } from './registry.service';
import type { RegistryQuery } from './registry.service';
import { FinancialDashboardService } from './dashboard.service';
import type { DashboardQuery } from './dashboard.service';

/**
 * The five background exports (doc 12 §7, doc 23 §8; `GUEST-DEC-006`, `-007`,
 * `FIN-DEC-008`).
 *
 * Four rules, and every one of them is enforced somewhere the code cannot skip.
 *
 * **Ten thousand rows, and never a partial file.** The count is taken *before*
 * the job runs, and a result above the cap refuses to start rather than writing
 * a truncated workbook. The column has a CHECK too, so a row count above the
 * cap has no shape to exist in.
 *
 * **The filter is snapshotted.** doc 12 §8: the job carries the filter, the
 * sort, the timezone and the policy version it ran under, and a trigger makes
 * them immutable — so the file and the screen that produced it cannot drift
 * apart.
 *
 * **The file lives an hour; a URL lives five minutes.** They are different
 * columns on different tables, and issuing a URL writes only to the grant
 * table. Re-issuing therefore cannot extend the file, which is exactly what
 * doc 12 §7 asks and is the phase's own gate.
 *
 * **Authority is re-checked on creation *and* on download.** doc 12 §7 says so
 * in as many words, and the two are separate commands with separate
 * authorization here.
 */

const REGISTRY_HEADERS = ['Дэс дугаар', 'Овог', 'Нэр', 'Нас', 'Өрөө', 'Хугацаа'] as const;

export interface ExportRequest {
  readonly hotelId: string;
  readonly kind: ExportKind;
  readonly registry?: Omit<RegistryQuery, 'hotelId' | 'page' | 'pageSize'>;
  readonly financial?: Omit<DashboardQuery, 'hotelId' | 'topBy'>;
  readonly idempotencyKey: string;
}

export interface ExportView {
  readonly jobId: string;
  readonly kind: ExportKind;
  readonly state: string;
  readonly rowCount: number | null;
  readonly requestedAt: Date;
  readonly readyAt: Date | null;
  readonly expiresAt: Date | null;
  readonly failureReason: string | null;
}

export function exportView(row: ExportJobRow): ExportView {
  return {
    jobId: row.jobId,
    kind: row.kind,
    state: row.state,
    rowCount: row.rowCount,
    requestedAt: row.requestedAt,
    readyAt: row.readyAt,
    expiresAt: row.expiresAt,
    failureReason: row.failureReason,
  };
}

export class ReportExportService extends ReportingServiceBase {
  private readonly registry: GuestRegistryService;
  private readonly dashboard: FinancialDashboardService;

  constructor(deps: ReportingDependencies) {
    super(deps);
    this.registry = new GuestRegistryService(deps);
    this.dashboard = new FinancialDashboardService(deps);
  }

  /**
   * `GUEST-DEC-006`: the job is created only once the count is known to fit.
   *
   * The count and the creation happen in one transaction, so a job cannot be
   * queued against a filter that had already grown past the cap when it was
   * measured — and the message names the cap so the caller knows to narrow the
   * filter rather than retry.
   */
  async request(
    input: ExportRequest,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ExportView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      permissionFor(input.kind),
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'reporting.export_request', input.idempotencyKey, {
          kind: input.kind,
        });
        if (claimed.kind === 'replay') return claimed.body as ExportView;
        await authorize();

        const repository = new ReportingRepository(uow);
        const timeZone = await hotelTimeZone(uow);
        const now = this.now(uow);
        const policy = await repository.currentPolicy(input.hotelId, DEFAULT_RETENTION_DAYS, now);
        const filters = this.snapshotFilters(input, timeZone, now);

        if (input.kind === 'GUEST_REGISTRY') {
          const filter = this.registry.resolveFilter(
            { hotelId: input.hotelId, ...(input.registry ?? {}) },
            timeZone,
            now,
          );
          const total = await this.deps.registry.count(uow, filter);
          if (total > EXPORT_ROW_CAP) {
            throw new ApiError(
              'PRECONDITION_FAILED',
              `EXPORT_TOO_LARGE: ${String(total)} rows exceed the ${String(EXPORT_ROW_CAP)}-row ` +
                'limit; narrow the filter',
            );
          }
        }

        const job = await repository.createJob({
          hotelId: input.hotelId,
          kind: input.kind,
          filters,
          timeZone,
          policyVersion: policy.version,
          requestedByAccountId: gate.principal.accountId,
        });
        await recordPlatformAudit(uow, {
          action: 'reporting.export_requested',
          outcome: 'allowed',
          targetType: 'report_export_job',
          targetRef: job.jobId,
          payload: { kind: input.kind, filters, by: gate.principal.accountId },
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'report_export_job',
          aggregateId: job.jobId,
          eventType: 'reporting.export_requested',
          payload: { jobId: job.jobId, kind: input.kind },
        });
        const view = exportView(job);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 202, view);
        return view;
      },
    );
  }

  /**
   * Runs one queued job: builds the workbook, stores it, and stamps the hour.
   *
   * The build happens outside the transaction that completes the job, because
   * it reads a great deal and writes nothing — and the storage call is a
   * network call, which has no business inside a lock.
   */
  async run(
    jobId: string,
    request: RequestContext = newReportingRequest(),
  ): Promise<ExportView | undefined> {
    // A queued job lives behind a tenant policy and this call is in no tenant
    // yet, so the hotel is resolved the same narrow way every sweep resolves
    // one: a `SECURITY DEFINER` function answering two identifiers.
    const located = await this.deps.pool.query<{ hotel_id: string }>(
      `SELECT hotel_id FROM platform.queued_export_jobs(100) WHERE job_id = $1::uuid`,
      [jobId],
    );
    const hotelId = located.rows[0]?.hotel_id;
    if (hotelId === undefined) return undefined;

    const claimedJob = await this.inHotelScope(hotelId, request, async (uow) => {
      const repository = new ReportingRepository(uow);
      const job = await repository.lockJob(jobId);
      if (job === undefined || job.state !== 'QUEUED') return undefined;
      const started = await repository.startJob(job.jobId, job.revision, this.now(uow));
      return started ? { ...job, revision: job.revision + 1 } : undefined;
    });
    if (claimedJob === undefined) return undefined;

    let built: { rows: number; body: Uint8Array };
    try {
      built = await this.build(claimedJob, request);
    } catch (error) {
      return this.fail(
        claimedJob,
        request,
        error instanceof Error ? error.message : 'build failed',
      );
    }

    const key = storageKeyFor(claimedJob.hotelId);
    const stored = await this.deps.storage.put({
      key,
      body: built.body,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    if (!stored.ok) {
      return this.fail(claimedJob, request, `storage ${stored.error.kind}`);
    }

    return this.inHotelScope(claimedJob.hotelId, request, async (uow) => {
      const repository = new ReportingRepository(uow);
      const job = await repository.lockJob(jobId);
      if (job === undefined) throw new Error('the export job vanished under its own lock');
      const readyAt = this.now(uow);
      const done = await repository.completeJob({
        jobId: job.jobId,
        expectedRevision: job.revision,
        rowCount: built.rows,
        storageKey: stored.value.key,
        contentHash: stored.value.contentHash,
        readyAt,
        expiresAt: fileExpiry(readyAt),
      });
      if (!done) throw new ApiError('CONFLICT', 'that export changed under this command');
      await recordPlatformAudit(uow, {
        action: 'reporting.export_completed',
        outcome: 'allowed',
        targetType: 'report_export_job',
        targetRef: job.jobId,
        payload: { rows: built.rows, kind: job.kind },
      });
      const reread = await repository.jobById(jobId);
      if (reread === undefined) throw new Error('the export job vanished under its own lock');
      return exportView(reread);
    });
  }

  /**
   * `GUEST-DEC-007`: a fresh five-minute URL, and never a longer-lived file.
   *
   * Authority is re-checked here, not only when the job was created — doc 12 §7
   * requires the download to be gated on its own. A completed job whose hour
   * has passed is `EXPIRED` and answers as such rather than handing out a URL
   * to a file that is gone.
   */
  async download(
    input: { hotelId: string; jobId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ url: string; expiresAt: Date }> {
    const prepared = await this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      REGISTRY_EXPORT,
      request,
      async (uow, gate, authorize) => {
        const repository = new ReportingRepository(uow);
        const job = await repository.lockJob(input.jobId);
        // A job of another hotel is invisible in this scope, so this is the
        // same answer a job that does not exist gets.
        if (job === undefined) throw new ApiError('NOT_FOUND', 'no such export');
        // The permission is the one the *kind* carries, so a caller entitled
        // to fetch a registry export is not thereby entitled to fetch a
        // financial one. The row was read under this hotel's scope and the
        // transaction rolls back if the gate refuses, so nothing about it
        // leaves this block.
        await authorize(permissionFor(job.kind));
        const now = this.now(uow);
        if (job.state === 'EXPIRED') {
          throw new ApiError('PRECONDITION_FAILED', 'EXPIRED: that export file is no longer kept');
        }
        if (job.state !== 'COMPLETED' || job.storageKey === null || job.expiresAt === null) {
          throw new ApiError('PRECONDITION_FAILED', `NOT_READY: the export is ${job.state}`);
        }
        // The file's own hour decides, and it is read rather than recomputed:
        // the sweep may not have run yet, and a URL for an expired file would
        // be a URL to nothing.
        if (job.expiresAt.getTime() <= now.getTime()) {
          throw new ApiError('PRECONDITION_FAILED', 'EXPIRED: that export file is no longer kept');
        }
        const issuedAt = now;
        const expiresAt = urlExpiry(issuedAt);
        await repository.recordGrant({
          hotelId: input.hotelId,
          jobId: job.jobId,
          issuedByAccountId: gate.principal.accountId,
          issuedAt,
          expiresAt,
        });
        await recordPlatformAudit(uow, {
          action: 'reporting.export_downloaded',
          outcome: 'allowed',
          targetType: 'report_export_job',
          targetRef: job.jobId,
          payload: { by: gate.principal.accountId, urlExpiresAt: expiresAt.toISOString() },
        });
        return { storageKey: job.storageKey, expiresAt };
      },
    );

    const signed = await this.deps.storage.signedUrl({
      key: prepared.storageKey,
      expiresInSeconds: EXPORT_URL_TTL_MINUTES * 60,
    });
    if (!signed.ok) {
      throw new ApiError('PRECONDITION_FAILED', 'EXPIRED: that export file is no longer kept');
    }
    return { url: signed.value.url, expiresAt: prepared.expiresAt };
  }

  /**
   * The hotel's own export jobs, newest first — and only of the kinds the
   * caller may have asked for.
   *
   * A job row carries its kind and its row count, which is the shape of the
   * data behind it. So the list is filtered by the same per-kind permission
   * the creation and the download run under, rather than shown whole to
   * anybody holding one of them: a Manager sees the registry exports and not
   * what the financial ones counted. A caller who may ask for none of the five
   * is refused outright, with the same opaque answer as any other denial.
   */
  async list(
    hotelId: string,
    actor: CommandActor,
    request: RequestContext,
    limit = 50,
  ): Promise<readonly ExportView[]> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId },
      REGISTRY_EXPORT,
      request,
      async (uow, _gate, authorize) => {
        const permitted: ExportKind[] = [];
        let refusal: unknown;
        for (const kind of EXPORT_KINDS) {
          try {
            await authorize(permissionFor(kind));
            permitted.push(kind);
          } catch (error) {
            refusal ??= error;
          }
        }
        if (permitted.length === 0) throw refusal;
        const jobs = await new ReportingRepository(uow).jobsFor(hotelId, limit);
        return jobs.filter((job) => permitted.includes(job.kind)).map((job) => exportView(job));
      },
    );
  }

  /** Runs the queued jobs, oldest first. The worker's entry point. */
  async runQueued(limit = 20, request: RequestContext = newReportingRequest()): Promise<number> {
    const queued = await this.deps.pool.query<{ job_id: string }>(
      `SELECT job_id FROM platform.queued_export_jobs($1::integer)`,
      [limit],
    );
    let ran = 0;
    for (const row of queued.rows) {
      if ((await this.run(row.job_id, request)) !== undefined) ran += 1;
    }
    return ran;
  }

  /**
   * `GUEST-DEC-007`: the sweep that ends a file's hour.
   *
   * The same shape as every sweep since Phase 13: find the work across every
   * hotel through the resolver, then settle each row in its own hotel's scope
   * on its own lock. Deleting the object happens before the row is marked, so a
   * crash between the two leaves a job that says `COMPLETED` with no file —
   * which the download path already treats as expired.
   */
  async sweepExpired(
    limit = 100,
    request: RequestContext = newReportingRequest(),
  ): Promise<number> {
    const now = this.wallClock();
    const due = await this.deps.pool.query<{ job_id: string; hotel_id: string }>(
      `SELECT job_id, hotel_id FROM platform.lapsed_export_files($1::integer, $2::timestamptz)`,
      [limit, now],
    );
    let expired = 0;
    for (const row of due.rows) {
      if (await this.expireOne(row.hotel_id, row.job_id, request)) expired += 1;
    }
    return expired;
  }

  async expireOne(
    hotelId: string,
    jobId: string,
    request: RequestContext = newReportingRequest(),
  ): Promise<boolean> {
    const key = await this.inHotelScope(hotelId, request, async (uow) => {
      const job = await new ReportingRepository(uow).jobById(jobId);
      if (job === undefined || job.state !== 'COMPLETED') return undefined;
      const now = this.now(uow);
      if (job.expiresAt === null || job.expiresAt.getTime() > now.getTime()) return undefined;
      return job.storageKey ?? '';
    });
    if (key === undefined) return false;
    if (key !== '') await this.deps.storage.remove(key);

    return this.inHotelScope(hotelId, request, async (uow) => {
      const repository = new ReportingRepository(uow);
      const job = await repository.lockJob(jobId);
      if (job === undefined || job.state !== 'COMPLETED') return false;
      const now = this.now(uow);
      if (job.expiresAt === null || job.expiresAt.getTime() > now.getTime()) return false;
      const moved = await repository.expireJob(job.jobId, job.revision, now);
      if (!moved) return false;
      await recordPlatformAudit(uow, {
        action: 'reporting.export_expired',
        outcome: 'allowed',
        targetType: 'report_export_job',
        targetRef: job.jobId,
        payload: { kind: job.kind },
      });
      return true;
    });
  }

  // ------------------------------------------------------------------ helpers

  private async fail(
    job: ExportJobRow,
    request: RequestContext,
    reason: string,
  ): Promise<ExportView> {
    return this.inHotelScope(job.hotelId, request, async (uow) => {
      const repository = new ReportingRepository(uow);
      const locked = await repository.lockJob(job.jobId);
      if (locked === undefined) throw new Error('the export job vanished under its own lock');
      await repository.failJob({
        jobId: locked.jobId,
        expectedRevision: locked.revision,
        reason,
        at: this.now(uow),
      });
      await recordPlatformAudit(uow, {
        action: 'reporting.export_failed',
        outcome: 'denied',
        targetType: 'report_export_job',
        targetRef: locked.jobId,
        reason: reason.slice(0, 200),
      });
      const reread = await repository.jobById(locked.jobId);
      if (reread === undefined) throw new Error('the export job vanished under its own lock');
      return exportView(reread);
    });
  }

  /** The filter, the sort and the timezone this job will always mean. */
  private snapshotFilters(
    input: ExportRequest,
    timeZone: string,
    now: Date,
  ): Record<string, unknown> {
    if (input.kind === 'GUEST_REGISTRY') {
      const filter = this.registry.resolveFilter(
        { hotelId: input.hotelId, ...(input.registry ?? {}) },
        timeZone,
        now,
      );
      return {
        from: filter.from.toISOString(),
        to: filter.to.toISOString(),
        ...(filter.stayState === undefined ? {} : { stayState: filter.stayState }),
        ...(filter.roomId === undefined ? {} : { roomId: filter.roomId }),
        ...(filter.nameSearch === undefined ? {} : { nameSearch: filter.nameSearch }),
        sort: 'effective_check_in_at DESC, stay_id',
      };
    }
    const window = this.dashboard.resolveWindow(
      { hotelId: input.hotelId, ...(input.financial ?? {}) },
      timeZone,
      now,
    );
    return {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      sort: 'recognized_at, id',
    };
  }

  /**
   * Builds the workbook for one job, from the snapshot it carries.
   *
   * Read *from the snapshot*, never from the request that started the run — the
   * whole point of the immutable filter is that a rerun produces the same file.
   */
  private async build(
    job: ExportJobRow,
    request: RequestContext,
  ): Promise<{ rows: number; body: Uint8Array }> {
    const from = new Date(String(job.filters['from']));
    const to = new Date(String(job.filters['to']));
    const window = { hotelId: job.hotelId, from, to };

    return this.inHotelScope(job.hotelId, request, async (uow) => {
      switch (job.kind) {
        case 'GUEST_REGISTRY':
          return this.buildRegistry(uow, job, window);
        case 'ROOM_SALES':
          return this.buildRoomSales(uow, window);
        case 'MINIBAR_SALES':
          return this.buildMinibarSales(uow, window);
        case 'EXPENSE':
          return this.buildExpenses(uow, window);
        case 'PAYMENT_BREAKDOWN':
          return this.buildPayments(uow, window);
      }
    });
  }

  private async buildRegistry(
    uow: UnitOfWork,
    job: ExportJobRow,
    window: { hotelId: string; from: Date; to: Date },
  ): Promise<{ rows: number; body: Uint8Array }> {
    const filter = {
      hotelId: window.hotelId,
      from: window.from,
      to: window.to,
      ...(job.filters['stayState'] === undefined
        ? {}
        : { stayState: job.filters['stayState'] as 'ACTIVE' | 'COMPLETED' }),
      ...(job.filters['roomId'] === undefined ? {} : { roomId: String(job.filters['roomId']) }),
      ...(job.filters['nameSearch'] === undefined
        ? {}
        : { nameSearch: String(job.filters['nameSearch']) }),
    };
    const rows = await this.deps.registry.all(uow, filter, EXPORT_ROW_CAP);
    // The read asks for one more than the cap so this can tell a full file from
    // an overflowing one, rather than writing a truncated workbook.
    if (rows.length > EXPORT_ROW_CAP) {
      throw new ApiError(
        'PRECONDITION_FAILED',
        `EXPORT_TOO_LARGE: the filter now selects more than ${String(EXPORT_ROW_CAP)} rows`,
      );
    }
    return {
      rows: rows.length,
      body: buildWorkbook(
        'Зочдын бүртгэл',
        [...REGISTRY_HEADERS],
        rows.map((row, index) => [
          String(index + 1),
          row.familyName,
          row.givenName,
          row.ageAtCheckIn === null ? 'Тодорхойгүй' : String(row.ageAtCheckIn),
          row.roomNumber,
          `${row.effectiveCheckInAt.toISOString()} – ${row.periodEndAt.toISOString()}`,
        ]),
      ),
    };
  }

  private async buildRoomSales(
    uow: UnitOfWork,
    window: { hotelId: string; from: Date; to: Date },
  ): Promise<{ rows: number; body: Uint8Array }> {
    const rows = await this.deps.sales.roomSalesRows(uow, window, EXPORT_ROW_CAP);
    this.refuseOverflow(rows.length);
    return {
      rows: rows.length,
      body: buildWorkbook(
        'Өрөөний борлуулалт',
        [
          'Дэс дугаар',
          'Stay дугаар',
          'Өрөө',
          'Category',
          'Төрөл',
          'Snapshot нэгж үнэ',
          'Tariff source',
          'Source ID',
          'Config version',
          'Actual check-in',
          'Actual check-out',
          'Gross charge',
          'Discount',
          'Net sales',
          'Allocated payment',
          'Receivable',
          'Payment status',
          'Payment channel',
          'Recognized date',
        ],
        rows.map((row, index) => [
          String(index + 1),
          row.stayId,
          row.roomNumber,
          row.categoryName,
          row.stayType,
          row.unitRateMnt.toString(),
          row.sourceLevel,
          row.sourceEntityId,
          String(row.pricingConfigVersion),
          row.effectiveCheckInAt.toISOString(),
          row.actualCheckoutAt?.toISOString() ?? '',
          row.grossChargeMnt.toString(),
          row.discountMnt.toString(),
          row.netSalesMnt.toString(),
          row.allocatedPaymentMnt.toString(),
          row.receivableMnt.toString(),
          row.paymentStatus,
          row.paymentChannel ?? '',
          row.recognizedAt.toISOString(),
        ]),
      ),
    };
  }

  private async buildMinibarSales(
    uow: UnitOfWork,
    window: { hotelId: string; from: Date; to: Date },
  ): Promise<{ rows: number; body: Uint8Array }> {
    const rows = await this.deps.minibar.sales(uow, window, EXPORT_ROW_CAP);
    this.refuseOverflow(rows.length);
    return {
      rows: rows.length,
      body: buildWorkbook(
        'Minibar борлуулалт',
        [
          'Дэс дугаар',
          'Stay дугаар',
          'Өрөө',
          'Бүтээгдэхүүн',
          'Тоо',
          'Selling unit price',
          'Gross sales',
          'Discount',
          'Net sales',
          'Weighted average cost',
          'COGS',
          'Gross profit',
          'Gross margin %',
          'Payment status',
          'Recognized date',
        ],
        rows.map((row, index) => {
          const profit = row.netSalesMnt - row.cogsMnt;
          return [
            String(index + 1),
            row.stayId,
            row.roomNumber,
            row.productName,
            String(row.quantity),
            row.sellingUnitPriceMnt.toString(),
            row.grossSalesMnt.toString(),
            row.discountMnt.toString(),
            row.netSalesMnt.toString(),
            row.unitCostMnt?.toString() ?? '',
            row.cogsMnt.toString(),
            profit.toString(),
            row.netSalesMnt <= 0n
              ? 'N/A'
              : String(Number((profit * 10000n) / row.netSalesMnt) / 100),
            row.paymentStatus,
            row.recognizedAt.toISOString(),
          ];
        }),
      ),
    };
  }

  private async buildExpenses(
    uow: UnitOfWork,
    window: { hotelId: string; from: Date; to: Date },
  ): Promise<{ rows: number; body: Uint8Array }> {
    const rows = await this.deps.expenses.rows(uow, window, EXPORT_ROW_CAP);
    this.refuseOverflow(rows.length);
    return {
      rows: rows.length,
      body: buildWorkbook(
        'Зарлага',
        [
          'Дэс дугаар',
          'Expense дугаар',
          'Төрөл',
          'Category',
          'Тайлбар',
          'Нийлүүлэгч',
          'Amount',
          'Payment method',
          'Status',
          'Stock receipt',
          'Submitted by',
          'Decided by',
          'Decided at',
          'Paid at',
          'Payment reference',
          'Executor',
          'Shift',
        ],
        rows.map((row, index) => [
          String(index + 1),
          row.expenseId,
          row.expenseType,
          row.category,
          row.description,
          row.supplier ?? '',
          row.amountMnt.toString(),
          row.method,
          row.state,
          row.stockMovementId ?? '',
          row.createdByAccountId,
          row.decidedByAccountId ?? '',
          row.decidedAt?.toISOString() ?? '',
          row.paidAt?.toISOString() ?? '',
          row.providerReference ?? '',
          row.paidByAccountId ?? '',
          row.shiftId ?? '',
        ]),
      ),
    };
  }

  private async buildPayments(
    uow: UnitOfWork,
    window: { hotelId: string; from: Date; to: Date },
  ): Promise<{ rows: number; body: Uint8Array }> {
    const rows = await this.deps.sales.paymentRows(uow, window, EXPORT_ROW_CAP);
    this.refuseOverflow(rows.length);
    return {
      rows: rows.length,
      body: buildWorkbook(
        'Төлбөрийн задаргаа',
        [
          'Дэс дугаар',
          'Reference',
          'Stay дугаар',
          'Channel',
          'Gross payment',
          'Room allocation',
          'Minibar allocation',
          'Other allocation',
          'Deposit allocation',
          'Refund',
          'Net successful payment',
          'Status',
          'Effective date',
        ],
        rows.map((row, index) => [
          String(index + 1),
          row.reference ?? '',
          row.stayId,
          row.channel,
          row.grossMnt.toString(),
          row.roomAllocationMnt.toString(),
          row.minibarAllocationMnt.toString(),
          row.otherAllocationMnt.toString(),
          row.depositAllocationMnt.toString(),
          row.refundMnt.toString(),
          row.netMnt.toString(),
          row.status,
          row.effectiveAt.toISOString(),
        ]),
      ),
    };
  }

  private refuseOverflow(count: number): void {
    if (count > EXPORT_ROW_CAP) {
      throw new ApiError(
        'PRECONDITION_FAILED',
        `EXPORT_TOO_LARGE: the filter selects more than ${String(EXPORT_ROW_CAP)} rows`,
      );
    }
  }
}

/**
 * doc 12 §7: the file name carries nothing personal.
 *
 * A hotel id and sixteen random bytes. No guest name, no registration number,
 * no date range that could identify a small result — and the column has a shape
 * CHECK, so a key with a name in it cannot be stored however it was built.
 */
function storageKeyFor(hotelId: string): string {
  return `exports/${hotelId}/${randomBytes(16).toString('hex')}.xlsx`;
}

/**
 * doc 18 §3: the registry export and the financial ones are different rows.
 *
 * `FIN-DEC-010` gives the financial exports to Hotel Admin alone, while the
 * registry is also Manager's and — on the 30,000₮ package — Manager Plus's. A
 * single permission for all five would have widened one of them.
 */
/**
 * doc 18 §3 gives the room Excel, the minibar Excel and the registry export
 * their own rows, and they do not carry the same packages: the minibar Excel
 * is a 25,000₮-and-above action while the room one is in every package. So the
 * kind decides the named permission, and a caller entitled to one export is
 * not thereby entitled to another.
 */
function permissionFor(kind: ExportKind): string {
  switch (kind) {
    case 'GUEST_REGISTRY':
      return REGISTRY_EXPORT;
    case 'ROOM_SALES':
      return ROOM_EXCEL;
    case 'MINIBAR_SALES':
      return MINIBAR_EXCEL;
    // The expense and payment sheets are the dashboard in another shape, and
    // doc 23 §6 keeps them under the dashboard's own permission.
    case 'EXPENSE':
    case 'PAYMENT_BREAKDOWN':
      return DASHBOARD_FULL;
  }
}
