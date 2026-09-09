import { COMMON, Table, errorText, formatTime } from '@prsystem/web-kit';
import { HOTEL } from '../../../../lib/copy';
import { hotelContext, lockedScreen } from '../../../../lib/hotel-context';
import type { RoomCard } from '../rooms/page';

/** Төлбөр тооцоо (doc 02 §5 tab 3): the occupied rooms, each leading to its stay's bill. */
export default async function BillingPage({ params }: { params: Promise<{ hotelId: string }> }) {
  const { hotelId } = await params;
  const ctx = await hotelContext(hotelId, `/hotels/${hotelId}/billing`);
  const locked = lockedScreen(ctx);
  if (locked !== undefined) return locked;
  const board = await ctx.client.call<{ rooms: readonly RoomCard[] }>(
    `/hotels/${hotelId}/rooms/board`,
    { token: ctx.token },
  );
  const occupied = board.ok ? board.body.rooms.filter((r) => r.stayId !== null) : [];
  return (
    <>
      <h1>{HOTEL.tabs.billing}</h1>
      {!board.ok ? <p role="status">{errorText(board.code, board.message)}</p> : null}
      <Table
        caption={HOTEL.tabs.billing}
        columns={[
          { key: 'room', header: HOTEL.labels.room, cell: (r: RoomCard) => r.roomNumber },
          {
            key: 'occupancy',
            header: COMMON.state,
            cell: (r: RoomCard) => HOTEL.occupancy[r.occupancy] ?? r.occupancy,
          },
          {
            key: 'type',
            header: 'Тооцооны төрөл',
            cell: (r: RoomCard) =>
              r.stayType === null ? '—' : (HOTEL.stayType[r.stayType] ?? r.stayType),
          },
          {
            key: 'until',
            header: HOTEL.labels.plannedCheckout,
            cell: (r: RoomCard) => formatTime(r.plannedCheckoutAt),
          },
          {
            key: 'link',
            header: COMMON.actions,
            cell: (r: RoomCard) => (
              <a className="button button-secondary" href={`${ctx.base}/stays/${r.stayId ?? ''}`}>
                {COMMON.details}
              </a>
            ),
          },
        ]}
        rows={occupied}
        rowKey={(r) => r.roomId}
        empty={COMMON.nothingHere}
      />
    </>
  );
}
