import { Badge, COMMON, errorText, formatMinutes, formatTime } from '@prsystem/web-kit';
import { HOTEL } from '../../../../lib/copy';
import { hotelContext, lockedScreen } from '../../../../lib/hotel-context';

export interface RoomCard {
  readonly roomId: string;
  readonly roomNumber: string;
  readonly categoryName: string;
  readonly lifecycle: string;
  readonly occupancy: string;
  readonly source: string;
  readonly stayType: string | null;
  readonly stayId: string | null;
  readonly effectiveActualCheckInAt: string | null;
  readonly plannedCheckoutAt: string | null;
  readonly timeState: string | null;
  readonly overdueMinutes: number;
  readonly readyNotBefore: string | null;
  readonly cleaningState: string | null;
  readonly minibarStatus: string;
  readonly minibarBlockers: readonly string[];
  readonly openConflicts: number;
  readonly pendingCorrection: boolean;
}

function remaining(card: RoomCard, now: Date): string | undefined {
  if (card.plannedCheckoutAt === null || card.occupancy === 'VACANT') return undefined;
  const minutes = Math.round((new Date(card.plannedCheckoutAt).getTime() - now.getTime()) / 60_000);
  if (card.timeState === 'OVERDUE')
    return `${formatMinutes(card.overdueMinutes)} ${HOTEL.timeState['OVERDUE']}`;
  return `${formatMinutes(minutes)} ${HOTEL.labels.remaining}`;
}

/**
 * The room board (doc 06 §2–§3): every axis of every room as the API derived
 * it, one card per room, no status merged into another.
 */
export default async function RoomsPage({ params }: { params: Promise<{ hotelId: string }> }) {
  const { hotelId } = await params;
  const ctx = await hotelContext(hotelId, `/hotels/${hotelId}/rooms`);
  const locked = lockedScreen(ctx);
  if (locked !== undefined) return locked;
  const answer = await ctx.client.call<{ rooms: readonly RoomCard[] }>(
    `/hotels/${hotelId}/rooms/board`,
    {
      token: ctx.token,
    },
  );
  const now = new Date();
  const minibarApplies = ctx.subscription?.effectivePackage !== 'P20';
  return (
    <>
      <h1>{HOTEL.tabs.rooms}</h1>
      {!answer.ok ? (
        <p role="status">
          {answer.code === 'NOT_FOUND'
            ? COMMON.notAvailable
            : errorText(answer.code, answer.message)}
        </p>
      ) : answer.body.rooms.length === 0 ? (
        <p>{COMMON.nothingHere}</p>
      ) : (
        <ul className="card-list" aria-label={HOTEL.tabs.rooms}>
          {answer.body.rooms.map((card) => {
            const left = remaining(card, now);
            return (
              <li className="card" key={card.roomId} data-room={card.roomNumber}>
                <h3>
                  {HOTEL.labels.room} {card.roomNumber}
                </h3>
                <p>
                  <Badge tone={card.occupancy === 'VACANT' ? 'ok' : 'plain'}>
                    {HOTEL.occupancy[card.occupancy] ?? card.occupancy}
                  </Badge>
                  {card.source !== 'NOT_APPLICABLE' ? (
                    <Badge>{HOTEL.source[card.source] ?? card.source}</Badge>
                  ) : null}
                  {card.stayType !== null ? (
                    <Badge>{HOTEL.stayType[card.stayType] ?? card.stayType}</Badge>
                  ) : null}
                  {card.timeState !== null ? (
                    <Badge
                      tone={
                        card.timeState === 'OVERDUE'
                          ? 'danger'
                          : card.timeState === 'ENDING_SOON'
                            ? 'warn'
                            : 'plain'
                      }
                    >
                      {HOTEL.timeState[card.timeState] ?? card.timeState}
                    </Badge>
                  ) : null}
                  {card.lifecycle !== 'ACTIVE' ? (
                    <Badge tone="warn">{HOTEL.lifecycle[card.lifecycle] ?? card.lifecycle}</Badge>
                  ) : null}
                </p>
                <p>{card.categoryName}</p>
                {card.occupancy !== 'VACANT' && card.plannedCheckoutAt !== null ? (
                  <p>
                    {formatTime(card.effectiveActualCheckInAt)}–{formatTime(card.plannedCheckoutAt)}
                    {left !== undefined ? ` · ${left}` : ''}
                  </p>
                ) : null}
                {card.occupancy === 'VACANT' && card.readyNotBefore !== null ? (
                  <p>
                    {HOTEL.labels.readyNotBefore}: {formatTime(card.readyNotBefore)}
                  </p>
                ) : null}
                <p>
                  {'Цэвэрлэгээ'}:{' '}
                  {card.cleaningState === null
                    ? '—'
                    : (HOTEL.cleaning[card.cleaningState] ?? card.cleaningState)}
                  {minibarApplies ? (
                    <>
                      {' · Минибар: '}
                      {HOTEL.minibar[card.minibarStatus] ?? card.minibarStatus}
                    </>
                  ) : null}
                </p>
                {card.minibarBlockers.length > 0 ? (
                  <p>
                    {card.minibarBlockers.map((blocker) => (
                      <Badge tone="warn" key={blocker}>
                        {blocker}
                      </Badge>
                    ))}
                  </p>
                ) : null}
                {card.openConflicts > 0 ? <Badge tone="danger">{'Overdue conflict'}</Badge> : null}
                <p className="actions">
                  {card.stayId !== null ? (
                    <a
                      className="button button-secondary"
                      href={`${ctx.base}/stays/${card.stayId}`}
                    >
                      {COMMON.details}
                    </a>
                  ) : ctx.has('hotel.stay.check_in') && card.lifecycle === 'ACTIVE' ? (
                    <a
                      className="button button-secondary"
                      href={`${ctx.base}/check-in?roomId=${card.roomId}`}
                    >
                      {HOTEL.actions.checkIn}
                    </a>
                  ) : null}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
