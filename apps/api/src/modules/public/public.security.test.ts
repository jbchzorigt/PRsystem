import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@prsystem/contracts';
import type { PublicHarness } from './test-support/public-harness';
import { createPublicHarness } from './test-support/public-harness';
import { newPublicRequest } from './services/search.service';
import { optionalPoint, optionalRadius, rejectClientDistance } from './http/public-validation';

/**
 * The Phase 12 gates that belong to the public surface (build-plan §"Phase 12";
 * doc 09 §4).
 *
 * Two of them are about what the server refuses to take from a client, and one
 * is about what it refuses to keep.
 */

let h: PublicHarness;

beforeAll(async () => {
  h = await createPublicHarness('public_sec');
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('a client-supplied distance is never trusted', () => {
  it('refuses the field outright rather than ignoring it', () => {
    // Ignoring it silently would be worse than refusing: somebody would
    // eventually assume it had been honoured.
    for (const field of ['distanceMetres', 'distance', 'distanceKm', 'sortDistance']) {
      expect(() => rejectClientDistance({ [field]: '5' })).toThrow(ApiError);
      expect(() => rejectClientDistance({ [field.toUpperCase()]: '5' })).toThrow(
        /computed by the server/,
      );
    }
    expect(() =>
      rejectClientDistance({ checkIn: '2026-09-05', location: 'Сүхбаатар' }),
    ).not.toThrow();
  });

  it('computes every distance itself, from the stored coordinates', async () => {
    const origin = { latitudeMicro: 47_918_600, longitudeMicro: 106_917_700 };
    const hotel = await h.publishedHotel('sec-distance', {
      latitudeMicro: origin.latitudeMicro + 10_000,
      longitudeMicro: origin.longitudeMicro,
    });
    const result = await h.search.search({ origin }, newPublicRequest());
    const card = result.listings.find((l) => l.hotelId === hotel.hotelId);
    // There is no input this number could have come from: the search request
    // carries no distance field at all.
    expect(card?.distanceMetres).toBe(1112);
  }, 120_000);

  it('refuses a position that is not integer micro-degrees', () => {
    expect(() => optionalPoint({ latitudeMicro: '47.9186', longitudeMicro: '106.9177' })).toThrow(
      /integer micro-degrees/,
    );
    expect(() => optionalPoint({ latitudeMicro: '47918600' })).toThrow(/both latitudeMicro/);
    expect(() => optionalRadius('5.5')).toThrow(/whole metres/);
    expect(optionalPoint({ latitudeMicro: '47918600', longitudeMicro: '106917700' })).toEqual({
      latitudeMicro: 47_918_600,
      longitudeMicro: 106_917_700,
    });
  });
});

describe('an unauthenticated searcher’s position is never persisted', () => {
  it('leaves no trace of the coordinates a search was made from', async () => {
    const origin = { latitudeMicro: 47_111_111, longitudeMicro: 106_222_222 };
    await h.publishedHotel('sec-position', origin);
    await h.search.search({ origin }, newPublicRequest());

    // doc 09 §4: the current position is used to compute nearby hotels and is
    // not a record of where a person was. It appears in no profile, no audit
    // payload and no outbox event.
    const traces = await h.admin.query<{ n: string }>(
      `SELECT (
         (SELECT count(*) FROM platform.hotel_profile
           WHERE latitude_micro = $1 AND longitude_micro <> $2)
       + (SELECT count(*) FROM audit.platform_event
           WHERE payload::text LIKE '%' || $1::text || '%')
       + (SELECT count(*) FROM platform.outbox_event
           WHERE payload::text LIKE '%' || $1::text || '%')
       ) AS n`,
      [String(origin.latitudeMicro), String(origin.longitudeMicro)],
    );
    expect(Number(traces.rows[0]?.n)).toBe(0);
  }, 120_000);
});

describe('the projection is the boundary', () => {
  it('cannot be reached by selecting the tables directly as the API', async () => {
    const hotel = await h.publishedHotel('sec-boundary');
    // The same rows the search returns are unreadable to the API's own login
    // outside the definer functions: it holds no cross-tenant SELECT, and under
    // the platform sentinel every tenant policy matches nothing.
    const direct = await h.api.query<{ n: string }>(
      `SELECT count(*) AS n FROM platform.hotel_profile WHERE hotel_id = $1`,
      [hotel.hotelId],
    );
    expect(Number(direct.rows[0]?.n)).toBe(0);

    const through = await h.search.search({}, newPublicRequest());
    expect(through.listings.some((l) => l.hotelId === hotel.hotelId)).toBe(true);
  }, 120_000);
});
