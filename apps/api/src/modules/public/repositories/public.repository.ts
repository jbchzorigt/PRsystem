import type { UnitOfWork } from '@prsystem/db';
import type { CategoryOffer, Listing } from '../domain/listing';

/**
 * The public listing projection (doc 09 §§3, 5).
 *
 * Both reads go through `SECURITY DEFINER` functions rather than through
 * `SELECT`: every table involved is `FORCE ROW LEVEL SECURITY`, and a public
 * search legitimately crosses every tenant. The functions are the reviewed
 * boundary — they return the listing fields and a count of free rooms, and the
 * role that owns them reaches those rows only through the narrow
 * `public_listing_read` policies migration `0013` creates.
 *
 * Nothing here takes a hotel scope, and nothing here can be widened from the
 * application: adding a column to a result means changing the function.
 */
export class PublicRepository {
  constructor(private readonly uow: UnitOfWork) {}

  async listings(): Promise<readonly Listing[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT hotel_id, public_name, district, khoroo, address_line, public_phone,
              latitude_micro, longitude_micro, cover_object_key, from_rate_mnt
         FROM platform.public_hotel_listings()`,
    );
    return result.rows.map((row) => ({
      hotelId: String(row['hotel_id']),
      publicName: String(row['public_name']),
      district: (row['district'] as string | null) ?? null,
      khoroo: (row['khoroo'] as string | null) ?? null,
      addressLine: String(row['address_line']),
      publicPhone: String(row['public_phone']),
      point: {
        latitudeMicro: Number(row['latitude_micro']),
        longitudeMicro: Number(row['longitude_micro']),
      },
      coverObjectKey: (row['cover_object_key'] as string | null) ?? null,
      fromRateMnt: row['from_rate_mnt'] === null ? null : BigInt(String(row['from_rate_mnt'])),
    }));
  }

  /** What that hotel can offer in `[start, end)`, half-open (`STAY-DEC-008`). */
  async offers(hotelId: string, start: Date, end: Date): Promise<readonly CategoryOffer[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT category_id, name, description, nightly_rate_mnt, available_rooms,
              photo_object_key
         FROM platform.public_category_offers($1::uuid, $2::timestamptz, $3::timestamptz)
        ORDER BY nightly_rate_mnt, name`,
      [hotelId, start, end],
    );
    return result.rows.map((row) => ({
      categoryId: String(row['category_id']),
      name: String(row['name']),
      description: (row['description'] as string | null) ?? null,
      nightlyRateMnt: BigInt(String(row['nightly_rate_mnt'])),
      availableRooms: Number(row['available_rooms']),
      photoObjectKey: (row['photo_object_key'] as string | null) ?? null,
    }));
  }
}
