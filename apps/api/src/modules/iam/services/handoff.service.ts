import type { HotelRole, Principal } from '@prsystem/authz';
import { isRoleAssignableIn } from '@prsystem/authz';
import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import {
  appendOutboxEvent,
  claimIdempotencyKey,
  completeIdempotencyKey,
  recordPlatformAudit,
} from '@prsystem/db';
import type { HandoffItemRow, HandoffSubjectKind } from '../repositories/handoff.repository';
import { HandoffRepository } from '../repositories/handoff.repository';
import type { MembershipRow } from '../repositories/membership.repository';
import { MembershipRepository } from '../repositories/membership.repository';
import { authorizeCommand } from './authorization.service';
import type { IamDependencies, RequestContext } from './iam-context';
import { IamServiceBase } from './iam-context';

/**
 * Unfinished work after a suspension (doc 19 §8.1–§8.4, `STAFF-DEC-007`,
 * `RBAC-DEC-014`).
 *
 * The rule the whole file exists to enforce: **a takeover is not an operational
 * role.** Claiming an item and choosing a replacement is a Manager or Manager
 * Plus action; doing the work is the Reception, Cleaner or Restaurant Manager
 * role, held separately. A replacement gains no permission it did not already
 * hold — this service assigns, and the pipeline still decides every action the
 * replacement then attempts.
 */

/** The operational role a replacement must already hold to do the work. */
const REQUIRED_ROLE: Readonly<Record<HandoffSubjectKind, HotelRole>> = {
  reception_shift: 'RECEPTION',
  cleaner_task: 'CLEANER',
  restaurant_order: 'RESTAURANT_MANAGER',
};

/** Which permission claims and assigns each kind of item (doc 18 §3.2). */
const CLAIM_PERMISSION: Readonly<Record<HandoffSubjectKind, string>> = {
  reception_shift: 'hotel.handoff.reception_cleaner_claim',
  cleaner_task: 'hotel.handoff.reception_cleaner_claim',
  restaurant_order: 'hotel.handoff.restaurant_reassign',
};

export interface OpenWork {
  readonly kind: HandoffSubjectKind;
  readonly ref: string;
  /**
   * True when an immutable movement, an actual count or a partial completion has
   * already been posted (doc 19 §8.2). Such an item is never reassigned: the
   * remaining work becomes a linked `CONTINUATION`.
   */
  readonly movementStarted?: boolean;
  readonly restaurantId?: string;
}

export class HandoffService extends IamServiceBase {
  constructor(deps: IamDependencies) {
    super(deps);
  }

  /**
   * Opens the queue item a suspension or termination produces.
   *
   * Called inside the suspension's own transaction, so the security effect and
   * the queue entry commit together — and the security effect is never waiting
   * for the queue entry to be resolved.
   */
  async openForMembership(
    uow: UnitOfWork,
    input: {
      membership: MembershipRow;
      work: OpenWork;
      reason: 'suspension' | 'termination';
      idempotencyKey: string;
    },
  ): Promise<string> {
    const items = new HandoffRepository(uow);
    const state =
      input.work.kind === 'reception_shift' ? 'TAKEOVER_REQUIRED' : 'REASSIGNMENT_REQUIRED';

    const { item, created } = await items.open({
      subjectKind: input.work.kind,
      subjectRef: input.work.ref,
      state,
      openedReason: input.reason,
      previousActorMembershipId: input.membership.membershipId,
      restaurantId: input.work.restaurantId ?? null,
    });

    if (input.work.movementStarted === true && !item.movementStarted) {
      await items.transition({
        itemId: item.itemId,
        expectedVersion: item.assignmentVersion,
        state: item.state,
        movementStarted: true,
      });
    }

    if (created) {
      await items.appendEvent({
        itemId: item.itemId,
        kind: 'opened',
        actorMembershipId: input.membership.membershipId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'work_handoff_item',
        aggregateId: item.itemId,
        eventType: 'iam.handoff.opened',
        payload: {
          itemId: item.itemId,
          subjectKind: input.work.kind,
          subjectRef: input.work.ref,
          state,
        },
      });
    }
    return item.itemId;
  }

