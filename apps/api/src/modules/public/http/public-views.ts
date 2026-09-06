import type { CategoryOffer, PublicReview, RankedListing } from '../domain/listing';
import { formatAverage } from '../../review/domain/review';
import type { HotelDetail, SearchResult } from '../services/search.service';

/**
 * The wire shape of the public surface.
 *
 * MNT amounts are integers in the domain and strings on the wire, the way every
 * other money-bearing endpoint returns them (CLAUDE.md §5): a `bigint` has no
 * JSON representation, and rendering one as a `number` would silently round the
 * values this platform exists to keep exact.
 */

const money = (value: bigint | null): string | null => (value === null ? null : value.toString());

export interface CategoryOfferView {
  readonly categoryId: string;
  readonly name: string;
  readonly description: string | null;
  readonly nightlyRateMnt: string;
  readonly availableRooms: number;
  readonly photoObjectKey: string | null;
}

export interface ListingView {
  readonly hotelId: string;
  readonly publicName: string;
  readonly district: string | null;
  readonly khoroo: string | null;
  readonly addressLine: string;
  readonly publicPhone: string;
  readonly latitudeMicro: number;
  readonly longitudeMicro: number;
  readonly coverObjectKey: string | null;
  readonly fromRateMnt: string | null;
  /**
   * `BK-DEC-004`: the rating the server computed, and the count behind it.
   *
   * The average is sent as a formatted string from the integer hundredths the
   * aggregate stores — never as a float, and never as two numbers the client is
   * expected to divide (doc 10 §6).
   */
  readonly reviewCount: number;
  readonly averageRating: string;
  readonly availability: RankedListing['availability'];
  readonly distanceMetres: number | null;
  readonly availableRooms: number;
}

export function offerView(offer: CategoryOffer): CategoryOfferView {
  return {
    categoryId: offer.categoryId,
    name: offer.name,
    description: offer.description,
    nightlyRateMnt: offer.nightlyRateMnt.toString(),
    availableRooms: offer.availableRooms,
    photoObjectKey: offer.photoObjectKey,
  };
}

export function listingView(listing: RankedListing): ListingView {
  return {
    hotelId: listing.hotelId,
    publicName: listing.publicName,
    district: listing.district,
    khoroo: listing.khoroo,
    addressLine: listing.addressLine,
    publicPhone: listing.publicPhone,
    latitudeMicro: listing.point.latitudeMicro,
    longitudeMicro: listing.point.longitudeMicro,
    coverObjectKey: listing.coverObjectKey,
    fromRateMnt: money(listing.fromRateMnt),
    reviewCount: listing.reviewCount,
    averageRating: formatAverage(listing.averageRatingCenti),
    availability: listing.availability,
    distanceMetres: listing.distanceMetres,
    availableRooms: listing.availableRooms,
  };
}

export interface SearchView {
  readonly nights: number;
  readonly listings: readonly ListingView[];
}

export function searchView(result: SearchResult): SearchView {
  return { nights: result.nights, listings: result.listings.map(listingView) };
}

export interface HotelDetailView extends Omit<ListingView, 'availability' | 'availableRooms'> {
  readonly nights: number;
  readonly offers: readonly CategoryOfferView[];
}

export function detailView(detail: HotelDetail): HotelDetailView {
  return {
    hotelId: detail.hotelId,
    publicName: detail.publicName,
    district: detail.district,
    khoroo: detail.khoroo,
    addressLine: detail.addressLine,
    publicPhone: detail.publicPhone,
    latitudeMicro: detail.point.latitudeMicro,
    longitudeMicro: detail.point.longitudeMicro,
    coverObjectKey: detail.coverObjectKey,
    fromRateMnt: money(detail.fromRateMnt),
    reviewCount: detail.reviewCount,
    averageRating: formatAverage(detail.averageRatingCenti),
    distanceMetres: null,
    nights: detail.nights,
    offers: detail.offers.map(offerView),
  };
}

/** One published review, as the public page shows it (doc 10 §6). */
export interface PublicReviewView {
  readonly reviewId: string;
  readonly rating: number;
  readonly comment: string;
  readonly displayName: string;
  readonly edited: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly verifiedStay: true;
  readonly reply: {
    readonly body: string;
    readonly edited: boolean;
    readonly updatedAt: string;
  } | null;
}

export function publicReviewView(review: PublicReview): PublicReviewView {
  return {
    reviewId: review.reviewId,
    rating: review.rating,
    comment: review.comment,
    displayName: review.displayName,
    edited: review.edited,
    createdAt: review.createdAt.toISOString(),
    updatedAt: review.updatedAt.toISOString(),
    // doc 10 §3: every review on this surface came from a completed booking, so
    // the badge is a constant rather than a field somebody could forget to set.
    verifiedStay: true,
    reply:
      review.reply === null
        ? null
        : {
            body: review.reply.body,
            edited: review.reply.edited,
            updatedAt: review.reply.updatedAt.toISOString(),
          },
  };
}
