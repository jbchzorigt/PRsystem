import type { Pool } from 'pg';
import type { GeoPoint, GeoPort } from '@prsystem/ports';
import { ApiError, newCorrelationId } from '@prsystem/contracts';
import type { TenantContext, UnitOfWork } from '@prsystem/db';
import { PLATFORM_SCOPE, withTenantTransaction } from '@prsystem/db';
import type { CategoryHoldsPort } from '../contracts/category-holds';
import { PublicRepository } from '../repositories/public.repository';
import type { CategoryOffer, Listing, RankedListing } from '../domain/listing';
import {
  NEARBY_RADIUS_METRES,
  distanceFrom,
  matchesLocation,
  nightsBetween,
  rankListings,
  withinRadius,
} from '../domain/listing';

/**
 * Public hotel search and hotel detail (doc 09 §§3–5, `BK-DEC-001`).
 *
 * Unauthenticated by design: doc 09 §6 makes search and detail public, and
 * requires no named permission for either. What replaces authorization is the
 * projection — an unpublished hotel, a suspended account or a lapsed
 * subscription is not filtered out of a result, it is never in one.
 *
 * Two rules from doc 09 §4 are enforced by what this service does *not* do. It
 * never reads a distance from the request: the only distance that exists is the
 * one computed here from stored coordinates. And it never writes a searcher's
 * position anywhere — the point is an argument to one query and is gone when
 * the request ends.
 */

export interface SearchRequest {
  readonly checkIn?: Date;
  readonly checkOut?: Date;
  /** A city, district or address the searcher typed. */
  readonly location?: string;
  /** The consented current position. Used, never stored (doc 09 §4). */
  readonly origin?: GeoPoint;
  readonly radiusMetres?: number;
}

export interface RequestContext {
  readonly correlationId: string;
}

export function newPublicRequest(): RequestContext {
  return { correlationId: newCorrelationId() };
}

export interface PublicDependencies {
  readonly pool: Pool;
  readonly geo: GeoPort;
  /** Phase 13's confirmed bookings. Fails closed once the table exists. */
  readonly bookings: CategoryHoldsPort;
}

export interface SearchResult {
  readonly nights: number;
  readonly listings: readonly RankedListing[];
}

export interface HotelDetail extends Listing {
  readonly offers: readonly CategoryOffer[];
  readonly nights: number;
}

export class PublicSearchService {
  constructor(private readonly deps: PublicDependencies) {}

  async search(input: SearchRequest, request: RequestContext): Promise<SearchResult> {
    const window = resolveWindow(input.checkIn, input.checkOut);
    const radius = input.radiusMetres ?? NEARBY_RADIUS_METRES;
    return this.inPublicScope(request, async (uow) => {
      const repository = new PublicRepository(uow);
      const visible = (await repository.listings()).filter((listing) =>
        matchesLocation(listing, input.location),
      );

      // The searcher's position narrows the set before any availability is
      // computed, so a hotel outside the radius costs nothing to exclude.
      const near = visible.filter((listing) =>
        withinRadius(distanceFrom(input.origin, listing), radius),
      );

      const held =
        window === undefined
          ? []
          : await this.deps.bookings.heldInWindow(
              uow,
              window,
              near.map((listing) => listing.hotelId),
            );

      const ranked: RankedListing[] = [];
      for (const listing of near) {
        const offers =
          window === undefined
            ? []
            : await repository.offers(listing.hotelId, window.start, window.end);
        const available = offers.reduce(
          (total, offer) =>
            total +
            Math.max(0, offer.availableRooms - heldFor(held, listing.hotelId, offer.categoryId)),
          0,
        );
        ranked.push({
          ...listing,
          // With no dates the card shows a price floor and no availability
          // claim; doc 09 §3.2 asks for `…₮-с` in exactly that case.
          availability:
            window === undefined ? 'NOT_BOOKABLE_ONLINE' : available > 0 ? 'AVAILABLE' : 'FULL',
          distanceMetres: distanceFrom(input.origin, listing),
          availableRooms: available,
        });
      }

      return {
        nights: window === undefined ? 0 : nightsBetween(window.start, window.end),
        listings: rankListings(ranked),
      };
    });
  }

  /** One hotel, with the categories it can offer (doc 09 §3.3). */
  async detail(
    input: { hotelId: string; checkIn?: Date; checkOut?: Date },
    request: RequestContext,
  ): Promise<HotelDetail> {
    const window = resolveWindow(input.checkIn, input.checkOut);
    return this.inPublicScope(request, async (uow) => {
      const repository = new PublicRepository(uow);
      const listing = (await repository.listings()).find(
        (candidate) => candidate.hotelId === input.hotelId,
      );
      // A hotel that is not visible is not "forbidden": it is indistinguishable
      // from one that does not exist, which is the only answer that does not
      // confirm an unpublished hotel to a stranger.
      if (listing === undefined) throw new ApiError('NOT_FOUND', 'no such hotel');

      const offers =
        window === undefined
          ? []
          : await repository.offers(listing.hotelId, window.start, window.end);
      const held =
        window === undefined
          ? []
          : await this.deps.bookings.heldInWindow(uow, window, [listing.hotelId]);

      return {
        ...listing,
        nights: window === undefined ? 0 : nightsBetween(window.start, window.end),
        offers: offers.map((offer) => ({
          ...offer,
          availableRooms: Math.max(
            0,
            offer.availableRooms - heldFor(held, listing.hotelId, offer.categoryId),
          ),
        })),
      };
    });
  }

  private inPublicScope<T>(
    request: RequestContext,
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(this.deps.pool, publicScope(request), work);
  }
}

/**
 * The scope a public read runs in: the platform sentinel, and an anonymous
 * actor. No hotel policy matches it, which is why the projection functions
 * exist at all.
 */
function publicScope(request: RequestContext): TenantContext {
  return {
    hotelId: PLATFORM_SCOPE,
    realm: 'guest',
    actorRef: 'anonymous',
    correlationId: request.correlationId,
  };
}

function heldFor(
  held: readonly { hotelId: string; categoryId: string; held: number }[],
  hotelId: string,
  categoryId: string,
): number {
  return held.find((h) => h.hotelId === hotelId && h.categoryId === categoryId)?.held ?? 0;
}

/**
 * The window, or nothing.
 *
 * doc 09 §3.1 lets a searcher browse without dates; doc 09 §3.2 then shows a
 * price floor rather than an availability claim. A half-open `[start, end)`
 * with at least one night is the only other accepted shape.
 */
function resolveWindow(
  checkIn: Date | undefined,
  checkOut: Date | undefined,
): { start: Date; end: Date } | undefined {
  if (checkIn === undefined && checkOut === undefined) return undefined;
  if (checkIn === undefined || checkOut === undefined) {
    throw new ApiError('VALIDATION_FAILED', 'give both checkIn and checkOut, or neither');
  }
  if (checkOut.getTime() <= checkIn.getTime()) {
    throw new ApiError('VALIDATION_FAILED', 'checkOut must be after checkIn');
  }
  return { start: checkIn, end: checkOut };
}
