import { Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { ApiError } from '@prsystem/contracts';
import { body, idempotencyKey, requireString, requireUuid } from '../../iam/http/validation';
import { requireRevision } from '../../catalog/http/catalog-validation';
import { ReconciliationService } from '../services/reconciliation.service';
import { newBillingRequest } from '../services/billing-context';
import type { CaseView } from '../services/billing-views';

/**
 * The late-success reconciliation (`DEP-DEC-010`). Every route here is a
 * Platform Operation action: `operation.deposit_refund_reconcile`, explicitly
 * granted and step-up gated. No hotel role reaches it.
 */
@ApiTags('billing-reconciliation')
@Controller('hotels/:hotelId/deposit-reconciliation')
export class ReconciliationController {
  constructor(@Inject(ReconciliationService) private readonly cases: ReconciliationService) {}

  @Get()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The open late-refund cases of a hotel' })
  async list(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ cases: readonly CaseView[] }> {
    const cases = await this.cases.list(
      { hotelId: requireUuid(hotelIdParam, 'hotelId') },
      actorOf(request),
      newBillingRequest(principalOf(request).accountId),
    );
    return { cases };
  }

  @Post(':caseId/claim')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Claim a case; one claimant, and only the claimant resolves it' })
  async claim(
    @Param('hotelId') hotelIdParam: string,
    @Param('caseId') caseIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<CaseView> {
    const payload = body(request);
    return this.cases.claimCase(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        caseId: requireUuid(caseIdParam, 'caseId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
      },
      actorOf(request),
      newBillingRequest(principalOf(request).accountId),
    );
  }

  @Post(':caseId/resolve')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Resolve it: nothing moved, or post the covered refund and the shortfall',
  })
  @ApiResponse({ status: 409, description: 'CASE_NOT_CLAIMED' })
  @ApiResponse({ status: 403, description: 'CASE_NOT_YOURS' })
  async resolve(
    @Param('hotelId') hotelIdParam: string,
    @Param('caseId') caseIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<CaseView> {
    const payload = body(request);
    const outcome = payload['outcome'];
    if (
      outcome !== 'PROVIDER_STATUS_CORRECTED_NOT_SUCCESS' &&
      outcome !== 'PROVIDER_SUCCESS_POSTED'
    ) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'outcome: must be PROVIDER_STATUS_CORRECTED_NOT_SUCCESS or PROVIDER_SUCCESS_POSTED',
        [{ field: 'outcome', issue: 'unknown outcome' }],
      );
    }
    return this.cases.resolve(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        caseId: requireUuid(caseIdParam, 'caseId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        outcome,
        note: requireString(payload['note'], 'note', 300),
      },
      actorOf(request),
      newBillingRequest(principalOf(request).accountId),
    );
  }
}
