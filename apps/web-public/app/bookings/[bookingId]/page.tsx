import {
  Badge,
  Banner,
  COMMON,
  Field,
  KeyValue,
  errorText,
  formatDateTime,
  formatMnt,
} from '@prsystem/web-kit';
import { IDEMPOTENCY_FIELD, newIdempotencyKey, outcomeOf } from '@prsystem/web-kit/server';
import { type BookingRow, stateLabel } from '../../../lib/bookings';
import { GUEST } from '../../../lib/copy';
import { api, requireGuest } from '../../../lib/portal';
import { GuestShell } from '../../../lib/shell';
import { cancel, pay, review } from './actions';

interface Review {
  readonly reviewId: string;
  readonly bookingId: string;
  readonly rating: number;
  readonly comment: string;
  readonly status: string;
}

const OK_COPY: Readonly<Record<string, string>> = {
  held: 'Захиалга 10 минутын hold-тэй үүслээ. Хугацаа дуустал төлбөрөө төлнө үү.',
  invoice: 'Нэхэмжлэх нээгдлээ. Төлбөрийн үйлчилгээний зааврыг дагана уу.',
  cancelled: 'Захиалга цуцлагдлаа.',
  reviewed: 'Сэтгэгдэл хүлээн авлаа.',
};

/** doc 09 §3.6: one booking, its four states, and the commands the API allows for it. */
export default async function BookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ bookingId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { bookingId } = await params;
  const outcome = outcomeOf(await searchParams);
  const token = await requireGuest(`/bookings/${bookingId}`);
  const client = api();
  const [answer, reviews] = await Promise.all([
    client.call<BookingRow>(`/guest/bookings/${bookingId}`, { token }),
    client.call<{ reviews: readonly Review[] }>('/guest/reviews', { token }),
  ]);
  if (!answer.ok) {
    return (
      <GuestShell current="bookings">
        <h1>{GUEST.bookings.booking}</h1>
        <p role="alert">{errorText(answer.code, answer.message)}</p>
      </GuestShell>
    );
  }
  const booking = answer.body;
  const hotel = await client.call<{ publicName: string }>(`/public/hotels/${booking.hotelId}`, {
    query: { checkIn: booking.checkInDate, checkOut: booking.checkOutDate },
  });
  const hotelName = hotel.ok ? hotel.body.publicName : booking.hotelId;
  const mine = reviews.ok
    ? reviews.body.reviews.find((r) => r.bookingId === booking.bookingId)
    : undefined;
  const holding = booking.state === 'HOLDING' && booking.holdState === 'ACTIVE';
  const cancellable = booking.state === 'HOLDING' || booking.state === 'CONFIRMED';
  const key = newIdempotencyKey();
  return (
    <GuestShell current="bookings">
      <h1>
        {GUEST.bookings.booking} {booking.bookingRef}
      </h1>
      {outcome.ok !== undefined ? (
        <Banner tone="ok">{OK_COPY[outcome.ok] ?? outcome.ok}</Banner>
      ) : null}
      {outcome.error !== undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      <KeyValue
        items={[
          [
            GUEST.bookings.hotel,
            <a
              key="h"
              href={`/hotels/${booking.hotelId}?checkIn=${booking.checkInDate}&checkOut=${booking.checkOutDate}`}
            >
              {hotelName}
            </a>,
          ],
          [GUEST.detail.stayingGuestName, booking.stayingGuestName],
          [
            GUEST.bookings.dates,
            `${booking.checkInDate} → ${booking.checkOutDate} (${String(booking.nightCount)} ${GUEST.detail.nights})`,
          ],
          [
            GUEST.bookings.total,
            booking.totalAmountMnt === null ? '—' : formatMnt(booking.totalAmountMnt),
          ],
          [
            GUEST.bookings.booking,
            <Badge key="s" tone={booking.state === 'CONFIRMED' ? 'ok' : holding ? 'warn' : 'plain'}>
              {stateLabel(booking.state)}
            </Badge>,
          ],
          [GUEST.bookings.hold, stateLabel(booking.holdState)],
          [GUEST.bookings.payment, stateLabel(booking.paymentState)],
          [GUEST.bookings.refund, stateLabel(booking.refundState)],
          ...(holding
            ? [[GUEST.bookings.holdUntil, formatDateTime(booking.holdExpiresAt)] as const]
            : []),
        ]}
      />
      {holding ? (
        <section aria-labelledby="pay-title">
          <h2 id="pay-title">{GUEST.bookings.pay}</h2>
          <p className="hint">{GUEST.detail.cancellationText}</p>
          <form action={pay}>
            <input type="hidden" name={IDEMPOTENCY_FIELD} value={key} />
            <input type="hidden" name="bookingId" value={booking.bookingId} />
            <Field id="provider" label={GUEST.detail.provider}>
              <select id="provider" name="provider" defaultValue="QPAY">
                <option value="QPAY">QPay</option>
                <option value="KHAAN">Khaan Bank</option>
              </select>
            </Field>
            <button className="button" type="submit">
              {GUEST.bookings.payLink}
            </button>
          </form>
        </section>
      ) : null}
      {cancellable ? (
        <section aria-labelledby="cancel-title">
          <h2 id="cancel-title">{GUEST.bookings.cancel}</h2>
          <form action={cancel}>
            <input type="hidden" name={IDEMPOTENCY_FIELD} value={`${key}-cancel`} />
            <input type="hidden" name="bookingId" value={booking.bookingId} />
            <Field id="reason" label={COMMON.reason}>
              <input id="reason" name="reason" type="text" maxLength={500} />
            </Field>
            <button className="button button-danger" type="submit">
              {GUEST.bookings.cancel}
            </button>
          </form>
        </section>
      ) : null}
      {booking.state === 'COMPLETED' ? (
        <section aria-labelledby="review-title">
          <h2 id="review-title">{GUEST.detail.leaveReview}</h2>
          {mine !== undefined ? (
            <p>
              {'★'.repeat(mine.rating)} — {mine.comment}
            </p>
          ) : (
            <form action={review}>
              <input type="hidden" name={IDEMPOTENCY_FIELD} value={`${key}-review`} />
              <input type="hidden" name="bookingId" value={booking.bookingId} />
              <Field id="rating" label={GUEST.review.rating}>
                <select id="rating" name="rating" defaultValue="5">
                  {[5, 4, 3, 2, 1].map((n) => (
                    <option key={n} value={n}>
                      {'★'.repeat(n)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                id="comment"
                label={GUEST.review.comment}
                error={
                  outcome.field === 'comment'
                    ? errorText(outcome.error ?? '', outcome.message)
                    : undefined
                }
              >
                <textarea
                  id="comment"
                  name="comment"
                  minLength={10}
                  maxLength={1000}
                  required
                  rows={4}
                />
              </Field>
              <button className="button" type="submit">
                {GUEST.review.submit}
              </button>
            </form>
          )}
        </section>
      ) : null}
      <p>
        <a href="/bookings">{COMMON.back}</a>
      </p>
    </GuestShell>
  );
}
