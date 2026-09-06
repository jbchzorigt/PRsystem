import { describe, expect, it } from 'vitest';
import { greatCircleMetres } from '@prsystem/ports';
import type { Listing, RankedListing } from './listing';
import {
  NEARBY_RADIUS_METRES,
  distanceFrom,
  matchesLocation,
  nightsBetween,
  rankListings,
  withinRadius,
} from './listing';

/**
 * What a public search decides, tested without a database (doc 09 §§3–5).
 */

const listing = (over: Partial<Listing> = {}): Listing => ({
  hotelId: 'h-1',
  publicName: 'Синтетик буудал',
  district: 'Сүхбаатар',
  khoroo: '1-р хороо',
  addressLine: 'Энх тайвны өргөн чөлөө 1',
  publicPhone: '+97611223344',
  point: { latitudeMicro: 47_918_600, longitudeMicro: 106_917_700 },
  coverObjectKey: 'cover/1',
  reviewCount: 0,
  averageRatingCenti: 0,
  fromRateMnt: 120_000n,
  ...over,
});

const ranked = (over: Partial<RankedListing>): RankedListing => ({
  ...listing(),
  availability: 'AVAILABLE',
  distanceMetres: null,
  availableRooms: 1,
  ...over,
});

describe('distance', () => {
  it('is computed from the stored coordinates, or is absent', () => {
    const origin = { latitudeMicro: 47_928_600, longitudeMicro: 106_917_700 };
    expect(distanceFrom(undefined, listing())).toBeNull();
    expect(distanceFrom(origin, listing())).toBe(greatCircleMetres(origin, listing().point));
    // Whole metres, and symmetric: an ordering never turns on a float's last bit.
    expect(Number.isInteger(distanceFrom(origin, listing()) ?? 0.5)).toBe(true);
  });

  it('keeps a hotel with no known distance in the set', () => {
    // A searcher who shared no position is not shown an empty page.
    expect(withinRadius(null, NEARBY_RADIUS_METRES)).toBe(true);
    expect(withinRadius(NEARBY_RADIUS_METRES, NEARBY_RADIUS_METRES)).toBe(true);
    expect(withinRadius(NEARBY_RADIUS_METRES + 1, NEARBY_RADIUS_METRES)).toBe(false);
  });
});

describe('rankListings', () => {
  it('puts availability before distance (P1-01 interim order)', () => {
    const order = rankListings([
      ranked({ hotelId: 'far-free', availability: 'AVAILABLE', distanceMetres: 4_000 }),
      ranked({
        hotelId: 'near-full',
        availability: 'FULL',
        distanceMetres: 100,
        availableRooms: 0,
      }),
      ranked({ hotelId: 'near-free', availability: 'AVAILABLE', distanceMetres: 200 }),
    ]).map((l) => l.hotelId);
    // A searcher with dates wants somewhere to stay, not somewhere to walk past.
    expect(order).toEqual(['near-free', 'far-free', 'near-full']);
  });

  it('is a total order, so a page is stable', () => {
    const order = rankListings([
      ranked({ hotelId: 'b', publicName: 'Б', distanceMetres: 100 }),
      ranked({ hotelId: 'a', publicName: 'А', distanceMetres: 100 }),
    ]).map((l) => l.hotelId);
    expect(order).toEqual(['a', 'b']);
  });
});

describe('matchesLocation', () => {
  it('matches the fields a listing carries, and passes everything when empty', () => {
    expect(matchesLocation(listing(), undefined)).toBe(true);
    expect(matchesLocation(listing(), '   ')).toBe(true);
    expect(matchesLocation(listing(), 'сүхбаатар')).toBe(true);
    expect(matchesLocation(listing(), 'ЭНХ ТАЙВНЫ')).toBe(true);
    expect(matchesLocation(listing(), 'Баянзүрх')).toBe(false);
  });
});

describe('nightsBetween', () => {
  it('counts the nights of a half-open window', () => {
    expect(nightsBetween(new Date('2026-09-05T00:00:00Z'), new Date('2026-09-07T00:00:00Z'))).toBe(
      2,
    );
    expect(nightsBetween(new Date('2026-09-05T00:00:00Z'), new Date('2026-09-05T00:00:00Z'))).toBe(
      0,
    );
  });
});
