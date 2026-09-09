import type { ReactNode } from 'react';
import { COMMON } from '../copy';

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly current?: boolean;
}

export interface ShellProps {
  readonly brand: string;
  readonly portal: string;
  readonly nav?: readonly NavItem[];
  /** What the header says about who is signed in; nothing when nobody is. */
  readonly user?: ReactNode;
  readonly children: ReactNode;
}

/**
 * The page frame every portal shares: a skip link, a landmark header with the
 * navigation the *server* decided to render, and the main landmark the skip
 * link targets. Hiding a link is never authorization (CLAUDE.md §4); the API
 * decides, and this only shows what it was told the session may reach.
 */
export function Shell({ brand, portal, nav, user, children }: ShellProps) {
  return (
    <>
      <a className="skip-link" href="#main">
        {COMMON.skipToContent}
      </a>
      <header className="shell-header">
        <p className="brand">
          {brand}
          <small>{portal}</small>
        </p>
        {nav !== undefined && nav.length > 0 ? (
          <nav className="shell-nav" aria-label={portal}>
            <ul>
              {nav.map((item) => (
                <li key={item.href}>
                  <a href={item.href} aria-current={item.current === true ? 'page' : undefined}>
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        {user !== undefined ? <div className="shell-user">{user}</div> : null}
      </header>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
