import { Banner, COMMON, Field, Pager, Table, errorText, formatDateTime } from '@prsystem/web-kit';
import { OPS } from '../../lib/copy';
import { api, requireSession, stepUpIfRequired } from '../../lib/portal';
import { OpsShell } from '../../lib/shell';

interface Row {
  readonly applicationId: string;
  readonly state: string;
  readonly queueGroup: string;
  readonly hotelName: string;
  readonly ownerType: string;
  readonly district: string;
  readonly packageCode: string;
  readonly termMonths: number;
  readonly emailMasked: string;
  readonly createdAt: string;
  readonly stateChangedAt: string | null;
  readonly provisionAttempts: number;
}
interface Page {
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly items: readonly Row[];
}

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, name: string) =>
  typeof q[name] === 'string' && q[name] !== '' ? (q[name] as string) : undefined;

/** doc 14 §3.4 / OPS-DEC-013: applications that are not hotels yet, in their two groups. */
export default async function OnboardingPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const group = one(query, 'group');
  const offset = one(query, 'offset') ?? '0';
  const self = `/onboarding?${new URLSearchParams({ ...(group === undefined ? {} : { group }), offset }).toString()}`;
  const { token, session } = await requireSession(self);
  const answer = await api().call<Page>('/operation/onboarding/queue', {
    token,
    query: { ...(group === undefined ? {} : { group }), offset, limit: '25' },
  });
  stepUpIfRequired(answer, self);
  const c = OPS.onboarding.columns;
  return (
    <OpsShell session={session} current="onboarding">
      <h1>{OPS.onboarding.title}</h1>
      <form method="get" className="form-grid">
        <Field id="group" label={OPS.onboarding.group}>
          <select id="group" name="group" defaultValue={group ?? ''}>
            <option value="">{OPS.list.any}</option>
            <option value="UNPAID">{OPS.onboarding.UNPAID}</option>
            <option value="INACTIVE">{OPS.onboarding.INACTIVE}</option>
          </select>
        </Field>
        <button className="button" type="submit">
          {COMMON.search}
        </button>
      </form>
      {!answer.ok ? (
        <Banner tone="danger">{errorText(answer.code, answer.message)}</Banner>
      ) : (
        <>
          <Table<Row>
            caption={OPS.onboarding.title}
            rows={answer.body.items}
            rowKey={(r) => r.applicationId}
            empty={COMMON.nothingHere}
            columns={[
              { key: 'name', header: c.hotelName, cell: (r) => r.hotelName },
              {
                key: 'state',
                header: c.state,
                cell: (r) =>
                  `${r.state} (${r.queueGroup === 'INACTIVE' ? OPS.onboarding.INACTIVE : OPS.onboarding.UNPAID})`,
              },
              {
                key: 'owner',
                header: c.ownerType,
                cell: (r) => OPS.list.ownerTypes[r.ownerType] ?? r.ownerType,
              },
              { key: 'district', header: c.district, cell: (r) => r.district },
              { key: 'package', header: c.package, cell: (r) => r.packageCode },
              { key: 'term', header: c.termMonths, cell: (r) => String(r.termMonths) },
              { key: 'email', header: c.emailMasked, cell: (r) => r.emailMasked },
              { key: 'created', header: c.createdAt, cell: (r) => formatDateTime(r.createdAt) },
              { key: 'attempts', header: c.attempts, cell: (r) => String(r.provisionAttempts) },
            ]}
          />
          <Pager
            total={answer.body.total}
            limit={answer.body.limit}
            offset={answer.body.offset}
            href={(next) =>
              `/onboarding?${new URLSearchParams({ ...(group === undefined ? {} : { group }), offset: String(next) }).toString()}`
            }
          />
        </>
      )}
    </OpsShell>
  );
}
