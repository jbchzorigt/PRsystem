import { SimulatedGeo } from '@prsystem/ports';
import type { StayHarness, StayHotel } from '../../stay/test-support/stay-harness';
import { createStayHarness } from '../../stay/test-support/stay-harness';
import { UnprovisionedCategoryHolds } from '../contracts/category-holds';
import type { PublicDependencies } from '../services/search.service';
import { PublicSearchService } from '../services/search.service';

/**
 * The Phase 12 public harness: the Phase 08 stay harness, plus the search
 * service over the same restricted runtime login.
 *
 * A hotel becomes visible here the way doc 09 §5 says it does — by satisfying
 * five separate conditions — so a test can withdraw exactly one of them and
 * watch the listing disappear. Everything is seeded as the superuser and
 * asserted through the API's own login, which is what proves the projection is
 * the boundary rather than the query.
 */

export interface PublicHarness extends StayHarness {
  readonly search: PublicSearchService;
  readonly geo: SimulatedGeo;
  readonly publicDeps: PublicDependencies;
  /** A hotel that meets all five listing conditions, with a cover photograph. */
  publishedHotel(
    name: string,
    position?: { latitudeMicro: number; longitudeMicro: number },
  ): Promise<StayHotel>;
  /** Registers a photograph for a category, the last availability condition. */
  categoryPhoto(hotelId: string, categoryId: string): Promise<void>;
  /** Withdraws one listing condition, so the effect of each can be seen alone. */
  unpublish(hotelId: string): Promise<void>;
  suspendHotel(hotelId: string): Promise<void>;
  expireSubscription(hotelId: string): Promise<void>;
  /**
   * A hotel with no profile row at all.
   *
   * `hotel_profile` declares its coordinates, its address and its public phone
   * `NOT NULL` and is append-only, so doc 09 §5's "location complete" and
   * "public phone registered" cannot be withdrawn one at a time or withdrawn
   * at all: a hotel either has a profile carrying both, or has neither.
   */
  hotelWithoutProfile(name: string): Promise<string>;
}

const UB = { latitudeMicro: 47_918_600, longitudeMicro: 106_917_700 };

export async function createPublicHarness(suite: string): Promise<PublicHarness> {
  const stay = await createStayHarness(suite);
  const geo = new SimulatedGeo();
  const publicDeps: PublicDependencies = {
    pool: stay.api,
    geo,
    bookings: new UnprovisionedCategoryHolds(),
  };
  let sequence = 0;

  const photo = async (hotelId: string, categoryId: string | null, cover: boolean) => {
    sequence += 1;
    await stay.admin.query(
      `INSERT INTO platform.hotel_photo
         (hotel_id, subject_type, category_id, object_key, content_type, byte_size, is_cover,
          created_by_account_id)
       VALUES ($1, $2, $3::uuid, $4, 'image/jpeg', 4096, $5, gen_random_uuid())`,
      [
        hotelId,
        categoryId === null ? 'HOTEL' : 'ROOM_CATEGORY',
        categoryId,
        `synthetic/${hotelId}/${String(sequence)}`,
        cover,
      ],
    );
  };

  return {
    ...stay,
    geo,
    publicDeps,
    search: new PublicSearchService(publicDeps),

    async publishedHotel(name, position = UB): Promise<StayHotel> {
      const hotel = await stay.hotel(name);
      // Phase 05's onboarding writes this row on activation; the harness seeds
      // it directly, because Phase 12 is about what a *published* hotel looks
      // like rather than about how it came to be published.
      await stay.admin.query(
        `INSERT INTO platform.hotel_profile
           (hotel_id, public_name, district, khoroo, address_line, public_phone,
            latitude_micro, longitude_micro, listing_state)
         VALUES ($1, $2, 'Сүхбаатар', '1-р хороо', 'Энх тайвны өргөн чөлөө 1',
                 '+97611223344', $3, $4, 'PUBLISHED')
         ON CONFLICT (hotel_id) DO UPDATE
            SET listing_state = 'PUBLISHED',
                latitude_micro = EXCLUDED.latitude_micro,
                longitude_micro = EXCLUDED.longitude_micro,
                revision = platform.hotel_profile.revision + 1`,
        [hotel.hotelId, name, position.latitudeMicro, position.longitudeMicro],
      );
      // doc 09 §5: a category is offered only with a valid price. The catalog
      // allows a hotel-level tariff with no category rate; a public card needs
      // the category's own, so the fixture states one.
      await stay.admin.query(
        `UPDATE platform.room_category
            SET nightly_rate_mnt = COALESCE(nightly_rate_mnt, 120000), revision = revision + 1
          WHERE hotel_id = $1`,
        [hotel.hotelId],
      );
      await photo(hotel.hotelId, null, true);
      await photo(hotel.hotelId, hotel.categoryId, false);
      return hotel;
    },

    categoryPhoto: (hotelId, categoryId) => photo(hotelId, categoryId, false),

    async unpublish(hotelId) {
      await stay.admin.query(
        `UPDATE platform.hotel_profile SET listing_state = 'UNLISTED', revision = revision + 1
          WHERE hotel_id = $1`,
        [hotelId],
      );
    },
    async suspendHotel(hotelId) {
      await stay.admin.query(
        `UPDATE platform.hotel SET state = 'SUSPENDED', revision = revision + 1
          WHERE hotel_id = $1`,
        [hotelId],
      );
    },
    async expireSubscription(hotelId) {
      // Suspended rather than back-dated: `expires_at` never moves backwards,
      // which is the Phase 05 guard, and suspension is the state a lapsed
      // subscription actually reaches.
      await stay.admin.query(
        `UPDATE platform.hotel_subscription
            SET suspended_at = now(), suspension_reason = 'synthetic-public-fixture',
                revision = revision + 1, billing_revision = billing_revision + 1
          WHERE hotel_id = $1`,
        [hotelId],
      );
    },
    async hotelWithoutProfile(name) {
      return (await stay.hotel(name)).hotelId;
    },
  };
}
