import { isNonProductionEnv } from '../port';
import type { EBarimtPort } from '../ebarimt.port';
import { SimulatedEBarimt, UnavailableEBarimt } from '../ebarimt.port';
import type { EMongoliaAuthPort } from '../emongolia-auth.port';
import { SimulatedEMongoliaAuth, UnavailableEMongoliaAuth } from '../emongolia-auth.port';
import type { GeoPort } from '../geo.port';
import { SimulatedGeo, UnavailableGeo } from '../geo.port';
import type { HotelPayoutPort } from '../hotel-payout.port';
import { SimulatedHotelPayout, UnavailableHotelPayout } from '../hotel-payout.port';
import type { XypIdentityPort } from '../identity-verification.port';
import { SimulatedXypIdentity, UnavailableXypIdentity } from '../identity-verification.port';
import type { NotificationPort } from '../notification.port';
import { SimulatedStaffNotification, UnavailableStaffNotification } from '../notification.port';
import type { ObjectStoragePort } from '../object-storage.port';
import { SimulatedObjectStorage, UnavailableObjectStorage } from '../object-storage.port';
import type { PaymentGatewayPort, PaymentProvider } from '../payment-gateway.port';
import {
  PaymentGatewayRegistry,
  SimulatedPaymentGateway,
  UnavailablePaymentGateway,
} from '../payment-gateway.port';
import type { PhoneVerificationPort } from '../phone-verification.port';
import {
  SimulatedPhoneVerification,
  UnavailablePhoneVerification,
} from '../phone-verification.port';
import type { SmsPort } from '../sms.port';
import { SimulatedSms, UnavailableSms } from '../sms.port';
import type { AdapterSlot, GateId } from '../gates';
import { ADAPTER_SLOTS, GATE_REGISTER, gateForSlot, isGateCleared } from '../gates';
import { FetchOutboundHttp } from './outbound-http';
import type { OutboundHttp } from './outbound-http';
import type { Secret } from './secret';
import { S3ObjectStorage } from './s3/s3-object-storage';

/**
 * Selects every external adapter for one deployment, and refuses to degrade
 * (Phase 20; CLAUDE.md §9; the same rule `selectKeyManagement` applies).
 *
 * A slot is configured to one of three things:
 *
 *  - `simulator` — the deterministic simulator. Reachable in local, CI and test
 *    and nowhere else; naming it in production is a refused startup, not a
 *    warning.
 *  - `disabled` — the fail-closed adapter, which answers `DISABLED` with its
 *    gate and makes no network call. The production default for every slot.
 *  - the name of a production adapter — permitted in production **only** when
 *    the slot's gate is `CLEARED` in the register. In local, CI and test a
 *    production adapter may run against a local stand-in (MinIO for S3), which
 *    is how it is tested at all; the gates are production release gates and
 *    block nothing in development.
 *
 * A production adapter that does not exist cannot be named — `unknown_adapter`
 * — and one that exists cannot run without its configuration —
 * `missing_configuration`. Every refusal names the slot and, where there is
 * one, the gate, and none of them carries a configuration value.
 */

export type AdapterMode = 'simulator' | 'disabled' | (string & {});

export type AdapterSelectionReason =
  'simulator_not_permitted' | 'gate_not_cleared' | 'unknown_adapter' | 'missing_configuration';

export class AdapterSelectionError extends Error {
  override readonly name = 'AdapterSelectionError';

  constructor(
    message: string,
    readonly slot: AdapterSlot,
    readonly reason: AdapterSelectionReason,
    readonly gate: GateId,
  ) {
    super(message);
  }
}

/** What `storage=s3` needs. The credential is a `Secret` from the moment it is parsed. */
export interface S3StorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: Secret;
  /** Test seam; production builds the fetch-backed client with a 10 s ceiling. */
  readonly http?: OutboundHttp;
}

export interface AdapterSelection {
  readonly appEnv: string;
  readonly slots: Readonly<Record<AdapterSlot, AdapterMode>>;
  readonly storage?: S3StorageConfig;
}

export interface AdapterDescription {
  readonly slot: AdapterSlot;
  readonly gate: GateId;
  readonly cleared: boolean;
  readonly mode: 'simulator' | 'disabled' | 'adapter';
  readonly adapter?: string;
}

export interface SelectedAdapters {
  readonly payments: PaymentGatewayRegistry;
  readonly ebarimt: EBarimtPort;
  readonly xyp: XypIdentityPort;
  readonly emongolia: EMongoliaAuthPort;
  readonly sms: SmsPort;
  readonly geo: GeoPort;
  readonly payouts: HotelPayoutPort;
  readonly notifications: NotificationPort;
  readonly otp: PhoneVerificationPort;
  readonly storage: ObjectStoragePort;
  /** One line per slot, safe to log: no endpoint, no credential. */
  describe(): readonly AdapterDescription[];
}

/** The production adapters that exist, per slot. Everything else is contract-bound. */
export const PRODUCTION_ADAPTERS: Readonly<Record<AdapterSlot, readonly string[]>> = {
  'payment.qpay': [],
  'payment.khaan': [],
  ebarimt: [],
  xyp: [],
  emongolia: [],
  sms: [],
  geo: [],
  payout: [],
  email: [],
  otp: [],
  storage: ['s3'],
};

