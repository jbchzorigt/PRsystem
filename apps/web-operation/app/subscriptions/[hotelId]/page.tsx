import { Badge, Banner, COMMON, Field, Table, errorText, formatDateTime } from '@prsystem/web-kit';
import { IDEMPOTENCY_FIELD, newIdempotencyKey, outcomeOf } from '@prsystem/web-kit/server';
import { OPS } from '../../../lib/copy';
import { api, can, requireSession, stepUpIfRequired } from '../../../lib/portal';
import { OpsShell } from '../../../lib/shell';
import { passwordReset } from '../actions';
import { suspension } from './actions';

interface HistoryRow {
  readonly eventId?: string;
  readonly suspended: boolean;
  readonly reasonCode?: string;
  readonly note?: string;
  readonly occurredAt: string;
  readonly startsAtSnapshot: string;
  readonly expiresAtSnapshot: string;
}

type Query = Record<string, string | string[] | undefined>;

/**
 * doc 14 §4.1 and §2.1 for one hotel: the suspension history the API keeps,
 * and the two commands. The API has no single-subscription read; the name
 * shown comes from the list link (display only — every command is by id).
 */
export default async function SubscriptionPage({
  params,
  searchParams,
}: {
  params: Promise<{ hotelId: string }>;
  searchParams: Promise<Query>;
}) {
  const { hotelId } = await params;
  const query = await searchParams;
  const outcome = outcomeOf(query);
  const name = typeof query['name'] === 'string' ? query['name'] : undefined;
  const self = `/subscriptions/${hotelId}${name === undefined ? '' : `?name=${encodeURIComponent(name)}`}`;
  const { token, session } = await requireSession(self);
  const history = await api().call<{ items: readonly HistoryRow[] }>(
    `/operation/subscriptions/${hotelId}/suspension-history`,
    { token },
  );
  stepUpIfRequired(history, self);
  const key = newIdempotencyKey();
  const OK: Readonly<Record<string, string>> = {
    suspension: 'Suspension төлөв өөрчлөгдлөө.',
    reset: OPS.detail.resetQueued,
    'reset-failed': OPS.detail.resetFailed,
  };
  return (
    <OpsShell session={session} current="subscriptions">
      <h1>
        {OPS.detail.title}: {name ?? hotelId}
      </h1>
      <p className="hint">{hotelId}</p>
      {outcome.ok !== undefined ? (
        <Banner tone={outcome.ok === 'reset-failed' ? 'warn' : 'ok'}>
          {OK[outcome.ok] ?? outcome.ok}
        </Banner>
      ) : null}
      {outcome.error !== undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      <h2>{OPS.detail.history}</h2>
      {!history.ok ? (
        <Banner tone="danger">{errorText(history.code, history.message)}</Banner>
      ) : (
        <Table<HistoryRow>
          caption={OPS.detail.history}
          rows={history.body.items}
          rowKey={(r) => r.eventId ?? r.occurredAt}
          empty={COMMON.nothingHere}
          columns={[
            { key: 'at', header: OPS.detail.occurredAt, cell: (r) => formatDateTime(r.occurredAt) },
            {
              key: 'suspended',
              header: OPS.detail.suspended,
              cell: (r) => (
                <Badge tone={r.suspended ? 'danger' : 'ok'}>
                  {r.suspended ? OPS.detail.suspend : OPS.detail.reactivate}
                </Badge>
              ),
            },
            { key: 'reason', header: OPS.detail.reasonCode, cell: (r) => r.reasonCode ?? '—' },
            { key: 'note', header: COMMON.note, cell: (r) => r.note ?? '—' },
            {
              key: 'starts',
              header: OPS.list.columns.startsAt,
              cell: (r) => formatDateTime(r.startsAtSnapshot),
            },
            {
              key: 'expires',
              header: OPS.list.columns.expiresAt,
              cell: (r) => formatDateTime(r.expiresAtSnapshot),
            },
          ]}
        />
      )}
      {can(session, 'operation.subscription_suspend') ? (
        <section aria-labelledby="suspend-title">
          <h2 id="suspend-title">
            {OPS.detail.suspend} / {OPS.detail.reactivate}
          </h2>
          <form action={suspension}>
            <input type="hidden" name={IDEMPOTENCY_FIELD} value={`${key}-suspension`} />
            <input type="hidden" name="hotelId" value={hotelId} />
            {name !== undefined ? <input type="hidden" name="name" value={name} /> : null}
            <fieldset>
              <legend>{COMMON.actions}</legend>
              <label>
                <input type="radio" name="suspend" value="yes" defaultChecked />{' '}
                {OPS.detail.suspend}
              </label>
              <label>
                <input type="radio" name="suspend" value="no" /> {OPS.detail.reactivate}
              </label>
            </fieldset>
            <Field id="reasonCode" label={OPS.detail.reasonCode}>
              <input
                id="reasonCode"
                name="reasonCode"
                type="text"
                pattern="[A-Z][A-Z0-9_]{2,39}"
                required
              />
            </Field>
            <Field
              id="note"
              label={OPS.detail.note}
              error={
                outcome.field === 'note' && outcome.error !== undefined
                  ? errorText(outcome.error, outcome.message)
                  : undefined
              }
            >
              <textarea id="note" name="note" minLength={10} maxLength={1000} required rows={3} />
            </Field>
            <button className="button button-danger" type="submit">
              {COMMON.confirm}
            </button>
          </form>
        </section>
      ) : null}
      {can(session, 'operation.hotel_admin_password_reset_initiate') ? (
        <section aria-labelledby="reset-title">
          <h2 id="reset-title">{OPS.list.passwordReset}</h2>
          <p className="hint">{OPS.detail.resetHint}</p>
          <form action={passwordReset}>
            <input type="hidden" name={IDEMPOTENCY_FIELD} value={`${key}-reset`} />
            <input type="hidden" name="hotelId" value={hotelId} />
            <input type="hidden" name="back" value={self} />
            <button className="button" type="submit">
              {OPS.detail.reset}
            </button>
          </form>
        </section>
      ) : null}
    </OpsShell>
  );
}
