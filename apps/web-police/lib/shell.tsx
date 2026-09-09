import type { ReactNode } from 'react';
import { COMMON, Shell } from '@prsystem/web-kit';
import { signOut } from '../app/actions';
import { POLICE } from './copy';
import { can, type PoliceSession } from './portal';

/** The Police frame: the tabs the API said this account may reach (doc 13 §4). */
export function PoliceShell({
  session,
  current,
  children,
}: {
  readonly session: PoliceSession;
  readonly current?: string;
  readonly children: ReactNode;
}) {
  const nav = [
    { href: '/', label: POLICE.nav.dashboard, current: current === 'dashboard' },
    ...(can(session, 'police.exact_identifier_search')
      ? [{ href: '/matches', label: POLICE.nav.matches, current: current === 'matches' }]
      : []),
    ...(can(session, 'police.all_hotel_checkin_list')
      ? [{ href: '/check-ins', label: POLICE.nav.checkIns, current: current === 'check-ins' }]
      : []),
    ...(can(session, 'police.wanted_case_draft_create')
      ? [{ href: '/wanted/new', label: POLICE.nav.wanted, current: current === 'wanted' }]
      : []),
    ...(can(session, 'police.wanted_case_export')
      ? [{ href: '/exports', label: POLICE.nav.exports, current: current === 'exports' }]
      : []),
  ];
  const user = (
    <span className="user">
      {COMMON.signedInAs}: {session.realmRole ?? POLICE.portal}{' '}
      <form action={signOut} className="inline">
        <button className="button button-secondary" type="submit">
          {COMMON.signOut}
        </button>
      </form>
    </span>
  );
  return (
    <Shell brand={POLICE.brand} portal={POLICE.portal} nav={nav} user={user}>
      {children}
    </Shell>
  );
}
