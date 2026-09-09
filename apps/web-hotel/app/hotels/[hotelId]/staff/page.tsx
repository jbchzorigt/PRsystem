import { Banner, COMMON, Field, errorText } from '@prsystem/web-kit';
import { IDEMPOTENCY_FIELD, newIdempotencyKey, outcomeOf } from '@prsystem/web-kit/server';
import { HOTEL } from '../../../../lib/copy';
import { hotelContext, lockedScreen } from '../../../../lib/hotel-context';
import { invite } from './actions';

const ROLES = [
  ['RECEPTION', 'Reception'],
  ['CLEANER', 'Cleaner'],
  ['MANAGER', 'Manager'],
  ['MANAGER_PLUS', 'Manager Plus'],
  ['HOTEL_ADMIN', 'Hotel Admin'],
] as const;

/** Ажилтнууд (doc 19): the invitation a Hotel Admin sends. */
export default async function StaffPage({
  params,
  searchParams,
}: {
  params: Promise<{ hotelId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { hotelId } = await params;
  const outcome = outcomeOf(await searchParams);
  const ctx = await hotelContext(hotelId, `/hotels/${hotelId}/staff`);
  const locked = lockedScreen(ctx);
  if (locked !== undefined) return locked;
  return (
    <>
      <h1>{HOTEL.tabs.staff}</h1>
      {outcome.error !== undefined ? (
        <Banner tone="danger">{errorText(outcome.error, outcome.message)}</Banner>
      ) : null}
      {outcome.ok === 'invited' ? (
        <Banner tone="ok">{'Урилга илгээгдлээ. Холбоос зөвхөн тухайн хаяг руу очно.'}</Banner>
      ) : null}
      <form action={invite} aria-labelledby="invite-title">
        <h2 id="invite-title">{HOTEL.actions.invite}</h2>
        <input type="hidden" name="hotelId" value={hotelId} />
        <input type="hidden" name={IDEMPOTENCY_FIELD} value={newIdempotencyKey()} />
        <Field id="email" label={COMMON.email}>
          <input id="email" name="email" type="email" required autoComplete="off" />
        </Field>
        <fieldset className="field">
          <legend>{HOTEL.labels.roles}</legend>
          {ROLES.map(([value, label]) => (
            <label className="choice" key={value} htmlFor={`role-${value}`}>
              <input id={`role-${value}`} type="checkbox" name="roles" value={value} />
              {label}
            </label>
          ))}
        </fieldset>
        <div className="actions">
          <button className="button" type="submit">
            {HOTEL.actions.invite}
          </button>
        </div>
      </form>
    </>
  );
}
