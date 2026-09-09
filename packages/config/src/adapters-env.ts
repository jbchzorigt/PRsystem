import { z } from 'zod';
import {
  ADAPTER_SLOTS,
  AdapterSelectionError,
  Secret,
  defaultAdapterModes,
  isNonProductionEnv,
  parseCidrList,
  selectAdapters,
} from '@prsystem/ports';
import type { AdapterMode, AdapterSelection, AdapterSlot, Cidr } from '@prsystem/ports';

/**
 * Per-environment adapter configuration (Phase 20; CLAUDE.md §9;
 * docs/implementation/external-integration-gates.md).
 *
 * One variable per adapter slot names what the deployment runs: `simulator`,
 * `disabled`, or a production adapter by name. Absent, a slot is the
 * simulator below production and `disabled` at and above it — so a production
 * deployment that configures nothing holds nothing, and a developer machine
 * that configures nothing works.
 *
 * The rules that make a value acceptable live in `@prsystem/ports`
 * (`selectAdapters`) and are applied here at parse time, so a production
 * environment naming a simulator or an uncleared adapter is reported as a
 * configuration error before a port is bound — the same moment the scheduler
 * and Police credentials are checked. The storage credential is wrapped in a
 * `Secret` as it is parsed and the raw variable is not returned.
 */

const adapterName = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, 'must be simulator, disabled or an adapter name')
  .optional();

/** The variable that configures each slot. */
export const ADAPTER_VARIABLES: Readonly<Record<AdapterSlot, string>> = {
  'payment.qpay': 'ADAPTER_PAYMENT_QPAY',
  'payment.khaan': 'ADAPTER_PAYMENT_KHAAN',
  ebarimt: 'ADAPTER_EBARIMT',
  xyp: 'ADAPTER_XYP',
  emongolia: 'ADAPTER_EMONGOLIA',
  sms: 'ADAPTER_SMS',
  geo: 'ADAPTER_GEO',
  payout: 'ADAPTER_PAYOUT',
  email: 'ADAPTER_EMAIL',
  otp: 'ADAPTER_OTP',
  storage: 'ADAPTER_STORAGE',
};

const nonEmpty = z.string().min(1);

export const adapterEnvSchema = z.object({
  ADAPTER_PAYMENT_QPAY: adapterName,
  ADAPTER_PAYMENT_KHAAN: adapterName,
  ADAPTER_EBARIMT: adapterName,
  ADAPTER_XYP: adapterName,
  ADAPTER_EMONGOLIA: adapterName,
  ADAPTER_SMS: adapterName,
  ADAPTER_GEO: adapterName,
  ADAPTER_PAYOUT: adapterName,
  ADAPTER_EMAIL: adapterName,
  ADAPTER_OTP: adapterName,
  ADAPTER_STORAGE: adapterName,

  /** Required exactly when `ADAPTER_STORAGE=s3`; refused otherwise (the secret). */
  OBJECT_STORAGE_ENDPOINT: nonEmpty.optional(),
  OBJECT_STORAGE_REGION: nonEmpty.optional(),
  OBJECT_STORAGE_BUCKET: nonEmpty.optional(),
  OBJECT_STORAGE_ACCESS_KEY_ID: nonEmpty.optional(),
  OBJECT_STORAGE_SECRET_ACCESS_KEY: nonEmpty.optional(),
});

export type AdapterEnv = z.infer<typeof adapterEnvSchema>;

/** The raw variables folded into `adapters` and not returned on the environment. */
export const ADAPTER_RAW_KEYS = [
  'ADAPTER_PAYMENT_QPAY',
  'ADAPTER_PAYMENT_KHAAN',
  'ADAPTER_EBARIMT',
  'ADAPTER_XYP',
  'ADAPTER_EMONGOLIA',
  'ADAPTER_SMS',
  'ADAPTER_GEO',
  'ADAPTER_PAYOUT',
  'ADAPTER_EMAIL',
  'ADAPTER_OTP',
  'ADAPTER_STORAGE',
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_REGION',
  'OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_ACCESS_KEY_ID',
  'OBJECT_STORAGE_SECRET_ACCESS_KEY',
] as const;

const S3_KEYS = [
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_ACCESS_KEY_ID',
  'OBJECT_STORAGE_SECRET_ACCESS_KEY',
] as const;

/** The modes a parsed environment names, with the environment's defaults filled in. */
export function adapterModes(appEnv: string, raw: AdapterEnv): Record<AdapterSlot, AdapterMode> {
  const modes = defaultAdapterModes(appEnv);
  for (const slot of ADAPTER_SLOTS) {
    const value = raw[ADAPTER_VARIABLES[slot] as keyof AdapterEnv];
    if (value !== undefined) modes[slot] = value;
  }
  return modes;
}

/**
 * Validates the adapter configuration and adds issues for what is wrong.
 *
 * Runs inside the schema's `superRefine`, so every problem is reported together
 * with the rest of the environment's, under the variable that carries it.
 */
