import { Banner, COMMON, Field, Shell, errorText } from '@prsystem/web-kit';
import { outcomeOf } from '@prsystem/web-kit/server';
import { OPS } from '../../lib/copy';
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
    <Shell brand={OPS.brand} portal={OPS.portal}>
      <h1>{OPS.signInTitle}</h1>
      <p>{OPS.realm}</p>
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
          {COMMON.signIn}
        </button>
      </form>
    </Shell>
  );
}
