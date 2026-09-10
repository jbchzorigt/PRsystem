import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { portalSecurityHeaders } from '@prsystem/web-kit/next-headers';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The monorepo root, so file tracing does not guess at a lockfile elsewhere.
  outputFileTracingRoot: resolve(here, '../..'),
  // Phase 22: the same security headers on every portal (GATE-SEC).
  headers: portalSecurityHeaders,
  reactStrictMode: true,
  poweredByHeader: false,
  // The shared kit is TypeScript source; Next compiles it with the app.
  transpilePackages: ['@prsystem/web-kit', '@prsystem/contracts'],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  // Business rules never live in a portal (CLAUDE.md §3): every page asks the
  // API and renders its answer, so nothing here is safe to cache across people.
  experimental: { serverActions: { bodySizeLimit: '1mb' } },
};

export default nextConfig;