export function refineAdapters(raw: AdapterEnv, appEnv: string, ctx: z.RefinementCtx): void {
  const modes = adapterModes(appEnv, raw);
  const storageIsS3 = modes.storage === 's3';

  if (storageIsS3) {
    for (const key of S3_KEYS) {
      if (raw[key] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when ADAPTER_STORAGE=s3`,
        });
      }
    }
  } else if (raw.OBJECT_STORAGE_SECRET_ACCESS_KEY !== undefined) {
    // A storage credential in a deployment whose storage adapter cannot use it
    // is a live secret nobody is accounting for — the scheduler rule, again.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OBJECT_STORAGE_SECRET_ACCESS_KEY'],
      message:
        `OBJECT_STORAGE_SECRET_ACCESS_KEY is set while ADAPTER_STORAGE is ${modes.storage}; ` +
        'remove the credential or set ADAPTER_STORAGE=s3',
    });
  }

  // The selection rules themselves — simulator only below production, a
  // production adapter only behind a cleared gate, no adapter that does not
  // exist — applied once, by the module that owns them.
  try {
    selectAdapters({
      appEnv,
      slots: modes,
      ...(storageIsS3 && raw.OBJECT_STORAGE_SECRET_ACCESS_KEY !== undefined
        ? {
            storage: {
              endpoint: raw.OBJECT_STORAGE_ENDPOINT ?? '',
              region: raw.OBJECT_STORAGE_REGION ?? 'us-east-1',
              bucket: raw.OBJECT_STORAGE_BUCKET ?? '',
              accessKeyId: raw.OBJECT_STORAGE_ACCESS_KEY_ID ?? '',
              secretAccessKey: new Secret(raw.OBJECT_STORAGE_SECRET_ACCESS_KEY),
            },
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof AdapterSelectionError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [ADAPTER_VARIABLES[error.slot]],
        message: error.message,
      });
    } else if (storageIsS3 && raw.OBJECT_STORAGE_SECRET_ACCESS_KEY !== undefined) {
      // The S3 adapter refused its endpoint or bucket. Its message names the
      // rule and never the value.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OBJECT_STORAGE_ENDPOINT'],
        message: error instanceof Error ? error.message : 'the storage configuration is not valid',
      });
    }
  }
}

/** The selection a validated environment names. Only called after `refineAdapters` passed. */
export function resolveAdapters(appEnv: string, raw: AdapterEnv): AdapterSelection {
  const modes = adapterModes(appEnv, raw);
  if (modes.storage !== 's3') return { appEnv, slots: modes };
  return {
    appEnv,
    slots: modes,
    storage: {
      endpoint: raw.OBJECT_STORAGE_ENDPOINT as string,
      region: raw.OBJECT_STORAGE_REGION ?? 'us-east-1',
      bucket: raw.OBJECT_STORAGE_BUCKET as string,
      accessKeyId: raw.OBJECT_STORAGE_ACCESS_KEY_ID as string,
      secretAccessKey: new Secret(raw.OBJECT_STORAGE_SECRET_ACCESS_KEY as string),
    },
  };
}

/**
 * Provider callback source allowlists (build plan Phase 20).
 *
 * One CIDR list per payment provider. What the list does with a request is the
 * API's decision (`CallbackSourceGuard`); what this does is refuse a list that
 * is not a list of ranges, so a typo cannot become "allow everything" or
 * "allow nothing" by accident.
 */
export const callbackAllowlistSchema = z.object({
  CALLBACK_ALLOWLIST_QPAY: z.string().optional(),
  CALLBACK_ALLOWLIST_KHAAN: z.string().optional(),
});

export type CallbackAllowlistEnv = z.infer<typeof callbackAllowlistSchema>;

export interface CallbackAllowlists {
  readonly QPAY?: readonly Cidr[];
  readonly KHAAN?: readonly Cidr[];
}

export function refineCallbackAllowlists(raw: CallbackAllowlistEnv, ctx: z.RefinementCtx): void {
  for (const key of ['CALLBACK_ALLOWLIST_QPAY', 'CALLBACK_ALLOWLIST_KHAAN'] as const) {
    const value = raw[key];
    if (value !== undefined && parseCidrList(value) === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} must be a comma-separated list of IPv4 or IPv6 CIDR ranges`,
      });
    }
  }
}

export function resolveCallbackAllowlists(raw: CallbackAllowlistEnv): CallbackAllowlists {
  const qpay = raw.CALLBACK_ALLOWLIST_QPAY;
  const khaan = raw.CALLBACK_ALLOWLIST_KHAAN;
  return {
    ...(qpay === undefined ? {} : { QPAY: parseCidrList(qpay) ?? [] }),
    ...(khaan === undefined ? {} : { KHAAN: parseCidrList(khaan) ?? [] }),
  };
}

export { isNonProductionEnv };
