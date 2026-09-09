import { Banner, COMMON, errorText } from '@prsystem/web-kit';
import { IDEMPOTENCY_FIELD, newIdempotencyKey, outcomeOf } from '@prsystem/web-kit/server';
import { HOTEL } from '../../../../lib/copy';
import { hotelContext, lockedScreen } from '../../../../lib/hotel-context';
import type { RoomCard } from '../rooms/page';
import { setCleaning } from './actions';

interface CleaningView {
  readonly roomId: string;
  readonly state: string | null;
  readonly revision: number;
}

/** Цэвэрлэгээний төлөв, for the package with no Cleaner (doc 04 §11, doc 06 §4). */
export default async function HousekeepingPage({
  params,
  searchParams,
}: {
  params: Promise<{ hotelId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { hotelId } = await params;
  const outcome = outcomeOf(await searchParams);
  const ctx = await hotelContext(hotelId, `/hotels/${hotelId}/housekeeping`);
  const locked = lockedScreen(ctx);
  if (locked !== undefined) return locked;
  const board = await ctx.client.call<{ rooms: readonly RoomCard[] }>(
    `/hotels/${hotelId}/rooms/board`,
    { token: ctx.token },
  );
  const dirty = board.ok
    ? board.body.rooms.filter((r) => r.cleaningState !== 'CLEAN' && r.lifecycle !== 'INACTIVE')
    : [];
  const states = await Promise.all(
    dirty.map((room) =>
      ctx.client.call<CleaningView>(`/hotels/${hotelId}/rooms/${room.roomId}/cleaning`, {
        token: ctx.token,
      }),
    ),
  );
  return (
    <>
      <h1>{HOTEL.tabs.housekeeping}</h1>
      {outcome.error !== undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      {outcome.ok !== undefined ? <Banner tone="ok">{'Хадгалагдлаа.'}</Banner> : null}
      {!board.ok ? <p role="status">{errorText(board.code, board.message)}</p> : null}
      {dirty.length === 0 ? (
        <p>{COMMON.nothingHere}</p>
      ) : (
        <ul className="card-list">
          {dirty.map((room, index) => {
            const view = states[index];
            const revision = view !== undefined && view.ok ? view.body.revision : 0;
            return (
              <li className="card" key={room.roomId}>
                <h3>
                  {HOTEL.labels.room} {room.roomNumber}
                </h3>
                <p>
                  {room.cleaningState === null
                    ? '—'
                    : (HOTEL.cleaning[room.cleaningState] ?? room.cleaningState)}
                </p>
                <form action={setCleaning}>
                  <input type="hidden" name="hotelId" value={hotelId} />
                  <input type="hidden" name="roomId" value={room.roomId} />
                  <input type="hidden" name="toState" value="CLEAN" />
                  <input type="hidden" name="expectedRevision" value={revision} />
                  <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
                  <button className="button" type="submit">
                    {HOTEL.actions.setClean}
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
