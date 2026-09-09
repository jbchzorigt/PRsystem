import { Banner, COMMON, Field, Table, errorText, formatDateTime } from '@prsystem/web-kit';
import { IDEMPOTENCY_FIELD, newIdempotencyKey, outcomeOf } from '@prsystem/web-kit/server';
import { OPS } from '../../lib/copy';
import { api, can, requireSession, stepUpIfRequired } from '../../lib/portal';
import { OpsShell } from '../../lib/shell';
import { decide, escalate } from './actions';

interface Row {
  readonly requestId: string;
  readonly accountId: string;
  readonly state: string;
  readonly caseReference: string;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
}

export default async function RecoveryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const outcome = outcomeOf(await searchParams);
  const { token, session } = await requireSession('/recovery');
  const decider = can(session, 'operation.account_ownership_recovery_approve');
  const answer = decider
    ? await api().call<{ items: readonly Row[] }>('/operation/recovery-requests', { token })
    : undefined;
  if (answer !== undefined) stepUpIfRequired(answer, '/recovery');
  const key = newIdempotencyKey();
  const OK: Readonly<Record<string, string>> = {
    escalated: 'Recovery хүсэлт бүртгэгдэж, Platform Super Admin руу шилжлээ.',
    decided: 'Шийдвэр бүртгэгдлээ.',
  };
  const c = OPS.recovery.columns;
  return (
    <OpsShell session={session} current="recovery">
      <h1>{OPS.recovery.title}</h1>
      <p className="hint">{OPS.recovery.hint}</p>
      {outcome.ok !== undefined ? <Banner tone="ok">{OK[outcome.ok] ?? outcome.ok}</Banner> : null}
      {outcome.error !== undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      <section aria-labelledby="escalate-title">
        <h2 id="escalate-title">{OPS.recovery.escalate}</h2>
        <form action={escalate}>
          <input type="hidden" name={IDEMPOTENCY_FIELD} value={`${key}-escalate`} />
          <Field id="hotelId" label={OPS.recovery.hotelId}>
            <input id="hotelId" name="hotelId" type="text" required />
          </Field>
          <Field id="caseReference" label={OPS.recovery.caseReference}>
            <input
              id="caseReference"
              name="caseReference"
              type="text"
              minLength={3}
              maxLength={120}
              required
            />
          </Field>
          <Field
            id="note"
            label={OPS.recovery.note}
            error={
              outcome.field === 'note' && outcome.error !== undefined
                ? errorText(outcome.error, outcome.message)
                : undefined
            }
          >
            <textarea id="note" name="note" minLength={10} maxLength={1000} required rows={3} />
          </Field>
          <button className="button" type="submit">
            {OPS.recovery.escalate}
          </button>
        </form>
      </section>
      {answer !== undefined ? (
        <section aria-labelledby="pending-title">
          <h2 id="pending-title">{OPS.recovery.pending}</h2>
          {!answer.ok ? (
            <Banner tone="danger">{errorText(answer.code, answer.message)}</Banner>
          ) : (
            <Table<Row>
              caption={OPS.recovery.pending}
              rows={answer.body.items}
              rowKey={(r) => r.requestId}
              empty={COMMON.nothingHere}
              columns={[
                { key: 'id', header: c.requestId, cell: (r) => r.requestId },
                { key: 'account', header: c.account, cell: (r) => r.accountId },
                { key: 'state', header: c.state, cell: (r) => r.state },
                { key: 'case', header: c.caseReference, cell: (r) => r.caseReference },
                { key: 'at', header: c.requestedAt, cell: (r) => formatDateTime(r.requestedAt) },
                {
                  key: 'decide',
                  header: OPS.recovery.decide,
                  cell: (r) => (
                    <form action={decide} className="inline">
                      <input
                        type="hidden"
                        name={IDEMPOTENCY_FIELD}
                        value={`${key}-${r.requestId}`}
                      />
                      <input type="hidden" name="requestId" value={r.requestId} />
                      <label>
                        {OPS.recovery.decision}{' '}
                        <select name="decision" defaultValue="APPROVED">
                          <option value="APPROVED">{OPS.recovery.APPROVED}</option>
                          <option value="REFUSED">{OPS.recovery.REFUSED}</option>
                        </select>
                      </label>
                      <label>
                        {OPS.recovery.reason}{' '}
                        <input name="reason" type="text" minLength={10} maxLength={1000} required />
                      </label>
                      <button className="button" type="submit">
                        {OPS.recovery.decide}
                      </button>
                    </form>
                  ),
                },
              ]}
            />
          )}
        </section>
      ) : null}
    </OpsShell>
  );
}
