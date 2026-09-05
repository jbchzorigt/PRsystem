import type { Port, PortContext, PortMode, PortResult } from './port';
import { fail, isNonProductionEnv, ok } from './port';

/**
 * `EXT-06` — `GeoPort` (doc 09 §4;
 * docs/architecture/16-external-port-catalog.md §1;
 * docs/implementation/external-integration-gates.md).
 *
 * Coordinates cross this boundary as integer micro-degrees, the way
 * `hotel_profile` stores them (CLAUDE.md §5: no floating point where a value is
 * persisted or compared).
 *
 * **Geocoding is gated; distance is not.** `geocode` and `reverseGeocode` need
 * Google Maps, so the production adapter answers `DISABLED` until EXT-06
 * clears. `distance` is a great-circle calculation over coordinates the
 * platform already holds; it reaches no provider, and it is available on both
 * paths. That distinction is deliberate: doc 09 §4 requires distance and
 * ordering to be computed *server-side* and a client-supplied distance never to
 * be trusted, and answering `DISABLED` for arithmetic would push the
 * calculation to the only other place it could go — the client. Recorded as an
 * assumption for the phase.
 *
 * The port neither stores nor logs a position. An unauthenticated searcher's
 * consented position is an argument to a query and nothing else (doc 09 §4).
 */

export interface GeoPoint {
  /** Degrees × 1e6, integer, −90e6 … 90e6. */
  readonly latitudeMicro: number;
  /** Degrees × 1e6, integer, −180e6 … 180e6. */
  readonly longitudeMicro: number;
}

export interface GeoAddress {
  readonly formattedAddress: string;
  readonly point: GeoPoint;
}

export type GeocodeAnswer =
  { readonly found: true; readonly address: GeoAddress } | { readonly found: false };

export interface GeoDistance {
  /** Great-circle distance, whole metres. */
  readonly metres: number;
}

export type GeoCommand =
  | { readonly kind: 'geocode'; readonly address: string }
  | { readonly kind: 'reverseGeocode'; readonly point: GeoPoint }
  | { readonly kind: 'distance'; readonly from: GeoPoint; readonly to: GeoPoint };

export type GeoAnswer = GeocodeAnswer | GeoDistance;

export interface GeoPort extends Port<GeoCommand, GeoAnswer> {
  geocode(address: string, ctx: PortContext): Promise<PortResult<GeocodeAnswer>>;
  reverseGeocode(point: GeoPoint, ctx: PortContext): Promise<PortResult<GeocodeAnswer>>;
  /** Server-side, provider-free, and available on every path. */
  distance(from: GeoPoint, to: GeoPoint): GeoDistance;
}

const EARTH_RADIUS_M = 6_371_008.8;
const MICRO = 1_000_000;

export function isGeoPoint(point: GeoPoint): boolean {
  return (
    Number.isInteger(point.latitudeMicro) &&
    Number.isInteger(point.longitudeMicro) &&
    point.latitudeMicro >= -90 * MICRO &&
    point.latitudeMicro <= 90 * MICRO &&
    point.longitudeMicro >= -180 * MICRO &&
    point.longitudeMicro <= 180 * MICRO
  );
}

/**
 * Haversine over micro-degrees, rounded to whole metres so two callers agree
 * exactly and an ordering never depends on a float's last bit.
 */
export function greatCircleMetres(from: GeoPoint, to: GeoPoint): number {
  const toRad = (micro: number): number => (micro / MICRO) * (Math.PI / 180);
  const lat1 = toRad(from.latitudeMicro);
  const lat2 = toRad(to.latitudeMicro);
  const dLat = lat2 - lat1;
  const dLon = toRad(to.longitudeMicro) - toRad(from.longitudeMicro);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a))));
}

/** The production path until EXT-06 clears: geocoding `DISABLED`, distance real. */
export class UnavailableGeo implements GeoPort {
  readonly id = 'geo';
  readonly mode: PortMode = 'adapter';

  geocode(_address: string, _ctx: PortContext): Promise<PortResult<GeocodeAnswer>> {
    return Promise.resolve(fail({ kind: 'DISABLED', gate: 'EXT-06' }));
  }

  reverseGeocode(_point: GeoPoint, _ctx: PortContext): Promise<PortResult<GeocodeAnswer>> {
    return Promise.resolve(fail({ kind: 'DISABLED', gate: 'EXT-06' }));
  }

  distance(from: GeoPoint, to: GeoPoint): GeoDistance {
    return { metres: greatCircleMetres(from, to) };
  }

  execute(command: GeoCommand, ctx: PortContext): Promise<PortResult<GeoAnswer>> {
    if (command.kind === 'geocode') return this.geocode(command.address, ctx);
    if (command.kind === 'reverseGeocode') return this.reverseGeocode(command.point, ctx);
    return Promise.resolve(ok(this.distance(command.from, command.to)));
  }
}

/** A deterministic simulator: it knows only the addresses a test teaches it. */
export class SimulatedGeo implements GeoPort {
  readonly id = 'geo';
  readonly mode: PortMode = 'simulator';

  private readonly addresses = new Map<string, GeoAddress>();
  private outages = 0;
  private timeouts = 0;

  /** Teaches the simulator one synthetic address. */
  register(query: string, address: GeoAddress): void {
    this.addresses.set(query.trim().toLowerCase(), address);
  }

  /** Arms the next `times` provider calls to answer UNAVAILABLE. */
  failNext(times = 1): void {
    this.outages += times;
  }

  /** Arms the next `times` provider calls to answer TIMEOUT. */
  timeoutNext(times = 1): void {
    this.timeouts += times;
  }

  private outage(): PortResult<GeocodeAnswer> | undefined {
    if (this.outages > 0) {
      this.outages -= 1;
      return fail({ kind: 'UNAVAILABLE', retryable: true });
    }
    if (this.timeouts > 0) {
      this.timeouts -= 1;
      return fail({ kind: 'TIMEOUT', retryable: true });
    }
    return undefined;
  }

  geocode(address: string, _ctx?: PortContext): Promise<PortResult<GeocodeAnswer>> {
    const outage = this.outage();
    if (outage !== undefined) return Promise.resolve(outage);
    const found = this.addresses.get(address.trim().toLowerCase());
    return Promise.resolve(
      ok(found === undefined ? { found: false } : { found: true, address: found }),
    );
  }

  reverseGeocode(point: GeoPoint, _ctx?: PortContext): Promise<PortResult<GeocodeAnswer>> {
    const outage = this.outage();
    if (outage !== undefined) return Promise.resolve(outage);
    for (const address of this.addresses.values()) {
      if (
        address.point.latitudeMicro === point.latitudeMicro &&
        address.point.longitudeMicro === point.longitudeMicro
      ) {
        return Promise.resolve(ok({ found: true, address }));
      }
    }
    return Promise.resolve(ok({ found: false }));
  }

  distance(from: GeoPoint, to: GeoPoint): GeoDistance {
    return { metres: greatCircleMetres(from, to) };
  }

  execute(command: GeoCommand, ctx?: PortContext): Promise<PortResult<GeoAnswer>> {
    if (command.kind === 'geocode') return this.geocode(command.address, ctx);
    if (command.kind === 'reverseGeocode') return this.reverseGeocode(command.point, ctx);
    return Promise.resolve(ok(this.distance(command.from, command.to)));
  }
}

export function selectGeo(appEnv: string): GeoPort {
  return isNonProductionEnv(appEnv) ? new SimulatedGeo() : new UnavailableGeo();
}
