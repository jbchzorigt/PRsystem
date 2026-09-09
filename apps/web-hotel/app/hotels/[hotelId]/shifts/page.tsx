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
import { countShift, openShift, selfCloseShift } from './actions';

interface ShiftView {
  readonly shiftId: string;
  readonly state: string;
  readonly openedAt: string;
  readonly openingBalanceMnt: string | null;
  readonly expectedCashMnt: string | null;
  readonly countedCashMnt: string | null;
  readonly varianceMnt: string | null;
  readonly reviewState: string;
  readonly revision: number;
}

/** Ээлж хаах ба хүлээлцэх (doc 02 §3.5): the current shift and its cash. */
export default async function ShiftsPage({
  params,
  searchParams,
}: {
  params: Promise<{ hotelId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { hotelId } = await params;
  const outcome = outcomeOf(await searchParams);
  const ctx = await hotelContext(hotelId, `/hotels/${hotelId}/shifts`);
  const locked = lockedScreen(ctx);
  if (locked !== undefined) return locked;
  const answer = await ctx.client.call<{ shift: ShiftView | null }>(
    `/hotels/${hotelId}/shifts/current`,
    { token: ctx.token },
  );
  const shift = answer.ok ? answer.body.shift : null;
  return (
    <>
      <h1>{HOTEL.tabs.shifts}</h1>
      {outcome.error !== undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      {outcome.ok !== undefined ? <Banner tone="ok">{'Хадгалагдлаа.'}</Banner> : null}
      {!answer.ok ? <p role="status">{errorText(answer.code, answer.message)}</p> : null}
      {shift === null ? (
        <form action={openShift} aria-labelledby="open-title">
          <h2 id="open-title">{HOTEL.actions.openShift}</h2>
          <input type="hidden" name="hotelId" value={hotelId} />
          <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
          <Field id="openingCountedMnt" label={HOTEL.labels.openingCounted}>
            <input
              id="openingCountedMnt"
              name="openingCountedMnt"
              type="number"
              min={0}
              step={1}
              defaultValue={0}
              inputMode="numeric"
              required
            />
          </Field>
          <div className="actions">
            <button className="button" type="submit">
              {HOTEL.actions.openShift}
            </button>
          </div>
        </form>
      ) : (
        <>
          <KeyValue
            items={[
              [COMMON.state, shift.state],
              [HOTEL.labels.openedAt, formatDateTime(shift.openedAt)],
              ['Эхний үлдэгдэл', formatMnt(shift.openingBalanceMnt)],
              [HOTEL.labels.expectedCash, formatMnt(shift.expectedCashMnt)],
              [HOTEL.labels.countedCash, formatMnt(shift.countedCashMnt)],
              [HOTEL.labels.variance, formatMnt(shift.varianceMnt)],
              ['Хяналт', shift.reviewState],
            ]}
          />
          <form action={countShift} aria-labelledby="count-title">
            <h2 id="count-title">{HOTEL.actions.countShift}</h2>
            <input type="hidden" name="hotelId" value={hotelId} />
            <input type="hidden" name="shiftId" value={shift.shiftId} />
            <input type="hidden" name="expectedRevision" value={shift.revision} />
            <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
            <Field id="countedCashMnt" label={HOTEL.labels.countedCash}>
              <input
                id="countedCashMnt"
                name="countedCashMnt"
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                required
              />
            </Field>
            <div className="actions">
              <button className="button button-secondary" type="submit">
                {HOTEL.actions.countShift}
              </button>
            </div>
          </form>
          <form action={selfCloseShift} aria-labelledby="close-title">
            <h2 id="close-title">{HOTEL.actions.closeShift}</h2>
            <input type="hidden" name="hotelId" value={hotelId} />
            <input type="hidden" name="shiftId" value={shift.shiftId} />
            <input type="hidden" name="expectedRevision" value={shift.revision} />
            <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
            <Field id="closeCounted" label={HOTEL.labels.countedCash}>
              <input
                id="closeCounted"
                name="countedCashMnt"
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                required
              />
            </Field>
            <Field id="closeReason" label={COMMON.reason}>
              <input id="closeReason" name="reason" maxLength={300} />
            </Field>
            <div className="actions">
              <button className="button" type="submit">
                {HOTEL.actions.closeShift}
              </button>
            </div>
          </form>
        </>
      )}
    </>
  );
}
