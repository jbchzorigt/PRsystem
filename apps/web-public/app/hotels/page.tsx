import { Badge, COMMON, errorText, formatMnt } from '@prsystem/web-kit';
import { GUEST } from '../../lib/copy';
import { api } from '../../lib/portal';
import { GuestShell } from '../../lib/shell';

export interface Listing {
  readonly hotelId: string;
  readonly publicName: string;
  readonly district: string | null;
  readonly addressLine: string;
  readonly publicPhone: string;
  readonly fromRateMnt: string | null;
  readonly reviewCount: number;
  readonly averageRating: string;
  readonly availability: string;
  readonly distanceMetres: number | null;
  readonly availableRooms: number;
}

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, name: string): string | undefined =>
  typeof q[name] === 'string' && q[name] !== '' ? (q[name] as string) : undefined;

/** doc 09 §3.2: the hotel list for the dates and place searched. */
export default async function HotelsPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const checkIn = one(query, 'checkIn');
  const checkOut = one(query, 'checkOut');
  const answer = await api().call<{ nights: number; listings: readonly Listing[] }>(
    '/public/hotels',
    {
      query: {
        checkIn,
        checkOut,
        location: one(query, 'location'),
        latitudeMicro: one(query, 'latitudeMicro'),
        longitudeMicro: one(query, 'longitudeMicro'),
      },
    },
  );
  const dates =
    checkIn !== undefined && checkOut !== undefined
      ? `?checkIn=${checkIn}&checkOut=${checkOut}`
      : '';
  return (
    <GuestShell current="home">
      <h1>{GUEST.search.title}</h1>
      <p>
        <a href="/">{GUEST.home}</a>
      </p>
      {!answer.ok ? (
        <p role="alert">{errorText(answer.code, answer.message)}</p>
      ) : answer.body.listings.length === 0 ? (
        <p>{COMMON.nothingHere}</p>
      ) : (
        <ul className="card-list" aria-label={GUEST.search.title}>
          {answer.body.listings.map((hotel) => (
            <li className="card" key={hotel.hotelId}>
              <h3>
                <a href={`/hotels/${hotel.hotelId}${dates}`}>{hotel.publicName}</a>
              </h3>
              <p>
                <Badge
                  tone={
                    hotel.availability === 'AVAILABLE'
                      ? 'ok'
                      : hotel.availability === 'FULL'
                        ? 'danger'
                        : 'warn'
                  }
                >
                  {GUEST.availability[hotel.availability] ?? hotel.availability}
                </Badge>
                <Badge>
                  ★ {hotel.averageRating} · {String(hotel.reviewCount)} {GUEST.card.reviews}
                </Badge>
              </p>
              <p>
                {[hotel.district, hotel.addressLine]
                  .filter((part) => part !== null && part !== '')
                  .join(', ')}
              </p>
              {hotel.distanceMetres !== null ? (
                <p>
                  {GUEST.card.distance}: {(hotel.distanceMetres / 1000).toFixed(1)} км
                </p>
              ) : null}
              <p>
                {hotel.fromRateMnt === null
                  ? '—'
                  : answer.body.nights > 0
                    ? `${formatMnt(hotel.fromRateMnt)} / ${GUEST.card.perNight}`
                    : `${formatMnt(hotel.fromRateMnt)}${GUEST.card.from}`}
              </p>
              <p className="actions">
                <a className="button button-secondary" href={`tel:${hotel.publicPhone}`}>
                  {GUEST.card.call} {hotel.publicPhone}
                </a>
                <a className="button" href={`/hotels/${hotel.hotelId}${dates}`}>
                  {GUEST.card.details}
                </a>
              </p>
            </li>
          ))}
        </ul>
      )}
    </GuestShell>
  );
}
