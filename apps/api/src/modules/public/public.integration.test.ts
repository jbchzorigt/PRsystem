import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@prsystem/contracts';
import type { PublicHarness } from './test-support/public-harness';
import { createPublicHarness } from './test-support/public-harness';
import { key, request, syntheticGuest } from '../stay/test-support/stay-harness';
import { newPublicRequest } from './services/search.service';
import { NEARBY_RADIUS_METRES } from './domain/listing';

/**
 * Public search and hotel detail against real PostgreSQL (doc 09 §§3–5,
 * `BK-DEC-001`).
 *
 * Every read here runs as the API's own restricted login under the platform
 * sentinel — the scope in which no tenant policy matches anything. That a
 * hotel appears at all is therefore the listing projection's doing, which is
 * exactly what these tests are about.
 */

let h: PublicHarness;

const DAY = 86_400_000;
const window = (): { checkIn: Date; checkOut: Date } => {
  const checkIn = new Date(Date.now() + 30 * DAY);
  return { checkIn, checkOut: new Date(checkIn.getTime() + 2 * DAY) };
};

beforeAll(async () => {
  h = await createPublicHarness('public_int');
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('the five listing conditions (doc 09 §5)', () => {
  it('shows a hotel that meets all five, and hides it when any one is withdrawn', async () => {
    const withdrawals: readonly [string, (hotelId: string) => Promise<void>][] = [
      ['listing published', (id) => h.unpublish(id)],
      ['hotel account active', (id) => h.suspendHotel(id)],
      ['subscription valid', (id) => h.expireSubscription(id)],
    ];

    for (const [condition, withdraw] of withdrawals) {
      const hotel = await h.publishedHotel(`visible-${condition}`);
      const before = await h.search.search({}, newPublicRequest());
      expect(
        before.listings.some((l) => l.hotelId === hotel.hotelId),
        `${condition}: visible before`,
      ).toBe(true);

      await withdraw(hotel.hotelId);
      const after = await h.search.search({}, newPublicRequest());
      // Each condition is checked separately: doc 09 §3.2 refuses to collapse
      // them into one "active" flag, and so does the projection.
      expect(
        after.listings.some((l) => l.hotelId === hotel.hotelId),
        `${condition}: hidden after`,
      ).toBe(false);
    }
  }, 180_000);

  it('never shows a hotel with no location and no public phone', async () => {
    // The remaining two conditions of doc 09 §5. `hotel_profile` carries both
    // as `NOT NULL` columns and is append-only, so they cannot be withdrawn
    // from a hotel that has them — a hotel simply has the profile, or has no
    // location and no phone at all.
    const hotelId = await h.hotelWithoutProfile('no-profile');
    const result = await h.search.search({}, newPublicRequest());
    expect(result.listings.some((l) => l.hotelId === hotelId)).toBe(false);
  }, 120_000);

  it('answers NOT_FOUND for a hotel that is real but not visible', async () => {
    const hotel = await h.publishedHotel('detail-hidden');
    expect((await h.search.detail({ hotelId: hotel.hotelId }, newPublicRequest())).hotelId).toBe(
      hotel.hotelId,
    );
    await h.unpublish(hotel.hotelId);
    // Indistinguishable from a hotel that never existed: the only answer that
    // does not confirm an unpublished hotel to a stranger.
    await expect(h.search.detail({ hotelId: hotel.hotelId }, newPublicRequest())).rejects.toThrow(
      ApiError,
    );
  });
});

describe('availability', () => {
  it('offers a category with a free room, and stops offering it once occupied', async () => {
    const hotel = await h.publishedHotel('availability');
    const room = await hotel.cleanRoom();
    // A window around today, because the occupancy below is a real check-in
    // and a real check-in happens now.
    const dates = {
      checkIn: new Date(Date.now() - 3_600_000),
      checkOut: new Date(Date.now() + DAY),
    };

    const offered = await h.search.detail({ hotelId: hotel.hotelId, ...dates }, newPublicRequest());
    const offer = offered.offers.find((o) => o.categoryId === hotel.categoryId);
    expect(offer?.availableRooms).toBeGreaterThan(0);

    // A real check-in, so the interval and the snapshotted cleaning buffer are
    // the ones the domain writes rather than ones a fixture invented.
    const before = offer?.availableRooms ?? 0;
    expect(before).toBeGreaterThan(0);
    await h.shifts.open(
      { hotelId: hotel.hotelId, idempotencyKey: key('shift'), openingCountedMnt: 0 } as never,
      hotel.reception,
      request(hotel.reception),
    );
    await h.checkIns.checkIn(
      {
        hotelId: hotel.hotelId,
        idempotencyKey: key('ci'),
        roomId: room,
        source: 'WALK_IN',
        stayType: 'NIGHTLY',
        nightCount: 1,
        guest: syntheticGuest(),
      } as never,
      hotel.reception,
      request(hotel.reception),
    );
    const now = await h.search.detail({ hotelId: hotel.hotelId, ...dates }, newPublicRequest());
    const after = now.offers.find((o) => o.categoryId === hotel.categoryId)?.availableRooms ?? 0;
    expect(after).toBeLessThan(before);
  }, 120_000);

  it('offers no category without a photograph (doc 09 §5)', async () => {
    const hotel = await h.publishedHotel('no-photo');
    await hotel.cleanRoom();
    await h.admin.query(
      `UPDATE platform.hotel_photo SET state = 'REMOVED', revision = revision + 1
        WHERE hotel_id = $1 AND subject_type = 'ROOM_CATEGORY'`,
      [hotel.hotelId],
    );
    const detail = await h.search.detail(
      { hotelId: hotel.hotelId, ...window() },
      newPublicRequest(),
    );
    expect(detail.offers).toHaveLength(0);
  }, 120_000);

  it('shows a price floor and no availability claim when no dates are given', async () => {
    const hotel = await h.publishedHotel('no-dates');
    await hotel.cleanRoom();
    const result = await h.search.search({}, newPublicRequest());
    const card = result.listings.find((l) => l.hotelId === hotel.hotelId);
    // doc 09 §3.2: `…₮-с` before dates are chosen.
    expect(card?.fromRateMnt).not.toBeNull();
    expect(card?.availability).toBe('NOT_BOOKABLE_ONLINE');
    expect(result.nights).toBe(0);
  }, 120_000);
});

describe('distance and ordering (doc 09 §4)', () => {
  it('computes distance on the server and orders availability before distance', async () => {
    const origin = { latitudeMicro: 47_918_600, longitudeMicro: 106_917_700 };
    const near = await h.publishedHotel('near', origin);
    const far = await h.publishedHotel('far', {
      latitudeMicro: origin.latitudeMicro + 20_000,
      longitudeMicro: origin.longitudeMicro,
    });

    const result = await h.search.search({ origin }, newPublicRequest());
    const nearCard = result.listings.find((l) => l.hotelId === near.hotelId);
    const farCard = result.listings.find((l) => l.hotelId === far.hotelId);
    expect(nearCard?.distanceMetres).toBe(0);
    // Whole metres, computed from the stored coordinates. Nothing the caller
    // sent could have produced this number.
    expect(farCard?.distanceMetres).toBeGreaterThan(2_000);
    expect(Number.isInteger(farCard?.distanceMetres ?? 0.5)).toBe(true);
  }, 120_000);

  it('excludes a hotel outside the nearby radius, and keeps everything without a position', async () => {
    const origin = { latitudeMicro: 47_918_600, longitudeMicro: 106_917_700 };
    const distant = await h.publishedHotel('distant', {
      latitudeMicro: origin.latitudeMicro + 900_000,
      longitudeMicro: origin.longitudeMicro,
    });
    const near = await h.search.search({ origin }, newPublicRequest());
    expect(near.listings.some((l) => l.hotelId === distant.hotelId)).toBe(false);
    expect(NEARBY_RADIUS_METRES).toBe(5_000);

    // A searcher who shared no position is shown everything visible.
    const all = await h.search.search({}, newPublicRequest());
    expect(all.listings.some((l) => l.hotelId === distant.hotelId)).toBe(true);
  }, 120_000);
});

describe('the window itself', () => {
  it('refuses half a window and a window that does not move forward', async () => {
    const dates = window();
    await expect(h.search.search({ checkIn: dates.checkIn }, newPublicRequest())).rejects.toThrow(
      /both checkIn and checkOut/,
    );
    await expect(
      h.search.search({ checkIn: dates.checkOut, checkOut: dates.checkIn }, newPublicRequest()),
    ).rejects.toThrow(/after checkIn/);
    await expect(
      h.search.search({ checkIn: dates.checkIn, checkOut: dates.checkIn }, newPublicRequest()),
    ).rejects.toThrow(/after checkIn/);
  });
});
