import { randomUUID } from 'node:crypto';
import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import { deriveLookupToken, encryptValue } from '@prsystem/ports';
import type { LocalDate } from '@prsystem/time';
import { hotelLocalDate, instant } from '@prsystem/time';
import { readCategoryState, shareRoom } from '../../catalog/contracts/room-reads';
import type { RoomState } from '../../catalog/contracts/room-reads';
import type { CheckInPin } from '../../minibar/services/configuration.service';
import type { GuestIdentityInput, Provenance } from '../domain/identity';
import {
  ADULT_AGE,
  ageAt,
  identifierOf,
  identityRefusals,
  isStructurallyValidRegistrationNumber,
  normalizeRegistrationNumber,
  policeEligibility,
} from '../domain/identity';
import { readinessBlockers } from '../domain/readiness';
import type { StayType } from '../domain/timing';
import {
  backdateMinutes,
  earliestAllowedCheckIn,
  fitsBeforeNext,
  hourlyCharge,
  nightlyCharge,
  plannedCheckout,
  readyNotBefore,
} from '../domain/timing';
import { HousekeepingRepository } from '../repositories/housekeeping.repository';
import type { InsertGuestInput, PriceLine } from '../repositories/stay.repository';
import { StayRepository } from '../repositories/stay.repository';
import { ConflictRepository } from '../repositories/conflict.repository';
import { ShiftRepository } from '../repositories/shift.repository';
import type { CommandActor, RequestContext, StayDependencies } from './stay-context';
import { StayServiceBase, claim, hotelTimeZone, serverNow, sqlState } from './stay-context';
import type { StayView } from './stay-views';
import { loadStayView } from './stay-views';

/**
 * Check-in (doc 05 §3, §§6–7, §§17–19, §23.1; doc 02 §3.1, §3.13; doc 25 §3;
 * `STAY-DEC-007`…`-009`, `-013`, `-014`, `RC-DEC-007`, `-012`, `-014`, `-017`,
 * `-033`, `-044`, `PRICE-DEC-001`).
 *
 * One transaction confirms everything or nothing: the shift and the room are
 * share-locked, the minibar configuration is pinned, the arrival is bounded
 * against the server's time, readiness is proven at the arrival instant from
 * history, the tariff is captured as a snapshot, the guest's identity is
 * verified or marked manual and stored encrypted, the price book is written
 * from the exact pinned version, and the stay, its history, the audit and the
 * outbox event Police matching consumes are all written before the key is
 * completed. Two Receptions confirming one room at once meet the partial
 * unique index; the loser sees `ROOM_OCCUPIED`.
 */

const CHECK_IN = 'hotel.stay.check_in';
const ACTUAL_TIME_SELECT = 'hotel.stay.check_in_actual_time_select';
const SNAPSHOT_VIEW = ['hotel.tariff.snapshot_view', 'hotel.tariff.snapshot_view.read'];

export interface CheckInInput {
  readonly hotelId: string;
  readonly idempotencyKey: string;
  readonly roomId: string;
  readonly source: 'WALK_IN' | 'ONLINE';
  readonly bookingRef?: string;
  readonly stayType: StayType;
  readonly halfHourUnits?: number;
  readonly nightCount?: number;
  /** Absent: the server's time. Present: a backdate within `STAY-DEC-009`. */
  readonly actualCheckInAt?: Date;
  readonly backdateReasonCode?: string;
  readonly backdateNote?: string;
  readonly guest: GuestIdentityInput;
}

export interface QuoteInput {
  readonly hotelId: string;
  readonly roomId: string;
  readonly stayType: StayType;
  readonly halfHourUnits?: number;
  readonly nightCount?: number;
  readonly actualCheckInAt?: Date;
}

export interface QuoteView {
  readonly roomId: string;
  readonly stayType: StayType;
  readonly serverNow: string;
  readonly actualCheckInAt: string;
  readonly earliestAllowedCheckInAt: string | null;
  readonly plannedCheckoutAt: string;
  readonly unitRateMnt: string;
  readonly roomChargeMnt: string;
  readonly sourceLevel: string;
  readonly pricingConfigVersion: number;
  readonly cleaningBufferMinutes: number;
  readonly fixedCheckoutMinute: number | null;
  readonly blockers: readonly string[];
  readonly depositRequired: boolean;
}

