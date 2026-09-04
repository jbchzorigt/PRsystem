import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import type { Channel, SourceLevel, StayType, TariffChain } from '../domain/tariffs';
import { resolveCleaningBuffer, resolveRate } from '../domain/tariffs';
import type {
  CatalogRepository as Repository,
  SnapshotRow,
} from '../repositories/catalog.repository';
import { CatalogRepository } from '../repositories/catalog.repository';
import type { CatalogDependencies, CommandActor, RequestContext } from './catalog-context';
import { CatalogServiceBase } from './catalog-context';

/**
 * Server-authoritative rate resolution and the confirmation snapshot
 * (doc 05 §13, doc 07 §2.1; `STAY-DEC-002`, `STAY-DEC-005`, `STAY-DEC-006`,
 * `RML-DEC-004`).
 *
 * Two surfaces, one resolution:
 *
 *  - `effectiveRate` is a read. It tells an operator, or the Reception screen,
 *    what the server would price a stay type at right now, and where that price
 *    comes from. It writes nothing.
 *  - `captureRateSnapshot` is the contract Phases 08 and 13 call **inside the
 *    transaction that confirms a walk-in stay or an online booking**. It has no
 *    HTTP route, because nothing in Phase 06 confirms anything; it resolves the
 *    price the same way, then writes it once, keyed by the subject, so a retry
 *    of the confirmation reads the price it already captured rather than
 *    pricing again.
 *
 * Both take the configuration, the category and the room `FOR SHARE`, in the
 * module's lock order. A tariff write or a lifecycle transition holds those rows
 * `FOR UPDATE`, so a resolution never straddles an edit: the version it records
 * belongs to a configuration that was whole when it read it, and a room or
 * category retired in a concurrent transaction is seen as retired
 * (doc 26 §11).
 *
 * A missing value is a refusal. No default rate, no zero-minute buffer and no
 * assumed check-out time exist anywhere in this file.
 */

const SNAPSHOT_VIEW = ['hotel.tariff.snapshot_view', 'hotel.tariff.snapshot_view.read'];

export const SUBJECT_TYPES = ['WALK_IN_STAY', 'ONLINE_BOOKING'] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export function isSubjectType(value: string): value is SubjectType {
  return (SUBJECT_TYPES as readonly string[]).includes(value);
}

/** The subject decides the channel: an online booking is quoted category-first, without a room. */
export function channelOf(subjectType: SubjectType): Channel {
  return subjectType === 'ONLINE_BOOKING' ? 'ONLINE' : 'WALK_IN';
}

export interface RateQuery {
  readonly hotelId: string;
  readonly stayType: StayType;
  readonly channel: Channel;
  /** Required for an online quote, derived from the room for a walk-in. */
  readonly categoryId?: string;
  /** Required for a walk-in, refused for an online quote. */
  readonly roomId?: string;
}

export interface EffectiveRate {
  readonly stayType: StayType;
  readonly channel: Channel;
  readonly unitPriceMnt: string;
  readonly sourceLevel: SourceLevel;
  readonly sourceEntityId: string;
  readonly configVersion: number;
  readonly categoryId: string;
  readonly roomId: string | null;
  readonly cleaningBufferMinutes: number;
  readonly fixedCheckoutMinute: number | null;
}

export interface CaptureSnapshotInput {
  readonly subjectType: SubjectType;
  readonly subjectRef: string;
  readonly stayType: StayType;
  readonly categoryId?: string;
  readonly roomId?: string;
}

export interface SnapshotView {
  readonly snapshotId: string;
  readonly subjectType: string;
  readonly subjectRef: string;
  readonly stayType: StayType;
  readonly unitPriceMnt: string;
  readonly sourceLevel: SourceLevel;
  readonly sourceEntityId: string;
  readonly pricingConfigVersion: number;
  readonly categoryId: string;
  readonly roomId: string | null;
  readonly cleaningBufferMinutes: number;
  readonly fixedCheckoutMinute: number | null;
}

export interface CaptureOutcome {
  readonly snapshot: SnapshotView;
  /** `false` when the subject already had a snapshot: that one is returned, unchanged. */
  readonly captured: boolean;
}

function snapshotView(row: SnapshotRow): SnapshotView {
  return {
    snapshotId: row.snapshotId,
    subjectType: row.subjectType,
    subjectRef: row.subjectRef,
    stayType: row.stayType,
    unitPriceMnt: row.unitPriceMnt.toString(),
    sourceLevel: row.sourceLevel,
    sourceEntityId: row.sourceEntityId,
    pricingConfigVersion: row.pricingConfigVersion,
    categoryId: row.categoryId,
    roomId: row.roomId,
    cleaningBufferMinutes: row.cleaningBufferMinutes,
    fixedCheckoutMinute: row.fixedCheckoutMinute,
  };
}

