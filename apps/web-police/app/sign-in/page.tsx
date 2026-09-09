import { Banner, COMMON, Field, Shell, errorText } from '@prsystem/web-kit';
import { outcomeOf } from '@prsystem/web-kit/server';
import { POLICE } from '../../lib/copy';
import { signIn } from '../actions';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const outcome = outcomeOf(query);
  const next = typeof query['next'] === 'string' ? query['next'] : undefined;
  return (
    <Shell brand={POLICE.brand} portal={POLICE.portal}>
      <h1>{POLICE.signInTitle}</h1>
      <p>{POLICE.realm}</p>
      {outcome.error !== undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      <form action={signIn}>
        {next !== undefined ? <input type="hidden" name="next" value={next} /> : null}
        <Field id="email" label={COMMON.email}>
          <input id="email" name="email" type="email" autoComplete="username" required />
        </Field>
        <Field id="password" label={COMMON.password}>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        <button className="button" type="submit">
          {COMMON.signIn}
        </button>
      </form>
    </Shell>
  );
}
