import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, requireString, requireUuid } from '../../iam/http/validation';
import { requireRevision } from '../../catalog/http/catalog-validation';
import { DisputeService } from '../services/dispute.service';
import { PaymentLockService } from '../services/payment-lock.service';
import { MinibarReportService } from '../services/report.service';
import { newStayRequest } from '../services/stay-context';
import type { ReportView } from '../services/checkout-views';
import {
  optionalAmountMnt,
  optionalString,
  requireAdjustmentKind,
  requireCountedLines,
  requireDisputeDecision,
  requirePositiveInteger,
} from './stay-validation';

/**
 * The minibar usage report: the Cleaner's inspection and version, the
 * Reception's return, the Manager's exception version and dispute decision,
 * the payment attempt's lock and its reconciliation, and the adjustments that
 * are the only correction after a settlement (doc 21).
 */
@ApiTags('stay-minibar-reports')
@Controller('hotels/:hotelId/minibar-reports')
export class ReportController {
  constructor(
    @Inject(MinibarReportService) private readonly reports: MinibarReportService,
    @Inject(DisputeService) private readonly disputes: DisputeService,
    @Inject(PaymentLockService) private readonly payments: PaymentLockService,
  ) {}

  @Get()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Reports waiting for a Cleaner or returned for correction' })
  async queue(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ reports: readonly { reportId: string; roomId: string; state: string }[] }> {
    const reports = await this.reports.queue(
      { hotelId: requireUuid(hotelIdParam, 'hotelId') },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
    return { reports };
  }

  @Get(':reportId')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The priced report, its versions, disputes and attempts' })
  async view(
    @Param('hotelId') hotelIdParam: string,
    @Param('reportId') reportIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ReportView> {
    return this.reports.view(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        reportId: requireUuid(reportIdParam, 'reportId'),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':reportId/claim')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'A Cleaner takes the inspection (task_claim)' })
  async claim(
    @Param('hotelId') hotelIdParam: string,
    @Param('reportId') reportIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ReportView> {
    const payload = body(request);
    return this.reports.claimInspection(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        reportId: requireUuid(reportIdParam, 'reportId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':reportId/versions')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The Cleaner submits a version (usage_report_create)' })
  @ApiResponse({ status: 400, description: 'PRODUCT_NOT_IN_PRICE_BOOK' })
  async submit(
    @Param('hotelId') hotelIdParam: string,
    @Param('reportId') reportIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ReportView> {
    const payload = body(request);
    return this.reports.submit(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        reportId: requireUuid(reportIdParam, 'reportId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        counted: requireCountedLines(payload['counted'], 'counted'),
        noUsage: payload['noUsage'] === true,
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':reportId/exception-versions')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'A Manager submits an exception version (exception_report_create)' })
  async submitException(
    @Param('hotelId') hotelIdParam: string,
    @Param('reportId') reportIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ReportView> {
    const payload = body(request);
    return this.reports.submitException(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        reportId: requireUuid(reportIdParam, 'reportId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        counted: requireCountedLines(payload['counted'], 'counted'),
        noUsage: payload['noUsage'] === true,
        reason: requireString(payload['reason'], 'reason', 300),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':reportId/return')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Reception returns the report for correction (report_return_to_cleaner)',
  })
  async returnToCleaner(
    @Param('hotelId') hotelIdParam: string,
    @Param('reportId') reportIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ReportView> {
    const payload = body(request);
    return this.reports.returnToCleaner(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        reportId: requireUuid(reportIdParam, 'reportId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        reason: requireString(payload['reason'], 'reason', 300),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':reportId/disputes')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Reception marks a disputed line (dispute_flag)' })
  async flagDispute(
    @Param('hotelId') hotelIdParam: string,
    @Param('reportId') reportIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ReportView> {
    const payload = body(request);
    const view = await this.disputes.flag(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        reportId: requireUuid(reportIdParam, 'reportId'),
        idempotencyKey: idempotencyKey(request),
        productId: requireUuid(payload['productId'], 'productId'),
        disputedQuantity: requirePositiveInteger(
          payload['disputedQuantity'],
          'disputedQuantity',
          999,
        ),
        note: requireString(payload['note'], 'note', 300),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return view;
  }

  @Post(':reportId/disputes/:disputeId/decide')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'A Manager upholds or waives the disputed line (dispute_resolve)' })
  async decideDispute(
    @Param('hotelId') hotelIdParam: string,
    @Param('disputeId') disputeIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ReportView> {
    const payload = body(request);
    return this.disputes.resolve(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        disputeId: requireUuid(disputeIdParam, 'disputeId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        decision: requireDisputeDecision(payload['decision']),
        reason: requireString(payload['reason'], 'reason', 300),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':reportId/payment-attempts')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Lock the exact version a payment attempt charges (checkout_record)' })
  @ApiResponse({ status: 412, description: 'PAYMENT_REFUSED: REPORT_NOT_SUBMITTED, DISPUTE_OPEN' })
  async lock(
    @Param('hotelId') hotelIdParam: string,
    @Param('reportId') reportIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ReportView> {
    const payload = body(request);
    const view = await this.payments.lockForPayment(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        reportId: requireUuid(reportIdParam, 'reportId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        attemptRef: requireString(payload['attemptRef'], 'attemptRef', 120),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return view;
  }

  @Post(':reportId/payment-attempts/:lockId/reconcile')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Re-query the provider; only a confirmed no-funds failure unlocks' })
  async reconcile(
    @Param('hotelId') hotelIdParam: string,
    @Param('lockId') lockIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ReportView> {
    const payload = body(request);
    return this.payments.reconcile(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        lockId: requireUuid(lockIdParam, 'lockId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
  }

  @Post(':reportId/adjustments')
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary:
      'Correct a settled charge by reversal, receivable or waiver (post_payment_correction_approve)',
  })
  @ApiResponse({ status: 409, description: 'REPORT_NOT_SETTLED' })
  async adjust(
    @Param('hotelId') hotelIdParam: string,
    @Param('reportId') reportIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ReportView> {
    const payload = body(request);
    const productId = optionalString(payload['productId'], 'productId', 64);
    const quantity = payload['quantity'];
    const amountMnt = optionalAmountMnt(payload['amountMnt'], 'amountMnt');
    const view = await this.payments.adjust(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        reportId: requireUuid(reportIdParam, 'reportId'),
        idempotencyKey: idempotencyKey(request),
        kind: requireAdjustmentKind(payload['kind']),
        ...(productId === undefined ? {} : { productId: requireUuid(productId, 'productId') }),
        ...(quantity === undefined || quantity === null
          ? {}
          : { quantity: requirePositiveInteger(quantity, 'quantity', 9999) }),
        ...(amountMnt === undefined ? {} : { amountMnt }),
        reason: requireString(payload['reason'], 'reason', 300),
      },
      actorOf(request),
      newStayRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return view;
  }
}
