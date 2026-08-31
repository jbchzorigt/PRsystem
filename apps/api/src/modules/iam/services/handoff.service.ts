import type { HotelRole } from '@prsystem/authz';
import { isRoleAssignableIn, permissionScopes } from '@prsystem/authz';
import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import {
  appendOutboxEvent,
  claimIdempotencyKey,
  completeIdempotencyKey,
  recordPlatformAudit,
} from '@prsystem/db';
import type { HandoffItemRow, HandoffSubjectKind } from '../repositories/handoff.repository';
import type { OpenWorkItem } from '../contracts/open-work.port';
import { HandoffDiscoveryRepository, HandoffRepository } from '../repositories/handoff.repository';
import type { MembershipRow } from '../repositories/membership.repository';
import { MembershipRepository } from '../repositories/membership.repository';
import { authorizeCommand } from './authorization.service';
import type { CommandActor, HotelGate, IamDependencies, RequestContext } from './iam-context';
import { IamServiceBase } from './iam-context';
import { derivedIdempotencyKey } from './derived-key';

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

/**
 * Open work, as the owning module reports it.
 *
 * The shape lives with the port that produces it — this alias is kept so the
 * call sites read as the domain concept they are.
 */
export type OpenWork = OpenWorkItem;

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
   * Enumerates the open work behind every marker a suspension left, and turns it
   * into handoff items.
   *
   * This is the second half of a suspension, deliberately separated from the
   * first. Asking another module what a person still holds is a call that can
   * fail, and doing it inside the security transaction meant a provider outage
   * rolled the suspension back — the member stayed active, with live sessions,
   * because a *different* system was down. So the transition commits with a
   * marker, and this runs afterwards: on the same request when the provider
   * answers, and on a later call when it does not.
   *
   * Idempotent by construction. The items are opened under the marker's stored
   * seed, the open-item index is one row per subject, and the marker's
   * completion is a compare-and-set — so running this twice creates nothing
   * twice, and a marker that has been settled is never reopened.
   */
  async reconcileDiscovery(
    actor: CommandActor,
    input: { hotelId: string; membershipId?: string; idempotencyKey: string },
    request: RequestContext,
  ): Promise<{ resolved: number; pending: number; items: readonly string[] }> {
    return this.runHotelCommand(actor, { hotelId: input.hotelId }, request, async (uow, gate) => {
      await this.authorize(gate, {
        uow,
        // The same authority the suspension itself needed: this creates nothing
        // the suspension did not already decide, it only finishes it.
        permission: 'hotel.staff.invite_suspend',
        hotelId: input.hotelId,
        restaurantId: null,
        targetType: 'work_handoff_discovery',
      });

      const claimed = await this.claimIdempotency(
        uow,
        'iam.handoff.discovery',
        input.idempotencyKey,
        input,
      );
      if (claimed.replay !== undefined) {
        return claimed.replay as { resolved: number; pending: number; items: readonly string[] };
      }

      const discovery = new HandoffDiscoveryRepository(uow);
      const memberships = new MembershipRepository(uow);
      const markers = await discovery.listPending(input.membershipId);

      const items: string[] = [];
      let resolved = 0;
      let pending = 0;

      let superseded = 0;
      for (const candidate of markers) {
        // **Membership first, marker second** — the one lock order every
        // operation on the pair uses. The candidate above was read without a
        // lock precisely so this order can be kept; taking the marker first is
        // what deadlocked against a reactivation.
        const membership = await memberships.lock(candidate.membershipId);
        if (membership === undefined) {
          await discovery.recordAttempt(candidate.discoveryId, 'the membership is not visible');
          pending += 1;
          continue;
        }

        // Now, and only now, the marker itself — re-read under its lock,
        // because a reactivation may have settled it while this transaction was
        // waiting for the membership.
        const marker = await discovery.lockPending(candidate.discoveryId);
        if (marker === undefined) continue;

        if (
          membership.state !== marker.expectedState ||
          membership.membershipRevision !== marker.membershipRevision
        ) {
          await discovery.supersede(marker.discoveryId, 'membership_moved_on');
          superseded += 1;
          continue;
        }

        let work: readonly OpenWork[];
        try {
          work = await this.deps.openWork.openWorkFor(input.hotelId, marker.membershipId);
        } catch (error) {
          // The marker stays open and the attempt is counted. Nothing here
          // treats an unanswerable provider as "no open work": that is the
          // difference between a queue that will be drained and a blocker that
          // was silently dropped.
          await discovery.recordAttempt(marker.discoveryId, describe(error));
          pending += 1;
          continue;
        }

        for (const entry of work) {
          items.push(
            await this.openForMembership(uow, {
              membership,
              work: entry,
              reason: marker.openedReason,
              idempotencyKey: derivedIdempotencyKey(
                'handoff.open',
                marker.idempotencySeed,
                entry.kind,
                entry.ref,
              ),
            }),
          );
        }
        await discovery.complete(marker.discoveryId);
        resolved += 1;
      }

      await recordPlatformAudit(uow, {
        action: 'iam.handoff.discovery_reconciled',
        outcome: 'allowed',
        targetType: 'work_handoff_discovery',
        payload: { resolved, pending, superseded, items: [...items] },
      });

      const result = { resolved, pending, items };
      await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
      return result;
    });
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
    actor: CommandActor,
    input: { hotelId: string; itemId: string; idempotencyKey: string },
    request: RequestContext,
  ): Promise<{ claimed: boolean; claimantMembershipId: string }> {
    return this.runHotelCommand(actor, { hotelId: input.hotelId }, request, async (uow, gate) => {
      const items = new HandoffRepository(uow);
      const item = await items.lock(input.itemId);
      if (item === undefined) throw new ApiError('NOT_FOUND', 'not found');

      const decision = await this.authorize(gate, {
        uow,
        permission: CLAIM_PERMISSION[item.subjectKind],
        hotelId: input.hotelId,
        restaurantId: item.restaurantId,
        targetRef: item.itemId,
      });
      const claimant = decision.membership;
      if (claimant === undefined)
        throw new ApiError('INTERNAL_ERROR', 'no membership was resolved');

      const claimed = await this.claimIdempotency(
        uow,
        'iam.handoff.claim',
        input.idempotencyKey,
        input,
      );
      if (claimed.replay !== undefined) {
        return claimed.replay as { claimed: boolean; claimantMembershipId: string };
      }

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
   * Releases a claim, so another Manager may take the item on.
   *
   * doc 19 §8.4 records `released` as a movement of its own: a claim is not
   * abandoned silently and it is not taken from its holder. This is the only
   * route from one claimant to another, which is what makes "an item claimed by
   * A cannot be assigned by B" a rule rather than a race.
   */
  async release(
    actor: CommandActor,
    input: { hotelId: string; itemId: string; reason: string; idempotencyKey: string },
    request: RequestContext,
  ): Promise<{ released: boolean }> {
    return this.runHotelCommand(actor, { hotelId: input.hotelId }, request, async (uow, gate) => {
      const items = new HandoffRepository(uow);
      const item = await items.lock(input.itemId);
      if (item === undefined) throw new ApiError('NOT_FOUND', 'not found');

      const decision = await this.authorize(gate, {
        uow,
        permission: CLAIM_PERMISSION[item.subjectKind],
        hotelId: input.hotelId,
        restaurantId: item.restaurantId,
        targetRef: item.itemId,
      });
      const actorMembership = requireMembership(decision.membership);
      if (item.state !== 'CLAIMED') {
        throw new ApiError('CONFLICT', 'only a claimed item is released');
      }
      assertClaimant(item, actorMembership.membershipId);

      const claimed = await this.claimIdempotency(
        uow,
        'iam.handoff.release',
        input.idempotencyKey,
        input,
      );
      if (claimed.replay !== undefined) return claimed.replay as { released: boolean };

      const moved = await items.transition({
        itemId: item.itemId,
        expectedVersion: item.assignmentVersion,
        state:
          item.subjectKind === 'reception_shift' ? 'TAKEOVER_REQUIRED' : 'REASSIGNMENT_REQUIRED',
        claimantMembershipId: null,
        assigneeMembershipId: null,
      });
      if (!moved) throw new ApiError('CONFLICT', 'this item changed concurrently');

      await items.appendEvent({
        itemId: item.itemId,
        kind: 'released',
        actorMembershipId: actorMembership.membershipId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });
      await recordPlatformAudit(uow, {
        action: 'iam.handoff.released',
        outcome: 'allowed',
        targetType: 'work_handoff_item',
        targetRef: item.itemId,
        reason: input.reason,
        payload: { claimantMembershipId: actorMembership.membershipId },
      });

      const result = { released: true };
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
    actor: CommandActor,
    input: {
      hotelId: string;
      itemId: string;
      replacementMembershipId: string;
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<{ assigned: boolean; assigneeMembershipId: string }> {
    return this.runHotelCommand(actor, { hotelId: input.hotelId }, request, async (uow, gate) => {
      const items = new HandoffRepository(uow);
      const item = await items.lock(input.itemId);
      if (item === undefined) throw new ApiError('NOT_FOUND', 'not found');

      const decision = await this.authorize(gate, {
        uow,
        permission: CLAIM_PERMISSION[item.subjectKind],
        hotelId: input.hotelId,
        restaurantId: item.restaurantId,
        targetRef: item.itemId,
      });
      const actorMembership = requireMembership(decision.membership);

      if (item.state !== 'CLAIMED') {
        throw new ApiError('CONFLICT', 'an item is assigned only after it has been claimed');
      }
      // doc 19 §8.4: the Manager who took the item on is the one who resolves
      // it. Another Manager holding the same permission may not step into a
      // claim that is not theirs — they release it, or the holder does.
      assertClaimant(item, actorMembership.membershipId);
      if (item.movementStarted) {
        throw new ApiError(
          'CONFLICT',
          'a posted movement is never reassigned; create a linked continuation instead',
        );
      }

      const claimed = await this.claimIdempotency(
        uow,
        'iam.handoff.assign',
        input.idempotencyKey,
        input,
      );
      if (claimed.replay !== undefined) {
        return claimed.replay as { assigned: boolean; assigneeMembershipId: string };
      }

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
        // The account that performed the action, not the person the work was
        // taken from: an audit trail that names the previous actor as the actor
        // attributes the decision to the wrong person (ADR-0018 §2).
        actorMembershipId: actorMembership.membershipId,
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
          actorMembershipId: actorMembership.membershipId,
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
    actor: CommandActor,
    input: {
      hotelId: string;
      itemId: string;
      replacementMembershipId: string;
      subjectRef: string;
      idempotencyKey: string;
    },
    request: RequestContext,
  ): Promise<{ continuationItemId: string }> {
    return this.runHotelCommand(actor, { hotelId: input.hotelId }, request, async (uow, gate) => {
      const items = new HandoffRepository(uow);
      const original = await items.lock(input.itemId);
      if (original === undefined) throw new ApiError('NOT_FOUND', 'not found');

      const decision = await this.authorize(gate, {
        uow,
        permission: 'hotel.handoff.cleaner_continuation_create',
        hotelId: input.hotelId,
        restaurantId: null,
        targetRef: original.itemId,
      });
      const actorMembership = requireMembership(decision.membership);

      if (original.subjectKind !== 'cleaner_task') {
        throw new ApiError('CONFLICT', 'only a Cleaner task produces a linked continuation');
      }
      if (!original.movementStarted) {
        throw new ApiError(
          'CONFLICT',
          'an item with no posted movement is reassigned, not continued',
        );
      }
      assertClaimant(original, actorMembership.membershipId);

      const claimed = await this.claimIdempotency(
        uow,
        'iam.handoff.continuation',
        input.idempotencyKey,
        input,
      );
      if (claimed.replay !== undefined) return claimed.replay as { continuationItemId: string };

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
        claimantMembershipId: actorMembership.membershipId,
        assigneeMembershipId: input.replacementMembershipId,
      });
      await items.appendEvent({
        itemId: continuation.itemId,
        kind: 'continuation_created',
        actorMembershipId: actorMembership.membershipId,
        newAssigneeMembershipId: input.replacementMembershipId,
        idempotencyKey: input.idempotencyKey,
      });
      await recordPlatformAudit(uow, {
        action: 'iam.handoff.continuation_created',
        outcome: 'allowed',
        targetType: 'work_handoff_item',
        targetRef: continuation.itemId,
        payload: {
          continuationOfItemId: original.itemId,
          actorMembershipId: actorMembership.membershipId,
        },
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
    actor: CommandActor,
    input: { hotelId: string; itemId: string; reason: string; idempotencyKey: string },
    request: RequestContext,
  ): Promise<{ state: string }> {
    return this.runHotelCommand(actor, { hotelId: input.hotelId }, request, async (uow, gate) => {
      const items = new HandoffRepository(uow);
      const item = await items.lock(input.itemId);
      if (item === undefined) throw new ApiError('NOT_FOUND', 'not found');

      const decision = await this.authorize(gate, {
        uow,
        permission: CLAIM_PERMISSION[item.subjectKind],
        hotelId: input.hotelId,
        restaurantId: item.restaurantId,
        targetRef: item.itemId,
      });
      const actorMembership = requireMembership(decision.membership);
      if (item.state === 'CLAIMED' || item.state === 'ASSIGNED') {
        assertClaimant(item, actorMembership.membershipId);
      }

      const claimed = await this.claimIdempotency(
        uow,
        'iam.handoff.unassignable',
        input.idempotencyKey,
        input,
      );
      if (claimed.replay !== undefined) return claimed.replay as { state: string };

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
        actorMembershipId: actorMembership.membershipId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });
      await recordPlatformAudit(uow, {
        action: 'iam.handoff.unassigned',
        outcome: 'allowed',
        targetType: 'work_handoff_item',
        targetRef: item.itemId,
        reason: input.reason,
        payload: { actorMembershipId: actorMembership.membershipId },
      });

      const result = { state: 'UNASSIGNED_REQUIRES_ACTION' };
      await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
      return result;
    });
  }

  /**
   * The queue, confined to what the caller's own cell allows them to see.
   *
   * doc 18 §3.2 does not grant `hotel.handoff.queue_view` flatly: a Manager sees
   * the queue, Reception sees the items assigned to it as a replacement, a
   * Cleaner its own task, a Restaurant Manager its own restaurant. The limit is
   * part of the grant, so it is read off the very cells that granted it rather
   * than restated here — and a role that carries no limit lifts it, because
   * roles union within one membership.
   */
  async list(
    actor: CommandActor,
    hotelId: string,
    request: RequestContext,
  ): Promise<readonly HandoffItemRow[]> {
    return this.runHotelCommand(actor, { hotelId }, request, async (uow, gate) => {
      const decision = await this.authorize(gate, {
        uow,
        permission: 'hotel.handoff.queue_view',
        hotelId,
        restaurantId: null,
        targetType: 'work_handoff_item',
      });
      const membership = requireMembership(decision.membership);
      const packageCode = decision.effectivePackage;
      if (packageCode === undefined) {
        throw new ApiError('INTERNAL_ERROR', 'no package was resolved');
      }

      const open = await new HandoffRepository(uow).listOpen();
      const limits = permissionScopes(membership.roles, packageCode, 'hotel.handoff.queue_view');
      if (limits.unrestricted) return open;

      return open.filter((item) => limits.scopes.some((scope) => visible(scope, item, membership)));
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

  /** The same gate-derived commit-time authorization the staff service uses. */
  private authorize(
    gate: HotelGate,
    input: {
      uow: UnitOfWork;
      permission: string;
      hotelId: string;
      restaurantId: string | null;
      targetType?: string;
      targetRef?: string;
    },
  ): ReturnType<typeof authorizeCommand> {
    return authorizeCommand({
      uow: input.uow,
      endpointRealm: 'hotel',
      permission: input.permission,
      principal: gate.principal,
      sessionId: gate.sessionId,
      ...(gate.principal.stepUpAt === undefined ? {} : { stepUpAt: gate.principal.stepUpAt }),
      target: {
        hotelId: input.hotelId,
        ...(input.restaurantId === null ? {} : { restaurantId: input.restaurantId }),
      },
      subscription: this.deps.subscription,
      targetType: input.targetType ?? 'work_handoff_item',
      ...(input.targetRef === undefined ? {} : { targetRef: input.targetRef }),
    });
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

/** The membership a hotel decision is always made against. */
function requireMembership(
  membership: { membershipId: string; roles: readonly HotelRole[] } | undefined,
): { membershipId: string; roles: readonly HotelRole[] } {
  if (membership === undefined) {
    throw new ApiError('INTERNAL_ERROR', 'no membership was resolved');
  }
  return membership;
}

/**
 * doc 19 §8.4: the claim belongs to the Manager who took it.
 *
 * Two Managers hold the same permission, and that is deliberate — the queue is a
 * shared responsibility. What it does not make them is interchangeable once one
 * has taken an item on: the second must release it, or the holder must, and
 * either way the movement is recorded.
 */
function assertClaimant(item: HandoffItemRow, actorMembershipId: string): void {
  if (item.claimantMembershipId !== null && item.claimantMembershipId !== actorMembershipId) {
    throw new ApiError('CONFLICT', 'this item is claimed by another account');
  }
}

/** Whether one cell scope lets this membership see this item (doc 18 §3.2). */
function visible(
  scope: string,
  item: HandoffItemRow,
  membership: { membershipId: string; restaurantId?: string },
): boolean {
  switch (scope) {
    case 'assigned_replacement':
      return item.assigneeMembershipId === membership.membershipId;
    case 'own_task':
      // The Cleaner's own work: the task taken from them, or handed to them.
      return (
        item.previousActorMembershipId === membership.membershipId ||
        item.assigneeMembershipId === membership.membershipId
      );
    case 'own_restaurant':
      return item.restaurantId !== null && item.restaurantId === membership.restaurantId;
    default:
      // An unmodelled limit denies. A scope this function does not understand is
      // one nobody implemented, and showing the row would be the failure.
      return false;
  }
}

/** A provider failure, reduced to something safe to store beside the marker. */
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return 'the owning module reported an unknown failure';
}
