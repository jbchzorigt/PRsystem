import { Badge, Banner, Field, Pager, Table, errorText, formatDateTime } from '@prsystem/web-kit';
import { POLICE } from '../../lib/copy';
import { api, requireSession } from '../../lib/portal';
import { PoliceShell } from '../../lib/shell';

interface Row {
  readonly rowNumber: number;
  readonly hotelName: string;
  readonly district: string;
  readonly familyName: string;
  readonly givenName: string;
  readonly registrationNumber: string;
  readonly roomNumber: string;
  readonly checkInAt: string;
  readonly plannedCheckoutAt: string;
  readonly stayType: string;
  readonly source: string;
  readonly stayState: string;
}
interface Page {
  readonly rows: readonly Row[];
  readonly totalRows: number;
  readonly page: number;
  readonly pageSize: number;
  readonly historical: boolean;
}

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, name: string) =>
  typeof q[name] === 'string' && q[name] !== '' ? (q[name] as string) : undefined;

/** doc 13 §4.1 / POL-DEC-010: the Police Admin's all-hotel list, twelve columns, no export. */
export default async function CheckInsPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const { token, session } = await requireSession('/check-ins');
  const from = one(query, 'from');
  const to = one(query, 'to');
  const reason = one(query, 'reason');
  const page = one(query, 'page');
  const answer = await api().call<Page>('/police/check-ins', {
    token,
    query: {
      ...(from === undefined ? {} : { from: new Date(from).toISOString() }),
      ...(to === undefined ? {} : { to: new Date(to).toISOString() }),
      ...(reason === undefined ? {} : { reason }),
      ...(page === undefined ? {} : { page }),
    },
  });
  const href = (offset: number) => {
    const params = new URLSearchParams();
    if (from !== undefined) params.set('from', from);
    if (to !== undefined) params.set('to', to);
    if (reason !== undefined) params.set('reason', reason);
    params.set('page', String(Math.floor(offset / (answer.ok ? answer.body.pageSize : 50)) + 1));
    return `/check-ins?${params.toString()}`;
  };
  const c = POLICE.checkIns.columns;
  return (
    <PoliceShell session={session} current="check-ins">
      <h1>{POLICE.checkIns.title}</h1>
      <p className="hint">{POLICE.checkIns.hint}</p>
      <form method="get" className="form-grid" aria-label={POLICE.checkIns.historical}>
        <Field id="from" label={POLICE.checkIns.from}>
          <input id="from" name="from" type="datetime-local" defaultValue={from ?? ''} />
        </Field>
        <Field id="to" label={POLICE.checkIns.to}>
          <input id="to" name="to" type="datetime-local" defaultValue={to ?? ''} />
        </Field>
        <Field id="reason" label={POLICE.checkIns.reason}>
          <input
            id="reason"
            name="reason"
            type="text"
            maxLength={300}
            defaultValue={reason ?? ''}
          />
        </Field>
        <button className="button" type="submit">
          {POLICE.checkIns.submit}
        </button>
      </form>
      {!answer.ok ? (
        <Banner tone="danger">{errorText(answer.code, answer.message)}</Banner>
      ) : (
        <>
          <p>
            <Badge tone={answer.body.historical ? 'warn' : 'ok'}>
              {answer.body.historical ? POLICE.checkIns.historical : POLICE.checkIns.active}
            </Badge>
          </p>
          <Table<Row>
            caption={POLICE.checkIns.title}
            rows={answer.body.rows}
            rowKey={(r) => String(r.rowNumber)}
            empty={'—'}
            columns={[
              { key: 'n', header: c.rowNumber, cell: (r) => String(r.rowNumber) },
              { key: 'hotel', header: c.hotelName, cell: (r) => r.hotelName },
              { key: 'district', header: c.district, cell: (r) => r.district },
              { key: 'family', header: c.familyName, cell: (r) => r.familyName },
              { key: 'given', header: c.givenName, cell: (r) => r.givenName },
              { key: 'reg', header: c.registrationNumber, cell: (r) => r.registrationNumber },
              { key: 'room', header: c.roomNumber, cell: (r) => r.roomNumber },
              { key: 'in', header: c.checkInAt, cell: (r) => formatDateTime(r.checkInAt) },
              {
                key: 'out',
                header: c.plannedCheckoutAt,
                cell: (r) => formatDateTime(r.plannedCheckoutAt),
              },
              {
                key: 'type',
                header: c.stayType,
                cell: (r) => POLICE.checkIns.stayType[r.stayType] ?? r.stayType,
              },
              {
                key: 'source',
                header: c.source,
                cell: (r) => POLICE.checkIns.source[r.source] ?? r.source,
              },
              { key: 'state', header: c.stayState, cell: (r) => r.stayState },
            ]}
          />
          <Pager
            total={answer.body.totalRows}
            limit={answer.body.pageSize}
            offset={(answer.body.page - 1) * answer.body.pageSize}
            href={href}
          />
        </>
      )}
    </PoliceShell>
  );
}
