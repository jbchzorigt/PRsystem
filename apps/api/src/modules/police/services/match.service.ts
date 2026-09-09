import { ApiError } from '@prsystem/contracts';
import { completeIdempotencyKey, recordPoliceAudit } from '@prsystem/db';
import type { UnitOfWork } from '@prsystem/db';
import { deriveLookupToken } from '@prsystem/ports';
import type { FalseMatchReason, MatchOutcome, MatchWorkflow } from '../domain/police';
import {
  falseMatchApprovable,
  isStructurallyValidRegistrationNumber,
  normalizeRegistrationNumber,
  separateAccounts,
  workflowAfterFoundCorrection,
  workflowTransitionAllowed,
} from '../domain/police';
import { PoliceRepository } from '../repositories/police.repository';
import type { MatchRow } from '../repositories/police.repository';
import type { CommandActor, PoliceDependencies, RequestContext } from './police-context';
import {
  ACKNOWLEDGE,
  EXACT_SEARCH,
  FALSE_MATCH_DECIDE,
  FALSE_MATCH_REQUEST,
  FOUND_CONFIRM,
  FOUND_CORRECTION_DECIDE,
  FOUND_CORRECTION_REQUEST,
  MATCH_VIEW,
  PoliceServiceBase,
  claim,
} from './police-context';

/**
 * What happens to a match after it exists (doc 13 §9).
 *
 * Four rules run through everything here.
 *
 * **Acknowledging is not owning** (`POL-DEC-011`, `POL-DEC-016`,
 * `POL-DEC-020`). The first confirmation is recorded with its account and its
 * time, and it confers nothing: every other authorised officer still sees the
 * match, still acts on it, and can still be the one who confirms a Found.
 *
 * **A Found is confirmed by whoever actually found the person**
 * (`POL-DEC-012`). Not the first acknowledger, not the district's officer —
 * the account that made the identification, signed in as themselves. Nobody
 * confirms on somebody else's behalf, which is why the account is taken from
 * the session and never from the request.
 *
 * **Two people undo a Found and two people decide a False Match**
 * (`POL-DEC-015`, `POL-DEC-019`). Both are append-only requests with a separate
 * decision, and the decider is compared to the requester on immutable account
 * ids by the pipeline, by this service and by a CHECK on the row.
 *
 * **A False Match cannot be approved over a Found.** The Found is corrected
 * first, by its own two-person path, or the approval is refused.
 */

export interface MatchView {
  readonly matchId: string;
  readonly workflowState: MatchWorkflow;
  readonly outcome: MatchOutcome;
  readonly hotelName: string;
  readonly hotelDistrict: string;
  readonly hotelAddressLine: string;
  readonly roomNumber: string;
  readonly latitudeMicro: number | null;
  readonly longitudeMicro: number | null;
  readonly detectedAt: Date;
  readonly checkInRecordedAt: Date;
  readonly actualCheckInAt: Date;
  readonly firstAcknowledgedByAccountId: string | null;
  readonly firstAcknowledgedAt: Date | null;
  readonly falseMatchReviewPending: boolean;
  readonly linkedCaseIds: readonly string[];
  readonly revision: number;
}

/** doc 13 §9: how many exact searches one account may make in a quarter of an hour. */
export const EXACT_SEARCH_LIMIT = 10;
export const EXACT_SEARCH_WINDOW_MINUTES = 15;

export class MatchService extends PoliceServiceBase {
  constructor(deps: PoliceDependencies) {
    super(deps);
  }

  async read(matchId: string, actor: CommandActor, request: RequestContext): Promise<MatchView> {
    return this.runPoliceCommand(actor, MATCH_VIEW, request, async (uow, authorize) => {
      const repository = new PoliceRepository(uow);
      const match = await repository.matchById(matchId);
      if (match === undefined) throw new ApiError('NOT_FOUND', 'no such match');
      // doc 18 §6: an Officer's match view is confined to their own unit. The
      // scope is read off the row and compared by the pipeline, which is what
      // makes an Admin's unconfined view and an Officer's confined one the same
      // command.
      await authorize({ resourceScopeRef: match.originatingUnitRef, targetRef: matchId });
      return this.view(match, await repository.linkedCases(matchId));
    });
  }

