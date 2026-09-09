import { ApiError } from '@prsystem/contracts';
import { OperationRepository } from '../repositories/operation.repository';
import type { RecoveryDecision } from '../domain/operation';
import type { CommandActor, OperationDependencies, RequestContext } from './operation-context';
import { RECOVERY_APPROVE, RESET_INITIATE, OperationServiceBase, claim } from './operation-context';

/**
 * The offline ownership-recovery handoff (doc 14 §2.2, `OPS-DEC-009`).
 *
 * What this service is for is what it refuses to do. There is no method that
 * changes an address, no method that sends a reset anywhere but the registered
 * one, and no method that records a "verified" flag — because doc 14 §2.2 puts
 * the identity check in an approved offline procedure that this MVP does not
 * perform. An Operation user may record that somebody has lost access; a
 * Platform Super Admin holding `ACCOUNT_OWNERSHIP_RECOVERY_APPROVE` records the
 * decision that procedure reached; and the two must be different people.
 *
 * The escalation itself is opened under `SUBSCRIPTION_PASSWORD_RESET_INITIATE`
 * — the permission that already lets an operator act on that account's access —
 * and the decision needs its own. `A-P19-5` records that doc 18 §5 names a
 * permission for the decision and none for the referral, so no new permission
 * was invented for it.
 */

export interface RecoveryRequestView {
  readonly requestId: string;
  readonly accountId: string;
  readonly state: string;
  readonly caseReference: string;
  readonly requestedAt: Date;
  readonly decidedAt: Date | null;
}

export class OperationRecoveryService extends OperationServiceBase {
  constructor(deps: OperationDependencies) {
    super(deps);
  }

  /** Records the support request and hands it on. It sends nothing to anybody. */
  async escalate(
    actor: CommandActor,
    input: {
      hotelId: string;
      caseReference: string;
      note: string;
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<{ requestId: string; accountId: string }> {
    return this.runOperationCommand(
      actor,
      RESET_INITIATE,
      { targetType: 'hotel', targetRef: input.hotelId },
      request,
      async (uow) => {
        const claimed = await claim(uow, 'operation.recovery.escalate', input.idempotencyKey, {
          hotelId: input.hotelId,
          caseReference: input.caseReference,
        });
        if (claimed.kind === 'replay') {
          return claimed.body as { requestId: string; accountId: string };
        }

        // The account is resolved through the masking resolver, so this surface
        // names the subscription account without the operator ever reading the
        // address they are escalating about.
        const repository = new OperationRepository(uow);
        const account = await repository.subscriptionAccount(input.hotelId);
        if (account === undefined) throw new ApiError('NOT_FOUND', 'not found');
        const accountId = account.accountId;

        const requestId = await repository.createRecoveryRequest({
          accountId,
          caseReference: input.caseReference,
          note: input.note,
          requestedBy: actor.principal.accountId,
        });

        await this.audit(uow, {
          action: 'operation.recovery.escalated',
          outcome: 'allowed',
          targetType: 'account_recovery_request',
          targetRef: requestId,
          payload: { hotelId: input.hotelId, caseReference: input.caseReference },
        });

        const result = { requestId, accountId };
        await this.complete(uow, claimed.idempotencyId, result);
        return result;
      },
    );
  }

  /**
   * The Platform Super Admin's decision.
   *
   * An approval records that the offline procedure concluded; it changes no
   * address and grants no access, because doc 14 §2.2 keeps both outside the
   * MVP. What it does is close the case with a named decider, a mandatory
   * reason and a recent step-up — and the row's own CHECK refuses a decider who
   * is the requester.
   */
  async decide(
    actor: CommandActor,
    input: {
      requestId: string;
      decision: RecoveryDecision;
      reason: string;
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<{ requestId: string; decision: RecoveryDecision }> {
    return this.runOperationCommand(
      actor,
      RECOVERY_APPROVE,
      { targetType: 'account_recovery_request', targetRef: input.requestId },
      request,
      async (uow) => {
        const claimed = await claim(uow, 'operation.recovery.decide', input.idempotencyKey, {
          requestId: input.requestId,
          decision: input.decision,
        });
        if (claimed.kind === 'replay') {
          return claimed.body as { requestId: string; decision: RecoveryDecision };
        }

        const repository = new OperationRepository(uow);
        const open = await repository.lockRecoveryRequest(input.requestId);
        if (open === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (open.state !== 'PENDING') {
          throw new ApiError('CONFLICT', 'this recovery request is already decided');
        }
        if (open.requestedByAccountId === actor.principal.accountId) {
          throw new ApiError(
            'FORBIDDEN',
            'the operator who escalated a recovery may not decide it',
          );
        }

        if (
          !(await repository.decideRecoveryRequest({
            requestId: input.requestId,
            decision: input.decision,
            reason: input.reason,
            decidedBy: actor.principal.accountId,
            expectedRevision: open.revision,
          }))
        ) {
          throw new ApiError('CONFLICT', 'the recovery request moved while it was being decided');
        }

        await this.audit(uow, {
          action: 'operation.recovery.decided',
          outcome: 'allowed',
          targetType: 'account_recovery_request',
          targetRef: input.requestId,
          reason: input.decision,
        });

        const result = { requestId: input.requestId, decision: input.decision };
        await this.complete(uow, claimed.idempotencyId, result);
        return result;
      },
    );
  }

  /** The open escalations, for the Super Admin's queue. */
  async pending(
    actor: CommandActor,
    request: RequestContext,
  ): Promise<readonly RecoveryRequestView[]> {
    return this.runOperationCommand(
      actor,
      RECOVERY_APPROVE,
      { targetType: 'account_recovery_request', targetRef: 'queue' },
      request,
      async (uow) => {
        const result = await uow.query<Record<string, unknown>>(
          `SELECT request_id, account_id, state, case_reference, requested_at, decided_at
             FROM platform.account_recovery_request
            WHERE state = 'PENDING'
            ORDER BY requested_at, request_id
            LIMIT 200`,
        );
        return result.rows.map((row) => ({
          requestId: String(row['request_id']),
          accountId: String(row['account_id']),
          state: String(row['state']),
          caseReference: String(row['case_reference']),
          requestedAt: row['requested_at'] as Date,
          decidedAt: (row['decided_at'] as Date | null) ?? null,
        }));
      },
    );
  }
}
