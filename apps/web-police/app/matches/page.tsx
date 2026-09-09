import { Banner, Field, errorText } from '@prsystem/web-kit';
import { outcomeOf } from '@prsystem/web-kit/server';
import { POLICE } from '../../lib/copy';
import { requireSession } from '../../lib/portal';
import { PoliceShell } from '../../lib/shell';
import { search } from './actions';

export default async function MatchesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const outcome = outcomeOf(await searchParams);
  const { session } = await requireSession('/matches');
  const error =
    outcome.error === undefined
      ? undefined
      : outcome.error === 'NOT_FOUND'
        ? POLICE.search.none
        : errorText(outcome.error, outcome.message);
  return (
    <PoliceShell session={session} current="matches">
      <h1>{POLICE.search.title}</h1>
      <p className="hint">{POLICE.search.hint}</p>
      {error !== undefined ? <Banner tone="danger">{error}</Banner> : null}
      <form action={search} autoComplete="off">
        <Field id="registrationNumber" label={POLICE.search.registrationNumber}>
          <input
            id="registrationNumber"
            name="registrationNumber"
            type="text"
            inputMode="text"
            autoComplete="off"
          />
        </Field>
        <Field id="matchId" label={POLICE.search.matchId}>
          <input id="matchId" name="matchId" type="text" autoComplete="off" />
        </Field>
        <button className="button" type="submit">
          {POLICE.search.submit}
        </button>
      </form>
    </PoliceShell>
  );
}
