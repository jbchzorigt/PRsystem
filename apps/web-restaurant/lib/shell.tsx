import type { ReactNode } from 'react';
import { Shell } from '@prsystem/web-kit';
import { signOut } from '../app/actions';
import { RESTAURANT } from './copy';
import { sessionToken } from './portal';

export async function RestaurantShell({
  current,
  children,
}: {
  readonly current?: string;
  readonly children: ReactNode;
}) {
  const token = await sessionToken();
  const nav =
    token === undefined
      ? []
      : [
          { href: '/menu', label: RESTAURANT.menu.title, current: current === 'menu' },
          { href: '/orders', label: RESTAURANT.orders.title, current: current === 'orders' },
        ];
  const user =
    token === undefined ? undefined : (
      <form action={signOut} className="inline">
        <button className="button button-secondary" type="submit">
          {RESTAURANT.signOut}
        </button>
      </form>
    );
  return (
    <Shell brand={RESTAURANT.brand} portal={RESTAURANT.portal} nav={nav} user={user}>
      {children}
    </Shell>
  );
}