  /**
   * Claims an open item.
   *
   * Compare-and-set on `assignment_version`: two Managers reading the same
   * version both attempt the update and exactly one row is affected, so the
   * loser is told the item is already claimed rather than silently replacing the
   * winner (doc 19 §8.1 rule 2).
   */
  async claim(
    actor: Principal,
    input: { hotelId: string; itemId: string; idempotencyKey: string },
    request: RequestContext,
  ): Promise<{ claimed: boolean; claimantMembershipId: string }> {
    return this.runHotelCommand(input.hotelId, request, async (uow) => {
      const claimed = await this.claimIdempotency(
        uow,
        'iam.handoff.claim',
        input.idempotencyKey,
        input,
      );
      if (claimed.replay !== undefined) {
        return claimed.replay as { claimed: boolean; claimantMembershipId: string };
      }

      const items = new HandoffRepository(uow);
      const item = await items.lock(input.itemId);
      if (item === undefined) throw new ApiError('NOT_FOUND', 'not found');

      const decision = await authorizeCommand({
        uow,
        endpointRealm: 'hotel',
        permission: CLAIM_PERMISSION[item.subjectKind],
        principal: actor,
        target: {
          hotelId: input.hotelId,
          ...(item.restaurantId === null ? {} : { restaurantId: item.restaurantId }),
        },
        subscription: this.deps.subscription,
        targetType: 'work_handoff_item',
        targetRef: item.itemId,
      });
      const claimant = decision.membership;
      if (claimant === undefined)
        throw new ApiError('INTERNAL_ERROR', 'no membership was resolved');

      if (item.state !== 'TAKEOVER_REQUIRED' && item.state !== 'REASSIGNMENT_REQUIRED') {
        if (item.claimantMembershipId === claimant.membershipId) {
          // A duplicate claim returns the previous result (doc 19 §8.1 rule 2).
          const result = { claimed: false, claimantMembershipId: claimant.membershipId };
          await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
          return result;
        }
        throw new ApiError('CONFLICT', 'this item is already claimed');
      }

      const moved = await items.transition({
        itemId: item.itemId,
        expectedVersion: item.assignmentVersion,
        state: 'CLAIMED',
        claimantMembershipId: claimant.membershipId,
      });
      if (!moved) throw new ApiError('CONFLICT', 'this item is already claimed');

      await items.appendEvent({
        itemId: item.itemId,
        kind: 'claimed',
        actorMembershipId: claimant.membershipId,
        idempotencyKey: input.idempotencyKey,
      });
      await recordPlatformAudit(uow, {
        action: 'iam.handoff.claimed',
        outcome: 'allowed',
        targetType: 'work_handoff_item',
        targetRef: item.itemId,
        payload: { claimantMembershipId: claimant.membershipId },
      });

      const result = { claimed: true, claimantMembershipId: claimant.membershipId };
      await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
      return result;
    });
  }

