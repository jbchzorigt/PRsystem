import { Banner, Field, errorText } from '@prsystem/web-kit';
import { outcomeOf } from '@prsystem/web-kit/server';
import { RESTAURANT } from '../lib/copy';
import { sessionToken } from '../lib/portal';
import { RestaurantShell } from '../lib/shell';
import { openSession } from './actions';
import { redirect } from 'next/navigation';

/** The QR's landing: the room token is in the URL the QR carries; the code is typed. */
export default async function EnterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const outcome = outcomeOf(query);
  if ((await sessionToken()) !== undefined) redirect('/menu');
  const roomToken = typeof query['token'] === 'string' ? query['token'] : '';
  return (
    <RestaurantShell>
      <h1>{RESTAURANT.enter.title}</h1>
      <p>{'Realm: Hotel (restaurant)'}</p>
      {outcome.error !== undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      <form action={openSession}>
        <Field id="roomToken" label={RESTAURANT.enter.roomToken}>
          <input
            id="roomToken"
            name="roomToken"
            required
            defaultValue={roomToken}
            autoComplete="off"
          />
        </Field>
        <Field id="code" label={RESTAURANT.enter.code} hint={RESTAURANT.enter.hint}>
          <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" required />
        </Field>
        <div className="actions">
          <button className="button" type="submit">
            {RESTAURANT.enter.submit}
          </button>
        </div>
      </form>
    </RestaurantShell>
  );
}
