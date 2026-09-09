import { redirect } from 'next/navigation';
import { readToken } from '@prsystem/web-kit/server';
import { Shell } from '@prsystem/web-kit';
import { api, runtime } from '../lib/portal';
import type { SessionView } from '../lib/portal';
import { HOTEL } from '../lib/copy';

/**
 * The portal's front door. A signed-in person goes to their hotel; with more
 * than one membership they choose. Nobody is asked to choose a hotel the API
 * did not list for them.
 */
export default async function Page() {
  const token = await readToken(runtime());
  if (token === undefined) redirect('/sign-in');
  const answer = await api().call<SessionView>('/auth/session', { token });
  if (!answer.ok) redirect('/sign-in');
  const active = answer.body.memberships.filter((m) => m.state === 'ACTIVE');
  if (active.length === 1 && active[0] !== undefined) redirect(`/hotels/${active[0].hotelId}`);
  return (
    <Shell brand={HOTEL.brand} portal={HOTEL.portal}>
      <h1>{HOTEL.chooseHotel}</h1>
      {active.length === 0 ? (
        <p>{'Идэвхтэй буудлын эрх байхгүй байна.'}</p>
      ) : (
        <ul className="card-list">
          {active.map((m) => (
            <li className="card" key={m.membershipId}>
              <h3>
                <a href={`/hotels/${m.hotelId}`}>{m.hotelId}</a>
              </h3>
              <p>{m.roles.join(', ')}</p>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
