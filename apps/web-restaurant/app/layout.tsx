import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Restaurant — PRsystem',
  description: 'Menu and order management for a linked restaurant.',
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
