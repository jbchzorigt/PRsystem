import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Hotel Operations — PRsystem',
  description: 'Reception, housekeeping, management and hotel administration.',
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
