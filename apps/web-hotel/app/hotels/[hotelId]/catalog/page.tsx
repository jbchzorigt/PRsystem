import { COMMON, KeyValue, Table, errorText, formatMnt } from '@prsystem/web-kit';
import { HOTEL } from '../../../../lib/copy';
import { hotelContext, lockedScreen } from '../../../../lib/hotel-context';

/** Тариф ба өрөө (doc 05 §2, doc 26): the catalog and the effective tariffs, read as the API answers them. */
export default async function CatalogPage({ params }: { params: Promise<{ hotelId: string }> }) {
  const { hotelId } = await params;
  const ctx = await hotelContext(hotelId, `/hotels/${hotelId}/catalog`);
  const locked = lockedScreen(ctx);
  if (locked !== undefined) return locked;
  const catalog = await ctx.client.call<Record<string, unknown>>(`/hotels/${hotelId}/catalog`, {
    token: ctx.token,
  });
  const tariffs = await ctx.client.call<Record<string, unknown>>(
    `/hotels/${hotelId}/tariffs/effective`,
    { token: ctx.token },
  );
  const rooms =
    catalog.ok && Array.isArray(catalog.body['rooms'])
      ? (catalog.body['rooms'] as Record<string, unknown>[])
      : [];
  const categories =
    catalog.ok && Array.isArray(catalog.body['categories'])
      ? (catalog.body['categories'] as Record<string, unknown>[])
      : [];
  return (
    <>
      <h1>{HOTEL.tabs.catalog}</h1>
      {!catalog.ok ? <p role="status">{errorText(catalog.code, catalog.message)}</p> : null}
      <h2>{HOTEL.labels.category}</h2>
      <Table
        caption={HOTEL.labels.category}
        columns={[
          {
            key: 'name',
            header: HOTEL.labels.name,
            cell: (r: Record<string, unknown>) => String(r['name'] ?? ''),
          },
          {
            key: 'state',
            header: COMMON.state,
            cell: (r: Record<string, unknown>) => String(r['lifecycleState'] ?? r['state'] ?? ''),
          },
        ]}
        rows={categories}
        rowKey={(r) => String(r['categoryId'] ?? r['name'])}
        empty={COMMON.nothingHere}
      />
      <h2>{HOTEL.labels.room}</h2>
      <Table
        caption={HOTEL.labels.room}
        columns={[
          {
            key: 'number',
            header: HOTEL.labels.room,
            cell: (r: Record<string, unknown>) => String(r['roomNumber'] ?? ''),
          },
          {
            key: 'floor',
            header: HOTEL.labels.floor,
            cell: (r: Record<string, unknown>) => String(r['floor'] ?? '—'),
          },
          {
            key: 'state',
            header: COMMON.state,
            cell: (r: Record<string, unknown>) => String(r['lifecycleState'] ?? r['state'] ?? ''),
          },
        ]}
        rows={rooms}
        rowKey={(r) => String(r['roomId'] ?? r['roomNumber'])}
        empty={COMMON.nothingHere}
      />
      <h2>{'Хүчинтэй тариф'}</h2>
      {!tariffs.ok ? (
        <p role="status">{errorText(tariffs.code, tariffs.message)}</p>
      ) : (
        <KeyValue
          items={Object.entries(tariffs.body)
            .filter(([, value]) => typeof value !== 'object' || value === null)
            .map(
              ([key, value]) =>
                [key, /Mnt$/.test(key) ? formatMnt(String(value)) : String(value ?? '—')] as const,
            )}
        />
      )}
    </>
  );
}
