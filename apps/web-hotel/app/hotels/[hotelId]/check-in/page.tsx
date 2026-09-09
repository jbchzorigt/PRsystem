import {
  Banner,
  COMMON,
  Field,
  KeyValue,
  errorText,
  formatDateTime,
  formatMnt,
} from '@prsystem/web-kit';
import { IDEMPOTENCY_FIELD, newIdempotencyKey, outcomeOf } from '@prsystem/web-kit/server';
import { HOTEL } from '../../../../lib/copy';
import { hotelContext, lockedScreen } from '../../../../lib/hotel-context';
import type { RoomCard } from '../rooms/page';
import { checkIn, quote } from './actions';

type Query = Record<string, string | string[] | undefined>;
const one = (query: Query, name: string): string =>
  typeof query[name] === 'string' ? (query[name] as string) : '';

interface QuoteView {
  readonly plannedCheckoutAt: string;
  readonly unitRateMnt: string;
  readonly roomChargeMnt: string;
  readonly sourceLevel: string;
  readonly cleaningBufferMinutes: number;
  readonly blockers: readonly string[];
  readonly depositRequired: boolean;
}

/**
 * Зочин бүртгэл — the check-in form (doc 02 §3.1, §5 tab 1).
 *
 * The quote is fetched again on the server when the page renders with
 * `quoted=1`, so what the Reception confirms is the server's current answer
 * and never a number the browser kept.
 */
