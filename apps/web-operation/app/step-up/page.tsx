import { Banner, Field, errorText } from '@prsystem/web-kit';
import { outcomeOf } from '@prsystem/web-kit/server';
import { OPS } from '../../lib/copy';
import { requireSession } from '../../lib/portal';
import { OpsShell } from '../../lib/shell';
import { stepUp } from '../actions';

export default async function StepUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const outcome = outcomeOf(query);
  const next = typeof query['next'] === 'string' ? query['next'] : '/';
  const { session } = await requireSession(`/step-up?next=${encodeURIComponent(next)}`);
  return (
    <OpsShell session={session}>
      <h1>{OPS.stepUpTitle}</h1>
      <p className="hint">{OPS.stepUpHint}</p>
      {outcome.error !== undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      <form action={stepUp}>
        <input type="hidden" name="next" value={next} />
        <Field id="code" label={OPS.code}>
          <input
            id="code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            required
          />
        </Field>
        <button className="button" type="submit">
          {OPS.stepUp}
        </button>
      </form>
    </OpsShell>
  );
}
