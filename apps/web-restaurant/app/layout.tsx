import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@prsystem/web-kit/styles.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Restaurant — PRsystem',
  description: 'Өрөөний QR ба нэг удаагийн кодоор нэвтэрч, ресторанаас хоол захиалах.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="mn">
      <body>{children}</body>
    </html>
  );
}
