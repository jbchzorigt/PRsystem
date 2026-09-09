import { ApiError } from '@prsystem/contracts';
import { completeIdempotencyKey, recordPoliceAudit } from '@prsystem/db';
import type { UnitOfWork } from '@prsystem/db';
import type { CaseState } from '../domain/police';
import { caseTransitionAllowed, isTerminalCase } from '../domain/police';
import { PoliceRepository } from '../repositories/police.repository';
import type { CommandActor, PoliceDependencies, RequestContext } from './police-context';
import {
  CASE_STATE_MANAGE,
  DRAFT_CREATE,
  PoliceServiceBase,
  WANTED_VIEW,
  claim,
} from './police-context';

/**
 * The wanted case and its lifecycle (doc 13 §7, `POL-DEC-018`).
 *
 * A case is the *reason* somebody is wanted, and a person may have several.
 * Only an `ACTIVE` case takes part in matching, which is why activation is the
 * one transition that does something beyond changing a word: doc 13 §8.3's
 * second trigger sweeps the guests who are in hotels at that moment, once.
 *
 * Nothing here closes a case because a person was found. `POL-DEC-013` is
 * explicit that a Found outcome resolves one match and decides nothing about
 * the cases — somebody with `WANTED_CASE_STATE_MANAGE` decides each of them,
 * separately, and a case left active keeps matching.
 */

export interface CaseView {
  readonly caseId: string;
  readonly personId: string;
  readonly state: CaseState;
  readonly crimeCategory: string;
  readonly owningUnitRef: string;
  readonly activatedAt: Date | null;
}

export interface ActivationOutcome extends CaseView {
  /** How many stays the activation sweep matched, if it ran (doc 13 §8.3). */
  readonly sweptMatches: number;
}

export class WantedCaseService extends PoliceServiceBase {
  constructor(deps: PoliceDependencies) {
    super(deps);
  }

  /** doc 13 §6.1 steps 5 and 6: the reason and the category the officer enters. */
  async open(
    input: {
      personId: string;
      reasonText: string;
      crimeCategory: string;
      owningUnitRef: string;
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<CaseView> {
    return this.runPoliceCommand(actor, DRAFT_CREATE, request, async (uow, authorize) => {
      const claimed = await claim(uow, 'police.case_open', input.idempotencyKey, {
        personId: input.personId,
      });
      if (claimed.kind === 'replay') return claimed.body as CaseView;
      await authorize({ targetRef: input.personId });

      const repository = new PoliceRepository(uow);
      const person = await repository.lockPerson(input.personId);
      if (person === undefined) throw new ApiError('NOT_FOUND', 'no such wanted person');

      const opened = await repository.insertCase({
        personId: input.personId,
        reasonText: input.reasonText,
        crimeCategory: input.crimeCategory,
        owningUnitRef: input.owningUnitRef,
        createdByAccountId: actor.principal.accountId,
      });
      await recordPoliceAudit(uow, {
        action: 'police.wanted_case.opened',
        outcome: 'allowed',
        caseRef: opened.caseId,
        payload: { category: opened.crimeCategory, unit: opened.owningUnitRef },
      });
      const view = this.view(opened);
      await completeIdempotencyKey(uow, claimed.idempotencyId, 201, view);
      return view;
    });
  }

  /**
   * Every lifecycle move, under one permission and one mandatory reason
   * (doc 13 §7). The transition table is the domain's, the compare-and-set is
   * the row's, and the sweep is only ever attached to an activation.
   */
  async move(
    input: {
      caseId: string;
      to: CaseState;
      reason: string;
      expectedRevision: number;
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ActivationOutcome> {
    const outcome = await this.runPoliceCommand(
      actor,
      CASE_STATE_MANAGE,
      request,
      async (uow, authorize) => {
        const claimed = await claim(uow, 'police.case_move', input.idempotencyKey, {
          caseId: input.caseId,
          to: input.to,
        });
        if (claimed.kind === 'replay') {
          return { view: claimed.body as CaseView, activated: false, token: undefined };
        }
        await authorize({ targetRef: input.caseId });

        const repository = new PoliceRepository(uow);
        const current = await repository.lockCase(input.caseId);
        if (current === undefined) throw new ApiError('NOT_FOUND', 'no such wanted case');
        if (current.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'that case changed under this command');
        }
        if (!caseTransitionAllowed(current.state, input.to)) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            `a case cannot move from ${current.state} to ${input.to}`,
          );
        }
        // `POL-DEC-018`: a case becomes active only once its person's identity
        // has been approved. A manual identity that nobody has approved yet
        // cannot start matching by having its case activated instead.
        if (input.to === 'ACTIVE') {
          const revision = await repository.currentRevision(current.personId);
          if (revision === undefined) {
            throw new ApiError(
              'PRECONDITION_FAILED',
              'IDENTITY_NOT_APPROVED: the wanted identity has no approved revision',
            );
          }
        }

        const now = this.now(uow);
        const moved = await repository.moveCase({
          caseId: current.caseId,
          expectedRevision: current.revision,
          to: input.to,
          at: now,
          terminal: isTerminalCase(input.to),
        });
        if (!moved) throw new ApiError('CONFLICT', 'that case changed under this command');
        await repository.appendCaseEvent({
          caseId: current.caseId,
          fromState: current.state,
          toState: input.to,
          reason: input.reason,
          actorAccountId: actor.principal.accountId,
          at: now,
        });
        await recordPoliceAudit(uow, {
          action: 'police.wanted_case.state_changed',
          outcome: 'allowed',
          caseRef: current.caseId,
          reason: input.reason,
          payload: { from: current.state, to: input.to },
        });

        const reread = await repository.caseById(current.caseId);
        const view = this.view(reread ?? { ...current, state: input.to });
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, view);
        const token =
          input.to === 'ACTIVE' ? await this.matchTokenOf(uow, current.personId) : undefined;
        return { view, activated: input.to === 'ACTIVE', token };
      },
      { targetType: 'wanted_case' },
    );

    // The sweep runs after the transition commits: a case that is not yet
    // active must not produce a match, and a match must not be rolled back by
    // an activation that failed afterwards.
    const swept =
      outcome.activated && outcome.token !== undefined
        ? await this.sweepActiveStays(outcome.token, request)
        : 0;
    return { ...outcome.view, sweptMatches: swept };
  }

