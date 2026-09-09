import {
  Badge,
  Banner,
  COMMON,
  Field,
  KeyValue,
  Table,
  errorText,
  formatDateTime,
  formatMnt,
} from '@prsystem/web-kit';
import { IDEMPOTENCY_FIELD, newIdempotencyKey, outcomeOf } from '@prsystem/web-kit/server';
import { HOTEL } from '../../../../../lib/copy';
import { hotelContext, lockedScreen } from '../../../../../lib/hotel-context';
import {
  cancelCheckout,
  finishCheckout,
  recordPayment,
  settleFolio,
  startCheckout,
} from './actions';

interface StayView {
  readonly stayId: string;
  readonly roomId: string;
  readonly source: string;
  readonly bookingRef: string | null;
  readonly stayType: string;
  readonly state: string;
  readonly actualCheckInAt: string;
  readonly effectiveActualCheckInAt: string;
  readonly plannedCheckoutAt: string;
  readonly nightCount: number | null;
  readonly halfHourUnits: number | null;
  readonly unitRateMnt: string;
  readonly roomChargeMnt: string;
  readonly depositRequired: boolean;
  readonly minibarApplicable: boolean;
  readonly actualCheckoutAt: string | null;
  readonly timeState: string | null;
  readonly overdueMinutes: number;
  readonly revision: number;
  readonly guest: {
    readonly familyName?: string;
    readonly givenName?: string;
    readonly identityType?: string;
  } | null;
}

interface FolioLine {
  readonly lineId: string;
  readonly kind: string;
  readonly description: string;
  readonly amountMnt: string;
}
interface Transaction {
  readonly transactionId: string;
  readonly kind?: string;
  readonly channel?: string;
  readonly amountMnt: string;
  readonly recordedAt?: string;
}
interface FolioView {
  readonly state: string;
  readonly chargedMnt: string;
  readonly paidMnt: string;
  readonly depositAppliedMnt: string;
  readonly balanceMnt: string;
  readonly lines: readonly FolioLine[];
  readonly transactions: readonly Transaction[];
  readonly revision: number;
}

interface ReportSummary {
  readonly reportId: string;
  readonly state: string;
  readonly payableMnt: string;
}

/**
 * One stay: the check-in facts, the bill, and the checkout (doc 02 §3.2–§3.3,
 * doc 04 §5.2). The unified bill is the API's — charged, paid, deposit
 * applied, balance — and the portal prints it.
 */
