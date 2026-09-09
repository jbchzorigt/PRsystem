import {
  Badge,
  Banner,
  COMMON,
  Field,
  KeyValue,
  errorText,
  formatDateTime,
} from '@prsystem/web-kit';
import { IDEMPOTENCY_FIELD, newIdempotencyKey, outcomeOf } from '@prsystem/web-kit/server';
import { HOTEL } from '../../../../lib/copy';
import { hotelContext } from '../../../../lib/hotel-context';
import { renew } from './actions';

/**
 * The subscription (doc 14 §4, doc 17): authoritative state, dates and the
 * renewal a Hotel Admin may pay. Reachable while locked, because it is the
 * way out of the lock.
 */
export default async function SubscriptionPage({
  params,
  searchParams,
}: {
  params: Promise<{ hotelId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { hotelId } = await params;
  const outcome = outcomeOf(await searchParams);
  const ctx = await hotelContext(hotelId, `/hotels/${hotelId}/subscription`);
  const s = ctx.subscription;
  return (
    <>
      <h1>{HOTEL.tabs.subscription}</h1>
      {outcome.error !== undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      {outcome.ok === 'renewal' ? (
        <Banner tone="ok" title={'Сунгалтын нэхэмжлэл үүслээ.'}>
          {outcome.message !== undefined && outcome.message !== '' ? (
            <a href={outcome.message} rel="noreferrer">
              {'Төлбөр төлөх холбоос'}
            </a>
          ) : (
            'Төлбөрийн үйлчилгээ одоогоор нээлттэй биш байна.'
          )}
        </Banner>
      ) : null}
      {s === undefined ? (
        <p role="status">{COMMON.notAvailable}</p>
      ) : (
        <>
          <p>
            <Badge
              tone={
                s.state === 'ACTIVE'
                  ? 'ok'
                  : s.state === 'GRACE' || s.state === 'EXPIRING_SOON'
                    ? 'warn'
                    : 'danger'
              }
            >
              {HOTEL.subscriptionState[s.state] ?? s.state}
            </Badge>
          </p>
          <KeyValue
            items={[
              [HOTEL.labels.package, HOTEL.packages[s.effectivePackage] ?? s.effectivePackage],
              [HOTEL.labels.startsAt, formatDateTime(s.startsAt)],
              [HOTEL.labels.expiresAt, formatDateTime(s.expiresAt)],
              [HOTEL.labels.graceUntil, formatDateTime(s.graceExpiresAt)],
              ['Public listing', s.listingEligible ? COMMON.yes : COMMON.no],
              ...(s.pendingUpgradePackage !== null
                ? ([
                    [
                      'Хүлээгдэж буй upgrade',
                      `${HOTEL.packages[s.pendingUpgradePackage] ?? s.pendingUpgradePackage} · ${formatDateTime(s.pendingUpgradeEffectiveAt)}`,
                    ],
                  ] as const)
                : []),
            ]}
          />
          {ctx.has('hotel.subscription.pay') ? (
            <form action={renew} aria-labelledby="renew-title" className="form-grid">
              <h2 id="renew-title" className="span-2">
                {HOTEL.actions.renew}
              </h2>
              <input type="hidden" name="hotelId" value={hotelId} />
              <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
              <Field id="targetPackage" label={HOTEL.labels.package}>
                <select id="targetPackage" name="targetPackage" defaultValue={s.effectivePackage}>
                  {Object.entries(HOTEL.packages).map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="termMonths" label={HOTEL.labels.term}>
                <select id="termMonths" name="termMonths" defaultValue="1">
                  {[1, 3, 7, 12].map((months) => (
                    <option key={months} value={months}>
                      {months}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="provider" label={HOTEL.labels.provider}>
                <select id="provider" name="provider" defaultValue="QPAY">
                  <option value="QPAY">QPay</option>
                  <option value="KHAAN">Khaan Bank</option>
                </select>
              </Field>
              <div className="actions span-2">
                <button className="button" type="submit">
                  {HOTEL.actions.renew}
                </button>
              </div>
            </form>
          ) : null}
        </>
      )}
    </>
  );
}
