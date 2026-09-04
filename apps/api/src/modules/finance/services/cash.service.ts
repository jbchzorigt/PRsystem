import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { directionOf, locationBalanceMnt } from '../domain/cash';
import type { LocationKind, TransferRow } from '../repositories/finance.repository';
import { FinanceRepository } from '../repositories/finance.repository';
import type { CommandActor, FinanceDependencies, RequestContext } from './finance-context';
import { FinanceServiceBase, claim, serverNow, sqlState } from './finance-context';
import {
  requireAmount,
  requireDrawerShift,
  requireLocation,
  requireReason,
  requireSufficientCash,
  shiftOf,
} from './ledger';
import type { LocationView, MovementView, TransferView } from './finance-views';
import { locationView, movementView, transferView } from './finance-views';

/**
 * The cash locations and the ledger over them (doc 24).
 *
 * Every write here is one transaction that locks the location, resolves the
 * shift accountable for it, appends to the ledger and audits — never an update
 * of a movement, because a movement that happened cannot un-happen
 * (`CASH-DEC-004`). A correction is a new movement in the shift it is
 * effective in, pointing at the one it corrects (`SHIFT-DEC-006`).
 */

const LOCATION_MANAGE = 'hotel.cash.location_manage';
const REPORT_FULL = 'hotel.cash.report_full';
const COUNT = 'hotel.cash.count';
const TOP_UP = 'hotel.cash.top_up';
const CORRECTION_REVIEW = 'hotel.cash.correction_review';
const TRANSFER_INITIATE = 'hotel.cash.transfer_initiate';
const TRANSFER_RECEIVE = 'hotel.cash.transfer_receive';
const TRANSFER_CANCEL = 'hotel.cash.transfer_cancel_return_confirm';
const DRAWER_SAFE = 'hotel.cash.drawer_safe_transfer';

export class CashService extends FinanceServiceBase {
  constructor(deps: FinanceDependencies) {
    super(deps);
  }

  // ------------------------------------------------------------- locations