export default async function CheckInPage({
  params,
  searchParams,
}: {
  params: Promise<{ hotelId: string }>;
  searchParams: Promise<Query>;
}) {
  const { hotelId } = await params;
  const query = await searchParams;
  const ctx = await hotelContext(hotelId, `/hotels/${hotelId}/check-in`);
  const locked = lockedScreen(ctx);
  if (locked !== undefined) return locked;
  const outcome = outcomeOf(query);
  const board = await ctx.client.call<{ rooms: readonly RoomCard[] }>(
    `/hotels/${hotelId}/rooms/board`,
    { token: ctx.token },
  );
  const vacant = board.ok
    ? board.body.rooms.filter((r) => r.occupancy === 'VACANT' && r.lifecycle === 'ACTIVE')
    : [];
  const roomId = one(query, 'roomId');
  const stayType = one(query, 'stayType') || 'NIGHTLY';
  const nightCount = one(query, 'nightCount') || '1';
  const halfHourUnits = one(query, 'halfHourUnits') || '2';
  const identityType = one(query, 'identityType') || 'MN_REG_NO';
  let quoted: QuoteView | undefined;
  let quoteError: string | undefined;
  if (one(query, 'quoted') === '1' && roomId !== '') {
    const answer = await ctx.client.call<QuoteView>(`/hotels/${hotelId}/stays/quote`, {
      method: 'POST',
      token: ctx.token,
      body: {
        roomId,
        stayType,
        ...(stayType === 'HOURLY'
          ? { halfHourUnits: Number(halfHourUnits) }
          : { nightCount: Number(nightCount) }),
      },
    });
    if (answer.ok) quoted = answer.body;
    else quoteError = errorText(answer.code, answer.message);
  }
  const error = outcome.error === undefined ? undefined : errorText(outcome.error, outcome.message);
  return (
    <>
      <h1>{HOTEL.tabs.guests}</h1>
      {error !== undefined ? <Banner tone="danger">{error}</Banner> : null}
      {quoteError !== undefined ? <Banner tone="danger">{quoteError}</Banner> : null}
      <form action={quote} className="form-grid" aria-labelledby="quote-title">
        <h2 id="quote-title" className="span-2">
          {HOTEL.actions.quote}
        </h2>
        <input type="hidden" name="hotelId" value={hotelId} />
        <Field id="roomId" label={HOTEL.labels.room}>
          <select id="roomId" name="roomId" required defaultValue={roomId}>
            <option value="">—</option>
            {vacant.map((room) => (
              <option key={room.roomId} value={room.roomId}>
                {room.roomNumber} · {room.categoryName}
              </option>
            ))}
          </select>
        </Field>
        <Field id="stayType" label={'Тооцооны төрөл'}>
          <select id="stayType" name="stayType" defaultValue={stayType}>
            <option value="NIGHTLY">{HOTEL.stayType['NIGHTLY']}</option>
            <option value="HOURLY">{HOTEL.stayType['HOURLY']}</option>
          </select>
        </Field>
        <Field id="nightCount" label={HOTEL.labels.nights} hint={'Хоногоор байрлалтад'}>
          <input
            id="nightCount"
            name="nightCount"
            type="number"
            min={1}
            max={365}
            defaultValue={nightCount}
            inputMode="numeric"
          />
        </Field>
        <Field
          id="halfHourUnits"
          label={HOTEL.labels.halfHourUnits}
          hint={'Цагаар байрлалтад: 1 нэгж = 30 минут'}
        >
          <input
            id="halfHourUnits"
            name="halfHourUnits"
            type="number"
            min={1}
            max={2880}
            defaultValue={halfHourUnits}
            inputMode="numeric"
          />
        </Field>
        <div className="actions span-2">
          <button className="button button-secondary" type="submit">
            {HOTEL.actions.quote}
          </button>
        </div>
      </form>
      {quoted !== undefined ? (
        <section aria-labelledby="quoted-title">
          <h2 id="quoted-title">{'Үнийн санал'}</h2>
          <KeyValue
            items={[
              [HOTEL.labels.plannedCheckout, formatDateTime(quoted.plannedCheckoutAt)],
              [HOTEL.labels.unitRate, formatMnt(quoted.unitRateMnt)],
              [HOTEL.labels.roomCharge, formatMnt(quoted.roomChargeMnt)],
              ['Cleaning buffer', `${String(quoted.cleaningBufferMinutes)} мин`],
              [HOTEL.labels.depositRequired, quoted.depositRequired ? COMMON.yes : COMMON.no],
              [
                HOTEL.labels.blockers,
                quoted.blockers.length === 0 ? '—' : quoted.blockers.join(', '),
              ],
            ]}
          />
          <form action={checkIn} className="form-grid" aria-labelledby="guest-title">
            <h2 id="guest-title" className="span-2">
              {HOTEL.labels.guest}
            </h2>
            <input type="hidden" name="hotelId" value={hotelId} />
            <input type="hidden" name="roomId" value={roomId} />
            <input type="hidden" name="stayType" value={stayType} />
            <input type="hidden" name="nightCount" value={nightCount} />
            <input type="hidden" name="halfHourUnits" value={halfHourUnits} />
            <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
            <Field id="source" label={'Захиалгын эх үүсвэр'}>
              <select id="source" name="source" defaultValue={one(query, 'source') || 'WALK_IN'}>
                <option value="WALK_IN">{HOTEL.source['WALK_IN']}</option>
                <option value="ONLINE">{HOTEL.source['ONLINE']}</option>
              </select>
            </Field>
            <Field id="identityType" label={HOTEL.labels.identityType}>
              <select id="identityType" name="identityType" defaultValue={identityType}>
                {Object.entries(HOTEL.identityTypes).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="familyName" label={HOTEL.labels.familyName}>
              <input
                id="familyName"
                name="familyName"
                required
                defaultValue={one(query, 'familyName')}
                autoComplete="off"
              />
            </Field>
            <Field id="givenName" label={HOTEL.labels.givenName}>
              <input
                id="givenName"
                name="givenName"
                required
                defaultValue={one(query, 'givenName')}
                autoComplete="off"
              />
            </Field>
            <Field id="dateOfBirth" label={HOTEL.labels.dateOfBirth}>
              <input
                id="dateOfBirth"
                name="dateOfBirth"
                type="date"
                required
                defaultValue={one(query, 'dateOfBirth')}
              />
            </Field>
            <Field id="nationality" label={HOTEL.labels.nationality} hint={'ISO код, жишээ нь MN'}>
              <input
                id="nationality"
                name="nationality"
                required
                defaultValue={one(query, 'nationality') || 'MN'}
                maxLength={2}
              />
            </Field>
            <Field
              id="registrationNumber"
              label={HOTEL.labels.registrationNumber}
              hint={'Монгол регистрийн дугаартай үед'}
            >
              <input
                id="registrationNumber"
                name="registrationNumber"
                defaultValue={one(query, 'registrationNumber')}
                autoComplete="off"
              />
            </Field>
            <Field
              id="passportNumber"
              label={HOTEL.labels.passportNumber}
              hint={'Гадаад паспорттой үед'}
            >
              <input id="passportNumber" name="passportNumber" autoComplete="off" />
            </Field>
            <Field
              id="issuingCountry"
              label={HOTEL.labels.issuingCountry}
              hint={'Паспорт эсвэл бусад баримттай үед'}
            >
              <input id="issuingCountry" name="issuingCountry" maxLength={2} />
            </Field>
            <Field
              id="documentType"
              label={HOTEL.labels.documentType}
              hint={'Бусад төрийн баримттай үед'}
            >
              <input id="documentType" name="documentType" />
            </Field>
            <Field
              id="documentNumber"
              label={HOTEL.labels.documentNumber}
              hint={'Бусад төрийн баримттай үед'}
            >
              <input id="documentNumber" name="documentNumber" />
            </Field>
            <Field id="noDocumentReason" label={`${COMMON.reason} (баримтгүй үед)`}>
              <input id="noDocumentReason" name="noDocumentReason" />
            </Field>
            <Field id="note" label={`${COMMON.note} (баримтгүй үед)`}>
              <input id="note" name="note" />
            </Field>
            <div className="actions span-2">
              <button className="button" type="submit" disabled={quoted.blockers.length > 0}>
                {HOTEL.actions.checkIn}
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </>
  );
}
