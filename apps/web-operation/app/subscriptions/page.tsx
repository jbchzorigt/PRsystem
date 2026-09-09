import {
  Badge,
  Banner,
  COMMON,
  Field,
  Pager,
  Table,
  errorText,
  formatDateTime,
} from '@prsystem/web-kit';
import { IDEMPOTENCY_FIELD, newIdempotencyKey, outcomeOf } from '@prsystem/web-kit/server';
import { OPS } from '../../lib/copy';
import { api, can, requireSession, stepUpIfRequired } from '../../lib/portal';
import { OpsShell } from '../../lib/shell';
import { passwordReset } from './actions';

export interface SubscriptionRow {
  readonly hotelId: string;
  readonly subscriptionId: string;
  readonly hotelName: string;
  readonly ownerType: string;
  readonly district: string;
  readonly addressLine: string;
  readonly contactPhone: string;
  readonly emailMasked: string;
  readonly effectivePackage: string;
  readonly termMonths: number;
  readonly startsAt: string;
  readonly expiresAt: string;
  readonly suspendedAt: string | null;
  readonly status: string;
  readonly remainingDays: number;
}
interface Page {
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly items: readonly SubscriptionRow[];
}

type Query = Record<string, string | string[] | undefined>;
const FILTERS = [
  'name',
  'phone',
  'email',
  'ownerType',
  'district',
  'package',
  'termMonths',
  'status',
  'expiresFrom',
  'expiresTo',
] as const;
const one = (q: Query, name: string) =>
  typeof q[name] === 'string' && q[name] !== '' ? (q[name] as string) : undefined;