export class TariffService extends CatalogServiceBase {
  constructor(deps: CatalogDependencies) {
    super(deps);
  }

  /** What the server would charge now, and why. Reads only. */
  async effectiveRate(
    query: RateQuery,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<EffectiveRate> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: query.hotelId },
      SNAPSHOT_VIEW,
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        return this.resolve(new CatalogRepository(uow), query);
      },
    );
  }

  /** A captured snapshot, as the permission row reads it. */
  async snapshot(
    target: { hotelId: string; subjectType: SubjectType; subjectRef: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<SnapshotView> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId: target.hotelId },
      SNAPSHOT_VIEW,
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const row = await new CatalogRepository(uow).snapshotFor(
          target.subjectType,
          target.subjectRef,
        );
        if (row === undefined) throw new ApiError('NOT_FOUND', 'not found');
        return snapshotView(row);
      },
    );
  }

  /**
   * The confirmation snapshot, written once per subject.
   *
   * Called by the owning phase inside its own transaction and hotel scope, after
   * it has taken whatever locks its aggregate needs and before it commits the
   * confirmation. Idempotent on `(hotel, subject_type, subject_ref)`: a second
   * call for the same subject — a retried confirmation, a duplicate request —
   * returns the snapshot the first one wrote, and never a re-resolved price.
   *
   * The rate is resolved on the channel the subject implies. An online booking
   * cannot pass a room: the physical room is assigned at check-in, after the
   * price was confirmed, and the database constraint on the snapshot table
   * refuses a room-sourced online price as well (`STAY-DEC-005`).
   */
  /**
   * The effective walk-in rate for a room, read-only, in the caller's
   * transaction: what Phase 08's quote shows before a check-in captures the
   * snapshot that confirms it (`STAY-DEC-005`).
   */
  async resolveForCheckIn(
    uow: UnitOfWork,
    input: { readonly stayType: StayType; readonly categoryId: string; readonly roomId: string },
  ): Promise<{
    readonly unitPriceMnt: bigint;
    readonly sourceLevel: SourceLevel;
    readonly pricingConfigVersion: number;
    readonly cleaningBufferMinutes: number;
    readonly fixedCheckoutMinute: number | null;
  }> {
    const rate = await this.resolve(new CatalogRepository(uow), {
      hotelId: uow.context.hotelId,
      stayType: input.stayType,
      channel: 'WALK_IN',
      categoryId: input.categoryId,
      roomId: input.roomId,
    });
    return {
      unitPriceMnt: BigInt(rate.unitPriceMnt),
      sourceLevel: rate.sourceLevel,
      pricingConfigVersion: rate.configVersion,
      cleaningBufferMinutes: rate.cleaningBufferMinutes,
      fixedCheckoutMinute: rate.fixedCheckoutMinute,
    };
  }

  async captureRateSnapshot(uow: UnitOfWork, input: CaptureSnapshotInput): Promise<CaptureOutcome> {
    const catalog = new CatalogRepository(uow);
    const existing = await catalog.snapshotFor(input.subjectType, input.subjectRef);
    if (existing !== undefined) return { snapshot: snapshotView(existing), captured: false };

    const channel = channelOf(input.subjectType);
    if (channel === 'ONLINE' && input.roomId !== undefined) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'an online booking is priced before a room is assigned; no room may be given',
      );
    }
    const rate = await this.resolve(catalog, {
      hotelId: uow.context.hotelId,
      stayType: input.stayType,
      channel,
      ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
      ...(input.roomId === undefined ? {} : { roomId: input.roomId }),
    });

    const { captured } = await catalog.captureSnapshot({
      subjectType: input.subjectType,
      subjectRef: input.subjectRef,
      stayType: rate.stayType,
      unitPriceMnt: BigInt(rate.unitPriceMnt),
      sourceLevel: rate.sourceLevel,
      sourceEntityId: rate.sourceEntityId,
      pricingConfigVersion: rate.configVersion,
      categoryId: rate.categoryId,
      roomId: rate.roomId,
      cleaningBufferMinutes: rate.cleaningBufferMinutes,
      fixedCheckoutMinute: rate.fixedCheckoutMinute,
    });
    // Read back rather than trusting the insert: two confirmations racing for
    // one subject both reach here, one row exists, and both return it. The
    // one whose insert did nothing reports `captured: false`.
    const written = await catalog.snapshotFor(input.subjectType, input.subjectRef);
    if (written === undefined) throw new Error('the snapshot was not written');
    return { snapshot: snapshotView(written), captured };
  }

  // ------------------------------------------------------------ internals

  /**
   * The resolution both surfaces share.
   *
   * Order of refusals: an unknown or foreign id is `NOT_FOUND`; a retired entity
   * is `ENTITY_NOT_ACTIVE` (doc 26 §3); a stay type no level prices, a cleaning
   * buffer no level sets, and a nightly stay with no fixed check-out time are
   * each `PRECONDITION_FAILED`, named, so the Manager knows what to configure.
   */
  private async resolve(catalog: Repository, query: RateQuery): Promise<EffectiveRate> {
    if (query.channel === 'ONLINE' && query.roomId !== undefined) {
      throw new ApiError('VALIDATION_FAILED', 'an online quote does not take a room');
    }
    if (query.channel === 'WALK_IN' && query.roomId === undefined) {
      throw new ApiError('VALIDATION_FAILED', 'a walk-in rate is resolved for a physical room');
    }

    // The module's lock order, configuration → category → room, with share
    // locks. The room's category is read without a lock first so the category
    // can be locked *before* the room; the room is then locked and re-read, and
    // a room that moved category in between is refused rather than priced
    // against a category it no longer belongs to.
    const configuration = await catalog.shareConfiguration();
    const unlockedRoom =
      query.roomId === undefined ? undefined : await catalog.roomById(query.roomId);
    if (query.roomId !== undefined && unlockedRoom === undefined) {
      throw new ApiError('NOT_FOUND', 'not found');
    }
    const categoryId = unlockedRoom?.categoryId ?? query.categoryId;
    if (categoryId === undefined) {
      throw new ApiError('VALIDATION_FAILED', 'an online quote names a room category');
    }
    if (
      query.categoryId !== undefined &&
      unlockedRoom !== undefined &&
      unlockedRoom.categoryId !== categoryId
    ) {
      throw new ApiError('VALIDATION_FAILED', 'the room does not belong to the named category');
    }
    const category = await catalog.shareCategory(categoryId);
    if (category === undefined) throw new ApiError('NOT_FOUND', 'not found');
    const room = query.roomId === undefined ? undefined : await catalog.shareRoom(query.roomId);
    if (query.roomId !== undefined && room === undefined) {
      throw new ApiError('NOT_FOUND', 'not found');
    }
    if (room !== undefined && room.categoryId !== categoryId) {
      throw new ApiError('CONFLICT', 'the room changed category; resolve again');
    }

    if (category.state !== 'ACTIVE') {
      throw new ApiError('CONFLICT', 'ENTITY_NOT_ACTIVE: the room category is not active');
    }
    if (room !== undefined && room.state !== 'ACTIVE') {
      throw new ApiError('CONFLICT', 'ENTITY_NOT_ACTIVE: the room is not active');
    }

    const chain: TariffChain = {
      ...(room === undefined
        ? {}
        : {
            room: {
              entityId: room.roomId,
              hourlyRateMnt: room.hourlyRateMnt,
              nightlyRateMnt: room.nightlyRateMnt,
            },
          }),
      category: {
        entityId: category.categoryId,
        hourlyRateMnt: category.hourlyRateMnt,
        nightlyRateMnt: category.nightlyRateMnt,
      },
      hotel: {
        entityId: query.hotelId,
        hourlyRateMnt: configuration?.hourlyRateMnt ?? null,
        nightlyRateMnt: configuration?.nightlyRateMnt ?? null,
      },
    };

    const resolved = resolveRate(chain, query.stayType, query.channel);
    if (resolved.kind === 'unset') {
      throw new ApiError(
        'PRECONDITION_FAILED',
        `TARIFF_UNSET: no ${query.stayType} rate is configured at any level`,
      );
    }
    const buffer = resolveCleaningBuffer(
      configuration?.cleaningBufferMinutes ?? null,
      category.cleaningBufferMinutes,
    );
    if (buffer.kind === 'unset') {
      throw new ApiError(
        'PRECONDITION_FAILED',
        'CLEANING_BUFFER_UNSET: no cleaning duration is configured for the hotel or the category',
      );
    }
    const fixedCheckoutMinute = configuration?.fixedCheckoutMinute ?? null;
    if (query.stayType === 'NIGHTLY' && fixedCheckoutMinute === null) {
      throw new ApiError(
        'PRECONDITION_FAILED',
        'CHECKOUT_TIME_UNSET: a nightly stay needs the hotel fixed check-out time',
      );
    }

    return {
      stayType: query.stayType,
      channel: query.channel,
      unitPriceMnt: resolved.rate.unitPriceMnt.toString(),
      sourceLevel: resolved.rate.sourceLevel,
      sourceEntityId: resolved.rate.sourceEntityId,
      // A hotel that has never written its configuration is at version 1, the
      // value the row would carry — but no level can have priced anything then,
      // so this branch is unreachable past the unset refusal above.
      configVersion: configuration?.configVersion ?? 1,
      categoryId: category.categoryId,
      roomId: room?.roomId ?? null,
      cleaningBufferMinutes: buffer.minutes,
      // An hourly stay has no fixed end; the snapshot constraint says so too.
      fixedCheckoutMinute: query.stayType === 'NIGHTLY' ? fixedCheckoutMinute : null,
    };
  }
}