  /** The cases of one person, for the officer reading their record. */
  async list(
    personId: string,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<readonly CaseView[]> {
    return this.runPoliceCommand(actor, WANTED_VIEW, request, async (uow, authorize) => {
      await authorize({ targetRef: personId });
      const cases = await new PoliceRepository(uow).casesOf(personId);
      return cases.map((row) => this.view(row));
    });
  }

  /**
   * doc 13 §8.3, trigger 2: the guests who are in hotels right now.
   *
   * The stays come from a `SECURITY DEFINER` function that answers only for the
   * token this person already is, and each one is then offered to the very
   * function the check-in path calls — so both triggers create a match the same
   * way, and neither can create one the other would not have.
   *
   * A stay that already produced a match for this person is left alone: the
   * unique pair makes the second attempt a no-op, which is what stops an
   * activation from alerting twice about the same guest.
   */
  async sweepActiveStays(
    token: { namespace: string; token: string; keyVersion: string },
    request: RequestContext,
  ): Promise<number> {
    return this.inPoliceScope(request, async (uow) => {
      const stays = await uow.query<{
        stay_id: string;
        hotel_id: string;
        room_number: string;
        check_in_recorded_at: Date;
        actual_check_in_at: Date;
      }>(
        `SELECT stay_id, hotel_id, room_number, check_in_recorded_at, actual_check_in_at
           FROM police.active_stays_for_match($1, $2, $3)`,
        [token.namespace, token.token, token.keyVersion],
      );
      const now = this.now(uow);
      let created = 0;
      for (const stay of stays.rows) {
        const matched = await uow.query<{ match_id: string | null }>(
          `SELECT police.record_check_in_match(
                    $1::uuid, $2::uuid, $3, $4, $5, $6, 'ELIGIBLE_EXACT_RD', $7, $8, $9)
                  AS match_id`,
          [
            stay.stay_id,
            stay.hotel_id,
            stay.room_number,
            stay.check_in_recorded_at,
            stay.actual_check_in_at,
            now,
            token.namespace,
            token.token,
            token.keyVersion,
          ],
        );
        if (matched.rows[0]?.match_id != null) created += 1;
      }
      if (created > 0) {
        await recordPoliceAudit(uow, {
          action: 'police.wanted_case.activation_sweep',
          outcome: 'allowed',
          payload: { matches: created, stays: stays.rows.length },
        });
      }
      return created;
    });
  }

  /** The platform-scope token a match is compared on, for this person. */
  private async matchTokenOf(
    uow: UnitOfWork,
    personId: string,
  ): Promise<{ namespace: string; token: string; keyVersion: string } | undefined> {
    const person = await new PoliceRepository(uow).lockPerson(personId);
    if (person === undefined) return undefined;
    return {
      namespace: person.matchNamespace,
      token: person.matchToken,
      keyVersion: person.matchKeyVersion,
    };
  }

  private view(row: {
    caseId: string;
    personId: string;
    state: CaseState;
    crimeCategory: string;
    owningUnitRef: string;
    activatedAt: Date | null;
  }): CaseView {
    return {
      caseId: row.caseId,
      personId: row.personId,
      state: row.state,
      crimeCategory: row.crimeCategory,
      owningUnitRef: row.owningUnitRef,
      activatedAt: row.activatedAt,
    };
  }
}
