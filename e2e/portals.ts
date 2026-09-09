/**
 * The five portals, the ports they answer on, and the identity each renders.
 *
 * Ports sit in a PRsystem-only range so an E2E run cannot collide with a dev
 * server, or with another project, already bound to 3000-3002.
 */
export interface Portal {
  readonly app: string;
  readonly port: number;
  /** The portal name the shared shell prints under the brand. */
  readonly identity: string;
  readonly realm: string;
  /** The path an anonymous visitor lands on. */
  readonly entry: string;
}

export const API_PORT = 53200;
export const CONSOLE_PORT = 53201;
export const API_URL = `http://127.0.0.1:${String(API_PORT)}`;
export const CONSOLE_URL = `http://127.0.0.1:${String(CONSOLE_PORT)}`;

export const PORTALS: readonly Portal[] = [
  { app: 'web-public', port: 53100, identity: 'Online Booking', realm: 'Guest', entry: '/' },
  {
    app: 'web-hotel',
    port: 53101,
    identity: 'Reception (RC) System',
    realm: 'Hotel',
    entry: '/sign-in',
  },
  {
    app: 'web-restaurant',
    port: 53102,
    identity: 'Restaurant',
    realm: 'Hotel (restaurant)',
    entry: '/',
  },
  { app: 'web-police', port: 53103, identity: 'Police', realm: 'Police', entry: '/sign-in' },
  {
    app: 'web-operation',
    port: 53104,
    identity: 'Operation Dashboard',
    realm: 'Operation/Platform',
    entry: '/sign-in',
  },
];

export function portalUrl(app: string): string {
  const portal = PORTALS.find((p) => p.app === app);
  if (portal === undefined) throw new Error(`unknown portal ${app}`);
  return `http://127.0.0.1:${String(portal.port)}`;
}
