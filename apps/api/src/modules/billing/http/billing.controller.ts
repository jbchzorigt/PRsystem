import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
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
import { DepositService } from '../services/deposit.service';
import { FinancialCorrectionService } from '../services/correction.service';
import { FolioService } from '../services/folio.service';
import { RefundService } from '../services/refund.service';
import { newBillingRequest } from '../services/billing-context';
import type { DepositConfigView, FolioView } from '../services/billing-views';
import {
  optionalString,
  optionalUuid,
  requireAmountMnt,
  requireChannel,
} from './billing-validation';

/**
 * The bill of a stay and the money against it (doc 02 §3.3–3.4, doc 20).
 * Reception takes and applies the deposit and the payments; a Manager
 * configures the deposit and decides the exceptions.
 */
@ApiTags('billing')
@Controller('hotels/:hotelId')
export class BillingController {
  constructor(
    @Inject(FolioService) private readonly folios: FolioService,
    @Inject(DepositService) private readonly deposits: DepositService,
    @Inject(RefundService) private readonly refunds: RefundService,
    @Inject(FinancialCorrectionService)
    private readonly corrections: FinancialCorrectionService,
  ) {}

  @Get('deposit-configuration')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The hotel default and every category override' })
  async configuration(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ configuration: readonly DepositConfigView[] }> {
    const configuration = await this.deposits.configuration(
      { hotelId: requireUuid(hotelIdParam, 'hotelId') },
      actorOf(request),
      newBillingRequest(principalOf(request).accountId),
    );
    return { configuration };
  }

