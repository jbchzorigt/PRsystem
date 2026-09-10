import { Badge, Banner, COMMON, Field, errorText, formatDateTime } from '@prsystem/web-kit';
import { IDEMPOTENCY_FIELD, newIdempotencyKey, outcomeOf } from '@prsystem/web-kit/server';
import { HOTEL } from '../../../../lib/copy';
import { hotelContext, lockedScreen } from '../../../../lib/hotel-context';
import type { RoomCard } from '../rooms/page';
import {
  claimCleaning,
  claimConfigTask,
  claimRefill,
  claimReport,
  completeCleaning,
  completeConfigTask,
  completeRefill,
  refillImpossible,
  submitReport,
} from './actions';

interface CleaningTask {
  readonly taskId: string;
  readonly roomId: string;
  readonly state: string;
  readonly claimedByAccountId: string | null;
  readonly openedAt: string;
  readonly revision: number;
}
interface RefillTask {
  readonly taskId: string;
  readonly roomId: string;
  readonly productId: string;
  readonly requestedQuantity: number;
  readonly confirmedQuantity: number | null;
  readonly state: string;
  readonly revision: number;
}
interface ReportRow {
  readonly reportId: string;
  readonly roomId: string;
  readonly state: string;
  readonly revision: number;
}
interface ConfigTask {
  readonly taskId: string;
  readonly roomId: string;
  readonly kind: string;
  readonly state: string;
  readonly bounds: readonly {
    productId: string;
    direction: string;
    quantity?: number;
    maxQuantity?: number;
  }[];
  readonly assignedAccountId: string | null;
  readonly revision: number;
}
interface RoomConfiguration {
  readonly mode: string;
  readonly stock: readonly { productId: string; quantity: number }[];
}

/**
 * Cleaner dashboard (doc 04 §3–§7): the four lists, newest and pending first,
 * every action a single tap, nothing that needs a horizontal scroll, and no
 * price, guest name or registration number anywhere on the screen — the API
 * sends this role none of them.
 */
