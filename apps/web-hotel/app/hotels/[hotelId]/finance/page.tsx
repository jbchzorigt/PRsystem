import { COMMON, KeyValue, errorText, formatMnt } from '@prsystem/web-kit';
import { HOTEL } from '../../../../lib/copy';
import { hotelContext, lockedScreen, refused } from '../../../../lib/hotel-context';

/**
 * Санхүү (doc 23 §3): the Hotel Admin's dashboard as the API computes it; the
 * portal prints figures and adds none.
 */
export default async function FinancePage({
  params,
  searchParams,
}: {
  params: Promise<{ hotelId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { hotelId } = await params;
  const query = await searchParams;
  const ctx = await hotelContext(hotelId, `/hotels/${hotelId}/finance`);
  const locked = lockedScreen(ctx);
  if (locked !== undefined) return locked;
  const from = typeof query['from'] === 'string' ? query['from'] : undefined;
  const to = typeof query['to'] === 'string' ? query['to'] : undefined;
  const answer = await ctx.client.call<Record<string, unknown>>(
    `/hotels/${hotelId}/finance/dashboard`,
    {
      token: ctx.token,
      query: { from, to },
    },
  );
  refused(answer);
  const money = (value: unknown): string =>
    typeof value === 'string' || typeof value === 'number' ? formatMnt(value) : '—';
  return (
    <>
      <h1>{HOTEL.tabs.finance}</h1>
      <form method="get" className="form-grid" aria-label={'Хугацаа'}>
        <div className="field">
          <label htmlFor="from">{HOTEL.labels.from}</label>
          <input id="from" name="from" type="date" defaultValue={from} />
        </div>
        <div className="field">
          <label htmlFor="to">{HOTEL.labels.to}</label>
          <input id="to" name="to" type="date" defaultValue={to} />
        </div>
        <div className="actions span-2">
          <button className="button button-secondary" type="submit">
            {COMMON.search}
          </button>
        </div>
      </form>
      {!answer.ok ? (
        <p role="status">
          {answer.code === 'NOT_FOUND'
            ? COMMON.notAvailable
            : errorText(answer.code, answer.message)}
        </p>
      ) : (
        <KeyValue
          items={Object.entries(answer.body)
            .filter(([, value]) => typeof value !== 'object' || value === null)
            .map(
              ([key, value]) =>
                [key, /Mnt$/.test(key) ? money(value) : String(value ?? '—')] as const,
            )}
        />
      )}
    </>
  );
}
