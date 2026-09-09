import type { ReactNode } from 'react';
import { Shell } from '@prsystem/web-kit';
import { signOut } from '../app/actions';
import { GUEST } from './copy';
import { sessionToken } from './portal';

/** The Guest frame: search is public; bookings and sign-out appear with a session. */
export async function GuestShell({
  current,
  children,
}: {
  readonly current?: string;
  readonly children: ReactNode;
}) {
  const token = await sessionToken();
  const nav = [
    { href: '/', label: GUEST.home, current: current === 'home' },
    ...(token === undefined
      ? [{ href: '/sign-in', label: GUEST.auth.signIn, current: current === 'sign-in' }]
      : [{ href: '/bookings', label: GUEST.bookings.title, current: current === 'bookings' }]),
  ];
  const user =
    token === undefined ? undefined : (
      <form action={signOut} className="inline">
        <button className="button button-secondary" type="submit">
          {GUEST.auth.signOut}
        </button>
      </form>
    );
  return (
    <Shell brand={GUEST.brand} portal={GUEST.portal} nav={nav} user={user}>
      {children}
    </Shell>
  );
}
