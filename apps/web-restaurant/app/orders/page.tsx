import { Table, errorText, formatMnt } from '@prsystem/web-kit';
import { RESTAURANT } from '../../lib/copy';
import { api, headersFor, requireGuestSession } from '../../lib/portal';
import { RestaurantShell } from '../../lib/shell';

export interface OrderView {
  readonly orderId: string;
  readonly orderNo: string;
  readonly restaurantId: string;
  readonly orderState: string;
  readonly fulfillmentState: string;
  readonly paymentState: string;
  readonly refundRequestState: string;
  readonly refundState: string;
  readonly handoffMode: string;
  readonly totalAmountMnt: string;
  readonly etaMinutes: number | null;
  readonly promisedReadyAt: string | null;
  readonly contactPhone?: string;
  readonly attempt?: { readonly attemptId: string; readonly expiresAt: string } | null;
}

export default async function OrdersPage() {
  const token = await requireGuestSession();
  const answer = await api().call<{ orders: readonly OrderView[] }>('/restaurant/guest/orders', {
    headers: headersFor(token),
  });
  return (
    <RestaurantShell current="orders">
      <h1>{RESTAURANT.orders.title}</h1>
      {!answer.ok ? (
        <p role="alert">{errorText(answer.code, answer.message)}</p>
      ) : (
        <Table
          caption={RESTAURANT.orders.title}
          columns={[
            {
              key: 'no',
              header: RESTAURANT.orders.orderNo,
              cell: (o: OrderView) => <a href={`/orders/${o.orderId}`}>{o.orderNo}</a>,
            },
            {
              key: 'total',
              header: RESTAURANT.orders.total,
              cell: (o: OrderView) => formatMnt(o.totalAmountMnt),
            },
            { key: 'state', header: RESTAURANT.orders.state, cell: (o: OrderView) => o.orderState },
            {
              key: 'payment',
              header: RESTAURANT.orders.payment,
              cell: (o: OrderView) => o.paymentState,
            },
            {
              key: 'fulfillment',
              header: RESTAURANT.orders.fulfillment,
              cell: (o: OrderView) => o.fulfillmentState,
            },
          ]}
          rows={answer.body.orders}
          rowKey={(o) => o.orderId}
          empty={RESTAURANT.orders.none}
        />
      )}
    </RestaurantShell>
  );
}
