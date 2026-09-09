import { Banner, Field, Kpi, Table, errorText } from '@prsystem/web-kit';
import { POLICE } from '../lib/copy';
import { api, can, requireSession } from '../lib/portal';
import { PoliceShell } from '../lib/shell';

interface Counts {
  readonly activeWantedPeople: number;
  readonly activeCases: number;
  readonly matchedPeople: number;
  readonly matchEvents: number;
  readonly foundPeople: number;
  readonly falseMatches: number;
  readonly openMatches: number;
}
interface Slice {
  readonly district?: string;
  readonly category?: string;
  readonly count: number;
}
interface Charts {
  readonly foundByCategory: readonly Slice[];
  readonly matchesByHotelDistrict: readonly Slice[];
  readonly wantedByHomeDistrict: readonly Slice[];
}

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, name: string) =>
  typeof q[name] === 'string' && q[name] !== '' ? (q[name] as string) : undefined;

/** doc 13 §11: the seven counters both columns read, and the Admin's two charts. */
export default async function DashboardPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const { token, session } = await requireSession('/');
  const from = one(query, 'from');
  const to = one(query, 'to');
  const window = {
    ...(from === undefined ? {} : { from: new Date(from).toISOString() }),
    ...(to === undefined ? {} : { to: new Date(to).toISOString() }),
  };
  const client = api();
  const charts = can(session, 'police.analytics_and_access_audit');
  const [counts, chartAnswer] = await Promise.all([
    client.call<Counts>('/police/dashboard', { token, query: window }),
    charts
      ? client.call<Charts>('/police/dashboard/charts', { token, query: window })
      : Promise.resolve(undefined),
  ]);
  const sliceTable = (caption: string, rows: readonly Slice[], key: 'district' | 'category') => (
    <Table<Slice>
      caption={caption}
      rows={rows}
      rowKey={(r) => r[key] ?? POLICE.dashboard.unknownDistrict}
      empty={'—'}
      columns={[
        {
          key,
          header: key === 'district' ? POLICE.match.district : POLICE.cases.category,
          cell: (r) => r[key] ?? POLICE.dashboard.unknownDistrict,
        },
        { key: 'count', header: 'Тоо', cell: (r) => String(r.count) },
      ]}
    />
  );
  return (
    <PoliceShell session={session} current="dashboard">
      <h1>{POLICE.dashboard.title}</h1>
      <form method="get" className="form-grid" aria-label={POLICE.dashboard.window}>
        <Field id="from" label={POLICE.dashboard.from}>
          <input id="from" name="from" type="date" defaultValue={from ?? ''} />
        </Field>
        <Field id="to" label={POLICE.dashboard.to}>
          <input id="to" name="to" type="date" defaultValue={to ?? ''} />
        </Field>
        <button className="button" type="submit">
          {POLICE.checkIns.submit}
        </button>
      </form>
      {!counts.ok ? (
        <Banner tone="danger">{errorText(counts.code, counts.message)}</Banner>
      ) : (
        <div className="kpi-grid">
          <Kpi label={POLICE.dashboard.activeWantedPeople} value={counts.body.activeWantedPeople} />
          <Kpi label={POLICE.dashboard.activeCases} value={counts.body.activeCases} />
          <Kpi label={POLICE.dashboard.matchedPeople} value={counts.body.matchedPeople} />
          <Kpi label={POLICE.dashboard.matchEvents} value={counts.body.matchEvents} />
          <Kpi label={POLICE.dashboard.foundPeople} value={counts.body.foundPeople} />
          <Kpi label={POLICE.dashboard.falseMatches} value={counts.body.falseMatches} />
          <Kpi label={POLICE.dashboard.openMatches} value={counts.body.openMatches} />
        </div>
      )}
      {chartAnswer !== undefined ? (
        <section aria-labelledby="charts-title">
          <h2 id="charts-title">{POLICE.dashboard.charts}</h2>
          {!chartAnswer.ok ? (
            <Banner tone="danger">{errorText(chartAnswer.code, chartAnswer.message)}</Banner>
          ) : (
            <>
              {sliceTable(
                POLICE.dashboard.foundByCategory,
                chartAnswer.body.foundByCategory,
                'category',
              )}
              {sliceTable(
                POLICE.dashboard.matchesByHotelDistrict,
                chartAnswer.body.matchesByHotelDistrict,
                'district',
              )}
              {sliceTable(
                POLICE.dashboard.wantedByHomeDistrict,
                chartAnswer.body.wantedByHomeDistrict,
                'district',
              )}
            </>
          )}
        </section>
      ) : null}
    </PoliceShell>
  );
}
