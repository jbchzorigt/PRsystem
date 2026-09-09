import type { ReactNode } from 'react';
import { COMMON } from '../copy';

export function Badge({
  tone = 'plain',
  children,
}: {
  readonly tone?: 'plain' | 'ok' | 'warn' | 'danger';
  readonly children: ReactNode;
}) {
  return <span className={tone === 'plain' ? 'badge' : `badge badge-${tone}`}>{children}</span>;
}

export function KeyValue({ items }: { readonly items: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="kv">
      {items.map(([term, value]) => (
        <div key={term} style={{ display: 'contents' }}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Kpi({
  label,
  value,
  href,
}: {
  readonly label: string;
  readonly value: string | number;
  readonly href?: string | undefined;
}) {
  const body = (
    <>
      <span className="kpi-value">{String(value)}</span>
      <span>{label}</span>
    </>
  );
  return <div className="kpi">{href === undefined ? body : <a href={href}>{body}</a>}</div>;
}

/** Server-side pagination controls; the page is a query parameter, never state. */
export function Pager({
  total,
  limit,
  offset,
  href,
}: {
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly href: (offset: number) => string;
}) {
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <nav className="pager" aria-label={COMMON.page}>
      {offset > 0 ? (
        <a className="button button-secondary" href={href(Math.max(0, offset - limit))}>
          {COMMON.previous}
        </a>
      ) : null}
      <span aria-current="page">
        {COMMON.page} {page} / {pages} · {COMMON.total} {total}
      </span>
      {offset + limit < total ? (
        <a className="button button-secondary" href={href(offset + limit)}>
          {COMMON.next}
        </a>
      ) : null}
    </nav>
  );
}

/** The screen a hotel sees once its subscription has hard-locked (doc 14 §4). */
export function LockScreen({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="lock-screen" aria-labelledby="lock-title">
      <h1 id="lock-title">{title}</h1>
      {children}
    </section>
  );
}
