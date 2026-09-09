import type { ReactNode } from 'react';
import { Banner, COMMON, Shell, formatDateTime } from '@prsystem/web-kit';
import type { NavItem } from '@prsystem/web-kit';
import { signOut } from '../../actions';
import { HOTEL } from '../../../lib/copy';
import { hotelContext, isLocked } from '../../../lib/hotel-context';

/**
 * The hotel frame: navigation decided on the server from the session's
 * effective permissions, the grace-period banner, and the hard-lock screen.
 *
 * When the subscription has hard-locked, the navigation shrinks to the
 * subscription tab and every operational page renders the lock screen
 * (`lockedScreen`) instead of its content. The API refuses the operational
 * routes independently; this is the person-facing half.
 */
export default async function HotelLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ hotelId: string }>;
}) {
  const { hotelId } = await params;
  const ctx = await hotelContext(hotelId, `/hotels/${hotelId}`);
  const p = ctx.has.bind(ctx);
  const base = ctx.base;
  const tabs: NavItem[] = [];
  const add = (href: string, label: string, allowed: boolean): void => {
    if (allowed) tabs.push({ href, label });
  };
  const locked = isLocked(ctx.subscription);
  if (!locked) {
    add(`${base}/check-in`, HOTEL.tabs.guests, p('hotel.stay.check_in'));
    add(`${base}/rooms`, HOTEL.tabs.rooms, true);
    add(`${base}/billing`, HOTEL.tabs.billing, p('hotel.stay.checkout_record'));
    add(
      `${base}/restaurant`,
      HOTEL.tabs.restaurant,
      p('hotel.stay.check_in') && ctx.subscription?.effectivePackage === 'P30',
    );
    add(`${base}/cleaner`, HOTEL.tabs.cleaner, p('hotel.housekeeping.task_claim'));
    add(
      `${base}/housekeeping`,
      HOTEL.tabs.housekeeping,
      p('hotel.catalog.room_manage') && ctx.subscription?.effectivePackage === 'P20',
    );
    add(`${base}/shifts`, HOTEL.tabs.shifts, p('hotel.shift.open_close_handover'));
    add(`${base}/catalog`, HOTEL.tabs.catalog, p('hotel.tariff.config_manage'));
    add(`${base}/registry`, HOTEL.tabs.registry, p('hotel.registry.list_view'));
    add(`${base}/finance`, HOTEL.tabs.finance, p('hotel.finance.dashboard_full'));
    add(`${base}/staff`, HOTEL.tabs.staff, p('hotel.staff.invite_suspend'));
  }
  add(`${base}/subscription`, HOTEL.tabs.subscription, true);

  const state = ctx.subscription?.state;
  const user = (
    <>
      <span>
        {COMMON.signedInAs}: {ctx.membership.roles.join(', ')}
      </span>
      <form action={signOut} className="inline">
        <button className="button button-secondary" type="submit">
          {COMMON.signOut}
        </button>
      </form>
    </>
  );
  return (
    <Shell brand={HOTEL.brand} portal={HOTEL.portal} nav={tabs} user={user}>
      {state === 'GRACE' && ctx.subscription !== undefined ? (
        <Banner tone="warn" title={HOTEL.subscriptionState['GRACE']}>
          {HOTEL.grace.banner} {HOTEL.labels.graceUntil}:{' '}
          {formatDateTime(ctx.subscription.graceExpiresAt)}.
        </Banner>
      ) : null}
      {state === 'EXPIRING_SOON' && ctx.subscription !== undefined ? (
        <Banner tone="warn" title={HOTEL.subscriptionState['EXPIRING_SOON']}>
          {HOTEL.grace.expiringSoon} {HOTEL.labels.expiresAt}:{' '}
          {formatDateTime(ctx.subscription.expiresAt)}.
        </Banner>
      ) : null}
      {children}
    </Shell>
  );
}