  /**
   * Assigns the replacement.
   *
   * Every guard of doc 19 §8.4 is checked at commit: same hotel scope, active
   * membership, the operational role the work requires, and the package
   * entitlement for that role. An item whose movement has already started is
   * never reassigned — the caller must create a linked continuation instead.
   */
  async assign(
    actor: Principal,
    input: {
      hotelId: string;
      itemId: string;
      replacementMembershipId: string;
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<{ assigned: boolean; assigneeMembershipId: string }> {
    return this.runHotelCommand(input.hotelId, request, async (uow) => {
      const claimed = await this.claimIdempotency(
        uow,
        'iam.handoff.assign',
        input.idempotencyKey,
        input,
      );
      if (claimed.replay !== undefined) {
        return claimed.replay as { assigned: boolean; assigneeMembershipId: string };
      }

      const items = new HandoffRepository(uow);
      const item = await items.lock(input.itemId);
      if (item === undefined) throw new ApiError('NOT_FOUND', 'not found');
      if (item.state !== 'CLAIMED') {
        throw new ApiError('CONFLICT', 'an item is assigned only after it has been claimed');
      }
      if (item.movementStarted) {
        throw new ApiError(
          'CONFLICT',
          'a posted movement is never reassigned; create a linked continuation instead',
        );
      }

      await authorizeCommand({
        uow,
        endpointRealm: 'hotel',
        permission: CLAIM_PERMISSION[item.subjectKind],
        principal: actor,
        target: {
          hotelId: input.hotelId,
          ...(item.restaurantId === null ? {} : { restaurantId: item.restaurantId }),
        },
        subscription: this.deps.subscription,
        targetType: 'work_handoff_item',
        targetRef: item.itemId,
      });

      await this.assertReplacementEligible(uow, input.hotelId, input.replacementMembershipId, item);

      const moved = await items.transition({
        itemId: item.itemId,
        expectedVersion: item.assignmentVersion,
        state: 'ASSIGNED',
        assigneeMembershipId: input.replacementMembershipId,
      });
      if (!moved) throw new ApiError('CONFLICT', 'this item changed concurrently');

      await items.appendEvent({
        itemId: item.itemId,
        kind: 'assigned',
        actorMembershipId: item.claimantMembershipId,
        previousAssigneeMembershipId: item.previousActorMembershipId,
        newAssigneeMembershipId: input.replacementMembershipId,
        idempotencyKey: input.idempotencyKey,
      });
      await recordPlatformAudit(uow, {
        action: 'iam.handoff.assigned',
        outcome: 'allowed',
        targetType: 'work_handoff_item',
        targetRef: item.itemId,
        payload: {
          previousActorMembershipId: item.previousActorMembershipId,
          assigneeMembershipId: input.replacementMembershipId,
        },
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'work_handoff_item',
        aggregateId: item.itemId,
        eventType: 'iam.handoff.assigned',
        payload: {
          itemId: item.itemId,
          subjectKind: item.subjectKind,
          subjectRef: item.subjectRef,
          assigneeMembershipId: input.replacementMembershipId,
        },
      });

      const result = { assigned: true, assigneeMembershipId: input.replacementMembershipId };
      await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
      return result;
    });
  }

  /**
   * Creates the linked `CONTINUATION` for the remaining work (doc 19 §8.2).
   *
   * The original item keeps its actor, its history and its posted movement; the
   * continuation carries the remaining work and is a new item, so one remaining
   * action can never be executed twice.
   */
  async createContinuation(
    actor: Principal,
    input: {
      hotelId: string;
      itemId: string;
      replacementMembershipId: string;
      subjectRef: string;
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<{ continuationItemId: string }> {
    return this.runHotelCommand(input.hotelId, request, async (uow) => {
      const claimed = await this.claimIdempotency(
        uow,
        'iam.handoff.continuation',
        input.idempotencyKey,
        input,
      );
      if (claimed.replay !== undefined) return claimed.replay as { continuationItemId: string };

      const items = new HandoffRepository(uow);
      const original = await items.lock(input.itemId);
      if (original === undefined) throw new ApiError('NOT_FOUND', 'not found');
      if (original.subjectKind !== 'cleaner_task') {
        throw new ApiError('CONFLICT', 'only a Cleaner task produces a linked continuation');
      }
      if (!original.movementStarted) {
        throw new ApiError(
          'CONFLICT',
          'an item with no posted movement is reassigned, not continued',
        );
      }

      await authorizeCommand({
        uow,
        endpointRealm: 'hotel',
        permission: 'hotel.handoff.cleaner_continuation_create',
        principal: actor,
        target: { hotelId: input.hotelId },
        subscription: this.deps.subscription,
        targetType: 'work_handoff_item',
        targetRef: original.itemId,
      });

      await this.assertReplacementEligible(
        uow,
        input.hotelId,
        input.replacementMembershipId,
        original,
      );

      // Opened in a state with no actor, then moved to ASSIGNED with both: the
      // CHECK constraints describe which states may carry a claimant and an
      // assignee, and an insert that skipped straight to one of them would be
      // refused by the database rather than by this service.
      const { item: continuation, created } = await items.open({
        subjectKind: 'cleaner_task',
        subjectRef: input.subjectRef,
        state: 'REASSIGNMENT_REQUIRED',
        openedReason: original.openedReason,
        previousActorMembershipId: original.previousActorMembershipId,
        continuationOfItemId: original.itemId,
      });
      if (!created) throw new ApiError('CONFLICT', 'a continuation already exists for that work');

      await items.transition({
        itemId: continuation.itemId,
        expectedVersion: continuation.assignmentVersion,
        state: 'ASSIGNED',
        claimantMembershipId: original.claimantMembershipId,
        assigneeMembershipId: input.replacementMembershipId,
      });
      await items.appendEvent({
        itemId: continuation.itemId,
        kind: 'continuation_created',
        actorMembershipId: original.claimantMembershipId,
        newAssigneeMembershipId: input.replacementMembershipId,
        idempotencyKey: input.idempotencyKey,
      });
      await recordPlatformAudit(uow, {
        action: 'iam.handoff.continuation_created',
        outcome: 'allowed',
        targetType: 'work_handoff_item',
        targetRef: continuation.itemId,
        payload: { continuationOfItemId: original.itemId },
      });

      const result = { continuationItemId: continuation.itemId };
      await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
      return result;
    });
  }

  /**
   * Marks an item as needing action because no eligible replacement exists.
   *
   * doc 19 §8.2: the task is not completed or bypassed automatically, and the
   * downstream blocker stays in force.
   */
  async markUnassignable(
    actor: Principal,
    input: { hotelId: string; itemId: string; reason: string; idempotencyKey: string },
    request: RequestContext,
  ): Promise<{ state: string }> {
    return this.runHotelCommand(input.hotelId, request, async (uow) => {
      const claimed = await this.claimIdempotency(
        uow,
        'iam.handoff.unassignable',
        input.idempotencyKey,
        input,
      );
      if (claimed.replay !== undefined) return claimed.replay as { state: string };

      const items = new HandoffRepository(uow);
      const item = await items.lock(input.itemId);
      if (item === undefined) throw new ApiError('NOT_FOUND', 'not found');

      await authorizeCommand({
        uow,
        endpointRealm: 'hotel',
        permission: CLAIM_PERMISSION[item.subjectKind],
        principal: actor,
        target: {
          hotelId: input.hotelId,
          ...(item.restaurantId === null ? {} : { restaurantId: item.restaurantId }),
        },
        subscription: this.deps.subscription,
        targetType: 'work_handoff_item',
        targetRef: item.itemId,
      });

      const moved = await items.transition({
        itemId: item.itemId,
        expectedVersion: item.assignmentVersion,
        state: 'UNASSIGNED_REQUIRES_ACTION',
        claimantMembershipId: null,
        assigneeMembershipId: null,
      });
      if (!moved) throw new ApiError('CONFLICT', 'this item changed concurrently');

      await items.appendEvent({
        itemId: item.itemId,
        kind: 'unassigned',
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });
      await recordPlatformAudit(uow, {
        action: 'iam.handoff.unassigned',
        outcome: 'allowed',
        targetType: 'work_handoff_item',
        targetRef: item.itemId,
        reason: input.reason,
      });

      const result = { state: 'UNASSIGNED_REQUIRES_ACTION' };
      await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
      return result;
    });
  }

  async list(
    actor: Principal,
    hotelId: string,
    request: RequestContext,
  ): Promise<readonly HandoffItemRow[]> {
    return this.runHotelCommand(hotelId, request, async (uow) => {
      await authorizeCommand({
        uow,
        endpointRealm: 'hotel',
        permission: 'hotel.handoff.queue_view',
        principal: actor,
        target: { hotelId },
        subscription: this.deps.subscription,
        targetType: 'work_handoff_item',
      });
      return new HandoffRepository(uow).listOpen();
    });
  }

  /**
   * The same-scope, same-role, entitled-package check of doc 19 §8.4.
   *
   * The replacement must **already** hold the operational role: a takeover hands
   * over the work, never the permission to do it (`RBAC-DEC-014`).
   */
  private async assertReplacementEligible(
    uow: UnitOfWork,
    hotelId: string,
    replacementMembershipId: string,
    item: HandoffItemRow,
  ): Promise<void> {
    const memberships = new MembershipRepository(uow);
    const replacement = await memberships.lock(replacementMembershipId);
    if (replacement === undefined || replacement.hotelId !== hotelId) {
      throw new ApiError('NOT_FOUND', 'not found');
    }
    if (replacement.state !== 'ACTIVE') {
      throw new ApiError('CONFLICT', 'the replacement membership is not active');
    }
    if (item.restaurantId !== null && replacement.restaurantId !== item.restaurantId) {
      throw new ApiError('CONFLICT', 'the replacement is not in the same restaurant scope');
    }

    const roles = (await memberships.rolesFor(hotelId, [replacementMembershipId])).get(
      replacementMembershipId,
    );
    const required = REQUIRED_ROLE[item.subjectKind];
    if (roles === undefined || !roles.includes(required)) {
      throw new ApiError('CONFLICT', `the replacement does not hold the ${required} role`);
    }

    const snapshot = await this.deps.subscription.snapshot(hotelId, uow.serverNow);
    if (snapshot === undefined) {
      throw new ApiError('DEPENDENCY_UNAVAILABLE', 'the subscription state cannot be determined');
    }
    if (!isRoleAssignableIn(required, snapshot.effectivePackage)) {
      throw new ApiError('FORBIDDEN', `the hotel package does not include the ${required} role`);
    }
  }

  private async claimIdempotency(
    uow: UnitOfWork,
    operation: string,
    key: string,
    payload: unknown,
  ): Promise<{ idempotencyId: string; replay?: unknown }> {
    const outcome = await claimIdempotencyKey(uow, {
      operation,
      key,
      clientRef: 'iam',
      payload,
    });
    switch (outcome.kind) {
      case 'claimed':
        return { idempotencyId: outcome.idempotencyId };
      case 'replay':
        return { idempotencyId: '', replay: outcome.body };
      case 'in_progress':
        throw new ApiError('IDEMPOTENT_REQUEST_IN_PROGRESS', 'the same request is still running');
      default:
        throw new ApiError('IDEMPOTENCY_KEY_REUSED', 'the key was used with a different request');
    }
  }
}
