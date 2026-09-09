import { Badge, Banner, Field, KeyValue, errorText, formatDateTime } from '@prsystem/web-kit';
import { IDEMPOTENCY_FIELD, newIdempotencyKey, outcomeOf } from '@prsystem/web-kit/server';
import { POLICE } from '../../../lib/copy';
import { api, can, requireSession } from '../../../lib/portal';
import { PoliceShell } from '../../../lib/shell';
import { acknowledge, falseMatch, found } from './actions';

interface MatchView {
  readonly matchId: string;
  readonly workflowState: string;
  readonly outcome: string;
  readonly hotelName: string;
  readonly hotelDistrict: string;
  readonly hotelAddressLine: string;
  readonly roomNumber: string;
  readonly detectedAt: string;
  readonly checkInRecordedAt: string;
  readonly actualCheckInAt: string;
  readonly firstAcknowledgedByAccountId: string | null;
  readonly firstAcknowledgedAt: string | null;
  readonly falseMatchReviewPending: boolean;
  readonly linkedCaseIds: readonly string[];
  readonly revision: number;
}

const OK_COPY: Readonly<Record<string, string>> = {
  acknowledged: 'Хүлээн авсан гэж бүртгэлээ.',
  found: 'Олдсон гэж баталгаажлаа.',
  'false-match': 'Худал Match хүсэлт бүртгэгдлээ; хоёр дахь хүн шийдвэрлэнэ.',
};

/** doc 13 §9: one Match, its two separate fields, and the three commands. */
export default async function MatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ matchId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { matchId } = await params;
  const outcome = outcomeOf(await searchParams);
  const { token, session } = await requireSession(`/matches/${matchId}`);
  const answer = await api().call<MatchView>(`/police/matches/${matchId}`, { token });
  if (!answer.ok) {
    return (
      <PoliceShell session={session} current="matches">
        <h1>{POLICE.match.title}</h1>
        <p role="alert">{errorText(answer.code, answer.message)}</p>
      </PoliceShell>
    );
  }
  const match = answer.body;
  const key = newIdempotencyKey();
  const open = match.workflowState !== 'RESOLVED';
  const hidden = (suffix: string) => (
    <>
      <input type="hidden" name={IDEMPOTENCY_FIELD} value={`${key}-${suffix}`} />
      <input type="hidden" name="matchId" value={match.matchId} />
      <input type="hidden" name="expectedRevision" value={String(match.revision)} />
    </>
  );
  return (
    <PoliceShell session={session} current="matches">
      <h1>
        {POLICE.match.title} {match.matchId}
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
            POLICE.match.workflow,
            <Badge key="w" tone={open ? 'warn' : 'plain'}>
              {POLICE.workflow[match.workflowState] ?? match.workflowState}
            </Badge>,
          ],
          [
            POLICE.match.outcome,
            <Badge
              key="o"
              tone={
                match.outcome === 'FOUND'
                  ? 'ok'
                  : match.outcome === 'FALSE_MATCH'
                    ? 'danger'
                    : 'plain'
              }
            >
              {POLICE.outcome[match.outcome] ?? match.outcome}
            </Badge>,
          ],
          [POLICE.match.hotel, match.hotelName],
          [POLICE.match.district, match.hotelDistrict],
          [POLICE.match.address, match.hotelAddressLine],
          [POLICE.match.room, match.roomNumber],
          [POLICE.match.detectedAt, formatDateTime(match.detectedAt)],
          [POLICE.match.checkInRecordedAt, formatDateTime(match.checkInRecordedAt)],
          [POLICE.match.actualCheckInAt, formatDateTime(match.actualCheckInAt)],
          [
            POLICE.match.firstAcknowledged,
            match.firstAcknowledgedAt === null
              ? POLICE.match.nobodyYet
              : `${formatDateTime(match.firstAcknowledgedAt)} · ${match.firstAcknowledgedByAccountId ?? ''}`,
          ],
          [POLICE.match.cases, match.linkedCaseIds.join(', ') || '—'],
          [POLICE.match.revision, String(match.revision)],
        ]}
      />
      {match.falseMatchReviewPending ? (
        <Banner tone="warn">{POLICE.match.pendingReview}</Banner>
      ) : null}
      {open && can(session, 'police.match_acknowledge') ? (
        <section aria-labelledby="ack-title">
          <h2 id="ack-title">{POLICE.match.acknowledge}</h2>
          <p className="hint">{POLICE.match.acknowledgeHint}</p>
          <form action={acknowledge}>
            {hidden('ack')}
            <button className="button" type="submit">
              {POLICE.match.acknowledge}
            </button>
          </form>
        </section>
      ) : null}
      {open && can(session, 'police.found_confirm') ? (
        <section aria-labelledby="found-title">
          <h2 id="found-title">{POLICE.match.foundTitle}</h2>
          <p className="hint">{POLICE.match.foundHint}</p>
          <form action={found}>
            {hidden('found')}
            <fieldset>
              <legend>{POLICE.match.locationKind}</legend>
              <label>
                <input type="radio" name="locationKind" value="AT_MATCH_HOTEL" defaultChecked />{' '}
                {POLICE.match.atMatchHotel}
              </label>
              <label>
                <input type="radio" name="locationKind" value="OTHER_LOCATION" />{' '}
                {POLICE.match.otherLocation}
              </label>
            </fieldset>
            <Field
              id="locationNote"
              label={POLICE.match.locationNote}
              error={
                outcome.field === 'locationNote' && outcome.error !== undefined
                  ? errorText(outcome.error, outcome.message)
                  : undefined
              }
            >
              <input id="locationNote" name="locationNote" type="text" maxLength={300} />
            </Field>
            <Field id="taskReference" label={POLICE.match.taskReference}>
              <input id="taskReference" name="taskReference" type="text" maxLength={100} />
            </Field>
            <Field id="note" label={POLICE.match.note}>
              <input id="note" name="note" type="text" maxLength={500} />
            </Field>
            <button className="button" type="submit">
              {POLICE.match.found}
            </button>
          </form>
        </section>
      ) : null}
      {open && can(session, 'police.false_match_request') ? (
        <section aria-labelledby="false-title">
          <h2 id="false-title">{POLICE.match.falseMatch}</h2>
          <p className="hint">{POLICE.match.falseMatchHint}</p>
          <form action={falseMatch}>
            {hidden('false')}
            <Field id="reasonCode" label={POLICE.match.reasonCode}>
              <select id="reasonCode" name="reasonCode" defaultValue="WRONG_NUMBER_ENTERED">
                {Object.entries(POLICE.falseMatchReasons).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              id="reasonNote"
              label={POLICE.match.reasonNote}
              error={
                outcome.field === 'reasonNote' && outcome.error !== undefined
                  ? errorText(outcome.error, outcome.message)
                  : undefined
              }
            >
              <textarea
                id="reasonNote"
                name="reasonNote"
                minLength={10}
                maxLength={500}
                required
                rows={3}
              />
            </Field>
            <button className="button button-danger" type="submit">
              {POLICE.match.falseMatch}
            </button>
          </form>
        </section>
      ) : null}
    </PoliceShell>
  );
}
