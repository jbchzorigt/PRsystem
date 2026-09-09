import { Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiError } from '@prsystem/contracts';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, requireString, requireUuid } from '../../iam/http/validation';
import { EBarimtService } from '../services/ebarimt.service';
import { ProvisioningService } from '../services/provisioning.service';
import { SubscriptionService } from '../services/subscription.service';
import { newOnboardingRequest } from '../services/onboarding-context';
import type { ReconciliationOutcome } from '../../operation/domain/operation';
import { isReconciliationOutcome } from '../../operation/domain/operation';

function requireOutcome(value: unknown): ReconciliationOutcome {
  const outcome = requireString(value, 'outcome', 60);
  if (!isReconciliationOutcome(outcome)) {
    throw new ApiError('VALIDATION_FAILED', 'the request is not valid', [
      { field: 'outcome', issue: 'unknown reconciliation outcome' },
    ]);
  }
  return outcome;
}

/** doc 14 §4.2: both the reference and the note are mandatory and bounded. */
function requireEvidence(payload: Record<string, unknown>): { reason: string; reference: string } {
  const reason = requireString(payload['reason'], 'reason', 1000);
  const reference = requireString(payload['reference'], 'reference', 120);
  if (reason.trim().length < 10 || reference.trim().length < 3) {
    throw new ApiError('VALIDATION_FAILED', 'the request is not valid', [
      { field: 'reason', issue: 'a note of at least ten characters is required' },
      { field: 'reference', issue: 'a provider, bank or finance reference is required' },
    ]);
  }
  return { reason: reason.trim(), reference: reference.trim() };
}

/**
 * The Operation surface of Phase 05 (doc 14; doc 18 §5).
 *
 * `SessionGuard` authenticates and nothing more. Every handler hands the actor
 * to a command that evaluates the Phase 04 pipeline in the Operation realm —
 * realm, role column, the explicit named permission and a recent step-up —
 * inside the transaction that applies the effect, and audits it. A Hotel-realm
 * session reaching any of these gets the same `NOT_FOUND` a stranger gets.
 *
 * What is **not** here: a route that writes a receipt field, a route that
 * applies a package, a term, an entitlement or a date from a reconciliation,
 * and the offline ownership verification of doc 15 §3.1 (3) — that surface is
 * Phase 19's, and until it exists the production action is not reachable.
 */
@ApiTags('operation')
@Controller('operation')
export class OperationController {
  constructor(
    @Inject(EBarimtService) private readonly ebarimt: EBarimtService,
    @Inject(ProvisioningService) private readonly provisioning: ProvisioningService,
    @Inject(SubscriptionService) private readonly subscriptions: SubscriptionService,
  ) {}

  @Get('ebarimt/manual-queue')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The eBarimt issuances awaiting manual resolution, across hotels' })
  @ApiResponse({ status: 404, description: 'Not an Operation account holding the permission' })
  @ApiResponse({ status: 412, description: 'A recent step-up authentication is required' })
  async manualQueue(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ items: readonly Record<string, unknown>[] }> {
    const items = await this.ebarimt.manualQueue(
      actorOf(request),
      newOnboardingRequest(principalOf(request).accountId),
    );
    return {
      items: items.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
    };
  }

  @Post('ebarimt/issuances/:hotelId/:issuanceId/retry')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Ask the issuer again for a receipt in manual resolution' })
  async retryIssuance(
    @Param('hotelId') hotelIdParam: string,
    @Param('issuanceId') issuanceIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    // No body is read: there is no receipt field an operator may supply.
    const outcome = await this.ebarimt.retry(
      requireUuid(hotelIdParam, 'hotelId'),
      requireUuid(issuanceIdParam, 'issuanceId'),
      actorOf(request),
      newOnboardingRequest(principalOf(request).accountId),
    );
    return { ...outcome };
  }

  @Post('onboarding/applications/:applicationId/provisioning/retry')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Retry a failed paid provisioning' })
  async retryProvisioning(
    @Param('applicationId') applicationIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const outcome = await this.provisioning.retryProvisioning(
      requireUuid(applicationIdParam, 'applicationId'),
      actorOf(request),
      newOnboardingRequest(principalOf(request).accountId),
    );
    return { ...outcome };
  }

  @Post('onboarding/applications/:applicationId/reconciliations/:attemptId')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Close an onboarding payment reconciliation case' })
  async reconcileOnboarding(
    @Param('applicationId') applicationIdParam: string,
    @Param('attemptId') attemptIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ closed: true }> {
    const payload = body(request);
    await this.provisioning.closeReconciliation(
      {
        applicationId: requireUuid(applicationIdParam, 'applicationId'),
        attemptId: requireUuid(attemptIdParam, 'attemptId'),
        outcome: requireOutcome(payload['outcome']),
        ...requireEvidence(payload),
      },
      actorOf(request),
      newOnboardingRequest(principalOf(request).accountId),
    );
    return { closed: true };
  }

  @Post('subscriptions/:hotelId/reconciliations/:intentId')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Close a subscription payment reconciliation case' })
  async reconcileSubscription(
    @Param('hotelId') hotelIdParam: string,
    @Param('intentId') intentIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ closed: true }> {
    const payload = body(request);
    await this.subscriptions.closeReconciliation(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        intentId: requireUuid(intentIdParam, 'intentId'),
        outcome: requireOutcome(payload['outcome']),
        ...requireEvidence(payload),
      },
      actorOf(request),
      newOnboardingRequest(principalOf(request).accountId),
    );
    return { closed: true };
  }
}
