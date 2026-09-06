import type { GeoPoint } from '@prsystem/ports';
import { greatCircleMetres } from '@prsystem/ports';

/**
 * What a public search decides, with nothing around it (doc 09 §§3–5).
 *
 * Distance and ordering are computed here — on the server, from the stored
 * coordinates — because doc 09 §4 says a client-supplied distance is never
 * trusted. The request has no field for one, and if it had, nothing here would
 * read it.
 */

/**
 * doc 09 §3.2 refuses to hide every condition behind one word. A card says
 * which of these it is, and the three are decided separately.
 */
export type ListingAvailability = 'AVAILABLE' | 'FULL' | 'NOT_BOOKABLE_ONLINE';

export interface CategoryOffer {
  readonly categoryId: string;
  readonly name: string;
  readonly description: string | null;
  readonly nightlyRateMnt: bigint;
  readonly availableRooms: number;
  readonly photoObjectKey: string | null;
}

export interface Listing {
  readonly hotelId: string;
  readonly publicName: string;
  readonly district: string | null;
  readonly khoroo: string | null;
  readonly addressLine: string;
  readonly publicPhone: string;
  readonly point: GeoPoint;
  readonly coverObjectKey: string | null;
  readonly fromRateMnt: bigint | null;
  /**
   * `BK-DEC-004` and doc 10 §6: what the published reviews say about this
   * hotel. The count and the average are the server's own aggregate — a hotel
   * with no published review reports `0` and `0`, never a null the caller has
   * to interpret and never an invented average.
   */
  readonly reviewCount: number;
  readonly averageRatingCenti: number;
}

export interface RankedListing extends Listing {
  readonly availability: ListingAvailability;
  /** Whole metres from the searcher's position, when they consented to share one. */
  readonly distanceMetres: number | null;
  readonly availableRooms: number;
}

/**
 * The interim nearby radius: 5 km.
 *
 * P1-01 in `external-integration-gates.md` §4 leaves the real number and the
 * sort order to a decision that has not been made. This is that document's own
 * interim value, named here rather than inlined so it changes in one place.
 */
export const NEARBY_RADIUS_METRES = 5_000;

/** Nights in `[checkIn, checkOut)`, which is what an MVP booking is priced in. */
export function nightsBetween(checkIn: Date, checkOut: Date): number {
  const ms = checkOut.getTime() - checkIn.getTime();
  return Math.max(0, Math.round(ms / 86_400_000));
}

export function distanceFrom(origin: GeoPoint | undefined, listing: Listing): number | null {
  return origin === undefined ? null : greatCircleMetres(origin, listing.point);
}

/**
 * The interim order: availability first, then distance (P1-01).
 *
 * A hotel with rooms outranks one without, whatever the distance — a searcher
 * with dates is looking for somewhere to stay, not somewhere to walk past. Ties
 * fall back to the name, so the order is total and a page is stable.
 */
export function rankListings(listings: readonly RankedListing[]): readonly RankedListing[] {
  const rank = (l: RankedListing): number => (l.availability === 'AVAILABLE' ? 0 : 1);
  return [...listings].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (
      a.distanceMetres !== null &&
      b.distanceMetres !== null &&
      a.distanceMetres !== b.distanceMetres
    ) {
      return a.distanceMetres - b.distanceMetres;
    }
    return a.publicName.localeCompare(b.publicName);
  });
}

/** Within the nearby radius, when the searcher gave a position at all. */
export function withinRadius(distanceMetres: number | null, radiusMetres: number): boolean {
  return distanceMetres === null || distanceMetres <= radiusMetres;
}

/**
 * A free-text location, matched against the fields a listing actually carries.
 *
 * doc 09 §3.1 lets a searcher choose a city, a district or an address by hand.
 * The comparison is case-insensitive and accent-preserving; it is a filter over
 * rows the projection already decided are visible, never a way to reach one it
 * did not return.
 */
export function matchesLocation(listing: Listing, query: string | undefined): boolean {
  if (query === undefined || query.trim() === '') return true;
  const needle = query.trim().toLocaleLowerCase();
  return [listing.district, listing.khoroo, listing.addressLine, listing.publicName].some(
    (field) => field !== null && field.toLocaleLowerCase().includes(needle),
  );
}

/**
 * One published review, as a stranger sees it (doc 10 §6, §8).
 *
 * The masked name and nothing that identifies the reviewer: no account, no
 * booking, no room, no contact detail. The reply is present only while both it
 * and its review are live.
 */
export interface PublicReview {
  readonly reviewId: string;
  readonly rating: number;
  readonly comment: string;
  readonly displayName: string;
  readonly edited: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly reply: {
    readonly body: string;
    readonly edited: boolean;
    readonly updatedAt: Date;
  } | null;
}