  async locations(
    target: { hotelId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ locations: readonly LocationView[] }> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      target,
      // A Manager holds neither the full cash report nor location management,
      // but cannot move cash between drawers it cannot see (doc 18 §3).
      [REPORT_FULL, LOCATION_MANAGE, COUNT, TRANSFER_INITIATE],
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const repository = new FinanceRepository(uow);
        const rows = await repository.locations();
        const locations = await Promise.all(
          rows.map(async (row) =>
            locationView(
              row,
              locationBalanceMnt(await repository.movementsOfLocation(row.locationId)),
            ),
          ),
        );
        return { locations };
      },
    );
  }

  /** doc 24 §2.1: a Hotel Admin adds a drawer or the hotel's one safe. */
  async createLocation(
    input: {
      hotelId: string;
      idempotencyKey: string;
      kind: LocationKind;
      name: string;
      code: string;
      physicalLocation?: string;
      configuredFloatMnt?: bigint;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<LocationView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      LOCATION_MANAGE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'finance.location_create', input.idempotencyKey, {
          code: input.code,
        });
        if (claimed.kind === 'replay') return claimed.body as LocationView;
        await authorize();
        const repository = new FinanceRepository(uow);
        let row;
        try {
          row = await repository.createLocation({
            kind: input.kind,
            name: input.name,
            code: input.code,
            accountId: gate.principal.accountId,
            ...(input.physicalLocation === undefined
              ? {}
              : { physicalLocation: input.physicalLocation }),
            ...(input.configuredFloatMnt === undefined
              ? {}
              : { configuredFloatMnt: input.configuredFloatMnt }),
          });
        } catch (error) {
          if (sqlState(error) === '23505') {
            throw new ApiError(
              'CONFLICT',
              'DUPLICATE_LOCATION: the hotel already has this code, or already has a safe',
            );
          }
          throw error;
        }
        await recordPlatformAudit(uow, {
          action: 'finance.cash_location.create',
          outcome: 'allowed',
          targetType: 'cash_location',
          targetRef: row.locationId,
          payload: { kind: row.kind, code: row.code },
        });
        const result = locationView(row);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }

  async updateLocation(
    input: {
      hotelId: string;
      locationId: string;
      idempotencyKey: string;
      expectedRevision: number;
      state?: 'ACTIVE' | 'INACTIVE';
      configuredFloatMnt?: bigint;
      physicalLocation?: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<LocationView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      LOCATION_MANAGE,
      request,
      async (uow, _gate, authorize) => {
        const claimed = await claim(uow, 'finance.location_update', input.idempotencyKey, {
          locationId: input.locationId,
          expectedRevision: input.expectedRevision,
        });
        if (claimed.kind === 'replay') return claimed.body as LocationView;
        const repository = new FinanceRepository(uow);
        const locked = await repository.lockLocation(input.locationId);
        await authorize();
        if (locked === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (locked.revision !== input.expectedRevision) {
          throw new ApiError('CONFLICT', 'the location changed; reload and retry');
        }
        if (input.state === 'INACTIVE') {
          // doc 24 §2.1: money cannot be stranded in a location nobody can use.
          const balance = locationBalanceMnt(
            await repository.movementsOfLocation(locked.locationId),
          );
          if (balance !== 0n) {
            throw new ApiError(
              'PRECONDITION_FAILED',
              `LOCATION_NOT_EMPTY: it still holds ${balance.toString()}₮`,
            );
          }
        }
        const row = await repository.updateLocation({
          locationId: locked.locationId,
          expectedRevision: locked.revision,
          ...(input.state === undefined ? {} : { state: input.state }),
          ...(input.configuredFloatMnt === undefined
            ? {}
            : { configuredFloatMnt: input.configuredFloatMnt }),
          ...(input.physicalLocation === undefined
            ? {}
            : { physicalLocation: input.physicalLocation }),
        });
        if (row === undefined) throw new ApiError('CONFLICT', 'the location changed; retry');
        await recordPlatformAudit(uow, {
          action: 'finance.cash_location.update',
          outcome: 'allowed',
          targetType: 'cash_location',
          targetRef: row.locationId,
          payload: { state: row.state },
        });
        const result = locationView(row);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, result);
        return result;
      },
    );
  }

  // ---------------------------------------------------------------- ledger

  async movements(
    target: { hotelId: string; locationId?: string; shiftId?: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ movements: readonly MovementView[] }> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: target.hotelId },
      [REPORT_FULL, COUNT, TRANSFER_INITIATE],
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const repository = new FinanceRepository(uow);
        const rows =
          target.shiftId !== undefined
            ? await repository.movementsOfShift(target.shiftId)
            : target.locationId !== undefined
              ? await repository.movementsOfLocation(target.locationId)
              : [];
        return { movements: rows.map(movementView) };
      },
    );
  }

  /** doc 24 §8: cash put into a drawer that did not come from a guest. */
  async topUp(
    input: {
      hotelId: string;
      idempotencyKey: string;
      locationId: string;
      amountMnt: bigint;
      reason: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<MovementView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      TOP_UP,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'finance.cash_top_up', input.idempotencyKey, {
          locationId: input.locationId,
          amountMnt: input.amountMnt.toString(),
        });
        if (claimed.kind === 'replay') return claimed.body as MovementView;
        const repository = new FinanceRepository(uow);
        const location = await requireLocation(repository, input.locationId, 'DRAWER');
        await authorize();
        const amount = requireAmount(input.amountMnt, 'a top-up');
        const reason = requireReason(input.reason, 'a top-up');
        const shiftId = await requireDrawerShift(this.deps, uow, location.locationId);
        const movement = await repository.post({
          locationId: location.locationId,
          shiftId,
          movementType: 'CASH_TOP_UP',
          direction: 'IN',
          amountMnt: amount,
          effectiveAt: serverNow(this.deps, uow),
          reason,
          accountId: gate.principal.accountId,
        });
        return this.finishMovement(uow, claimed.idempotencyId, movement, 'finance.cash.top_up');
      },
    );
  }

  /**
   * `CASH-DEC-004`, `SHIFT-DEC-006`: a mistake in the ledger is corrected by a
   * new movement in the shift it is effective in, naming the movement it
   * corrects. The original stays exactly as it was, and the shift it belonged
   * to is not rewritten.
   */
  async correct(
    input: {
      hotelId: string;
      idempotencyKey: string;
      originalMovementId: string;
      amountMnt: bigint;
      direction: 'IN' | 'OUT';
      reason: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<MovementView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      CORRECTION_REVIEW,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'finance.cash_correction', input.idempotencyKey, {
          originalMovementId: input.originalMovementId,
          amountMnt: input.amountMnt.toString(),
          direction: input.direction,
        });
        if (claimed.kind === 'replay') return claimed.body as MovementView;
        const repository = new FinanceRepository(uow);
        const original = await repository.movement(input.originalMovementId);
        await authorize();
        if (original === undefined) throw new ApiError('NOT_FOUND', 'not found');
        const location = await requireLocation(repository, original.locationId);
        const amount = requireAmount(input.amountMnt, 'a correction');
        const reason = requireReason(input.reason, 'a correction');
        const movementType =
          input.direction === 'IN' ? 'CASH_CORRECTION_IN' : 'CASH_CORRECTION_OUT';
        if (input.direction === 'OUT') {
          await requireSufficientCash(repository, location.locationId, amount);
        }
        // The shift the correction is effective in — the one open now, not the
        // closed shift the original belonged to.
        const shiftId = await shiftOf(this.deps, uow, location);
        const movement = await repository.post({
          locationId: location.locationId,
          ...(shiftId === undefined ? {} : { shiftId }),
          movementType,
          direction: directionOf(movementType),
          amountMnt: amount,
          effectiveAt: serverNow(this.deps, uow),
          reason,
          originalMovementId: original.movementId,
          accountId: gate.principal.accountId,
        });
        return this.finishMovement(uow, claimed.idempotencyId, movement, 'finance.cash.correct', {
          originalMovementId: original.movementId,
          originalShiftId: original.shiftId,
        });
      },
    );
  }

  // ------------------------------------------------------------- transfers

  /**
   * doc 24 §9.1 and `CASH-DEC-006`: the two locations and the shifts
   * accountable for them are pinned now. The money is in neither balance until
   * the recipient counts it.
   */
  async initiateTransfer(
    input: {
      hotelId: string;
      idempotencyKey: string;
      sourceLocationId: string;
      destinationLocationId: string;
      amountMnt: bigint;
      reason?: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<TransferView> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: input.hotelId },
      [TRANSFER_INITIATE, DRAWER_SAFE],
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'finance.transfer_initiate', input.idempotencyKey, {
          sourceLocationId: input.sourceLocationId,
          destinationLocationId: input.destinationLocationId,
          amountMnt: input.amountMnt.toString(),
        });
        if (claimed.kind === 'replay') return claimed.body as TransferView;
        if (input.sourceLocationId === input.destinationLocationId) {
          throw new ApiError('VALIDATION_FAILED', 'a transfer goes between two locations');
        }
        const repository = new FinanceRepository(uow);
        // Locked in a fixed order so two transfers between the same pair cannot
        // deadlock against each other.
        const [firstId, secondId] = [input.sourceLocationId, input.destinationLocationId].sort();
        await requireLocation(repository, firstId as string);
        await requireLocation(repository, secondId as string);
        const source = await repository.location(input.sourceLocationId);
        const destination = await repository.location(input.destinationLocationId);
        await authorize();
        if (source === undefined || destination === undefined) {
          throw new ApiError('NOT_FOUND', 'not found');
        }
        const amount = requireAmount(input.amountMnt, 'a transfer');
        await requireSufficientCash(repository, source.locationId, amount);
        const kind =
          source.kind === 'DRAWER' && destination.kind === 'DRAWER'
            ? 'DRAWER_TO_DRAWER'
            : 'DRAWER_SAFE';
        const sourceShiftId = await shiftOf(this.deps, uow, source);
        const destinationShiftId = await shiftOf(this.deps, uow, destination);
        const transfer = await repository.createTransfer({
          kind,
          sourceLocationId: source.locationId,
          destinationLocationId: destination.locationId,
          ...(sourceShiftId === undefined ? {} : { sourceShiftId }),
          ...(destinationShiftId === undefined ? {} : { destinationShiftId }),
          amountMnt: amount,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          accountId: gate.principal.accountId,
          at: serverNow(this.deps, uow),
        });
        return this.finishTransfer(
          uow,
          claimed.idempotencyId,
          transfer,
          'finance.transfer.initiate',
          201,
        );
      },
    );
  }

  /**
   * doc 24 §9.2: the recipient's own count completes the transfer, and the two
   * movements are written in the same transaction — two movements or none.
   */
  async confirmTransfer(
    input: {
      hotelId: string;
      idempotencyKey: string;
      transferId: string;
      expectedRevision: number;
      countedMnt: bigint;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<TransferView> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: input.hotelId },
      [TRANSFER_RECEIVE, DRAWER_SAFE],
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'finance.transfer_confirm', input.idempotencyKey, {
          transferId: input.transferId,
          countedMnt: input.countedMnt.toString(),
        });
        if (claimed.kind === 'replay') return claimed.body as TransferView;
        const repository = new FinanceRepository(uow);
        const locked = await repository.lockTransfer(input.transferId);
        await authorize();
        const transfer = this.pendingTransfer(locked, input.expectedRevision);
        if (input.countedMnt !== transfer.amountMnt) {
          throw new ApiError(
            'CONFLICT',
            'COUNT_MISMATCH: cancel the transfer and recount instead of confirming a different amount',
          );
        }
        const at = serverNow(this.deps, uow);
        const source = await requireLocation(repository, transfer.sourceLocationId);
        const destination = await requireLocation(repository, transfer.destinationLocationId);
        await requireSufficientCash(repository, source.locationId, transfer.amountMnt);
        const resolved = await repository.resolveTransfer({
          transferId: transfer.transferId,
          expectedRevision: transfer.revision,
          state: 'COMPLETED',
          accountId: gate.principal.accountId,
          at,
          countedMnt: input.countedMnt,
        });
        if (resolved === undefined) throw new ApiError('CONFLICT', 'the transfer changed; retry');
        const outType = source.kind === 'SAFE' ? 'SAFE_TRANSFER_OUT' : 'DRAWER_TRANSFER_OUT';
        const inType = destination.kind === 'SAFE' ? 'SAFE_TRANSFER_IN' : 'DRAWER_TRANSFER_IN';
        await repository.post({
          locationId: source.locationId,
          ...(transfer.sourceShiftId === null ? {} : { shiftId: transfer.sourceShiftId }),
          movementType: outType,
          direction: 'OUT',
          amountMnt: transfer.amountMnt,
          effectiveAt: at,
          transferId: transfer.transferId,
          accountId: gate.principal.accountId,
        });
        await repository.post({
          locationId: destination.locationId,
          ...(transfer.destinationShiftId === null ? {} : { shiftId: transfer.destinationShiftId }),
          movementType: inType,
          direction: 'IN',
          amountMnt: transfer.amountMnt,
          effectiveAt: at,
          transferId: transfer.transferId,
          accountId: gate.principal.accountId,
        });
        return this.finishTransfer(
          uow,
          claimed.idempotencyId,
          resolved,
          'finance.transfer.confirm',
        );
      },
    );
  }

  /**
   * doc 24 §9.3: a cancellation is a recount, not a movement — the money never
   * left, so nothing is posted and the source is simply counted again.
   */
  async cancelTransfer(
    input: {
      hotelId: string;
      idempotencyKey: string;
      transferId: string;
      expectedRevision: number;
      recountMnt: bigint;
      reason: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<TransferView> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: input.hotelId },
      [TRANSFER_CANCEL, TRANSFER_INITIATE, DRAWER_SAFE],
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'finance.transfer_cancel', input.idempotencyKey, {
          transferId: input.transferId,
        });
        if (claimed.kind === 'replay') return claimed.body as TransferView;
        const repository = new FinanceRepository(uow);
        const locked = await repository.lockTransfer(input.transferId);
        await authorize();
        const transfer = this.pendingTransfer(locked, input.expectedRevision);
        const reason = requireReason(input.reason, 'a cancellation');
        const resolved = await repository.resolveTransfer({
          transferId: transfer.transferId,
          expectedRevision: transfer.revision,
          state: 'CANCELLED',
          accountId: gate.principal.accountId,
          at: serverNow(this.deps, uow),
          countedMnt: input.recountMnt,
          cancelReason: reason,
        });
        if (resolved === undefined) throw new ApiError('CONFLICT', 'the transfer changed; retry');
        return this.finishTransfer(uow, claimed.idempotencyId, resolved, 'finance.transfer.cancel');
      },
    );
  }

  async transfers(
    target: { hotelId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<{ transfers: readonly TransferView[] }> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      target,
      [REPORT_FULL, TRANSFER_INITIATE, TRANSFER_RECEIVE, COUNT],
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const rows = await new FinanceRepository(uow).pendingTransfers();
        return { transfers: rows.map(transferView) };
      },
    );
  }

  // --------------------------------------------------------------- helpers

  private pendingTransfer(row: TransferRow | undefined, expectedRevision: number): TransferRow {
    if (row === undefined) throw new ApiError('NOT_FOUND', 'not found');
    if (row.revision !== expectedRevision) {
      throw new ApiError('CONFLICT', 'the transfer changed; reload and retry');
    }
    if (row.state !== 'PENDING') {
      throw new ApiError('CONFLICT', 'the transfer is already resolved');
    }
    return row;
  }

  private async finishMovement(
    uow: UnitOfWork,
    idempotencyId: string,
    movement: Awaited<ReturnType<FinanceRepository['post']>>,
    action: string,
    payload: Record<string, unknown> = {},
  ): Promise<MovementView> {
    await recordPlatformAudit(uow, {
      action,
      outcome: 'allowed',
      targetType: 'cash_movement',
      targetRef: movement.movementId,
      payload: {
        movementType: movement.movementType,
        amountMnt: movement.amountMnt.toString(),
        locationId: movement.locationId,
        shiftId: movement.shiftId,
        ...payload,
      },
    });
    await appendOutboxEvent(uow, {
      aggregateType: 'cash_movement',
      aggregateId: movement.movementId,
      eventType: 'finance.cash.movement_posted',
      payload: {
        movementId: movement.movementId,
        locationId: movement.locationId,
        shiftId: movement.shiftId,
        movementType: movement.movementType,
        amountMnt: movement.amountMnt.toString(),
      },
    });
    const result = movementView(movement);
    await completeIdempotencyKey(uow, idempotencyId, 201, result);
    return result;
  }

  private async finishTransfer(
    uow: UnitOfWork,
    idempotencyId: string,
    transfer: TransferRow,
    action: string,
    status = 200,
  ): Promise<TransferView> {
    await recordPlatformAudit(uow, {
      action,
      outcome: 'allowed',
      targetType: 'cash_transfer',
      targetRef: transfer.transferId,
      payload: { state: transfer.state, amountMnt: transfer.amountMnt.toString() },
    });
    await appendOutboxEvent(uow, {
      aggregateType: 'cash_transfer',
      aggregateId: transfer.transferId,
      eventType: `finance.transfer.${transfer.state.toLowerCase()}`,
      payload: {
        transferId: transfer.transferId,
        state: transfer.state,
        amountMnt: transfer.amountMnt.toString(),
      },
    });
    const result = transferView(transfer);
    await completeIdempotencyKey(uow, idempotencyId, status, result);
    return result;
  }
}
