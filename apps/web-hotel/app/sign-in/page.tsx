import { Banner, COMMON, Field, Shell, describedBy, errorText } from '@prsystem/web-kit';
import { outcomeOf } from '@prsystem/web-kit/server';
import { signIn } from '../actions';
import { HOTEL } from '../../lib/copy';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const outcome = outcomeOf(query);
  const next = typeof query['next'] === 'string' ? query['next'] : undefined;
  const error = outcome.error === undefined ? undefined : errorText(outcome.error, outcome.message);
  return (
    <Shell brand={HOTEL.brand} portal={HOTEL.portal}>
      <h1>{HOTEL.signInTitle}</h1>
      <p>{'Realm: Hotel'}</p>
      {error !== undefined ? <Banner tone="danger">{error}</Banner> : null}
      <form action={signIn} aria-describedby={error === undefined ? undefined : 'sign-in-error'}>
        {next !== undefined ? <input type="hidden" name="next" value={next} /> : null}
        <Field id="email" label={COMMON.email}>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            aria-describedby={describedBy('email')}
          />
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
        <div className="actions">
          <button className="button" type="submit">
            {COMMON.signIn}
          </button>
        </div>
      </form>
    </Shell>
  );
}
