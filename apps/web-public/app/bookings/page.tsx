import { Badge, Table, formatMnt } from '@prsystem/web-kit';
import { type BookingRow, stateLabel } from '../../lib/bookings';
import { GUEST } from '../../lib/copy';
import { api, requireGuest } from '../../lib/portal';
import { GuestShell } from '../../lib/shell';

/** doc 09 §3.6: the guest's own bookings and nothing else — the API scopes the list to the session. */
export default async function BookingsPage() {
  const token = await requireGuest('/bookings');
  const answer = await api().call<{ bookings: readonly BookingRow[] }>('/guest/bookings', {
    token,
  });
  const rows = answer.ok ? answer.body.bookings : [];
  return (
    <GuestShell current="bookings">
      <h1>{GUEST.bookings.title}</h1>
      <Table<BookingRow>
        caption={GUEST.bookings.title}
        rows={rows}
        rowKey={(row) => row.bookingId}
        empty={GUEST.bookings.none}
        columns={[
          {
            key: 'ref',
            header: GUEST.bookings.ref,
            cell: (row) => <a href={`/bookings/${row.bookingId}`}>{row.bookingRef}</a>,
          },
          {
            key: 'dates',
            header: GUEST.bookings.dates,
            cell: (row) =>
              `${row.checkInDate} → ${row.checkOutDate} (${String(row.nightCount)} ${GUEST.detail.nights})`,
          },
          {
            key: 'guest',
            header: GUEST.detail.stayingGuestName,
            cell: (row) => row.stayingGuestName,
          },
          {
            key: 'state',
            header: GUEST.bookings.booking,
            cell: (row) => (
              <Badge
                tone={row.state === 'CONFIRMED' ? 'ok' : row.state === 'HOLDING' ? 'warn' : 'plain'}
              >
                {stateLabel(row.state)}
              </Badge>
            ),
          },
          {
            key: 'payment',
            header: GUEST.bookings.payment,
            cell: (row) => stateLabel(row.paymentState),
          },
          {
            key: 'total',
            header: GUEST.bookings.total,
            cell: (row) => (row.totalAmountMnt === null ? '—' : formatMnt(row.totalAmountMnt)),
          },
        ]}
      />
    </GuestShell>
  );
}
