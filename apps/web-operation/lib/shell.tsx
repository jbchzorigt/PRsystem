import type { ReactNode } from 'react';
import { COMMON, Shell } from '@prsystem/web-kit';
import { signOut } from '../app/actions';
import { OPS } from './copy';
import { can, type OperationSession } from './portal';

/** The Operation frame: the tabs the API said this account may reach (doc 14 §2.4). */
export function OpsShell({
  session,
  current,
  children,
}: {
  readonly session: OperationSession;
  readonly current?: string;
  readonly children: ReactNode;
}) {
  const read = can(session, 'operation.hotel_subscription_list');
  const nav = [
    ...(read ? [{ href: '/', label: OPS.nav.dashboard, current: current === 'dashboard' }] : []),
    ...(read
      ? [
          {
            href: '/subscriptions',
            label: OPS.nav.subscriptions,
            current: current === 'subscriptions',
          },
        ]
      : []),
    ...(read
      ? [{ href: '/onboarding', label: OPS.nav.onboarding, current: current === 'onboarding' }]
      : []),
    ...(can(session, 'operation.subscription_payment_reconcile')
      ? [
          {
            href: '/reconciliations',
            label: OPS.nav.reconciliations,
            current: current === 'reconciliations',
          },
        ]
      : []),
    ...(read || can(session, 'operation.account_ownership_recovery_approve')
      ? [{ href: '/recovery', label: OPS.nav.recovery, current: current === 'recovery' }]
      : []),
    ...(can(session, 'operation.access_user_manage')
      ? [{ href: '/accounts', label: OPS.nav.accounts, current: current === 'accounts' }]
      : []),
    ...(can(session, 'operation.subscription_reminder_send')
      ? [{ href: '/sms', label: OPS.nav.sms, current: current === 'sms' }]
      : []),
  ];
  const user = (
    <span className="user">
      {COMMON.signedInAs}: {session.realmRole ?? OPS.portal}{' '}
      <form action={signOut} className="inline">
        <button className="button button-secondary" type="submit">
          {COMMON.signOut}
        </button>
      </form>
    </span>
  );
  return (
    <Shell brand={OPS.brand} portal={OPS.portal} nav={nav} user={user}>
      {children}
    </Shell>
  );
}
