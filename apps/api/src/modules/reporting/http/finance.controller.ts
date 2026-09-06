import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiError } from '@prsystem/contracts';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, requireUuid } from '../../iam/http/validation';
import { formatMargin } from '../domain/reporting';
import { newReportingRequest } from '../services/reporting-context';
import { FinancialDashboardService } from '../services/dashboard.service';
import type { Dashboard } from '../services/dashboard.service';
import { ReportExportService } from '../services/export.service';
import type { ExportView } from '../services/export.service';
import { ExpenseCategoryService } from '../services/category.service';
import {
  optionalLocalDate,
  optionalQuickRange,
  optionalTopBy,
  rejectServerOwnedFields,
  requireCategoryKind,
  requireExportKind,
} from './reporting-validation';

/**
 * The Hotel Admin financial dashboard, its exports and its expense categories
 * (doc 23; `FIN-DEC-010`).
 *
 * Every route here is Hotel Admin's alone, and the permission cell says so
 * rather than this file: `hotel.finance.dashboard_full` and
 * `hotel.expense.category_manage` are `deny` in every other column of doc 18 §3.
 * Manager, Manager Plus, Reception and Cleaner reach none of it.
 */
@ApiTags('hotel-finance')
@Controller('hotels/:hotelId/finance')
export class FinanceReportingController {
  constructor(
    @Inject(FinancialDashboardService) private readonly dashboard: FinancialDashboardService,
    @Inject(ReportExportService) private readonly exports: ReportExportService,
    @Inject(ExpenseCategoryService) private readonly categories: ExpenseCategoryService,
  ) {}

