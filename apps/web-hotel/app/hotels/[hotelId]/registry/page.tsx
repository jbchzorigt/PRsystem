import { COMMON, Field, Table, errorText, formatDateTime } from '@prsystem/web-kit';
import { HOTEL } from '../../../../lib/copy';
import { hotelContext, lockedScreen, refused } from '../../../../lib/hotel-context';

/**
 * Зочдын жагсаалт (doc 12 §3–§4): a server-side query, paginated, with the
 * columns the API returns for the caller's role.
 */
export default async function RegistryPage({
  params,
  searchParams,
}: {
  params: Promise<{ hotelId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { hotelId } = await params;
  const query = await searchParams;
  const ctx = await hotelContext(hotelId, `/hotels/${hotelId}/registry`);
  const locked = lockedScreen(ctx);
  if (locked !== undefined) return locked;
  const one = (name: string): string | undefined =>
    typeof query[name] === 'string' && query[name] !== '' ? (query[name] as string) : undefined;
  const page = Number(one('page') ?? '1');
  const answer = await ctx.client.call<{
    items?: readonly Record<string, unknown>[];
    rows?: readonly Record<string, unknown>[];
    total?: number;
  }>(`/hotels/${hotelId}/registry/queries`, {
    method: 'POST',
    token: ctx.token,
    body: {
      ...(one('from') === undefined ? {} : { from: one('from') }),
      ...(one('to') === undefined ? {} : { to: one('to') }),
      ...(one('nameSearch') === undefined ? {} : { nameSearch: one('nameSearch') }),
      page,
    },
  });
  refused(answer);
  const rows = answer.ok ? (answer.body.items ?? answer.body.rows ?? []) : [];
  const columns =
    rows.length === 0
      ? []
      : Object.keys(rows[0] ?? {}).filter((key) => typeof (rows[0] ?? {})[key] !== 'object');
  return (
    <>
      <h1>{HOTEL.tabs.registry}</h1>
      <form method="get" className="form-grid" aria-label={HOTEL.actions.query}>
        <Field id="from" label={HOTEL.labels.from}>
          <input id="from" name="from" type="date" defaultValue={one('from')} />
        </Field>
        <Field id="to" label={HOTEL.labels.to}>
          <input id="to" name="to" type="date" defaultValue={one('to')} />
        </Field>
        <Field id="nameSearch" label={HOTEL.labels.name}>
          <input id="nameSearch" name="nameSearch" defaultValue={one('nameSearch')} />
        </Field>
        <div className="actions span-2">
          <button className="button button-secondary" type="submit">
            {HOTEL.actions.query}
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
        <Table
          caption={HOTEL.tabs.registry}
          columns={columns.map((key) => ({
            key,
            header: key,
            cell: (row: Record<string, unknown>) =>
              /At$/.test(key) ? formatDateTime(String(row[key] ?? '')) : String(row[key] ?? '—'),
          }))}
          rows={rows}
          rowKey={(row) => String(row['stayId'] ?? row['id'] ?? JSON.stringify(row))}
          empty={COMMON.nothingHere}
        />
      )}
    </>
  );
}
