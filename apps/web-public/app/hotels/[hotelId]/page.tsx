import {
  Badge,
  Banner,
  COMMON,
  Field,
  KeyValue,
  errorText,
  formatMnt,
  todayHotelLocal,
  addDays,
} from '@prsystem/web-kit';
import { IDEMPOTENCY_FIELD, newIdempotencyKey, outcomeOf } from '@prsystem/web-kit/server';
import { GUEST } from '../../../lib/copy';
import { api, sessionToken } from '../../../lib/portal';
import { GuestShell } from '../../../lib/shell';
import { book } from './actions';

interface Offer {
  readonly categoryId: string;
  readonly name: string;
  readonly description: string | null;
  readonly nightlyRateMnt: string;
  readonly availableRooms: number;
}
interface Detail {
  readonly hotelId: string;
  readonly publicName: string;
  readonly district: string | null;
  readonly addressLine: string;
  readonly publicPhone: string;
  readonly latitudeMicro: number;
  readonly longitudeMicro: number;
  readonly fromRateMnt: string | null;
  readonly reviewCount: number;
  readonly averageRating: string;
  readonly nights: number;
  readonly offers: readonly Offer[];
}
interface Review {
  readonly reviewId?: string;
  readonly rating: number;
  readonly comment: string;
  readonly displayName?: string;
  readonly publishedAt?: string;
  readonly reply?: { readonly body?: string } | null;
}

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, name: string): string | undefined =>
  typeof q[name] === 'string' && q[name] !== '' ? (q[name] as string) : undefined;

/** doc 09 §3.3–§3.4: the hotel, its categories for the dates, the reviews, and `Захиалах`. */
export default async function HotelPage({
  params,
  searchParams,
}: {
  params: Promise<{ hotelId: string }>;
  searchParams: Promise<Query>;
}) {
  const { hotelId } = await params;
  const query = await searchParams;
  const outcome = outcomeOf(query);
  const checkIn = one(query, 'checkIn') ?? todayHotelLocal();
  const checkOut = one(query, 'checkOut') ?? addDays(checkIn, 1);
  const client = api();
  const [detail, reviews, token] = await Promise.all([
    client.call<Detail>(`/public/hotels/${hotelId}`, { query: { checkIn, checkOut } }),
    client.call<{ reviews: readonly Review[] }>(`/public/hotels/${hotelId}/reviews`),
    sessionToken(),
  ]);
  if (!detail.ok) {
    return (
      <GuestShell>
        <h1>{GUEST.card.details}</h1>
        <p role="alert">{errorText(detail.code, detail.message)}</p>
      </GuestShell>
    );
  }
  const hotel = detail.body;
  const mapHref = `https://www.google.com/maps?q=${(hotel.latitudeMicro / 1_000_000).toFixed(6)},${(hotel.longitudeMicro / 1_000_000).toFixed(6)}`;
  return (
    <GuestShell>
      <h1>{hotel.publicName}</h1>
      {outcome.error !== undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      <KeyValue
        items={[
          [
            GUEST.detail.address,
            [hotel.district, hotel.addressLine].filter((p) => p !== null && p !== '').join(', '),
          ],
          [
            GUEST.detail.phone,
            <a key="tel" href={`tel:${hotel.publicPhone}`}>
              {hotel.publicPhone}
            </a>,
          ],
          [GUEST.detail.rating, `★ ${hotel.averageRating} (${String(hotel.reviewCount)})`],
          [
            'Газрын зураг',
            <a key="map" href={mapHref} rel="noreferrer">
              {'Google Maps дээр харах'}
            </a>,
          ],
          [GUEST.search.checkIn, checkIn],
          [GUEST.search.checkOut, `${checkOut} · ${String(hotel.nights)} ${GUEST.detail.nights}`],
        ]}
      />
      <h2>{GUEST.detail.categories}</h2>
      {hotel.offers.length === 0 ? (
        <p>{COMMON.nothingHere}</p>
      ) : (
        <ul className="card-list">
          {hotel.offers.map((offer) => (
            <li className="card" key={offer.categoryId}>
              <h3>{offer.name}</h3>
              {offer.description !== null ? <p>{offer.description}</p> : null}
              <p>
                <Badge tone={offer.availableRooms > 0 ? 'ok' : 'danger'}>
                  {offer.availableRooms > 0
                    ? `${String(offer.availableRooms)} ${GUEST.detail.availableRooms}`
                    : GUEST.availability['FULL']}
                </Badge>
              </p>
              <p>
                {formatMnt(offer.nightlyRateMnt)} / {GUEST.card.perNight}
              </p>
              {offer.availableRooms > 0 ? (
                token === undefined ? (
                  <a
                    className="button"
                    href={`/sign-in?next=${encodeURIComponent(`/hotels/${hotelId}?checkIn=${checkIn}&checkOut=${checkOut}`)}`}
                  >
                    {GUEST.detail.book}
                  </a>
                ) : (
                  <form action={book} aria-label={`${GUEST.detail.book}: ${offer.name}`}>
                    <input type="hidden" name="hotelId" value={hotelId} />
                    <input type="hidden" name="categoryId" value={offer.categoryId} />
                    <input type="hidden" name="checkInDate" value={checkIn} />
                    <input type="hidden" name="checkOutDate" value={checkOut} />
                    <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
                    <Field id={`guest-${offer.categoryId}`} label={GUEST.detail.stayingGuestName}>
                      <input
                        id={`guest-${offer.categoryId}`}
                        name="stayingGuestName"
                        required
                        maxLength={120}
                      />
                    </Field>
                    <Field id={`provider-${offer.categoryId}`} label={GUEST.detail.provider}>
                      <select
                        id={`provider-${offer.categoryId}`}
                        name="provider"
                        defaultValue="QPAY"
                      >
                        <option value="QPAY">QPay</option>
                        <option value="KHAAN">Khaan Bank</option>
                      </select>
                    </Field>
                    <p className="hint">
                      {GUEST.detail.cancellation}: {GUEST.detail.cancellationText}
                    </p>
                    <button className="button" type="submit">
                      {GUEST.detail.book}
                    </button>
                  </form>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <h2>{GUEST.detail.reviews}</h2>
      {!reviews.ok || reviews.body.reviews.length === 0 ? (
        <p>{COMMON.nothingHere}</p>
      ) : (
        <ul className="card-list">
          {reviews.body.reviews.map((review, index) => (
            <li className="card" key={review.reviewId ?? String(index)}>
              <p>
                <Badge>★ {String(review.rating)}</Badge> {review.displayName ?? ''}
              </p>
              <p>{review.comment}</p>
              {review.reply?.body !== undefined ? (
                <p className="hint">{`Буудлын хариу: ${review.reply.body}`}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </GuestShell>
  );
}