interface ResolvedTiming {
  readonly now: Date;
  readonly actualCheckInAt: Date;
  readonly backdate: number;
  readonly earliest: Date | null;
}

export class CheckInService extends StayServiceBase {
  constructor(deps: StayDependencies) {
    super(deps);
  }

  /**
   * doc 05 §3: what the Reception sees before confirming — the planned end,
   * the charge and its source, and every blocker — computed by the same rules
   * as the confirmation and writing nothing.
   */
  async quote(input: QuoteInput, actor: CommandActor, request: RequestContext): Promise<QuoteView> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: input.hotelId },
      [CHECK_IN, ...SNAPSHOT_VIEW],
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const room = await shareRoom(uow, input.roomId);
        if (room === undefined) throw new ApiError('NOT_FOUND', 'not found');
        const now = serverNow(this.deps, uow);
        const timeZone = await hotelTimeZone(uow);
        const shift = await new ShiftRepository(uow).currentOpen();
        const actualCheckInAt = input.actualCheckInAt ?? now;
        const earliest =
          shift === undefined
            ? null
            : earliestAllowedCheckIn({ serverNow: now, shiftOpenedAt: shift.openedAt, timeZone });
        const rate = await this.deps.tariffs.resolveForCheckIn(uow, {
          stayType: input.stayType,
          categoryId: room.categoryId,
          roomId: room.roomId,
        });
        const planned = this.plannedEnd(input, actualCheckInAt, rate.fixedCheckoutMinute, timeZone);
        const charge = this.charge(input, rate.unitPriceMnt);
        const blockers = await this.readiness(
          uow,
          room,
          actualCheckInAt,
          now,
          planned,
          rate.cleaningBufferMinutes,
          undefined,
        );
        if (shift === undefined) blockers.blockers.unshift('NO_OPEN_SHIFT');
        return {
          roomId: room.roomId,
          stayType: input.stayType,
          serverNow: now.toISOString(),
          actualCheckInAt: actualCheckInAt.toISOString(),
          earliestAllowedCheckInAt: earliest === null ? null : earliest.toISOString(),
          plannedCheckoutAt: planned.toISOString(),
          unitRateMnt: rate.unitPriceMnt.toString(),
          roomChargeMnt: charge.toString(),
          sourceLevel: rate.sourceLevel,
          pricingConfigVersion: rate.pricingConfigVersion,
          cleaningBufferMinutes: rate.cleaningBufferMinutes,
          fixedCheckoutMinute: rate.fixedCheckoutMinute,
          blockers: blockers.blockers,
          depositRequired: true,
        };
      },
    );
  }

  async checkIn(
    input: CheckInInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<StayView> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: input.hotelId },
      [CHECK_IN],
      request,
      async (uow, gate, authorize, authorizeAlso) => {
        const claimed = await claim(uow, 'stay.check_in', input.idempotencyKey, {
          roomId: input.roomId,
          source: input.source,
          bookingRef: input.bookingRef ?? null,
          stayType: input.stayType,
          halfHourUnits: input.halfHourUnits ?? null,
          nightCount: input.nightCount ?? null,
          actualCheckInAt: input.actualCheckInAt?.toISOString() ?? null,
          identityType: input.guest.identityType,
        });
        if (claimed.kind === 'replay') return claimed.body as StayView;

        // Lock order: shift (share) → room (share) → minibar configuration (share).
        const openShift = await new ShiftRepository(uow).shareOpen();
        const room = await shareRoom(uow, input.roomId);
        await authorize();
        if (room === undefined) throw new ApiError('NOT_FOUND', 'not found');
        if (openShift === undefined) {
          throw new ApiError('PRECONDITION_FAILED', 'NO_OPEN_SHIFT: open a Reception shift first');
        }
        const shift = openShift;
        const pin = await this.deps.minibar.checkInPin(uow, room.roomId);

        const now = serverNow(this.deps, uow);
        const timeZone = await hotelTimeZone(uow);
        const booking =
          input.source === 'ONLINE'
            ? await this.deps.bookings.byReference(uow, input.bookingRef as string)
            : undefined;
        if (input.source === 'ONLINE' && booking === undefined) {
          throw new ApiError(
            'NOT_FOUND',
            'BOOKING_NOT_FOUND: no confirmed booking with that reference',
          );
        }
        if (booking !== undefined && booking.categoryId !== room.categoryId) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            'BOOKING_CATEGORY_MISMATCH: the room is not of the booked category',
          );
        }

        // `STAY-DEC-009`: the arrival, bounded on the server's time.
        const timing = this.resolveTiming(
          input,
          now,
          shift.openedAt,
          timeZone,
          booking?.plannedCheckInAt,
        );
        if (timing.backdate > 0) await authorizeAlso(ACTUAL_TIME_SELECT);

        // `STAY-DEC-005` / `-007`: the tariff is a snapshot the stay owns.
        const stayId = randomUUID();
        const captured = await this.deps.tariffs.captureRateSnapshot(uow, {
          subjectType: input.source === 'ONLINE' ? 'ONLINE_BOOKING' : 'WALK_IN_STAY',
          subjectRef: input.source === 'ONLINE' ? (input.bookingRef as string) : stayId,
          stayType: input.stayType,
          categoryId: room.categoryId,
          ...(input.source === 'ONLINE' ? {} : { roomId: room.roomId }),
        });
        const snapshot = captured.snapshot;
        const unitRate = BigInt(snapshot.unitPriceMnt);
        const planned = this.plannedEnd(
          input,
          timing.actualCheckInAt,
          snapshot.fixedCheckoutMinute,
          timeZone,
        );
        if (planned.getTime() <= now.getTime()) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            'PLANNED_CHECKOUT_PASSED: the planned checkout is not after the server time',
          );
        }
        const charge = this.charge(input, unitRate);

        // Readiness at the arrival instant, proven from history when backdated.
        const readiness = await this.readiness(
          uow,
          room,
          timing.actualCheckInAt,
          now,
          planned,
          snapshot.cleaningBufferMinutes,
          pin,
          booking?.bookingRef,
        );
        if (readiness.blockers.length > 0) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            `ROOM_NOT_READY: ${readiness.blockers.join(', ')}`,
            readiness.blockers.map((code) => ({ field: 'roomId', issue: code })),
          );
        }
        if (timing.backdate > 0 && !readiness.historicallyProven) {
          throw new ApiError(
            'PRECONDITION_FAILED',
            'HISTORICAL_READINESS_UNPROVEN: the room cannot be proven ready at the chosen time; check in at the server time',
          );
        }

        // The primary guest (doc 02 §3.1).
        const guest = await this.resolveGuest(
          input.guest,
          timing.actualCheckInAt,
          timeZone,
          input.idempotencyKey,
          request,
        );

        // `BK-DEC-013`: the booking is consumed in this transaction, so the
        // category reservation becomes this stay's occupancy atomically. A
        // booking that stopped being fulfillable between the read above and
        // this lock refuses the check-in rather than producing a stay no
        // booking authorizes.
        let fulfilledBookingId: string | undefined;
        if (input.source === 'ONLINE') {
          fulfilledBookingId = await this.deps.bookingFulfilment.consumeAtCheckIn(uow, {
            bookingRef: input.bookingRef as string,
            stayId,
            actorRef: gate.principal.accountId,
          });
          if (fulfilledBookingId === undefined) {
            throw new ApiError(
              'CONFLICT',
              'BOOKING_NOT_FULFILLABLE: that booking is no longer confirmed',
            );
          }
        }

        const stays = new StayRepository(uow);
        let stay;
        try {
          stay = await stays.insert({
            stayId,
            roomId: room.roomId,
            categoryId: room.categoryId,
            source: input.source,
            bookingRef: input.bookingRef ?? null,
            stayType: input.stayType,
            actualCheckInAt: timing.actualCheckInAt,
            checkInRecordedAt: now,
            plannedCheckoutAt: planned,
            halfHourUnits: input.stayType === 'HOURLY' ? (input.halfHourUnits as number) : null,
            nightCount: input.stayType === 'NIGHTLY' ? (input.nightCount as number) : null,
            fixedCheckoutMinute: input.stayType === 'NIGHTLY' ? snapshot.fixedCheckoutMinute : null,
            cleaningBufferMinutes: snapshot.cleaningBufferMinutes,
            rateSnapshotId: snapshot.snapshotId,
            unitRateMnt: unitRate,
            roomChargeMnt: charge,
            pricingConfigVersion: snapshot.pricingConfigVersion,
            shiftId: shift.shiftId,
            checkedInByAccountId: gate.principal.accountId,
            backdateMinutes: timing.backdate,
            backdateReasonCode: timing.backdate > 0 ? (input.backdateReasonCode as string) : null,
            backdateNote: timing.backdate > 0 ? (input.backdateNote ?? null) : null,
            minibarApplicable: pin.configuration?.mode === 'ON',
            ...(fulfilledBookingId === undefined ? {} : { fulfilledBookingId }),
          });
        } catch (error) {
          if (sqlState(error) === '23505') {
            throw new ApiError(
              'CONFLICT',
              'ROOM_OCCUPIED: another stay was confirmed for this room',
            );
          }
          throw error;
        }

        const guestRecordId = randomUUID();
        const identifier = await this.protectIdentifier(guest.identifier, guestRecordId);
        const guestRow = await stays.insertGuest({
          guestRecordId,
          stayId,
          revisionNo: 1,
          ...guest.record,
          identifier,
          correctionReason: null,
          recordedByAccountId: gate.principal.accountId,
        });

        // `PRICE-DEC-001`: the price book, or no stay.
        if (pin.configuration?.mode === 'ON') {
          await stays.insertPriceBook({
            stayId,
            roomId: room.roomId,
            templateId: pin.configuration.templateId as string,
            versionId: pin.configuration.currentVersionId as string,
            snapshotAt: now,
            lines: this.priceLines(pin),
          });
          if (pin.configuration.overrideId !== null) {
            await this.deps.minibar.consumeOverride(uow, room.roomId, stayId);
          }
        }

        await stays.appendEvent({
          stayId,
          eventType: 'CHECKED_IN',
          toState: 'ACTIVE',
          actorAccountId: gate.principal.accountId,
          occurredAt: now,
          payload: {
            roomId: room.roomId,
            source: input.source,
            stayType: input.stayType,
            actualCheckInAt: timing.actualCheckInAt.toISOString(),
            checkInRecordedAt: now.toISOString(),
            backdateMinutes: timing.backdate,
            backdateReasonCode: timing.backdate > 0 ? input.backdateReasonCode : null,
            earliestAllowedAt: timing.earliest?.toISOString() ?? null,
            plannedCheckoutAt: planned.toISOString(),
            rateSnapshotId: snapshot.snapshotId,
            pricingConfigVersion: snapshot.pricingConfigVersion,
            minibarVersionId: pin.configuration?.currentVersionId ?? null,
            overrideId: pin.configuration?.overrideId ?? null,
            identityType: guest.record.identityType,
            provenance: guest.record.provenance,
            policeMatchEligibility: guest.record.policeMatchEligibility,
          },
        });
        // doc 02 §3.4, `DEP-DEC-001`: the confirmation is where the deposit
        // requirement and the configuration behind it are snapshotted. A hotel
        // that has configured no deposit cannot confirm a walk-in at all.
        await this.deps.deposits.openForStay(uow, {
          stayId,
          roomId: room.roomId,
          categoryId: room.categoryId,
          source: input.source === 'ONLINE' ? 'ONLINE' : 'WALK_IN',
        });
        await recordPlatformAudit(uow, {
          action: 'stay.check_in',
          outcome: 'allowed',
          targetType: 'stay',
          targetRef: stayId,
          ...(timing.backdate > 0 ? { reason: input.backdateReasonCode as string } : {}),
          payload: {
            roomId: room.roomId,
            shiftId: shift.shiftId,
            stayType: input.stayType,
            actualCheckInAt: timing.actualCheckInAt.toISOString(),
            checkInRecordedAt: now.toISOString(),
            backdateMinutes: timing.backdate,
            provenance: guest.record.provenance,
            xypOutcome: guest.xypOutcome,
          },
        });
        // doc 13 §8.3: the minimal event Police matching consumes at
        // `check_in_recorded_at` — a keyed token, never the number.
        await appendOutboxEvent(uow, {
          aggregateType: 'stay',
          aggregateId: stayId,
          eventType: 'stay.checked_in',
          payload: {
            stayId,
            roomId: room.roomId,
            roomNumber: room.roomNumber,
            categoryId: room.categoryId,
            source: input.source,
            stayType: input.stayType,
            checkInRecordedAt: now.toISOString(),
            actualCheckInAt: timing.actualCheckInAt.toISOString(),
            plannedCheckoutAt: planned.toISOString(),
            guest: {
              identityType: guest.record.identityType,
              policeMatchEligibility: guest.record.policeMatchEligibility,
              lookupToken: identifier?.lookupToken ?? null,
              lookupKeyVersion: identifier?.lookupKeyVersion ?? null,
              lookupNamespace: identifier?.lookupNamespace ?? null,
            },
          },
        });

        const result = await loadStayView(uow, stay, now);
        void guestRow;
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, result);
        return result;
      },
    );
  }

  // ------------------------------------------------------------ internals

  private resolveTiming(
    input: CheckInInput,
    now: Date,
    shiftOpenedAt: Date,
    timeZone: string,
    bookingPlannedCheckInAt: Date | undefined,
  ): ResolvedTiming {
    const actualCheckInAt = input.actualCheckInAt ?? now;
    if (actualCheckInAt.getTime() > now.getTime()) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'ARRIVAL_IN_FUTURE: the arrival is after the server time',
      );
    }
    const earliest = earliestAllowedCheckIn({
      serverNow: now,
      shiftOpenedAt,
      timeZone,
      ...(bookingPlannedCheckInAt === undefined ? {} : { bookingPlannedCheckInAt }),
    });
    const backdate = backdateMinutes(actualCheckInAt, now);
    if (backdate > 0) {
      if (actualCheckInAt.getTime() < earliest.getTime()) {
        throw new ApiError(
          'PRECONDITION_FAILED',
          'BACKDATE_OUT_OF_BOUND: the arrival is before the earliest allowed time',
          [{ field: 'actualCheckInAt', issue: `not before ${earliest.toISOString()}` }],
        );
      }
      if (input.backdateReasonCode === undefined || input.backdateReasonCode.length === 0) {
        throw new ApiError(
          'VALIDATION_FAILED',
          'BACKDATE_REASON_REQUIRED: a reason code is required for a past arrival',
          [{ field: 'backdateReasonCode', issue: 'required' }],
        );
      }
    }
    return { now, actualCheckInAt, backdate, earliest };
  }

  private plannedEnd(
    input: { stayType: StayType; halfHourUnits?: number; nightCount?: number },
    actualCheckInAt: Date,
    fixedCheckoutMinute: number | null,
    timeZone: string,
  ): Date {
    if (input.stayType === 'HOURLY') {
      if (input.halfHourUnits === undefined) {
        throw new ApiError('VALIDATION_FAILED', 'halfHourUnits is required for an hourly stay');
      }
      return plannedCheckout({
        stayType: 'HOURLY',
        actualCheckInAt,
        halfHourUnits: input.halfHourUnits,
      });
    }
    if (input.nightCount === undefined) {
      throw new ApiError('VALIDATION_FAILED', 'nightCount is required for a nightly stay');
    }
    if (fixedCheckoutMinute === null) {
      throw new ApiError(
        'PRECONDITION_FAILED',
        'NO_FIXED_CHECKOUT_TIME: the hotel has no fixed check-out time configured',
      );
    }
    return plannedCheckout({
      stayType: 'NIGHTLY',
      actualCheckInAt,
      nightCount: input.nightCount,
      fixedCheckoutMinute,
      timeZone,
    });
  }

  private charge(
    input: { stayType: StayType; halfHourUnits?: number; nightCount?: number },
    unitRate: bigint,
  ): bigint {
    return input.stayType === 'HOURLY'
      ? hourlyCharge(unitRate, input.halfHourUnits as number)
      : nightlyCharge(unitRate, input.nightCount as number);
  }

  /**
   * doc 05 §17.1 and §19.2: room and category active, no live stay, the
   * previous stay's readiness anchor passed, `Цэвэр` at the arrival instant
   * from the history, the minibar's own blockers, and the planned end plus
   * buffer fitting before the next confirmed booking. `historicallyProven` is
   * whether every time-dependent fact was already true at the arrival —
   * which for a backdate means the last cleaning event at or before it says
   * `CLEAN` and the minibar configuration has not changed since.
   */
  private async readiness(
    uow: UnitOfWork,
    room: RoomState,
    at: Date,
    now: Date,
    plannedCheckoutAt: Date,
    cleaningBufferMinutes: number,
    pin: CheckInPin | undefined,
    fulfillingBookingRef?: string,
  ): Promise<{ blockers: string[]; historicallyProven: boolean }> {
    const stays = new StayRepository(uow);
    const housekeeping = new HousekeepingRepository(uow);
    const categoryState = (await readCategoryState(uow, room.categoryId)) ?? 'INACTIVE';
    const live = await stays.liveOfRoom(room.roomId);
    const previous = await stays.lastCompletedOfRoom(room.roomId);
    const anchor =
      previous?.actualCheckoutAt === null || previous === undefined
        ? null
        : readyNotBefore(previous.actualCheckoutAt as Date, previous.cleaningBufferMinutes);
    const cleaningAt = await housekeeping.stateAt(room.roomId, at);
    const minibar = pin ?? (await this.deps.minibar.checkInPin(uow, room.roomId));
    const blockers = [
      ...readinessBlockers({
        at,
        roomState: room.state,
        categoryState,
        cleaningStateAt: cleaningAt,
        occupied: live !== undefined,
        readyNotBefore: anchor,
        minibarBlockers: minibar.blockers,
      }),
    ];
    const next = (await this.deps.bookings.commitmentsForRoom(uow, room.roomId, at)).find(
      (booking) => booking.bookingRef !== fulfillingBookingRef,
    );
    if (!fitsBeforeNext(plannedCheckoutAt, cleaningBufferMinutes, next?.plannedCheckInAt)) {
      blockers.push('NEXT_BOOKING_CONFLICT');
    }
    // An overdue conflict open on this room says the room is spoken for, and
    // a resolution that assigned this room to a booking is a commitment the
    // stay must fit before, buffer included (doc 05 §23.2).
    const conflictRepository = new ConflictRepository(uow);
    const conflicts = await conflictRepository.openForRoom(room.roomId);
    if (conflicts.length > 0 && live === undefined) blockers.push('OVERDUE_CONFLICT_OPEN');
    const assignments = await conflictRepository.assignedToRoom(room.roomId, at);
    const ready = readyNotBefore(plannedCheckoutAt, cleaningBufferMinutes);
    if (
      assignments.some(
        (assignment) =>
          assignment.bookingRef !== fulfillingBookingRef &&
          at.getTime() < assignment.plannedCheckoutAt.getTime() &&
          ready.getTime() > assignment.plannedCheckInAt.getTime(),
      )
    ) {
      blockers.push('ASSIGNED_BOOKING_CONFLICT');
    }
    const configurationUnchangedSince =
      minibar.configuration === null || minibar.configuration.updatedAt.getTime() <= at.getTime();
    const historicallyProven =
      at.getTime() >= now.getTime() || (cleaningAt === 'CLEAN' && configurationUnchangedSince);
    return { blockers, historicallyProven };
  }

  private priceLines(pin: CheckInPin): PriceLine[] {
    const held = new Map(pin.stock.map((line) => [line.productId, line.quantity]));
    return pin.items.map((item) => {
      if (item.sellingPriceMnt === null) {
        throw new ApiError(
          'PRECONDITION_FAILED',
          'PRICE_BOOK_INCOMPLETE: a product of the pinned version has no selling price',
          [{ field: item.productId, issue: 'unpriced' }],
        );
      }
      return {
        productId: item.productId,
        productName: item.name,
        productCategory: item.category,
        productUnit: item.unit,
        sellingPriceMnt: item.sellingPriceMnt,
        targetQuantity: item.targetQuantity,
        openingQuantity: held.get(item.productId) ?? 0,
      };
    });
  }

  /**
   * doc 02 §3.1, doc 12 §6, doc 13 §8.2: the record as it will be stored.
   * XYP is asked for a registration number and its answer, when found,
   * is the record; anything else is `MANUAL`, never presented as verified.
   */
  private async resolveGuest(
    input: GuestIdentityInput,
    actualCheckInAt: Date,
    timeZone: string,
    requestRef: string,
    request: RequestContext,
  ): Promise<{
    record: Omit<
      InsertGuestInput,
      | 'guestRecordId'
      | 'stayId'
      | 'revisionNo'
      | 'identifier'
      | 'correctionReason'
      | 'recordedByAccountId'
    >;
    identifier: ReturnType<typeof identifierOf>;
    xypOutcome: string;
  }> {
    const checkInDate = hotelLocalDate(instant(actualCheckInAt), timeZone);
    let provenance: Provenance = 'MANUAL';
    let xypOutcome = 'NOT_ASKED';
    let familyName = input.familyName;
    let givenName = input.givenName;
    let dateOfBirth: LocalDate = input.dateOfBirth;
    if (input.identityType === 'MN_REG_NO') {
      const normalized = normalizeRegistrationNumber(input.registrationNumber);
      if (!isStructurallyValidRegistrationNumber(normalized)) {
        throw new ApiError('VALIDATION_FAILED', 'REGISTRATION_NUMBER_INVALID', [
          { field: 'registrationNumber', issue: 'not a structurally valid registration number' },
        ]);
      }
      const answer = await this.deps.xyp.lookupByRegistrationNumber(
        { registrationNumber: normalized, requestRef },
        { correlationId: request.correlationId },
      );
      if (answer.ok && answer.value.found) {
        provenance = 'XYP_VERIFIED';
        xypOutcome = 'FOUND';
        familyName = answer.value.citizen.familyName;
        givenName = answer.value.citizen.givenName;
        dateOfBirth = answer.value.citizen.dateOfBirth as LocalDate;
      } else {
        xypOutcome = answer.ok ? 'NOT_FOUND' : answer.error.kind;
      }
    }
    const refusals = identityRefusals(
      { ...input, familyName, givenName, dateOfBirth },
      checkInDate,
    );
    if (refusals.length > 0) {
      throw new ApiError(
        'VALIDATION_FAILED',
        `IDENTITY_INVALID: ${refusals.map((r) => r.code).join(', ')}`,
        refusals.map((r) => ({ field: r.field, issue: r.code })),
      );
    }
    const age = ageAt(dateOfBirth, checkInDate);
    const identifier = identifierOf(input);
    const structurallyValid = input.identityType !== 'MN_REG_NO' || identifier !== undefined;
    const record = {
      identityType: input.identityType,
      familyName,
      givenName,
      dateOfBirth,
      nationality: input.nationality,
      provenance,
      assurance: input.identityType === 'NO_DOCUMENT' ? 'LOW_ASSURANCE' : 'DOCUMENT',
      documentCountry:
        input.identityType === 'MN_REG_NO'
          ? 'MN'
          : input.identityType === 'NO_DOCUMENT'
            ? null
            : input.issuingCountry,
      documentExpiresOn: input.identityType === 'FOREIGN_PASSPORT' ? input.expiresOn : null,
      documentType: input.identityType === 'OTHER_GOV_ID' ? input.documentType : null,
      documentAuthority: input.identityType === 'OTHER_GOV_ID' ? input.issuingAuthority : null,
      noDocumentReason: input.identityType === 'NO_DOCUMENT' ? input.reason : null,
      noDocumentNote: input.identityType === 'NO_DOCUMENT' ? (input.note ?? null) : null,
      ageAtCheckIn: age,
      guardian:
        age < ADULT_AGE && input.guardian !== undefined
          ? {
              name: input.guardian.name,
              phone: input.guardian.phone,
              relationship: input.guardian.relationship,
            }
          : null,
      policeMatchEligibility: policeEligibility(input.identityType, structurallyValid),
    };
    return { record, identifier, xypOutcome };
  }

  /** Envelope-encrypts the identifier bound to its row and derives the keyed lookup token. */
  private async protectIdentifier(
    identifier: ReturnType<typeof identifierOf>,
    guestRecordId: string,
  ): Promise<InsertGuestInput['identifier']> {
    if (identifier === undefined) return null;
    const envelope = await encryptValue(this.deps.keys, 'pii.hotel_guest', identifier.value, {
      table: 'platform.stay_guest',
      column: 'identifier_ciphertext',
      rowRef: guestRecordId,
    });
    const token = await deriveLookupToken(
      this.deps.keys,
      'lookup.identity',
      { identityType: identifier.identityType, countryCode: identifier.countryCode },
      identifier.value,
    );
    return {
      ciphertext: envelope.ciphertext,
      wrappedDek: envelope.wrappedDek,
      keyVersion: envelope.keyVersion,
      lookupToken: token.token,
      lookupKeyVersion: token.keyVersion,
      lookupNamespace: `${identifier.identityType}:${identifier.countryCode}`,
    };
  }
}
