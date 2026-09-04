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
import { body, idempotencyKey, requireUuid } from '../../iam/http/validation';
import { optionalString, requireMnt, requireRevision } from '../../catalog/http/catalog-validation';
import { newFinanceRequest } from '../services/finance-context';
import { CashRequestService } from '../services/request.service';
import { ExpenseService } from '../services/expense.service';
import type { ExpenseView, RequestView } from '../services/finance-views';
import {
  requireDecision,
  requireExpenseMethod,
  requireRequestKind,
  requireText,
} from './finance-validation';

/**
 * Hotel expenses, bank deposits and owner withdrawals (doc 23, doc 24 §§10–11).
 *
 * An approval and a payment are two different requests here because they are
 * two different facts: approving decides an expense may be paid, and only the
 * payment moves anything (`FIN-DEC-005`).
 */
@ApiTags('hotel-finance')
@Controller('hotels/:hotelId/finance')
export class ExpenseController {
  constructor(
    @Inject(ExpenseService) private readonly expenses: ExpenseService,
    @Inject(CashRequestService) private readonly requests: CashRequestService,
  ) {}

  @Get('expenses')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The hotel’s expenses and their states' })
  async list(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ expenses: readonly ExpenseView[] }> {
    return this.expenses.expenses(
      { hotelId: requireUuid(hotelIdParam, 'hotelId') },
      actorOf(request),
      newFinanceRequest(principalOf(request).accountId),
    );
  }

  @Post('expenses')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Submit an expense for approval (hotel.expense.request_submit)' })
  async submit(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ExpenseView> {
    const payload = body(request);
    const expense = await this.expenses.submit(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        idempotencyKey: idempotencyKey(request),
        category: requireText(payload['category'], 'category', 80),
        description: requireText(payload['description'], 'description', 300),
        amountMnt: requireMnt(payload['amountMnt'], 'amountMnt'),
        method: requireExpenseMethod(payload['method']),
      },
      actorOf(request),
      newFinanceRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return expense;
  }

  @Post('expenses/:expenseId/decide')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Approve or reject an expense — an approval moves no cash' })
  async decide(
    @Param('hotelId') hotelIdParam: string,
    @Param('expenseId') expenseIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ExpenseView> {
    const payload = body(request);
    const reason = optionalString(payload['reason'], 'reason', 300);
    return this.expenses.decide(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        expenseId: requireUuid(expenseIdParam, 'expenseId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        decision: requireDecision(payload['decision']),
        ...(reason === undefined ? {} : { reason }),
      },
      actorOf(request),
      newFinanceRequest(principalOf(request).accountId),
    );
  }

  @Post('expenses/:expenseId/pay')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Pay an approved expense (CASH-DEC-005)' })
  @ApiResponse({ status: 412, description: 'INSUFFICIENT_CASH or NO_ACTIVE_SHIFT' })
  async pay(
    @Param('hotelId') hotelIdParam: string,
    @Param('expenseId') expenseIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ExpenseView> {
    const payload = body(request);
    const providerReference = optionalString(
      payload['providerReference'],
      'providerReference',
      120,
    );
    const locationId = payload['locationId'];
    return this.expenses.pay(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        expenseId: requireUuid(expenseIdParam, 'expenseId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        ...(locationId === undefined || locationId === null
          ? {}
          : { locationId: requireUuid(locationId, 'locationId') }),
        ...(providerReference === undefined ? {} : { providerReference }),
      },
      actorOf(request),
      newFinanceRequest(principalOf(request).accountId),
    );
  }

  @Get('cash-requests')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Bank deposit and owner withdrawal requests' })
  async cashRequests(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ requests: readonly RequestView[] }> {
    return this.requests.requests(
      { hotelId: requireUuid(hotelIdParam, 'hotelId') },
      actorOf(request),
      newFinanceRequest(principalOf(request).accountId),
    );
  }

  @Post('cash-requests')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Ask to bank cash or to pay an owner out (doc 24 §10)' })
  async createRequest(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<RequestView> {
    const payload = body(request);
    const reference = optionalString(payload['reference'], 'reference', 120);
    const recipient = optionalString(payload['recipient'], 'recipient', 120);
    const created = await this.requests.create(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        idempotencyKey: idempotencyKey(request),
        kind: requireRequestKind(payload['kind']),
        locationId: requireUuid(payload['locationId'], 'locationId'),
        amountMnt: requireMnt(payload['amountMnt'], 'amountMnt'),
        reason: requireText(payload['reason'], 'reason', 300),
        ...(reference === undefined ? {} : { reference }),
        ...(recipient === undefined ? {} : { recipient }),
      },
      actorOf(request),
      newFinanceRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return created;
  }

  @Post('cash-requests/:requestId/decide')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Approve or refuse it; approving is the outflow itself' })
  async decideRequest(
    @Param('hotelId') hotelIdParam: string,
    @Param('requestId') requestIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<RequestView> {
    const payload = body(request);
    const reason = optionalString(payload['reason'], 'reason', 300);
    return this.requests.decide(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        requestId: requireUuid(requestIdParam, 'requestId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        decision: requireDecision(payload['decision']),
        ...(reason === undefined ? {} : { reason }),
      },
      actorOf(request),
      newFinanceRequest(principalOf(request).accountId),
    );
  }
}