export const S3_OUTBOUND_TIMEOUT_MS = 10_000;

/** The modes a deployment gets when it names none: simulators below production, nothing above it. */
export function defaultAdapterModes(appEnv: string): Record<AdapterSlot, AdapterMode> {
  const mode: AdapterMode = isNonProductionEnv(appEnv) ? 'simulator' : 'disabled';
  return Object.fromEntries(ADAPTER_SLOTS.map((slot) => [slot, mode])) as Record<
    AdapterSlot,
    AdapterMode
  >;
}

type Resolved = 'simulator' | 'disabled' | { adapter: string };

function resolve(selection: AdapterSelection, slot: AdapterSlot): Resolved {
  const mode = selection.slots[slot];
  const gate = gateForSlot(slot);
  const nonProduction = isNonProductionEnv(selection.appEnv);
  if (mode === 'simulator') {
    if (!nonProduction) {
      throw new AdapterSelectionError(
        `${slot}: the simulator is not permitted outside local, ci or test`,
        slot,
        'simulator_not_permitted',
        gate,
      );
    }
    return 'simulator';
  }
  if (mode === 'disabled') return 'disabled';
  if (!PRODUCTION_ADAPTERS[slot].includes(mode)) {
    throw new AdapterSelectionError(
      `${slot}: no production adapter named "${mode}" exists; ${gate} (${GATE_REGISTER[gate].system}) ` +
        'has no approved contract to implement one against',
      slot,
      'unknown_adapter',
      gate,
    );
  }
  if (!nonProduction && !isGateCleared(gate)) {
    throw new AdapterSelectionError(
      `${slot}: the production adapter "${mode}" cannot be enabled while ${gate} ` +
        `(${GATE_REGISTER[gate].system}) is not cleared`,
      slot,
      'gate_not_cleared',
      gate,
    );
  }
  return { adapter: mode };
}

function gateway(resolved: Resolved, provider: PaymentProvider): PaymentGatewayPort {
  return resolved === 'simulator'
    ? new SimulatedPaymentGateway(provider)
    : new UnavailablePaymentGateway(provider);
}

function storage(selection: AdapterSelection, resolved: Resolved): ObjectStoragePort {
  if (resolved === 'simulator') return new SimulatedObjectStorage();
  if (resolved === 'disabled') return new UnavailableObjectStorage();
  const config = selection.storage;
  if (config === undefined) {
    throw new AdapterSelectionError(
      'storage: the s3 adapter needs an endpoint, a region, a bucket and a credential',
      'storage',
      'missing_configuration',
      'INT-STORAGE-01',
    );
  }
  return new S3ObjectStorage({
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    http: config.http ?? new FetchOutboundHttp({ timeoutMs: S3_OUTBOUND_TIMEOUT_MS }),
  });
}

export function selectAdapters(selection: AdapterSelection): SelectedAdapters {
  // Every slot is resolved before any adapter is built, so a refused startup
  // has constructed nothing and holds nothing.
  const resolved = Object.fromEntries(
    ADAPTER_SLOTS.map((slot) => [slot, resolve(selection, slot)]),
  ) as Record<AdapterSlot, Resolved>;

  const describe = (): readonly AdapterDescription[] =>
    ADAPTER_SLOTS.map((slot) => {
      const gate = gateForSlot(slot);
      const one = resolved[slot];
      return {
        slot,
        gate,
        cleared: isGateCleared(gate),
        mode: one === 'simulator' ? 'simulator' : one === 'disabled' ? 'disabled' : 'adapter',
        ...(typeof one === 'object' ? { adapter: one.adapter } : {}),
      };
    });

  return {
    payments: new PaymentGatewayRegistry(
      new Map<PaymentProvider, PaymentGatewayPort>([
        ['QPAY', gateway(resolved['payment.qpay'], 'QPAY')],
        ['KHAAN', gateway(resolved['payment.khaan'], 'KHAAN')],
      ]),
    ),
    ebarimt: resolved.ebarimt === 'simulator' ? new SimulatedEBarimt() : new UnavailableEBarimt(),
    xyp: resolved.xyp === 'simulator' ? new SimulatedXypIdentity() : new UnavailableXypIdentity(),
    emongolia:
      resolved.emongolia === 'simulator'
        ? new SimulatedEMongoliaAuth()
        : new UnavailableEMongoliaAuth(),
    sms: resolved.sms === 'simulator' ? new SimulatedSms() : new UnavailableSms(),
    geo: resolved.geo === 'simulator' ? new SimulatedGeo() : new UnavailableGeo(),
    payouts:
      resolved.payout === 'simulator' ? new SimulatedHotelPayout() : new UnavailableHotelPayout(),
    // The Phase 04 names: the accepted callers were written against them, and
    // a test that asks `instanceof SimulatedStaffNotification` is asking the
    // right question.
    notifications:
      resolved.email === 'simulator'
        ? new SimulatedStaffNotification()
        : new UnavailableStaffNotification(),
    otp:
      resolved.otp === 'simulator'
        ? new SimulatedPhoneVerification()
        : new UnavailablePhoneVerification(),
    storage: storage(selection, resolved.storage),
    describe,
  };
}
