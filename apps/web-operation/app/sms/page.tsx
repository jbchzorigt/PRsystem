import {
  Banner,
  COMMON,
  Field,
  KeyValue,
  Pager,
  Table,
  errorText,
  formatDateTime,
  formatMnt,
} from '@prsystem/web-kit';
import { IDEMPOTENCY_FIELD, newIdempotencyKey, outcomeOf } from '@prsystem/web-kit/server';
import { OPS } from '../../lib/copy';
import { api, requireSession, stepUpIfRequired } from '../../lib/portal';
import { OpsShell } from '../../lib/shell';
import { confirm, preview, refresh } from './actions';

interface Job {
  readonly jobId: string;
  readonly state: string;
  readonly recipientCount: number;
  readonly excludedCount: number;
  readonly totalSegments: number;
  readonly confirmedAt: string;
  readonly dispatchedAt: string | null;
  readonly providerReference: string | null;
  readonly pending: number | string;
  readonly sent: number | string;
  readonly delivered: number | string;
  readonly failed: number | string;
}

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, name: string) =>
  typeof q[name] === 'string' && q[name] !== '' ? (q[name] as string) : undefined;

/**
 * doc 14 §5–§6: recipients → text → preview → confirm, then the history. A
 * preview the API returned is shown from the query string's id only when the
 * page was reached from the preview command; its numbers come from the API's
 * answer to that command, which the page re-reads nowhere (previews expire).
 */
export default async function SmsPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const outcome = outcomeOf(query);
  const { token, session } = await requireSession('/sms');
  const offset = one(query, 'offset') ?? '0';
  const previewId = one(query, 'previewId');
  const history = await api().call<{ total: number; items: readonly Job[] }>(
    '/operation/sms/jobs',
    { token, query: { offset, limit: '20' } },
  );
  stepUpIfRequired(history, `/sms?offset=${offset}`);
  const key = newIdempotencyKey();
  const OK: Readonly<Record<string, string>> = {
    confirmed: OPS.sms.confirmed,
    refreshed: 'Хүргэлтийн төлөв шинэчлэгдлээ.',
  };
  const c = OPS.sms.columns;
  return (
    <OpsShell session={session} current="sms">
      <h1>{OPS.sms.title}</h1>
      {outcome.ok !== undefined ? <Banner tone="ok">{OK[outcome.ok] ?? outcome.ok}</Banner> : null}
      {outcome.error !== undefined && outcome.field === undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      {previewId !== undefined ? (
        <section aria-labelledby="preview-title">
          <h2 id="preview-title">{OPS.sms.previewTitle}</h2>
          <KeyValue
            items={[
              [OPS.sms.previewTitle, previewId],
              [OPS.sms.characters, one(query, 'characters') ?? '—'],
              [OPS.sms.alphabet, one(query, 'alphabet') ?? '—'],
              [OPS.sms.segments, one(query, 'segmentsPerRecipient') ?? '—'],
              [OPS.sms.recipientCount, one(query, 'recipientCount') ?? '—'],
              [OPS.sms.duplicateCount, one(query, 'duplicateCount') ?? '—'],
              [OPS.sms.excludedCount, one(query, 'excludedCount') ?? '—'],
              [OPS.sms.totalSegments, one(query, 'totalSegments') ?? '—'],
              [
                OPS.sms.estimatedCost,
                one(query, 'estimatedCostMnt') === undefined
                  ? '—'
                  : formatMnt(one(query, 'estimatedCostMnt')),
              ],
              [OPS.sms.expiresAt, formatDateTime(one(query, 'expiresAt'))],
            ]}
          />
          <form action={confirm}>
            <input type="hidden" name={IDEMPOTENCY_FIELD} value={`${key}-confirm`} />
            <input type="hidden" name="previewId" value={previewId} />
            <button className="button" type="submit">
              {OPS.sms.confirm}
            </button>
          </form>
        </section>
      ) : null}
      <section aria-labelledby="compose-title">
        <h2 id="compose-title">{OPS.sms.recipients}</h2>
        <form action={preview} className="form-grid">
          <Field id="hotelIds" label={OPS.sms.hotelIds}>
            <input
              id="hotelIds"
              name="hotelIds"
              type="text"
              defaultValue={one(query, 'hotelIds') ?? ''}
            />
          </Field>
          <Field id="package" label={OPS.list.package}>
            <select id="package" name="package" defaultValue="">
              <option value="">{OPS.list.any}</option>
              <option value="P20">{OPS.kpi.P20}</option>
              <option value="P25">{OPS.kpi.P25}</option>
              <option value="P30">{OPS.kpi.P30}</option>
            </select>
          </Field>
          <Field id="status" label={OPS.list.status}>
            <select id="status" name="status" defaultValue="">
              <option value="">{OPS.list.any}</option>
              {Object.entries(OPS.list.statuses).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field id="expiresFrom" label={OPS.list.expiresFrom}>
            <input id="expiresFrom" name="expiresFrom" type="date" />
          </Field>
          <Field id="expiresTo" label={OPS.list.expiresTo}>
            <input id="expiresTo" name="expiresTo" type="date" />
          </Field>
          <Field
            id="body"
            label={OPS.sms.body}
            error={
              outcome.field === 'body' && outcome.error !== undefined
                ? errorText(outcome.error, outcome.message)
                : undefined
            }
          >
            <textarea id="body" name="body" maxLength={300} required rows={3} />
          </Field>
          <button className="button" type="submit">
            {OPS.sms.preview}
          </button>
        </form>
      </section>
      <section aria-labelledby="history-title">
        <h2 id="history-title">{OPS.sms.history}</h2>
        <form action={refresh} className="inline">
          <button className="button button-secondary" type="submit">
            {OPS.sms.refresh}
          </button>
        </form>
        {!history.ok ? (
          <Banner tone="danger">{errorText(history.code, history.message)}</Banner>
        ) : (
          <>
            <Table<Job>
              caption={OPS.sms.history}
              rows={history.body.items}
              rowKey={(r) => r.jobId}
              empty={COMMON.nothingHere}
              columns={[
                { key: 'id', header: c.jobId, cell: (r) => r.jobId },
                {
                  key: 'confirmed',
                  header: c.confirmedAt,
                  cell: (r) => formatDateTime(r.confirmedAt),
                },
                {
                  key: 'dispatched',
                  header: c.dispatchedAt,
                  cell: (r) => formatDateTime(r.dispatchedAt),
                },
                { key: 'recipients', header: c.recipients, cell: (r) => String(r.recipientCount) },
                { key: 'excluded', header: c.excluded, cell: (r) => String(r.excludedCount) },
                { key: 'segments', header: c.segments, cell: (r) => String(r.totalSegments) },
                { key: 'pending', header: c.pending, cell: (r) => String(r.pending) },
                { key: 'sent', header: c.sent, cell: (r) => String(r.sent) },
                { key: 'delivered', header: c.delivered, cell: (r) => String(r.delivered) },
                { key: 'failed', header: c.failed, cell: (r) => String(r.failed) },
                { key: 'provider', header: c.provider, cell: (r) => r.providerReference ?? '—' },
                { key: 'state', header: c.state, cell: (r) => r.state },
              ]}
            />
            <Pager
              total={history.body.total}
              limit={20}
              offset={Number(offset)}
              href={(next) => `/sms?offset=${String(next)}`}
            />
          </>
        )}
      </section>
    </OpsShell>
  );
}