  /** `POL-DEC-011`: the first acknowledgement is a fact, not an assignment. */
  async acknowledge(
    input: { matchId: string; expectedRevision: number; idempotencyKey: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<MatchView> {
    return this.runPoliceCommand(actor, ACKNOWLEDGE, request, async (uow, authorize) => {
      const claimed = await claim(uow, 'police.match_acknowledge', input.idempotencyKey, {
        matchId: input.matchId,
      });
      if (claimed.kind === 'replay') return claimed.body as MatchView;

      const repository = new PoliceRepository(uow);
      const match = await repository.lockMatch(input.matchId);
      if (match === undefined) throw new ApiError('NOT_FOUND', 'no such match');
      await authorize({ resourceScopeRef: match.originatingUnitRef, targetRef: input.matchId });
      if (match.revision !== input.expectedRevision) {
        throw new ApiError('CONFLICT', 'that match changed under this command');
      }

      const now = this.now(uow);
      if (workflowTransitionAllowed(match.workflowState, 'ACKNOWLEDGED')) {
        const moved = await repository.acknowledgeMatch({
          matchId: match.matchId,
          expectedRevision: match.revision,
          accountId: actor.principal.accountId,
          at: now,
        });
        if (!moved) throw new ApiError('CONFLICT', 'that match changed under this command');
      }
      // A second acknowledgement is recorded and changes nothing: doc 13 §9
      // says the others keep their right to act, and this is the trace of them
      // doing so.
      await repository.appendMatchEvent({
        matchId: match.matchId,
        eventType: 'ACKNOWLEDGED',
        actorAccountId: actor.principal.accountId,
        payload: { first: match.firstAcknowledgedByAccountId === null },
        at: now,
      });
      await recordPoliceAudit(uow, {
        action: 'police.match.acknowledged',
        outcome: 'allowed',
        caseRef: match.matchId,
        payload: { first: match.firstAcknowledgedByAccountId === null },
      });

      const reread = await repository.matchById(match.matchId);
      const view = this.view(reread ?? match, await repository.linkedCases(match.matchId));
      await completeIdempotencyKey(uow, claimed.idempotencyId, 200, view);
      return view;
    });
  }

  /**
   * `POL-DEC-012`: the exact search that opens an active match.
   *
   * A whole registration number or a whole match id, and nothing else — no
   * partial number, no name, no birth date, no address. It opens one match's
   * confirmation view and never a list, so it cannot become the all-hotel
   * check-in list by another route, and every attempt is recorded whether or
   * not it found anything.
   */
  async searchActive(
    input: { registrationNumber?: string; matchId?: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<MatchView> {
    const outcome = await this.runPoliceCommand(
      actor,
      EXACT_SEARCH,
      request,
      async (uow, authorize) => {
        await authorize();
        const repository = new PoliceRepository(uow);
        const now = this.now(uow);
        await this.holdSearchRate(uow, actor.principal.accountId, now);

        const kind = input.matchId !== undefined ? 'MATCH_ID' : 'REGISTRATION_NUMBER';
        let match: MatchRow | undefined;
        if (input.matchId !== undefined) {
          match = await repository.matchById(input.matchId);
          if (match?.workflowState === 'RESOLVED') match = undefined;
        } else {
          const normalized = normalizeRegistrationNumber(input.registrationNumber ?? '');
          if (!isStructurallyValidRegistrationNumber(normalized)) {
            throw new ApiError('VALIDATION_FAILED', 'the search takes a whole registration number');
          }
          const token = await deriveLookupToken(
            this.deps.keys,
            'lookup.police_identity',
            { identityType: 'registration_number', countryCode: 'MN' },
            normalized,
          );
          match = await repository.activeMatchByPersonToken(token.token);
        }

        await uow.query(
          `INSERT INTO police.exact_search_attempt (account_id, search_kind, device_ref, found, attempted_at)
         VALUES ($1::uuid, $2, $3, $4, $5)`,
          [actor.principal.accountId, kind, request.deviceRef ?? null, match !== undefined, now],
        );
        await recordPoliceAudit(uow, {
          action: 'police.match.exact_search',
          outcome: 'allowed',
          ...(match === undefined ? {} : { caseRef: match.matchId }),
          // The number itself is never here: doc 13 §9 forbids it in ordinary
          // logs and analytics, and an audit payload is neither exception.
          payload: { kind, found: match !== undefined },
        });
        // A search that found nothing is still a search, and doc 13 §9 requires
        // it to be recorded. Throwing here would roll the record back with the
        // transaction, so the refusal is raised after this commits.
        return match === undefined
          ? undefined
          : this.view(match, await repository.linkedCases(match.matchId));
      },
    );
    if (outcome === undefined) throw new ApiError('NOT_FOUND', 'no active match');
    return outcome;
  }

  /** `POL-DEC-014`: the quick form. The server fills in everything it knows. */
  async confirmFound(
    input: {
      matchId: string;
      expectedRevision: number;
      locationKind: 'AT_MATCH_HOTEL' | 'OTHER_LOCATION';
      locationNote?: string;
      taskReference?: string;
      note?: string;
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<MatchView> {
    return this.runPoliceCommand(actor, FOUND_CONFIRM, request, async (uow, authorize) => {
      const claimed = await claim(uow, 'police.found_confirm', input.idempotencyKey, {
        matchId: input.matchId,
      });
      if (claimed.kind === 'replay') return claimed.body as MatchView;
      await authorize({ targetRef: input.matchId });

      const repository = new PoliceRepository(uow);
      const match = await repository.lockMatch(input.matchId);
      if (match === undefined) throw new ApiError('NOT_FOUND', 'no such match');
      if (match.revision !== input.expectedRevision) {
        throw new ApiError('CONFLICT', 'that match changed under this command');
      }
      // doc 13 §9: two officers confirming at once — the first server-side
      // confirmation decides, and the second is told who was already there.
      const existing = await repository.activeFound(match.matchId);
      if (existing !== undefined) {
        throw new ApiError(
          'CONFLICT',
          `ALREADY_FOUND: confirmed at ${existing.confirmedAt.toISOString()}`,
        );
      }
      if (match.outcome !== 'NONE') {
        throw new ApiError('PRECONDITION_FAILED', `that match is already ${match.outcome}`);
      }
      if (input.locationKind === 'OTHER_LOCATION' && (input.locationNote ?? '').trim().length < 3) {
        throw new ApiError('VALIDATION_FAILED', 'another location has to say which');
      }

      const now = this.now(uow);
      const foundId = await repository.insertFound({
        matchId: match.matchId,
        foundByAccountId: actor.principal.accountId,
        foundByUnitRef: actor.principal.policeScopeRef ?? 'UNASSIGNED',
        confirmedAt: now,
        locationKind: input.locationKind,
        locationNote: input.locationKind === 'OTHER_LOCATION' ? (input.locationNote ?? null) : null,
        taskReference: input.taskReference ?? null,
        note: input.note ?? null,
      });
      const moved = await repository.setMatchWorkflow({
        matchId: match.matchId,
        expectedRevision: match.revision,
        workflow: 'RESOLVED',
        outcome: 'FOUND',
      });
      if (!moved) throw new ApiError('CONFLICT', 'that match changed under this command');
      await repository.appendMatchEvent({
        matchId: match.matchId,
        eventType: 'FOUND_CONFIRMED',
        actorAccountId: actor.principal.accountId,
        payload: { foundId, locationKind: input.locationKind },
        at: now,
      });
      await recordPoliceAudit(uow, {
        action: 'police.match.found_confirmed',
        outcome: 'allowed',
        caseRef: match.matchId,
        payload: { locationKind: input.locationKind, unit: actor.principal.policeScopeRef ?? null },
      });

      const reread = await repository.matchById(match.matchId);
      const view = this.view(reread ?? match, await repository.linkedCases(match.matchId));
      await completeIdempotencyKey(uow, claimed.idempotencyId, 200, view);
      return view;
    });
  }

  /** `POL-DEC-015`: only the officer who confirmed may ask for it to be undone. */
  async requestFoundCorrection(
    input: { matchId: string; reason: string; idempotencyKey: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ requestId: string }> {
    return this.runPoliceCommand(
      actor,
      FOUND_CORRECTION_REQUEST,
      request,
      async (uow, authorize) => {
        const claimed = await claim(uow, 'police.found_correction', input.idempotencyKey, {
          matchId: input.matchId,
        });
        if (claimed.kind === 'replay') return claimed.body as { requestId: string };
        await authorize({ targetRef: input.matchId });

        const repository = new PoliceRepository(uow);
        const match = await repository.lockMatch(input.matchId);
        if (match === undefined) throw new ApiError('NOT_FOUND', 'no such match');
        const found = await repository.activeFound(match.matchId);
        if (found === undefined || match.outcome !== 'FOUND') {
          throw new ApiError('PRECONDITION_FAILED', 'that match has no Found to correct');
        }
        if (found.foundByAccountId !== actor.principal.accountId) {
          throw new ApiError(
            'FORBIDDEN',
            'a Found correction is requested by the account that confirmed it',
          );
        }
        if ((await repository.pendingFoundCorrection(match.matchId)) !== undefined) {
          throw new ApiError('CONFLICT', 'a correction is already pending on that match');
        }

        const now = this.now(uow);
        const requestId = await repository.insertFoundCorrection({
          matchId: match.matchId,
          foundId: found.foundId,
          requestedByAccountId: actor.principal.accountId,
          reason: input.reason,
          at: now,
        });
        await repository.appendMatchEvent({
          matchId: match.matchId,
          eventType: 'FOUND_CORRECTION_REQUESTED',
          actorAccountId: actor.principal.accountId,
          payload: { requestId },
          at: now,
        });
        await recordPoliceAudit(uow, {
          action: 'police.match.found_correction_requested',
          outcome: 'allowed',
          caseRef: match.matchId,
          reason: input.reason,
          payload: { requestId },
        });
        const body = { requestId };
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, body);
        return body;
      },
    );
  }

  async decideFoundCorrection(
    input: {
      matchId: string;
      requestId: string;
      approve: boolean;
      note: string;
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<MatchView> {
    const requester = await this.requesterOf(request, () => 'found', input.requestId);
    return this.runPoliceCommand(
      actor,
      FOUND_CORRECTION_DECIDE,
      request,
      async (uow, authorize) => {
        const claimed = await claim(uow, 'police.found_correction_decide', input.idempotencyKey, {
          requestId: input.requestId,
          approve: input.approve,
        });
        if (claimed.kind === 'replay') return claimed.body as MatchView;
        await authorize({
          ...(requester === undefined ? {} : { separationCounterpartAccountId: requester }),
          targetRef: input.matchId,
        });

        const repository = new PoliceRepository(uow);
        const pending = await repository.lockFoundCorrection(input.requestId);
        if (pending === undefined || pending.matchId !== input.matchId) {
          throw new ApiError('NOT_FOUND', 'no such correction request');
        }
        if (pending.state !== 'PENDING') {
          throw new ApiError('CONFLICT', 'that correction has already been decided');
        }
        if (!separateAccounts(pending.requestedByAccountId, actor.principal.accountId)) {
          throw new ApiError(
            'FORBIDDEN',
            'SEPARATION_OF_DUTIES: the approver may not be the requester',
          );
        }

        const match = await repository.lockMatch(input.matchId);
        if (match === undefined) throw new ApiError('NOT_FOUND', 'no such match');
        const now = this.now(uow);
        const decided = await repository.decideFoundCorrection({
          requestId: pending.requestId,
          approved: input.approve,
          decidedByAccountId: actor.principal.accountId,
          decidedAt: now,
          note: input.note,
        });
        if (!decided) throw new ApiError('CONFLICT', 'that correction changed under this command');

        if (input.approve) {
          const found = await repository.activeFound(match.matchId);
          if (found !== undefined) await repository.markFoundCorrected(found.foundId, now);
          // doc 13 §9.2: the match returns to what it was before the Found,
          // and the erroneous confirmation stays in the history as one.
          const restored = await repository.setMatchWorkflow({
            matchId: match.matchId,
            expectedRevision: match.revision,
            workflow: workflowAfterFoundCorrection(),
            outcome: 'NONE',
          });
          if (!restored) throw new ApiError('CONFLICT', 'that match changed under this command');
        }
        await repository.appendMatchEvent({
          matchId: match.matchId,
          eventType: input.approve ? 'FOUND_CORRECTION_APPROVED' : 'FOUND_CORRECTION_REJECTED',
          actorAccountId: actor.principal.accountId,
          payload: { requestId: pending.requestId },
          at: now,
        });
        await recordPoliceAudit(uow, {
          action: input.approve
            ? 'police.match.found_correction_approved'
            : 'police.match.found_correction_rejected',
          outcome: 'allowed',
          caseRef: match.matchId,
          reason: input.note,
          payload: { requestId: pending.requestId },
        });

        const reread = await repository.matchById(match.matchId);
        const view = this.view(reread ?? match, await repository.linkedCases(match.matchId));
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, view);
        return view;
      },
    );
  }

  /** `POL-DEC-019`: anybody in scope may ask; somebody else decides. */
  async requestFalseMatch(
    input: {
      matchId: string;
      reasonCode: FalseMatchReason;
      reasonNote: string;
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ requestId: string }> {
    return this.runPoliceCommand(actor, FALSE_MATCH_REQUEST, request, async (uow, authorize) => {
      const claimed = await claim(uow, 'police.false_match', input.idempotencyKey, {
        matchId: input.matchId,
      });
      if (claimed.kind === 'replay') return claimed.body as { requestId: string };
      await authorize({ targetRef: input.matchId });

      const repository = new PoliceRepository(uow);
      const match = await repository.lockMatch(input.matchId);
      if (match === undefined) throw new ApiError('NOT_FOUND', 'no such match');
      if ((await repository.pendingFalseMatch(match.matchId)) !== undefined) {
        throw new ApiError('CONFLICT', 'a False Match request is already pending on that match');
      }

      const now = this.now(uow);
      const requestId = await repository.insertFalseMatch({
        matchId: match.matchId,
        requestedByAccountId: actor.principal.accountId,
        reasonCode: input.reasonCode,
        reasonNote: input.reasonNote,
        at: now,
      });
      // doc 13 §9.3: the request marks the match and changes nothing else —
      // the outcome stands and the escalation keeps running until somebody
      // decides.
      const marked = await repository.setMatchWorkflow({
        matchId: match.matchId,
        expectedRevision: match.revision,
        workflow: match.workflowState,
        outcome: match.outcome,
        falseMatchReviewPending: true,
      });
      if (!marked) throw new ApiError('CONFLICT', 'that match changed under this command');
      await repository.appendMatchEvent({
        matchId: match.matchId,
        eventType: 'FALSE_MATCH_REQUESTED',
        actorAccountId: actor.principal.accountId,
        payload: { requestId, reasonCode: input.reasonCode },
        at: now,
      });
      await recordPoliceAudit(uow, {
        action: 'police.match.false_match_requested',
        outcome: 'allowed',
        caseRef: match.matchId,
        reason: input.reasonNote,
        payload: { requestId, reasonCode: input.reasonCode },
      });
      const body = { requestId };
      await completeIdempotencyKey(uow, claimed.idempotencyId, 201, body);
      return body;
    });
  }

  async decideFalseMatch(
    input: {
      matchId: string;
      requestId: string;
      approve: boolean;
      note: string;
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<MatchView> {
    const requester = await this.requesterOf(request, () => 'false', input.requestId);
    return this.runPoliceCommand(actor, FALSE_MATCH_DECIDE, request, async (uow, authorize) => {
      const claimed = await claim(uow, 'police.false_match_decide', input.idempotencyKey, {
        requestId: input.requestId,
        approve: input.approve,
      });
      if (claimed.kind === 'replay') return claimed.body as MatchView;
      await authorize({
        ...(requester === undefined ? {} : { separationCounterpartAccountId: requester }),
        targetRef: input.matchId,
      });

      const repository = new PoliceRepository(uow);
      const pending = await repository.lockFalseMatch(input.requestId);
      if (pending === undefined || pending.matchId !== input.matchId) {
        throw new ApiError('NOT_FOUND', 'no such False Match request');
      }
      if (pending.state !== 'PENDING') {
        throw new ApiError('CONFLICT', 'that request has already been decided');
      }
      if (!separateAccounts(pending.requestedByAccountId, actor.principal.accountId)) {
        throw new ApiError(
          'FORBIDDEN',
          'SEPARATION_OF_DUTIES: the approver may not be the requester',
        );
      }

      const match = await repository.lockMatch(input.matchId);
      if (match === undefined) throw new ApiError('NOT_FOUND', 'no such match');
      if (input.approve && !falseMatchApprovable(match.outcome)) {
        throw new ApiError(
          'PRECONDITION_FAILED',
          'FOUND_FIRST: correct the Found before approving a False Match',
        );
      }

      const now = this.now(uow);
      const decided = await repository.decideFalseMatch({
        requestId: pending.requestId,
        approved: input.approve,
        decidedByAccountId: actor.principal.accountId,
        decidedAt: now,
        note: input.note,
      });
      if (!decided) throw new ApiError('CONFLICT', 'that request changed under this command');

      const moved = await repository.setMatchWorkflow({
        matchId: match.matchId,
        expectedRevision: match.revision,
        workflow: input.approve ? 'RESOLVED' : match.workflowState,
        outcome: input.approve ? 'FALSE_MATCH' : match.outcome,
        falseMatchReviewPending: false,
      });
      if (!moved) throw new ApiError('CONFLICT', 'that match changed under this command');
      await repository.appendMatchEvent({
        matchId: match.matchId,
        eventType: input.approve ? 'FALSE_MATCH_APPROVED' : 'FALSE_MATCH_REJECTED',
        actorAccountId: actor.principal.accountId,
        payload: { requestId: pending.requestId },
        at: now,
      });
      await recordPoliceAudit(uow, {
        action: input.approve
          ? 'police.match.false_match_approved'
          : 'police.match.false_match_rejected',
        outcome: 'allowed',
        caseRef: match.matchId,
        reason: input.note,
        payload: { requestId: pending.requestId },
      });

      const reread = await repository.matchById(match.matchId);
      const view = this.view(reread ?? match, await repository.linkedCases(match.matchId));
      await completeIdempotencyKey(uow, claimed.idempotencyId, 200, view);
      return view;
    });
  }

  /**
   * doc 13 §9.2: a guest who left before anybody arrived is `LOCATION_STALE`,
   * not a False Match.
   *
   * The system distinguishes the two rather than asking an officer to: the
   * sweep asks which unresolved matches are about a stay that has ended, and
   * resolves exactly those. It decides nothing about the person, the case or
   * the identification — only that the address on the alert is no longer where
   * they are.
   */
  async sweepStaleLocations(limit = 100, request: RequestContext): Promise<number> {
    return this.inPoliceScope(request, async (uow) => {
      const due = await uow.query<{ match_id: string }>(
        `SELECT match_id FROM police.stale_match_locations($1::integer)`,
        [limit],
      );
      const repository = new PoliceRepository(uow);
      const now = this.now(uow);
      let resolved = 0;
      for (const row of due.rows) {
        const match = await repository.lockMatch(row.match_id);
        if (match === undefined || match.workflowState === 'RESOLVED') continue;
        const moved = await repository.setMatchWorkflow({
          matchId: match.matchId,
          expectedRevision: match.revision,
          workflow: 'RESOLVED',
          outcome: 'LOCATION_STALE',
        });
        if (!moved) continue;
        await repository.appendMatchEvent({
          matchId: match.matchId,
          eventType: 'LOCATION_STALE',
          payload: {},
          at: now,
        });
        await recordPoliceAudit(uow, {
          action: 'police.match.location_stale',
          outcome: 'allowed',
          caseRef: match.matchId,
          payload: {},
        });
        resolved += 1;
      }
      return resolved;
    });
  }

  /**
   * doc 13 §9: an automated guesser is held to a rate.
   *
   * The window is counted from this account's own attempts, successful or not,
   * so a caller cannot learn anything by the shape of the refusal either.
   */
  private async holdSearchRate(uow: UnitOfWork, accountId: string, now: Date): Promise<void> {
    const recent = await uow.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM police.exact_search_attempt
        WHERE account_id = $1::uuid AND attempted_at > $2::timestamptz - make_interval(mins => $3)`,
      [accountId, now, EXACT_SEARCH_WINDOW_MINUTES],
    );
    if (Number(recent.rows[0]?.count ?? '0') >= EXACT_SEARCH_LIMIT) {
      throw new ApiError('CONFLICT', 'RATE_LIMITED: too many exact searches; try again later');
    }
  }

  /** The requester of a pending decision, read before authorization needs it. */
  private async requesterOf(
    request: RequestContext,
    kind: () => 'found' | 'false',
    requestId: string,
  ): Promise<string | undefined> {
    return this.inPoliceScope(request, async (uow) => {
      const repository = new PoliceRepository(uow);
      const row =
        kind() === 'found'
          ? await repository.lockFoundCorrection(requestId)
          : await repository.lockFalseMatch(requestId);
      return row?.requestedByAccountId;
    });
  }

  private view(match: MatchRow, linkedCaseIds: readonly string[]): MatchView {
    return {
      matchId: match.matchId,
      workflowState: match.workflowState,
      outcome: match.outcome,
      hotelName: match.hotelName,
      hotelDistrict: match.hotelDistrict,
      hotelAddressLine: match.hotelAddressLine,
      roomNumber: match.roomNumber,
      latitudeMicro: match.latitudeMicro,
      longitudeMicro: match.longitudeMicro,
      detectedAt: match.detectedAt,
      checkInRecordedAt: match.checkInRecordedAt,
      actualCheckInAt: match.actualCheckInAt,
      firstAcknowledgedByAccountId: match.firstAcknowledgedByAccountId,
      firstAcknowledgedAt: match.firstAcknowledgedAt,
      falseMatchReviewPending: match.falseMatchReviewPending,
      linkedCaseIds,
      revision: match.revision,
    };
  }
}
