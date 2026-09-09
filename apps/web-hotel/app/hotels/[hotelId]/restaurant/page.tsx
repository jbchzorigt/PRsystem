import { Banner, COMMON, Table, errorText } from '@prsystem/web-kit';
import { IDEMPOTENCY_FIELD, newIdempotencyKey, outcomeOf } from '@prsystem/web-kit/server';
import { HOTEL } from '../../../../lib/copy';
import { hotelContext, lockedScreen } from '../../../../lib/hotel-context';
import type { RoomCard } from '../rooms/page';
import { issueGuestCode, revokeGuestSessions } from './actions';

/**
 * Restaurant (doc 02 §5 tab 4; RC-DEC-026, -027): on the 30,000₮ package the
 * Reception issues a stay's one-time guest access code and can close its
 * sessions. The code is shown once, here, and stored nowhere by the portal.
 */
export default async function RestaurantPage({
  params,
  searchParams,
}: {
  params: Promise<{ hotelId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { hotelId } = await params;
  const outcome = outcomeOf(await searchParams);
  const ctx = await hotelContext(hotelId, `/hotels/${hotelId}/restaurant`);
  const locked = lockedScreen(ctx);
  if (locked !== undefined) return locked;
  const board = await ctx.client.call<{ rooms: readonly RoomCard[] }>(
    `/hotels/${hotelId}/rooms/board`,
    { token: ctx.token },
  );
  const occupied = board.ok
    ? board.body.rooms.filter((r) => r.stayId !== null && r.occupancy === 'CHECKED_IN')
    : [];
  return (
    <>
      <h1>{HOTEL.tabs.restaurant}</h1>
      {outcome.error !== undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      {outcome.ok === 'code' ? (
        <Banner tone="ok" title={'Guest access код'}>
          <strong>{outcome.message}</strong> {'— зочинд уншиж өгнө үү; дахин харагдахгүй.'}
        </Banner>
      ) : null}
      {outcome.ok === 'revoked' ? (
        <Banner tone="ok">{'Зочны session-ууд хүчингүй боллоо.'}</Banner>
      ) : null}
      {!board.ok ? <p role="status">{errorText(board.code, board.message)}</p> : null}
      <Table
        caption={HOTEL.tabs.restaurant}
        columns={[
          { key: 'room', header: HOTEL.labels.room, cell: (r: RoomCard) => r.roomNumber },
          {
            key: 'code',
            header: COMMON.actions,
            cell: (r: RoomCard) => (
              <span className="actions">
                <form action={issueGuestCode} className="inline">
                  <input type="hidden" name="hotelId" value={hotelId} />
                  <input type="hidden" name="stayId" value={r.stayId ?? ''} />
                  <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
                  <button className="button button-secondary" type="submit">
                    {HOTEL.actions.issueGuestCode}
                  </button>
                </form>
                <form action={revokeGuestSessions} className="inline">
                  <input type="hidden" name="hotelId" value={hotelId} />
                  <input type="hidden" name="stayId" value={r.stayId ?? ''} />
                  <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
                  <button className="button button-secondary" type="submit">
                    {HOTEL.actions.revokeGuestSessions}
                  </button>
                </form>
              </span>
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