export default async function CleanerPage({
  params,
  searchParams,
}: {
  params: Promise<{ hotelId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { hotelId } = await params;
  const outcome = outcomeOf(await searchParams);
  const ctx = await hotelContext(hotelId, `/hotels/${hotelId}/cleaner`);
  const locked = lockedScreen(ctx);
  if (locked !== undefined) return locked;
  const token = ctx.token;
  const [board, cleaning, refills, reports, configTasks] = await Promise.all([
    ctx.client.call<{ rooms: readonly RoomCard[] }>(`/hotels/${hotelId}/rooms/board`, { token }),
    ctx.client.call<{ tasks: readonly CleaningTask[] }>(`/hotels/${hotelId}/cleaning-tasks`, {
      token,
    }),
    ctx.client.call<{ tasks: readonly RefillTask[] }>(`/hotels/${hotelId}/minibar-refills`, {
      token,
    }),
    ctx.client.call<{ reports: readonly ReportRow[] }>(`/hotels/${hotelId}/minibar-reports`, {
      token,
    }),
    ctx.client.call<readonly ConfigTask[]>(`/hotels/${hotelId}/minibar/tasks`, { token }),
  ]);
  const rooms = new Map((board.ok ? board.body.rooms : []).map((r) => [r.roomId, r]));
  const roomLabel = (roomId: string): string => {
    const room = rooms.get(roomId);
    return room === undefined
      ? roomId
      : `${HOTEL.labels.room} ${room.roomNumber} · ${room.categoryName}`;
  };
  const me = ctx.session.accountId;
  const mine = (owner: string | null): boolean => owner === me;
  const stateBadge = (state: string) => (
    <Badge tone={state === 'OPEN' || state === 'PENDING' ? 'warn' : 'plain'}>
      {HOTEL.cleanerTaskState[state] ?? state}
    </Badge>
  );
  const hiddenFor = (task: { revision: number }, id: string, name: string) => (
    <>
      <input type="hidden" name="hotelId" value={hotelId} />
      <input type="hidden" name={name} value={id} />
      <input type="hidden" name="expectedRevision" value={task.revision} />
      <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
    </>
  );
  // The room's current stock, for the count forms. Read per room, only for
  // the rooms with an inspection or a reconciliation open.
  const configRooms = new Set<string>();
  if (reports.ok) reports.body.reports.forEach((r) => configRooms.add(r.roomId));
  if (configTasks.ok) configTasks.body.forEach((t) => configRooms.add(t.roomId));
  const configurations = new Map<string, RoomConfiguration>();
  await Promise.all(
    [...configRooms].map(async (roomId) => {
      const answer = await ctx.client.call<RoomConfiguration>(
        `/hotels/${hotelId}/minibar/rooms/${roomId}/configuration`,
        { token },
      );
      if (answer.ok) configurations.set(roomId, answer.body);
    }),
  );
  const countLines = (roomId: string, prefix: string) => {
    const stock = configurations.get(roomId)?.stock ?? [];
    if (stock.length === 0)
      return <p className="hint">{'Бүтээгдэхүүний жагсаалт энэ эрхэд харагдахгүй байна.'}</p>;
    return stock.map((line) => (
      <Field
        key={line.productId}
        id={`${prefix}-${line.productId}`}
        label={`${HOTEL.labels.product} ${line.productId.slice(0, 8)}`}
        hint={`${'Одоогийн тоо'}: ${String(line.quantity)}`}
      >
        <input
          id={`${prefix}-${line.productId}`}
          name={`qty:${line.productId}`}
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
        />
      </Field>
    ));
  };
  const failed = [board, cleaning, refills, reports, configTasks].filter((a) => !a.ok);
  return (
    <>
      <h1>{HOTEL.tabs.cleaner}</h1>
      {outcome.error !== undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      {outcome.ok !== undefined ? <Banner tone="ok">{'Хадгалагдлаа.'}</Banner> : null}
      {failed.length === 5 ? <p role="status">{COMMON.notAvailable}</p> : null}

      <section aria-labelledby="refill-title">
        <h2 id="refill-title">{HOTEL.cleanerLists.refill}</h2>
        {!refills.ok || refills.body.tasks.length === 0 ? (
          <p>{COMMON.nothingHere}</p>
        ) : (
          <ul className="card-list">
            {refills.body.tasks.map((task) => (
              <li className="card" key={task.taskId}>
                <h3>{roomLabel(task.roomId)}</h3>
                <p>
                  {stateBadge(task.state)} {HOTEL.labels.product} {task.productId.slice(0, 8)} ·{' '}
                  {HOTEL.labels.requested}: {String(task.requestedQuantity)}
                </p>
                {task.state === 'OPEN' ? (
                  <form action={claimRefill}>
                    {hiddenFor(task, task.taskId, 'taskId')}
                    <button className="button" type="submit">
                      {HOTEL.actions.claim}
                    </button>
                  </form>
                ) : null}
                {task.state === 'CLAIMED' ? (
                  <>
                    <form action={completeRefill}>
                      {hiddenFor(task, task.taskId, 'taskId')}
                      <Field id={`confirmed-${task.taskId}`} label={HOTEL.labels.confirmed}>
                        <input
                          id={`confirmed-${task.taskId}`}
                          name="confirmedQuantity"
                          type="number"
                          min={0}
                          max={task.requestedQuantity}
                          step={1}
                          inputMode="numeric"
                          required
                          defaultValue={task.requestedQuantity}
                        />
                      </Field>
                      <button className="button" type="submit">
                        {HOTEL.actions.complete}
                      </button>
                    </form>
                    <form action={refillImpossible}>
                      {hiddenFor(task, task.taskId, 'taskId')}
                      <Field id={`reason-${task.taskId}`} label={COMMON.reason}>
                        <input
                          id={`reason-${task.taskId}`}
                          name="reason"
                          maxLength={300}
                          required
                        />
                      </Field>
                      <button className="button button-secondary" type="submit">
                        {HOTEL.actions.impossible}
                      </button>
                    </form>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="inspect-title">
        <h2 id="inspect-title">{HOTEL.cleanerLists.inspect}</h2>
        {!reports.ok || reports.body.reports.length === 0 ? (
          <p>{COMMON.nothingHere}</p>
        ) : (
          <ul className="card-list">
            {reports.body.reports.map((report) => (
              <li className="card" key={report.reportId}>
                <h3>{roomLabel(report.roomId)}</h3>
                <p>{stateBadge(report.state)}</p>
                {report.state === 'PENDING' ? (
                  <form action={claimReport}>
                    {hiddenFor(report, report.reportId, 'reportId')}
                    <button className="button" type="submit">
                      {HOTEL.actions.claim}
                    </button>
                  </form>
                ) : null}
                {report.state === 'INSPECTING' || report.state === 'RETURNED' ? (
                  <>
                    <form action={submitReport} aria-label={HOTEL.actions.submitReport}>
                      {hiddenFor(report, report.reportId, 'reportId')}
                      {countLines(report.roomId, `count-${report.reportId}`)}
                      <button className="button" type="submit">
                        {HOTEL.actions.submitReport}
                      </button>
                    </form>
                    <form action={submitReport}>
                      {hiddenFor(report, report.reportId, 'reportId')}
                      <input type="hidden" name="noUsage" value="1" />
                      <button className="button button-secondary" type="submit">
                        {HOTEL.actions.noUsage}
                      </button>
                    </form>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="clean-title">
        <h2 id="clean-title">{HOTEL.cleanerLists.clean}</h2>
        {!cleaning.ok || cleaning.body.tasks.length === 0 ? (
          <p>{COMMON.nothingHere}</p>
        ) : (
          <ul className="card-list">
            {cleaning.body.tasks.map((task) => (
              <li className="card" key={task.taskId} data-task={task.taskId}>
                <h3>{roomLabel(task.roomId)}</h3>
                <p>
                  {stateBadge(task.state)} {HOTEL.labels.openedAt}: {formatDateTime(task.openedAt)}
                </p>
                {task.state === 'OPEN' ? (
                  <form action={claimCleaning}>
                    {hiddenFor(task, task.taskId, 'taskId')}
                    <button className="button" type="submit">
                      {HOTEL.actions.claim}
                    </button>
                  </form>
                ) : null}
                {task.state === 'CLAIMED' && mine(task.claimedByAccountId) ? (
                  <form action={completeCleaning}>
                    {hiddenFor(task, task.taskId, 'taskId')}
                    {rooms.get(task.roomId)?.minibarStatus !== 'NOT_APPLICABLE'
                      ? countLines(task.roomId, `refill-${task.taskId}`)
                      : null}
                    <button className="button" type="submit">
                      {HOTEL.actions.complete} · {HOTEL.cleaning['CLEAN']}
                    </button>
                  </form>
                ) : task.state === 'CLAIMED' ? (
                  <p>{'Өөр Cleaner гүйцэтгэж байна.'}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="reconcile-title">
        <h2 id="reconcile-title">{HOTEL.cleanerLists.reconcile}</h2>
        {!configTasks.ok || configTasks.body.length === 0 ? (
          <p>{COMMON.nothingHere}</p>
        ) : (
          <ul className="card-list">
            {configTasks.body.map((task) => (
              <li className="card" key={task.taskId}>
                <h3>{roomLabel(task.roomId)}</h3>
                <p>
                  {stateBadge(task.state)} <Badge>{task.kind}</Badge>
                </p>
                <ul>
                  {task.bounds.map((bound) => (
                    <li key={`${bound.productId}-${bound.direction}`}>
                      {HOTEL.labels.product} {bound.productId.slice(0, 8)} · {bound.direction} ·{' '}
                      {String(bound.quantity ?? bound.maxQuantity ?? '')}
                    </li>
                  ))}
                </ul>
                {task.state === 'OPEN' ? (
                  <form action={claimConfigTask}>
                    {hiddenFor(task, task.taskId, 'taskId')}
                    <button className="button" type="submit">
                      {HOTEL.actions.claim}
                    </button>
                  </form>
                ) : null}
                {task.state === 'CLAIMED' || task.state === 'IN_PROGRESS' ? (
                  <form action={completeConfigTask}>
                    {hiddenFor(task, task.taskId, 'taskId')}
                    {task.bounds.map((bound) => (
                      <Field
                        key={bound.productId}
                        id={`cfg-${task.taskId}-${bound.productId}`}
                        label={`${HOTEL.labels.counted} · ${bound.productId.slice(0, 8)}`}
                      >
                        <input
                          id={`cfg-${task.taskId}-${bound.productId}`}
                          name={`qty:${bound.productId}`}
                          type="number"
                          min={0}
                          step={1}
                          inputMode="numeric"
                        />
                      </Field>
                    ))}
                    <button className="button" type="submit">
                      {HOTEL.actions.complete}
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
