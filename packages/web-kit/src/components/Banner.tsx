import type { ReactNode } from 'react';

export type BannerTone = 'info' | 'ok' | 'warn' | 'danger';

/**
 * A status message a screen reader announces. `danger` is assertive because
 * it is the answer to something the person just did; the others are polite.
 */
export function Banner({
  tone = 'info',
  title,
  children,
}: {
  readonly tone?: BannerTone | undefined;
  readonly title?: string | undefined;
  readonly children?: ReactNode;
}) {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {title !== undefined ? <strong>{title} </strong> : null}
      {children}
    </div>
  );
}