export default async function StayPage({
  params,
  searchParams,
}: {
  params: Promise<{ hotelId: string; stayId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { hotelId, stayId } = await params;
  const outcome = outcomeOf(await searchParams);
  const here = `/hotels/${hotelId}/stays/${stayId}`;
  const ctx = await hotelContext(hotelId, here);
  const locked = lockedScreen(ctx);
  if (locked !== undefined) return locked;
  const stay = await ctx.client.call<StayView>(`/hotels/${hotelId}/stays/${stayId}`, {
    token: ctx.token,
  });
  if (!stay.ok) {
    return (
      <>
        <h1>{HOTEL.labels.guest}</h1>
        <p role="status">
          {stay.code === 'NOT_FOUND' ? COMMON.notAvailable : errorText(stay.code, stay.message)}
        </p>
      </>
    );
  }
  const s = stay.body;
  const folio = await ctx.client.call<FolioView>(`/hotels/${hotelId}/stays/${stayId}/folio`, {
    token: ctx.token,
  });
  const reports = s.minibarApplicable
    ? await ctx.client.call<{
        reports: readonly { reportId: string; roomId: string; state: string }[];
      }>(`/hotels/${hotelId}/minibar-reports`, { token: ctx.token })
    : undefined;
  const openReport =
    reports !== undefined && reports.ok
      ? reports.body.reports.find((r) => r.roomId === s.roomId)
      : undefined;
  const report =
    openReport === undefined
      ? undefined
      : await ctx.client.call<ReportSummary>(
          `/hotels/${hotelId}/minibar-reports/${openReport.reportId}`,
          { token: ctx.token },
        );
  const canCheckout = ctx.has('hotel.stay.checkout_record');
  const hidden = (
    <>
      <input type="hidden" name="hotelId" value={hotelId} />
      <input type="hidden" name="stayId" value={stayId} />
      <input type="hidden" name="expectedRevision" value={s.revision} />
      <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
    </>
  );
  return (
    <>
      <h1>
        {HOTEL.labels.guest}: {s.guest?.familyName ?? ''} {s.guest?.givenName ?? ''}
      </h1>
      {outcome.error !== undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      {outcome.ok !== undefined ? <Banner tone="ok">{'Хадгалагдлаа.'}</Banner> : null}
      <p>
        <Badge>{s.state}</Badge>
        <Badge>{HOTEL.source[s.source] ?? s.source}</Badge>
        <Badge>{HOTEL.stayType[s.stayType] ?? s.stayType}</Badge>
        {s.timeState !== null ? (
          <Badge tone={s.timeState === 'OVERDUE' ? 'danger' : 'plain'}>
            {HOTEL.timeState[s.timeState] ?? s.timeState}
          </Badge>
        ) : null}
      </p>
      <KeyValue
        items={[
          ['Check-in', formatDateTime(s.effectiveActualCheckInAt)],
          [HOTEL.labels.plannedCheckout, formatDateTime(s.plannedCheckoutAt)],
          [
            s.stayType === 'HOURLY' ? HOTEL.labels.halfHourUnits : HOTEL.labels.nights,
            String(s.stayType === 'HOURLY' ? (s.halfHourUnits ?? '—') : (s.nightCount ?? '—')),
          ],
          [HOTEL.labels.unitRate, formatMnt(s.unitRateMnt)],
          [HOTEL.labels.roomCharge, formatMnt(s.roomChargeMnt)],
          [HOTEL.labels.depositRequired, s.depositRequired ? COMMON.yes : COMMON.no],
          ['Actual check-out', formatDateTime(s.actualCheckoutAt)],
        ]}
      />

      {s.minibarApplicable ? (
        <section aria-labelledby="minibar-title">
          <h2 id="minibar-title">{'Минибарын шалгалт'}</h2>
          {openReport === undefined ? (
            <p>{s.state === 'ACTIVE' ? 'Check-out эхлээгүй.' : '—'}</p>
          ) : (
            <p>
              <Badge
                tone={
                  openReport.state === 'SUBMITTED' || openReport.state === 'RESUBMITTED'
                    ? 'ok'
                    : 'warn'
                }
              >
                {HOTEL.cleanerTaskState[openReport.state] ?? openReport.state}
              </Badge>{' '}
              {report !== undefined && report.ok
                ? `${'Төлөх дүн'}: ${formatMnt(report.body.payableMnt)}`
                : null}
            </p>
          )}
        </section>
      ) : null}

      <section aria-labelledby="folio-title">
        <h2 id="folio-title">{HOTEL.tabs.billing}</h2>
        {!folio.ok ? (
          <p role="status">
            {folio.code === 'NOT_FOUND'
              ? COMMON.notAvailable
              : errorText(folio.code, folio.message)}
          </p>
        ) : (
          <>
            <KeyValue
              items={[
                [HOTEL.labels.charged, formatMnt(folio.body.chargedMnt)],
                [HOTEL.labels.paid, formatMnt(folio.body.paidMnt)],
                ['Барьцаанаас суутгах дүн', formatMnt(folio.body.depositAppliedMnt)],
                [HOTEL.labels.balance, formatMnt(folio.body.balanceMnt)],
                [COMMON.state, folio.body.state],
              ]}
            />
            <Table
              caption={'Тооцооны задаргаа'}
              columns={[
                { key: 'kind', header: 'Төрөл', cell: (l: FolioLine) => l.kind },
                { key: 'description', header: 'Тайлбар', cell: (l: FolioLine) => l.description },
                {
                  key: 'amount',
                  header: HOTEL.labels.amount,
                  cell: (l: FolioLine) => formatMnt(l.amountMnt),
                },
              ]}
              rows={folio.body.lines}
              rowKey={(l) => l.lineId}
              empty={COMMON.nothingHere}
            />
            {canCheckout && folio.body.state !== 'SETTLED' ? (
              <form action={recordPayment} className="form-grid" aria-labelledby="pay-title">
                <h3 id="pay-title" className="span-2">
                  {HOTEL.actions.recordPayment}
                </h3>
                {hidden}
                <Field id="channel" label={HOTEL.labels.channel}>
                  <select id="channel" name="channel" defaultValue="CASH">
                    <option value="CASH">{HOTEL.channels.CASH}</option>
                    <option value="MANUAL_POS">{HOTEL.channels.CARD_MANUAL}</option>
                    <option value="QPAY">{HOTEL.channels.QPAY}</option>
                  </select>
                </Field>
                <Field id="amountMnt" label={HOTEL.labels.amount}>
                  <input
                    id="amountMnt"
                    name="amountMnt"
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    required
                    defaultValue={folio.body.balanceMnt}
                  />
                </Field>
                <Field
                  id="approvalCode"
                  label={'POS approval код'}
                  hint={'Гараар бүртгэсэн картын төлбөрт'}
                >
                  <input id="approvalCode" name="approvalCode" />
                </Field>
                <Field id="terminalId" label={'Терминал'} hint={'Гараар бүртгэсэн картын төлбөрт'}>
                  <input id="terminalId" name="terminalId" />
                </Field>
                <Field id="providerReference" label={'Provider reference'} hint={'QPay төлбөрт'}>
                  <input id="providerReference" name="providerReference" />
                </Field>
                <div className="actions span-2">
                  <button className="button" type="submit">
                    {HOTEL.actions.recordPayment}
                  </button>
                </div>
              </form>
            ) : null}
            {canCheckout && folio.body.state !== 'SETTLED' ? (
              <form action={settleFolio}>
                <input type="hidden" name="hotelId" value={hotelId} />
                <input type="hidden" name="stayId" value={stayId} />
                <input type="hidden" name="expectedRevision" value={folio.body.revision} />
                <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
                <button className="button button-secondary" type="submit">
                  {HOTEL.actions.settle}
                </button>
              </form>
            ) : null}
          </>
        )}
      </section>

      {canCheckout ? (
        <section aria-labelledby="checkout-title">
          <h2 id="checkout-title">{'Check-out'}</h2>
          <div className="actions">
            {s.state === 'ACTIVE' ? (
              <form action={startCheckout} className="inline">
                {hidden}
                <button className="button" type="submit">
                  {HOTEL.actions.startCheckout}
                </button>
              </form>
            ) : null}
            {s.state === 'CHECKOUT_IN_PROGRESS' ? (
              <form action={finishCheckout} className="inline">
                {hidden}
                <button className="button" type="submit">
                  {HOTEL.actions.finishCheckout}
                </button>
              </form>
            ) : null}
          </div>
          {s.state === 'CHECKOUT_IN_PROGRESS' ? (
            <form action={cancelCheckout} aria-labelledby="cancel-title">
              <h3 id="cancel-title">{HOTEL.actions.cancelCheckout}</h3>
              {hidden}
              <Field id="reason" label={COMMON.reason}>
                <input id="reason" name="reason" required maxLength={300} />
              </Field>
              <button className="button button-danger" type="submit">
                {HOTEL.actions.cancelCheckout}
              </button>
            </form>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
