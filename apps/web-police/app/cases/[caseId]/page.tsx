import { Badge, Banner, Field, KeyValue, errorText } from '@prsystem/web-kit';
import { IDEMPOTENCY_FIELD, newIdempotencyKey, outcomeOf } from '@prsystem/web-kit/server';
import { POLICE } from '../../../lib/copy';
import { can, requireSession } from '../../../lib/portal';
import { PoliceShell } from '../../../lib/shell';
import { decideIdentity, move } from './actions';

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, name: string) =>
  typeof q[name] === 'string' && q[name] !== '' ? (q[name] as string) : undefined;

const OK_COPY: Readonly<Record<string, string>> = {
  opened: 'Wanted Person бүртгэгдэж, Wanted Case DRAFT төлөвтэй үүслээ.',
  moved: 'Case төлөв өөрчлөгдлөө.',
  identity: 'Identity шийдвэр бүртгэгдлээ.',
};

/**
 * doc 13 §7: the case as the last command answered it. There is no read route
 * for one case, so the state and revision the last answer carried travel in
 * the query string; the API compares the revision on every move (CAS).
 */
export default async function CasePage({
  params,
  searchParams,
}: {
  params: Promise<{ caseId: string }>;
  searchParams: Promise<Query>;
}) {
  const { caseId } = await params;
  const query = await searchParams;
  const outcome = outcomeOf(query);
  const { session } = await requireSession(`/cases/${caseId}`);
  const state = one(query, 'state') ?? 'DRAFT';
  const revision = one(query, 'revision') ?? '1';
  const personId = one(query, 'personId');
  const revisionId = one(query, 'revisionId');
  const provenance = one(query, 'provenance');
  const approval = one(query, 'approval');
  const swept = one(query, 'swept');
  const key = newIdempotencyKey();
  const carried = (
    <>
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="currentState" value={state} />
      <input type="hidden" name="expectedRevision" value={revision} />
      {personId !== undefined ? <input type="hidden" name="personId" value={personId} /> : null}
      {revisionId !== undefined ? (
        <input type="hidden" name="revisionId" value={revisionId} />
      ) : null}
      {provenance !== undefined ? (
        <input type="hidden" name="provenance" value={provenance} />
      ) : null}
      {approval !== undefined ? <input type="hidden" name="approval" value={approval} /> : null}
    </>
  );
  return (
    <PoliceShell session={session} current="wanted">
      <h1>
        {POLICE.cases.title} {caseId}
      </h1>
      {outcome.ok !== undefined ? (
        <Banner tone="ok">{OK_COPY[outcome.ok] ?? outcome.ok}</Banner>
      ) : null}
      {outcome.error !== undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      <KeyValue
        items={[
          [
            POLICE.cases.state,
            <Badge key="s" tone={state === 'ACTIVE' ? 'ok' : 'plain'}>
              {POLICE.caseStates[state] ?? state}
            </Badge>,
          ],
          [POLICE.cases.expectedRevision, revision],
          ...(personId !== undefined ? [[POLICE.wanted.person, personId] as const] : []),
          ...(provenance !== undefined
            ? [[POLICE.wanted.title, POLICE.wanted.provenance[provenance] ?? provenance] as const]
            : []),
          ...(approval !== undefined
            ? [[POLICE.cases.identity, POLICE.wanted.approval[approval] ?? approval] as const]
            : []),
          ...(swept !== undefined ? [[POLICE.cases.swept, swept] as const] : []),
        ]}
      />
      {can(session, 'police.case_state_manage') ? (
        <section aria-labelledby="move-title">
          <h2 id="move-title">{POLICE.cases.move}</h2>
          <form action={move}>
            <input type="hidden" name={IDEMPOTENCY_FIELD} value={`${key}-move`} />
            {carried}
            <Field id="state" label={POLICE.cases.to}>
              <select
                id="state"
                name="state"
                defaultValue={state === 'DRAFT' ? 'PENDING_APPROVAL' : 'ACTIVE'}
              >
                {Object.keys(POLICE.caseStates).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="reason" label={POLICE.cases.reason}>
              <input id="reason" name="reason" type="text" minLength={5} maxLength={500} required />
            </Field>
            <button className="button" type="submit">
              {POLICE.cases.move}
            </button>
          </form>
        </section>
      ) : null}
      {personId !== undefined &&
      revisionId !== undefined &&
      approval === 'PENDING_APPROVAL' &&
      can(session, 'police.manual_identity_approve') ? (
        <section aria-labelledby="identity-title">
          <h2 id="identity-title">{POLICE.cases.identity}</h2>
          <form action={decideIdentity}>
            <input type="hidden" name={IDEMPOTENCY_FIELD} value={`${key}-identity`} />
            {carried}
            <Field id="identityReason" label={POLICE.cases.reason}>
              <input
                id="identityReason"
                name="identityReason"
                type="text"
                minLength={5}
                maxLength={500}
                required
              />
            </Field>
            <div className="actions">
              <button className="button" type="submit" name="decision" value="approve">
                {POLICE.cases.approve}
              </button>
              <button className="button button-danger" type="submit" name="decision" value="reject">
                {POLICE.cases.reject}
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </PoliceShell>
  );
}