  @Get('dashboard')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The eleven KPI cards, the daily series and the top five rooms' })
  @ApiResponse({ status: 404, description: 'A hotel the caller has no membership in' })
  async read(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Query('range') range?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('topBy') topBy?: string,
  ): Promise<Record<string, unknown>> {
    const quick = optionalQuickRange(range);
    const fromDate = optionalLocalDate(from, 'from');
    const toDate = optionalLocalDate(to, 'to');
    const order = optionalTopBy(topBy);
    return dashboardView(
      await this.dashboard.read(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          ...(quick === undefined ? {} : { range: quick }),
          ...(fromDate === undefined ? {} : { from: fromDate }),
          ...(toDate === undefined ? {} : { to: toDate }),
          ...(order === undefined ? {} : { topBy: order }),
        },
        actorOf(request),
        this.context(request),
      ),
    );
  }

  @Post('exports')
  @HttpCode(202)
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Queue one of the five background exports (GUEST-DEC-006, FIN-DEC-008)',
  })
  @ApiResponse({ status: 412, description: 'EXPORT_TOO_LARGE: more than 10,000 rows' })
  async requestExport(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    const quick = optionalQuickRange(payload['range']);
    const from = optionalLocalDate(payload['from'], 'from');
    const to = optionalLocalDate(payload['to'], 'to');
    return exportBody(
      await this.exports.request(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          kind: requireExportKind(payload['kind']),
          registry: {
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
          },
          financial: {
            ...(quick === undefined ? {} : { range: quick }),
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
          },
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      ),
    );
  }

  @Get('exports')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'This hotel’s export jobs, newest first' })
  async listExports(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ exports: unknown[] }> {
    const jobs = await this.exports.list(
      requireUuid(hotelIdParam, 'hotelId'),
      actorOf(request),
      this.context(request),
    );
    return { exports: jobs.map((job) => exportBody(job)) };
  }

  @Post('exports/:jobId/download')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'A fresh five-minute signed URL; the file’s hour is unchanged' })
  @ApiResponse({ status: 412, description: 'EXPIRED or NOT_READY' })
  async download(
    @Param('hotelId') hotelIdParam: string,
    @Param('jobId') jobIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const signed = await this.exports.download(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        jobId: requireUuid(jobIdParam, 'jobId'),
      },
      actorOf(request),
      this.context(request),
    );
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }

  @Get('expense-categories')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The hotel’s expense categories and their reporting kind' })
  async listCategories(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ categories: unknown[] }> {
    const rows = await this.categories.list(
      requireUuid(hotelIdParam, 'hotelId'),
      actorOf(request),
      this.context(request),
    );
    return { categories: [...rows] };
  }

  @Post('expense-categories')
  @HttpCode(201)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Add a category; its reporting kind is fixed at creation' })
  async addCategory(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    return {
      ...(await this.categories.create(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          name: requireCategoryName(payload['name']),
          kind: requireCategoryKind(payload['kind']),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  @Post('expense-categories/:categoryId/state')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Deactivate or reactivate a category; it is never deleted' })
  async setCategoryState(
    @Param('hotelId') hotelIdParam: string,
    @Param('categoryId') categoryIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    return {
      ...(await this.categories.setState(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          categoryId: requireUuid(categoryIdParam, 'categoryId'),
          state: payload['state'] === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  private context(request: AuthenticatedRequest): ReturnType<typeof newReportingRequest> {
    return newReportingRequest(principalOf(request).accountId);
  }
}

function requireCategoryName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 80) {
    throw new ApiError('VALIDATION_FAILED', 'name must be 1 to 80 characters');
  }
  return value.trim();
}

function exportBody(job: ExportView): Record<string, unknown> {
  return {
    jobId: job.jobId,
    kind: job.kind,
    state: job.state,
    rowCount: job.rowCount,
    requestedAt: job.requestedAt.toISOString(),
    readyAt: job.readyAt?.toISOString() ?? null,
    expiresAt: job.expiresAt?.toISOString() ?? null,
    failureReason: job.failureReason,
  };
}

/**
 * The wire shape of the dashboard.
 *
 * Every amount is a string, the way every money-bearing endpoint returns one
 * (CLAUDE.md §5), and every margin is a formatted percentage from the integer
 * basis points the server computed — a client never divides two numbers to
 * find one (doc 23 §6).
 */
function dashboardView(dashboard: Dashboard): Record<string, unknown> {
  const kpis = dashboard.kpis;
  return {
    window: {
      from: dashboard.window.from.toISOString(),
      to: dashboard.window.to.toISOString(),
      timeZone: dashboard.window.timeZone,
    },
    kpis: {
      grossSalesMnt: kpis.grossSalesMnt.toString(),
      netSalesMnt: kpis.netSalesMnt.toString(),
      receivedMnt: kpis.receivedMnt.toString(),
      receivableMnt: kpis.receivableMnt.toString(),
      refundMnt: kpis.refundMnt.toString(),
      paidOperatingExpenseMnt: kpis.paidOperatingExpenseMnt.toString(),
      inventoryPurchaseOutflowMnt: kpis.inventoryPurchaseOutflowMnt.toString(),
      minibarCogsMnt: kpis.minibarCogsMnt.toString(),
      minibarGrossProfitMnt: kpis.minibarGrossProfitMnt.toString(),
      minibarGrossMargin: formatMargin(kpis.minibarGrossMarginBps),
      // doc 23 §3.2: never called `Цэвэр ашиг`, and the field name says so.
      operatingResultMnt: kpis.operatingResultMnt.toString(),
      operatingMargin: formatMargin(kpis.operatingMarginBps),
      depositsHeldMnt: kpis.depositsHeldMnt.toString(),
    },
    paymentChannels: Object.fromEntries(
      Object.entries(dashboard.paymentChannels).map(([channel, amount]) => [
        channel,
        amount.toString(),
      ]),
    ),
    depositAllocationMnt: dashboard.depositAllocationMnt.toString(),
    series: dashboard.series.map((point) => ({
      localDate: point.localDate,
      roomNetSalesMnt: point.roomNetSalesMnt.toString(),
      minibarNetSalesMnt: point.minibarNetSalesMnt.toString(),
      paidOperatingExpenseMnt: point.paidOperatingExpenseMnt.toString(),
      inventoryPurchaseMnt: point.inventoryPurchaseMnt.toString(),
      refundMnt: point.refundMnt.toString(),
      operatingResultMnt: point.operatingResultMnt.toString(),
    })),
    topBy: dashboard.topBy,
    topRooms: dashboard.topRooms.map((room) => ({
      roomNumber: room.roomNumber,
      categoryName: room.categoryName,
      completedStays: room.completedStays,
      hourlyStays: room.hourlyStays,
      nightlyStays: room.nightlyStays,
      totalMinutes: room.totalMinutes,
      roomGrossSalesMnt: room.roomGrossSalesMnt.toString(),
      roomNetSalesMnt: room.roomNetSalesMnt.toString(),
    })),
  };
}
