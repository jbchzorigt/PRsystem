/**
 * The five portal shells and the identity each one must render.
 *
 * Ports sit in a PRsystem-only range so an E2E run cannot collide with a dev
 * server, or with another project, already bound to 3000-3002.
 */
export interface PortalShell {
  readonly app: string;
  readonly port: number;
  readonly heading: string;
  readonly realm: string;
}

export const PORTAL_SHELLS: readonly PortalShell[] = [
  { app: 'web-public', port: 53100, heading: 'Public and Guest', realm: 'Guest' },
  { app: 'web-hotel', port: 53101, heading: 'Hotel Operations', realm: 'Hotel' },
  { app: 'web-restaurant', port: 53102, heading: 'Restaurant', realm: 'Hotel (restaurant)' },
  { app: 'web-police', port: 53103, heading: 'Police', realm: 'Police' },
  {
    app: 'web-operation',
    port: 53104,
    heading: 'Platform Operation',
    realm: 'Operation/Platform',
  },
];
