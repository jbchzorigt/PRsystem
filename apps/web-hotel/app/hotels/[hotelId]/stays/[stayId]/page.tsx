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
  lockReport,
  postCharges,
  reconcileReport,
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
  readonly minibarReport: {
    readonly reportId: string;
    readonly state: string;
    readonly revision: number;
  } | null;
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

interface ReportLock {
  readonly lockId: string;
  readonly attemptRef: string;
  readonly state: string;
  readonly providerStatus: string | null;
  readonly amountMnt: string;
  readonly revision: number;
}
interface ReportSummary {
  readonly reportId: string;
  readonly state: string;
  readonly revision: number;
  readonly payableMnt?: string;
  readonly currentVersionId: string | null;
  readonly versions: readonly {
    readonly versionId: string;
    readonly totalMnt: string;
    readonly noUsage: boolean;
  }[];
  readonly locks: readonly ReportLock[];
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
  // The stay's own live report, as the API names it (a submitted report has
  // left the Cleaner's queue but is still the checkout's).
  const openReport = s.minibarReport ?? undefined;
  const report =
    openReport === undefined
      ? undefined
      : await ctx.client.call<ReportSummary>(
          `/hotels/${hotelId}/minibar-reports/${openReport.reportId}`,
          { token: ctx.token },
        );
  const canCheckout = ctx.has('hotel.stay.checkout_record');
  // doc 24: cash belongs to the shift of the desk that took it. The Reception's
  // open shift, if any, travels with a cash payment; the API refuses cash
  // without one, and this page says so before the desk tries.
  const currentShift = await ctx.client.call<{ shift: { shiftId: string } | null }>(
    `/hotels/${hotelId}/shifts/current`,
    { token: ctx.token },
  );
  const shiftId = currentShift.ok ? (currentShift.body.shift?.shiftId ?? undefined) : undefined;
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
                ? `${'Төлөх дүн'}: ${formatMnt(report.body.payableMnt ?? report.body.versions.find((v) => v.versionId === report.body.currentVersionId)?.totalMnt ?? '0')}`
                : null}
            </p>
          )}
          {report !== undefined && report.ok && canCheckout ? (
            <>
              {openReport?.state === 'SUBMITTED' || openReport?.state === 'RESUBMITTED' ? (
                <form action={lockReport} className="form-grid" aria-labelledby="lock-title">
                  <h3 id="lock-title" className="span-2">
                    {HOTEL.labels.lockReport}
                  </h3>
                  <input type="hidden" name="hotelId" value={hotelId} />
                  <input type="hidden" name="stayId" value={stayId} />
                  <input type="hidden" name="reportId" value={report.body.reportId} />
                  <input type="hidden" name="reportRevision" value={report.body.revision} />
                  <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
                  <Field
                    id="attemptRef"
                    label={HOTEL.labels.attemptRef}
                    hint={HOTEL.labels.attemptRefHint}
                  >
                    <input
                      id="attemptRef"
                      name="attemptRef"
                      defaultValue={`mb-${report.body.reportId.slice(0, 8)}`}
                      maxLength={120}
                      required
                    />
                  </Field>
                  <div className="actions span-2">
                    <button className="button" type="submit">
                      {HOTEL.labels.lockReport}
                    </button>
                  </div>
                </form>
              ) : null}
              {report.body.locks
                .filter((lock) => lock.state === 'HELD')
                .map((lock) => (
                  <form key={lock.lockId} action={reconcileReport} className="inline">
                    <input type="hidden" name="hotelId" value={hotelId} />
                    <input type="hidden" name="stayId" value={stayId} />
                    <input type="hidden" name="reportId" value={report.body.reportId} />
                    <input type="hidden" name="lockId" value={lock.lockId} />
                    <input type="hidden" name="lockRevision" value={lock.revision} />
                    <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
                    <span>
                      {HOTEL.labels.attemptRef}: {lock.attemptRef} · {formatMnt(lock.amountMnt)} ·{' '}
                      {lock.state}
                    </span>{' '}
                    <button className="button button-secondary" type="submit">
                      {HOTEL.labels.reconcileReport}
                    </button>
                  </form>
                ))}
            </>
          ) : null}
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
              <form action={postCharges} className="inline">
                <input type="hidden" name="hotelId" value={hotelId} />
                <input type="hidden" name="stayId" value={stayId} />
                <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
                <button className="button button-secondary" type="submit">
                  {HOTEL.labels.postCharges}
                </button>
              </form>
            ) : null}
            {canCheckout && folio.body.state !== 'SETTLED' ? (
              <form action={recordPayment} className="form-grid" aria-labelledby="pay-title">
                {shiftId !== undefined ? (
                  <input type="hidden" name="shiftId" value={shiftId} />
                ) : (
                  <p className="hint span-2">{HOTEL.labels.noOpenShift}</p>
                )}
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
