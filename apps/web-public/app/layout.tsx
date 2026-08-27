import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Public and Guest — PRsystem',
  description: 'Hotel search, booking and guest self-service.',
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
