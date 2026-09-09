import { Banner, KeyValue, errorText, formatDateTime, formatMnt } from '@prsystem/web-kit';
import { IDEMPOTENCY_FIELD, newIdempotencyKey, outcomeOf } from '@prsystem/web-kit/server';
import { RESTAURANT } from '../../../lib/copy';
import { api, headersFor, requireGuestSession } from '../../../lib/portal';
import { RestaurantShell } from '../../../lib/shell';
import { openInvoice, requestRefund } from '../../actions';
import type { OrderView } from '../page';

/** One order: its axes, the invoice to pay it, and the refund request (REST-DEC-002). */
export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orderId } = await params;
  const outcome = outcomeOf(await searchParams);
  const token = await requireGuestSession();
  const answer = await api().call<{ orders: readonly OrderView[] }>('/restaurant/guest/orders', {
    headers: headersFor(token),
  });
  const order = answer.ok ? answer.body.orders.find((o) => o.orderId === orderId) : undefined;
  return (
    <RestaurantShell current="orders">
      <h1>
        {RESTAURANT.orders.orderNo} {order?.orderNo ?? ''}
      </h1>
      {outcome.error !== undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      {outcome.ok === 'placed' ? <Banner tone="ok">{RESTAURANT.orders.placed}</Banner> : null}
      {outcome.ok === 'invoice' ? (
        <Banner tone="ok">
          {outcome.message !== undefined && outcome.message !== '' ? (
            <a href={outcome.message} rel="noreferrer">
              {RESTAURANT.orders.payLink}
            </a>
          ) : (
            'Төлбөрийн үйлчилгээ одоогоор нээлттэй биш байна.'
          )}
        </Banner>
      ) : null}
      {outcome.ok === 'refund-requested' ? (
        <Banner tone="ok">{'Хүсэлт бүртгэгдлээ.'}</Banner>
      ) : null}
      {order === undefined ? (
        <p role="alert">
          {answer.ok ? RESTAURANT.orders.none : errorText(answer.code, answer.message)}
        </p>
      ) : (
        <>
          <KeyValue
            items={[
              [RESTAURANT.orders.total, formatMnt(order.totalAmountMnt)],
              [RESTAURANT.orders.state, order.orderState],
              [RESTAURANT.orders.payment, order.paymentState],
              [RESTAURANT.orders.fulfillment, order.fulfillmentState],
              [RESTAURANT.orders.refund, `${order.refundRequestState} / ${order.refundState}`],
              [RESTAURANT.orders.handoff, order.handoffMode],
              [
                RESTAURANT.orders.eta,
                order.promisedReadyAt === null
                  ? order.etaMinutes === null
                    ? '—'
                    : `${String(order.etaMinutes)} мин`
                  : formatDateTime(order.promisedReadyAt),
              ],
              ...(order.contactPhone === undefined
                ? []
                : ([
                    [
                      RESTAURANT.orders.contact,
                      <a key="tel" href={`tel:${order.contactPhone}`}>
                        {order.contactPhone}
                      </a>,
                    ],
                  ] as const)),
            ]}
          />
          <div className="actions">
            {order.paymentState === 'PENDING' ? (
              <form action={openInvoice} className="inline">
                <input type="hidden" name="orderId" value={order.orderId} />
                <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
                <button className="button" type="submit">
                  {RESTAURANT.orders.pay}
                </button>
              </form>
            ) : null}
            {order.paymentState === 'PAID' && order.refundRequestState === 'NONE' ? (
              <form action={requestRefund} className="inline">
                <input type="hidden" name="orderId" value={order.orderId} />
                <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
                <button className="button button-secondary" type="submit">
                  {RESTAURANT.orders.requestRefund}
                </button>
              </form>
            ) : null}
          </div>
        </>
      )}
    </RestaurantShell>
  );
}
