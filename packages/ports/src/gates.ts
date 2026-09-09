/**
 * The external-integration gate register, as code (Phase 20;
 * docs/implementation/external-integration-gates.md §2 and §4, CLAUDE.md §9).
 *
 * Every production adapter is enabled only when the gate that governs it
 * records the named contract, credential or written approval. That rule used to
 * live in a document alone; here it is a value the adapter selector reads, so a
 * production deployment that names an adapter whose gate is still `BLOCKED`
 * refuses to start rather than starting with a provider nobody has approved.
 *
 * Three copies of the register exist and are held to one another by tests:
 *
 *  - this module, which the runtime reads;
 *  - the gate register document, which people read and Phase 23 audits;
 *  - `platform.external_gate` / `platform.internal_gate`, which Phase 03 seeds.
 *
 * Clearing a gate is therefore a code change, a document change and a migration
 * — deliberately three, because a gate cleared by editing one cell of one table
 * is the arrangement §5 of the register forbids.
 */

export const EXTERNAL_GATE_IDS = [
  'EXT-01',
  'EXT-02',
  'EXT-03',
  'EXT-04',
  'EXT-05',
  'EXT-06',
  'EXT-07',
  'EXT-08',
  'EXT-09',
  'EXT-10',
  'EXT-11',
] as const;
export type ExternalGateId = (typeof EXTERNAL_GATE_IDS)[number];

export const INTERNAL_GATE_IDS = [
  'INT-KMS-01',
  'INT-MAIL-01',
  'INT-OTP-01',
  'INT-STORAGE-01',
] as const;
export type InternalGateId = (typeof INTERNAL_GATE_IDS)[number];

export type GateId = ExternalGateId | InternalGateId;

/**
 * The adapter slots a deployment configures, one per port that reaches a
 * provider. `payment.qpay` and `payment.khaan` share one port contract and two
 * gates, so they are two slots.
 */
export const ADAPTER_SLOTS = [
  'payment.qpay',
  'payment.khaan',
  'ebarimt',
  'xyp',
  'emongolia',
  'sms',
  'geo',
  'payout',
  'email',
  'otp',
  'storage',
] as const;
export type AdapterSlot = (typeof ADAPTER_SLOTS)[number];

/**
 * A gate is `BLOCKED` with a recorded blocker, or `CLEARED` by a named
 * artefact on a named date. There is no third state, and there is no way to
 * write `CLEARED` without the artefact: the type refuses it.
 */
export type GateStatus =
  | { readonly cleared: false; readonly blocker: string }
  | { readonly cleared: true; readonly artefact: string; readonly clearedOn: string };

export interface GateEntry {
  readonly system: string;
  readonly status: GateStatus;
  /** The adapter slots this gate governs; empty for a policy-only gate. */
  readonly slots: readonly AdapterSlot[];
}

const BLOCKED = (blocker: string): GateStatus => ({ cleared: false, blocker });

/** The register. Every entry is `BLOCKED` at Phase 20. */
export const GATE_REGISTER: Readonly<Record<GateId, GateEntry>> = {
  'EXT-01': {
    system: 'XYP / ХУР',
    status: BLOCKED('no service list, field list, consent basis, contract or network access'),
    slots: ['xyp'],
  },
  'EXT-02': {
    system: 'e-Mongolia',
    status: BLOCKED('no authentication flow, field set, token lifecycle or sandbox access'),
    slots: ['emongolia'],
  },
  'EXT-03': {
    system: 'QPay',
    status: BLOCKED('no merchant contract, callback verification rule or settlement approval'),
    slots: ['payment.qpay'],
  },
  'EXT-04': {
    system: 'Khaan Bank',
    status: BLOCKED('no gateway or POS contract, callback semantics or credentials'),
    slots: ['payment.khaan'],
  },
  'EXT-05': {
    system: 'CallPro',
    status: BLOCKED('no endpoint, authentication scheme, callback signature or tariff'),
    slots: ['sms'],
  },
  'EXT-06': {
    system: 'Google Maps',
    status: BLOCKED('no API selection, billing account, key restriction or storage permission'),
    slots: ['geo'],
  },
  'EXT-07': {
    system: 'Platform central account',
    status: BLOCKED('no contract, payment-service authorization or liability allocation'),
    slots: ['payout'],
  },
  'EXT-08': {
    system: 'Personal data',
    status: BLOCKED('no written privacy notice, consent, role definition or breach procedure'),
    slots: [],
  },
  'EXT-09': {
    system: 'ЦЕГ (National Police)',
    status: BLOCKED('no written legal basis, appointment procedure or approved configuration'),
    slots: [],
  },
  'EXT-10': {
    system: 'Police security',
    status: BLOCKED('no impact assessment, DR, penetration test or written exception approval'),
    slots: [],
  },
  'EXT-11': {
    system: 'eBarimt',
    status: BLOCKED('no issuer structure, API credentials or tax authority approval'),
    slots: ['ebarimt'],
  },
  'INT-KMS-01': {
    system: 'Key management',
    status: BLOCKED('no approved production KMS'),
    slots: [],
  },
  'INT-MAIL-01': {
    system: 'Email delivery',
    status: BLOCKED('no contracted provider; delivery-status semantics and TTLs are P1-15'),
    slots: ['email'],
  },
  'INT-OTP-01': {
    system: 'Phone one-time password',
    status: BLOCKED('no contracted OTP provider; CallPro is a send contract, not an OTP service'),
    slots: ['otp'],
  },
  'INT-STORAGE-01': {
    system: 'S3-compatible object storage',
    status: BLOCKED('no production bucket, credential or retention configuration'),
    slots: ['storage'],
  },
};

export const GATE_IDS: readonly GateId[] = [...EXTERNAL_GATE_IDS, ...INTERNAL_GATE_IDS];

export function isGateId(value: string): value is GateId {
  return (GATE_IDS as readonly string[]).includes(value);
}

export function isAdapterSlot(value: string): value is AdapterSlot {
  return (ADAPTER_SLOTS as readonly string[]).includes(value);
}

/** The gate that governs a slot. Every slot has exactly one. */
export function gateForSlot(slot: AdapterSlot): GateId {
  for (const gate of GATE_IDS) {
    if (GATE_REGISTER[gate].slots.includes(slot)) return gate;
  }
  // Unreachable while the register covers every slot; the test asserts it does.
  throw new Error(`no gate governs the adapter slot ${slot}`);
}

export function isGateCleared(gate: GateId): boolean {
  return GATE_REGISTER[gate].status.cleared;
}

/** One line per gate, safe to log: no secret, no configuration value. */
export function describeGates(): readonly {
  gate: GateId;
  system: string;
  cleared: boolean;
  slots: readonly AdapterSlot[];
}[] {
  return GATE_IDS.map((gate) => ({
    gate,
    system: GATE_REGISTER[gate].system,
    cleared: GATE_REGISTER[gate].status.cleared,
    slots: GATE_REGISTER[gate].slots,
  }));
}
