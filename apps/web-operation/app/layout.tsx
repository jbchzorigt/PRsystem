import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Platform Operation — PRsystem',
  description: 'Subscriptions, reminders and reconciliation.',
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
