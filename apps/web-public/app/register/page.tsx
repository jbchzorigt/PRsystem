import { Banner, Field, errorText } from '@prsystem/web-kit';
import { outcomeOf } from '@prsystem/web-kit/server';
import { GUEST } from '../../lib/copy';
import { GuestShell } from '../../lib/shell';
import { cookies } from 'next/headers';
import { register, requestCode } from '../actions';
import { REGISTER_PHONE_COOKIE } from '../../lib/portal';

/** doc 09 §6.2: number, then the six-digit code, then a password the guest chooses. */
export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const outcome = outcomeOf(query);
  const next = typeof query['next'] === 'string' ? query['next'] : undefined;
  const phone = (await cookies()).get(REGISTER_PHONE_COOKIE)?.value ?? '';
  const sent = outcome.ok === 'sent' && phone !== '';
  return (
    <GuestShell current="sign-in">
      <h1>{GUEST.auth.registerTitle}</h1>
      {outcome.error !== undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      {sent ? <Banner tone="ok">{GUEST.auth.codeSent}</Banner> : null}
      <form action={requestCode} aria-labelledby="code-title">
        <h2 id="code-title">{GUEST.auth.sendCode}</h2>
        {next !== undefined ? <input type="hidden" name="next" value={next} /> : null}
        <Field id="phone" label={GUEST.auth.phone}>
          <input
            id="phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required
            defaultValue={phone}
          />
        </Field>
        <div className="actions">
          <button className="button button-secondary" type="submit">
            {GUEST.auth.sendCode}
          </button>
        </div>
      </form>
      {sent ? (
        <form action={register} aria-labelledby="register-title">
          <h2 id="register-title">{GUEST.auth.register}</h2>
          {next !== undefined ? <input type="hidden" name="next" value={next} /> : null}
          <Field id="code" label={GUEST.auth.code}>
            <input
              id="code"
              name="code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              autoComplete="one-time-code"
              required
            />
          </Field>
          <Field id="password" label={GUEST.auth.password}>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
            />
          </Field>
          <div className="actions">
            <button className="button" type="submit">
              {GUEST.auth.register}
            </button>
          </div>
        </form>
      ) : null}
      <p>{GUEST.auth.orSignIn}</p>
    </GuestShell>
  );
}
