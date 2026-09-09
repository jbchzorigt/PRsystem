import { Banner, Field, errorText } from '@prsystem/web-kit';
import { outcomeOf } from '@prsystem/web-kit/server';
import { GUEST } from '../../lib/copy';
import { GuestShell } from '../../lib/shell';
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
    <GuestShell current="sign-in">
      <h1>{GUEST.auth.signInTitle}</h1>
      <p>{'Realm: Guest'}</p>
      {outcome.error !== undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      <form action={signIn}>
        {next !== undefined ? <input type="hidden" name="next" value={next} /> : null}
        <Field id="phone" label={GUEST.auth.phone}>
          <input id="phone" name="phone" type="tel" autoComplete="tel" inputMode="tel" required />
        </Field>
        <Field id="password" label={GUEST.auth.password}>
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
            {GUEST.auth.signIn}
          </button>
          <a
            className="button button-secondary"
            href={`/register${next === undefined ? '' : `?next=${encodeURIComponent(next)}`}`}
          >
            {GUEST.auth.register}
          </a>
        </div>
      </form>
      <p>{GUEST.auth.orRegister}</p>
      <p className="hint">{GUEST.auth.emongoliaClosed}</p>
    </GuestShell>
  );
}
