import { Banner, Field, KeyValue, errorText, formatDateTime } from '@prsystem/web-kit';
import { IDEMPOTENCY_FIELD, newIdempotencyKey, outcomeOf } from '@prsystem/web-kit/server';
import { POLICE } from '../../lib/copy';
import { requireSession } from '../../lib/portal';
import { PoliceShell } from '../../lib/shell';
import { download, run } from './actions';

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, name: string) =>
  typeof q[name] === 'string' && q[name] !== '' ? (q[name] as string) : undefined;

export default async function ExportsPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const outcome = outcomeOf(query);
  const { session } = await requireSession('/exports');
  const jobId = one(query, 'jobId');
  const e = POLICE.exports;
  return (
    <PoliceShell session={session} current="exports">
      <h1>{e.title}</h1>
      <p className="hint">{e.hint}</p>
      {outcome.error !== undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      {jobId !== undefined ? (
        <section aria-labelledby="job-title">
          <h2 id="job-title">{e.job}</h2>
          <KeyValue
            items={[
              [e.job, jobId],
              ['Төлөв', one(query, 'state') ?? ''],
              [e.rows, one(query, 'rows') ?? '—'],
              [e.fullIdentifier, one(query, 'full') === 'yes' ? 'Тийм' : 'Үгүй'],
              [e.expires, formatDateTime(one(query, 'expiresAt'))],
            ]}
          />
          <form action={download}>
            <input type="hidden" name="jobId" value={jobId} />
            <button className="button" type="submit">
              {e.download}
            </button>
          </form>
        </section>
      ) : null}
      <form action={run}>
        <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
        <Field id="purpose" label={e.purpose}>
          <input id="purpose" name="purpose" type="text" minLength={10} maxLength={500} required />
        </Field>
        <Field id="taskReference" label={e.taskReference}>
          <input id="taskReference" name="taskReference" type="text" maxLength={100} required />
        </Field>
        <Field id="state" label={e.state}>
          <select id="state" name="state" defaultValue="">
            <option value="">{'Бүх төлөв'}</option>
            {Object.keys(POLICE.caseStates).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <label>
          <input type="checkbox" name="fullIdentifier" value="yes" /> {e.fullIdentifier}
        </label>
        <div className="actions">
          <button className="button" type="submit">
            {e.run}
          </button>
        </div>
      </form>
    </PoliceShell>
  );
}