  @Put('deposit-configuration')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Configure the deposit, 50,000₮–100,000₮ (deposit.config_manage)' })
  @ApiResponse({ status: 400, description: 'the amount is outside the configured range' })
  async configure(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ configuration: readonly DepositConfigView[] }> {
    const payload = body(request);
    const categoryId = optionalUuid(payload['categoryId'], 'categoryId');
    const configuration = await this.deposits.configure(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        idempotencyKey: idempotencyKey(request),
        ...(categoryId === undefined ? {} : { categoryId }),
        amountMnt: requireAmountMnt(payload['amountMnt'], 'amountMnt'),
      },
      actorOf(request),
      newBillingRequest(principalOf(request).accountId),
    );
    return { configuration };
  }

  @Get('stays/:stayId/folio')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The consolidated bill, its movements and the deposit' })
  async folio(
    @Param('hotelId') hotelIdParam: string,
    @Param('stayId') stayIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<FolioView> {
    return this.folios.view(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        stayId: requireUuid(stayIdParam, 'stayId'),
      },
      actorOf(request),
      newBillingRequest(principalOf(request).accountId),
    );
  }

  @Post('stays/:stayId/folio/charges')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Post the room charge and the settled minibar charge' })
  async postCharges(
    @Param('hotelId') hotelIdParam: string,
    @Param('stayId') stayIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<FolioView> {
    return this.folios.postCharges(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        stayId: requireUuid(stayIdParam, 'stayId'),
        idempotencyKey: idempotencyKey(request),
      },
      actorOf(request),
      newBillingRequest(principalOf(request).accountId),
    );
  }

  @Post('stays/:stayId/folio/payments')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Record a payment against the bill (deposit.collect_deduct_refund)' })
  @ApiResponse({ status: 412, description: 'PROVIDER_NOT_PAID, PAYMENT_ABOVE_BALANCE' })
  async pay(
    @Param('hotelId') hotelIdParam: string,
    @Param('stayId') stayIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<FolioView> {
    const payload = body(request);
    const view = await this.folios.pay(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        stayId: requireUuid(stayIdParam, 'stayId'),
        idempotencyKey: idempotencyKey(request),
        channel: requireChannel(payload['channel']),
        amountMnt: requireAmountMnt(payload['amountMnt'], 'amountMnt'),
        ...this.references(payload),
      },
      actorOf(request),
      newBillingRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return view;
  }

  @Post('stays/:stayId/folio/allocations')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Apply the deposit to a line of the bill (DEP-DEC-002)' })
  @ApiResponse({ status: 412, description: 'ALLOCATION_ABOVE_AVAILABLE, DEPOSIT_FROZEN' })
  async allocate(
    @Param('hotelId') hotelIdParam: string,
    @Param('stayId') stayIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<FolioView> {
    const payload = body(request);
    const view = await this.folios.allocate(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        stayId: requireUuid(stayIdParam, 'stayId'),
        idempotencyKey: idempotencyKey(request),
        folioLineId: requireUuid(payload['folioLineId'], 'folioLineId'),
        amountMnt: requireAmountMnt(payload['amountMnt'], 'amountMnt'),
      },
      actorOf(request),
      newBillingRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return view;
  }

  @Post('stays/:stayId/folio/settle')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Close the bill once nothing is left to pay' })
  @ApiResponse({ status: 412, description: 'FOLIO_UNPAID' })
  async settle(
    @Param('hotelId') hotelIdParam: string,
    @Param('stayId') stayIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<FolioView> {
    const payload = body(request);
    return this.folios.settle(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        stayId: requireUuid(stayIdParam, 'stayId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
      },
      actorOf(request),
      newBillingRequest(principalOf(request).accountId),
    );
  }

  @Post('stays/:stayId/deposit')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Take the deposit on one of the four channels (RC-DEC-004)' })
  @ApiResponse({ status: 412, description: 'DEPOSIT_NOT_REQUIRED, DEPOSIT_FROZEN' })
  async receive(
    @Param('hotelId') hotelIdParam: string,
    @Param('stayId') stayIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<FolioView> {
    const payload = body(request);
    const view = await this.deposits.receive(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        stayId: requireUuid(stayIdParam, 'stayId'),
        idempotencyKey: idempotencyKey(request),
        channel: requireChannel(payload['channel']),
        amountMnt: requireAmountMnt(payload['amountMnt'], 'amountMnt'),
        ...this.references(payload),
      },
      actorOf(request),
      newBillingRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return view;
  }

  @Post('stays/:stayId/deposit/refunds')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Refund the unused deposit; naming a channel is the exception' })
  @ApiResponse({ status: 412, description: 'REFUND_ABOVE_AVAILABLE, DEPOSIT_FROZEN' })
  async requestRefund(
    @Param('hotelId') hotelIdParam: string,
    @Param('stayId') stayIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<FolioView> {
    const payload = body(request);
    const channel =
      payload['channel'] === undefined ? undefined : requireChannel(payload['channel']);
    const reason = optionalString(payload['reason'], 'reason', 300);
    const view = await this.refunds.request(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        stayId: requireUuid(stayIdParam, 'stayId'),
        idempotencyKey: idempotencyKey(request),
        originalTransactionId: requireUuid(
          payload['originalTransactionId'],
          'originalTransactionId',
        ),
        amountMnt: requireAmountMnt(payload['amountMnt'], 'amountMnt'),
        ...(channel === undefined ? {} : { channel }),
        ...(reason === undefined ? {} : { reason }),
      },
      actorOf(request),
      newBillingRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return view;
  }

  @Post('deposit-refunds/:requestId/decide')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Approve or reject an alternate channel (alternate_refund_decide)' })
  async decideRefund(
    @Param('hotelId') hotelIdParam: string,
    @Param('requestId') requestIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<FolioView> {
    const payload = body(request);
    return this.refunds.decide(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        requestId: requireUuid(requestIdParam, 'requestId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        approve: payload['approve'] === true,
        reason: requireString(payload['reason'], 'reason', 300),
      },
      actorOf(request),
      newBillingRequest(principalOf(request).accountId),
    );
  }

  @Post('deposit-refunds/:requestId/execute')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Send the refund; only a provider success settles it' })
  @ApiResponse({ status: 412, description: 'APPROVAL_REQUIRED, DEPOSIT_FROZEN' })
  async executeRefund(
    @Param('hotelId') hotelIdParam: string,
    @Param('requestId') requestIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<FolioView> {
    const payload = body(request);
    const shiftId = optionalUuid(payload['shiftId'], 'shiftId');
    const providerReference = optionalString(
      payload['providerReference'],
      'providerReference',
      120,
    );
    const approvalCode = optionalString(payload['approvalCode'], 'approvalCode', 60);
    return this.refunds.execute(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        requestId: requireUuid(requestIdParam, 'requestId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        ...(shiftId === undefined ? {} : { shiftId }),
        ...(providerReference === undefined ? {} : { providerReference }),
        ...(approvalCode === undefined ? {} : { approvalCode }),
      },
      actorOf(request),
      newBillingRequest(principalOf(request).accountId),
    );
  }

  @Post('deposit-refunds/:requestId/release')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Release the reservation on proof no money moved (refund_release)' })
  @ApiResponse({ status: 412, description: 'PROVIDER_NOT_AUTHORITATIVE' })
  async releaseRefund(
    @Param('hotelId') hotelIdParam: string,
    @Param('requestId') requestIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<FolioView> {
    const payload = body(request);
    return this.refunds.release(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        requestId: requireUuid(requestIdParam, 'requestId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        reason: requireString(payload['reason'], 'reason', 300),
      },
      actorOf(request),
      newBillingRequest(principalOf(request).accountId),
    );
  }

  @Post('deposit-refunds/:requestId/provider-check')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Ask the provider again about a released refund (DEP-DEC-009)' })
  async checkRefund(
    @Param('hotelId') hotelIdParam: string,
    @Param('requestId') requestIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<FolioView> {
    return this.refunds.checkForLateSuccess(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        requestId: requireUuid(requestIdParam, 'requestId'),
        idempotencyKey: idempotencyKey(request),
      },
      actorOf(request),
      newBillingRequest(principalOf(request).accountId),
    );
  }

  @Post('stays/:stayId/financial-corrections')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Ask for a wrong movement to be reversed and re-recorded' })
  @ApiResponse({ status: 409, description: 'CORRECTION_ALREADY_OPEN' })
  async requestCorrection(
    @Param('hotelId') hotelIdParam: string,
    @Param('stayId') stayIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<FolioView> {
    const payload = body(request);
    const channel =
      payload['correctedChannel'] === undefined
        ? undefined
        : requireChannel(payload['correctedChannel']);
    const reference = optionalString(payload['correctedReference'], 'correctedReference', 120);
    const amount =
      payload['correctedAmountMnt'] === undefined
        ? undefined
        : requireAmountMnt(payload['correctedAmountMnt'], 'correctedAmountMnt');
    const view = await this.corrections.request(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        stayId: requireUuid(stayIdParam, 'stayId'),
        idempotencyKey: idempotencyKey(request),
        originalTransactionId: requireUuid(
          payload['originalTransactionId'],
          'originalTransactionId',
        ),
        reason: requireString(payload['reason'], 'reason', 300),
        ...(amount === undefined ? {} : { correctedAmountMnt: amount }),
        ...(channel === undefined ? {} : { correctedChannel: channel }),
        ...(reference === undefined ? {} : { correctedReference: reference }),
      },
      actorOf(request),
      newBillingRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return view;
  }

  @Post('financial-corrections/:correctionId/decide')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Decide it; approving posts the reversal and the corrected record' })
  async decideCorrection(
    @Param('hotelId') hotelIdParam: string,
    @Param('correctionId') correctionIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<FolioView> {
    const payload = body(request);
    return this.corrections.decide(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        correctionId: requireUuid(correctionIdParam, 'correctionId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        approve: payload['approve'] === true,
        decisionReason: requireString(payload['decisionReason'], 'decisionReason', 300),
      },
      actorOf(request),
      newBillingRequest(principalOf(request).accountId),
    );
  }

  private references(payload: Record<string, unknown>): {
    providerReference?: string;
    approvalCode?: string;
    terminalId?: string;
    shiftId?: string;
  } {
    const providerReference = optionalString(
      payload['providerReference'],
      'providerReference',
      120,
    );
    const approvalCode = optionalString(payload['approvalCode'], 'approvalCode', 60);
    const terminalId = optionalString(payload['terminalId'], 'terminalId', 60);
    const shiftId = optionalUuid(payload['shiftId'], 'shiftId');
    return {
      ...(providerReference === undefined ? {} : { providerReference }),
      ...(approvalCode === undefined ? {} : { approvalCode }),
      ...(terminalId === undefined ? {} : { terminalId }),
      ...(shiftId === undefined ? {} : { shiftId }),
    };
  }
}
