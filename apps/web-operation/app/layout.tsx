import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@prsystem/web-kit/styles.css';

// Every page is rendered per request from the session's cookie; nothing is
// prerendered at build time, because nothing here is the same for two people.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Operation Dashboard — PRsystem',
  description: 'Subscription, onboarding queue, reconciliation, SMS сануулга.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="mn">
      <body>{children}</body>
    </html>
  );
}