/** doc 14 §3.2–3.3: thirteen columns, server filters, server pages, default order by expiry. */
export default async function SubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<Query>;
}) {
  const query = await searchParams;
  const outcome = outcomeOf(query);
  const { token, session } = await requireSession('/subscriptions');
  const filters: Record<string, string> = {};
  for (const name of FILTERS) {
    const value = one(query, name);
    if (value !== undefined) filters[name] = value;
  }
  const offset = one(query, 'offset') ?? '0';
  const self = `/subscriptions?${new URLSearchParams({ ...filters, offset }).toString()}`;
  const answer = await api().call<Page>('/operation/subscriptions', {
    token,
    query: { ...filters, offset, limit: '25' },
  });
  stepUpIfRequired(answer, self);
  const href = (next: number) =>
    `/subscriptions?${new URLSearchParams({ ...filters, offset: String(next) }).toString()}`;
  const c = OPS.list.columns;
  const canReset = can(session, 'operation.hotel_admin_password_reset_initiate');
  const canSms = can(session, 'operation.subscription_reminder_send');
  const key = newIdempotencyKey();
  const packageLabel = (code: string) =>
    code === 'P20'
      ? OPS.kpi.P20
      : code === 'P25'
        ? OPS.kpi.P25
        : code === 'P30'
          ? OPS.kpi.P30
          : code;
  return (
    <OpsShell session={session} current="subscriptions">
      <h1>{OPS.list.title}</h1>
      {outcome.ok === 'reset' ? <Banner tone="ok">{OPS.detail.resetQueued}</Banner> : null}
      {outcome.error !== undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      <form method="get" className="form-grid" aria-label={OPS.list.filters}>
        <Field id="name" label={OPS.list.name}>
          <input id="name" name="name" type="search" defaultValue={filters['name'] ?? ''} />
        </Field>
        <Field id="phone" label={OPS.list.phone}>
          <input id="phone" name="phone" type="tel" defaultValue={filters['phone'] ?? ''} />
        </Field>
        <Field id="email" label={OPS.list.email}>
          <input id="email" name="email" type="text" defaultValue={filters['email'] ?? ''} />
        </Field>
        <Field id="ownerType" label={OPS.list.ownerType}>
          <select id="ownerType" name="ownerType" defaultValue={filters['ownerType'] ?? ''}>
            <option value="">{OPS.list.any}</option>
            {Object.entries(OPS.list.ownerTypes).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field id="district" label={OPS.list.district}>
          <input
            id="district"
            name="district"
            type="text"
            defaultValue={filters['district'] ?? ''}
          />
        </Field>
        <Field id="package" label={OPS.list.package}>
          <select id="package" name="package" defaultValue={filters['package'] ?? ''}>
            <option value="">{OPS.list.any}</option>
            {(['P20', 'P25', 'P30'] as const).map((p) => (
              <option key={p} value={p}>
                {packageLabel(p)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="termMonths" label={OPS.list.termMonths}>
          <select id="termMonths" name="termMonths" defaultValue={filters['termMonths'] ?? ''}>
            <option value="">{OPS.list.any}</option>
            {[1, 3, 7, 12].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <Field id="status" label={OPS.list.status}>
          <select id="status" name="status" defaultValue={filters['status'] ?? ''}>
            <option value="">{OPS.list.any}</option>
            {Object.entries(OPS.list.statuses).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field id="expiresFrom" label={OPS.list.expiresFrom}>
          <input
            id="expiresFrom"
            name="expiresFrom"
            type="date"
            defaultValue={filters['expiresFrom'] ?? ''}
          />
        </Field>
        <Field id="expiresTo" label={OPS.list.expiresTo}>
          <input
            id="expiresTo"
            name="expiresTo"
            type="date"
            defaultValue={filters['expiresTo'] ?? ''}
          />
        </Field>
        <div className="actions">
          <button className="button" type="submit">
            {COMMON.search}
          </button>
          <a className="button button-secondary" href="/subscriptions">
            {COMMON.clear}
          </a>
        </div>
      </form>
      {!answer.ok ? (
        <Banner tone="danger">{errorText(answer.code, answer.message)}</Banner>
      ) : (
        <>
          <Table<SubscriptionRow>
            caption={OPS.list.title}
            rows={answer.body.items}
            rowKey={(r) => r.hotelId}
            empty={COMMON.nothingHere}
            columns={[
              {
                key: 'n',
                header: c.n,
                cell: (r) => String(answer.body.offset + answer.body.items.indexOf(r) + 1),
              },
              {
                key: 'name',
                header: c.hotelName,
                cell: (r) => (
                  <a href={`/subscriptions/${r.hotelId}?name=${encodeURIComponent(r.hotelName)}`}>
                    {r.hotelName}
                  </a>
                ),
              },
              {
                key: 'owner',
                header: c.ownerType,
                cell: (r) => OPS.list.ownerTypes[r.ownerType] ?? r.ownerType,
              },
              {
                key: 'district',
                header: c.district,
                cell: (r) => `${r.district} · ${r.addressLine}`,
              },
              { key: 'phone', header: c.contactPhone, cell: (r) => r.contactPhone },
              { key: 'email', header: c.emailMasked, cell: (r) => r.emailMasked },
              { key: 'package', header: c.package, cell: (r) => packageLabel(r.effectivePackage) },
              { key: 'term', header: c.termMonths, cell: (r) => String(r.termMonths) },
              { key: 'starts', header: c.startsAt, cell: (r) => formatDateTime(r.startsAt) },
              { key: 'expires', header: c.expiresAt, cell: (r) => formatDateTime(r.expiresAt) },
              { key: 'remaining', header: c.remainingDays, cell: (r) => String(r.remainingDays) },
              {
                key: 'status',
                header: c.status,
                cell: (r) => (
                  <Badge
                    tone={
                      r.status === 'ACTIVE'
                        ? 'ok'
                        : r.status === 'SUSPENDED' || r.status === 'EXPIRED'
                          ? 'danger'
                          : 'warn'
                    }
                  >
                    {OPS.list.statuses[r.status] ?? r.status}
                  </Badge>
                ),
              },
              {
                key: 'actions',
                header: c.actions,
                cell: (r) => (
                  <span className="actions">
                    <a
                      className="button button-secondary"
                      href={`/subscriptions/${r.hotelId}?name=${encodeURIComponent(r.hotelName)}`}
                    >
                      {OPS.list.details}
                    </a>
                    {canSms ? (
                      <a className="button button-secondary" href={`/sms?hotelIds=${r.hotelId}`}>
                        {OPS.list.sendSms}
                      </a>
                    ) : null}
                    {canReset ? (
                      <form action={passwordReset} className="inline">
                        <input
                          type="hidden"
                          name={IDEMPOTENCY_FIELD}
                          value={`${key}-${r.hotelId}`}
                        />
                        <input type="hidden" name="hotelId" value={r.hotelId} />
                        <input type="hidden" name="back" value={self} />
                        <button className="button button-secondary" type="submit">
                          {OPS.list.passwordReset}
                        </button>
                      </form>
                    ) : null}
                  </span>
                ),
              },
            ]}
          />
          <Pager
            total={answer.body.total}
            limit={answer.body.limit}
            offset={answer.body.offset}
            href={href}
          />
        </>
      )}
    </OpsShell>
  );
}
