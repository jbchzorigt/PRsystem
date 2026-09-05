import { Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { EMongoliaAuthPort, KeyManagementPort, PhoneVerificationPort } from '@prsystem/ports';
import { selectEMongoliaAuth, selectKeyManagement, selectPhoneVerification } from '@prsystem/ports';
import type { GuestAccountsPort } from '../iam/contracts/guest-accounts.port';
import { GUEST_ACCOUNTS } from '../iam/iam.tokens';
import { GuestController } from './http/guest.controller';
import { GuestRegistrationService } from './services/registration.service';
import { GuestEMongoliaService } from './services/emongolia.service';
import type { GuestDependencies, GuestParameters } from './services/guest-context';
import { GUEST_EMONGOLIA, GUEST_OTP, GUEST_PARAMETERS_TOKEN, GUEST_POOL } from './guest.tokens';

/**
 * The Guest realm: registration, sign-in and identity linking (Phase 12).
 *
 * It owns the four `guest_*` tables and nothing else. The account kernel it
 * needs — `user_account`, `account_credential`, `server_session` — belongs to
 * Phase 04 and is reached through `GuestAccountsPort`, so the two modules stay
 * one-way and there is exactly one place that issues a session (CLAUDE.md §3).
 *
 * Both external channels are ports with deterministic simulators: the phone
 * one-time code (INT-OTP-01) and e-Mongolia (EXT-02). Outside local, CI and
 * test both select the fail-closed adapter, and e-Mongolia answering `DISABLED`
 * is why doc 09 §6.1 keeps phone registration as the fallback.
 */
export interface GuestModuleConfig {
  readonly databaseUrl: string;
  /** Chooses the simulator or the fail-closed adapter (ADR-0020 §7). */
  readonly appEnv: string;
  readonly kmsAdapter: string;
  readonly kmsSeed?: string;
}

export interface GuestModuleOptions {
  readonly config?: GuestModuleConfig;
  readonly iam?: DynamicModule;
  readonly pool?: Pool;
  readonly keys?: KeyManagementPort;
  readonly accounts?: GuestAccountsPort;
  readonly otp?: PhoneVerificationPort;
  readonly emongolia?: EMongoliaAuthPort;
  readonly parameters?: GuestParameters;
  /** Tests only: the server's now. Production reads the transaction's time. */
  readonly clock?: () => Date;
}

class GuestLifecycle implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly owned: boolean,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.owned) await this.pool.end().catch(() => undefined);
  }
}

@Module({})
export class GuestModule {
  static forRoot(options: GuestModuleOptions): DynamicModule {
    const pool =
      options.pool ??
      new Pool({
        connectionString:
          options.config?.databaseUrl ??
          (() => {
            throw new Error('GuestModule needs either a configuration or a pool');
          })(),
        max: 10,
      });
    const ownsPool = options.pool === undefined;
    const appEnv = options.config?.appEnv ?? 'production';
    // Selected here rather than imported from the IAM module, exactly as the
    // stay module does: the selector is the one place that decides between the
    // local simulator and the fail-closed adapter (ADR-0020 §7).
    const keys =
      options.keys ??
      selectKeyManagement({
        appEnv,
        kmsAdapter: options.config?.kmsAdapter ?? 'unset',
        ...(options.config?.kmsSeed === undefined ? {} : { seed: options.config.kmsSeed }),
      });
    const otp = options.otp ?? selectPhoneVerification(appEnv);
    const emongolia = options.emongolia ?? selectEMongoliaAuth(appEnv);
    const parameters = options.parameters;
    const clock = options.clock;

    const deps = (accounts: GuestAccountsPort): GuestDependencies => ({
      pool,
      keys,
      accounts,
      otp,
      emongolia,
      ...(parameters === undefined ? {} : { parameters }),
      ...(clock === undefined ? {} : { clock }),
    });
    const inject = [GUEST_ACCOUNTS];

    return {
      module: GuestModule,
      imports: [...(options.iam === undefined ? [] : [options.iam])],
      controllers: [GuestController],
      providers: [
        { provide: GUEST_POOL, useValue: pool },
        { provide: GUEST_OTP, useValue: otp },
        { provide: GUEST_EMONGOLIA, useValue: emongolia },
        { provide: GUEST_PARAMETERS_TOKEN, useValue: parameters ?? null },
        { provide: GuestLifecycle, useValue: new GuestLifecycle(pool, ownsPool) },
        {
          provide: GuestRegistrationService,
          useFactory: (accounts: GuestAccountsPort) => new GuestRegistrationService(deps(accounts)),
          inject,
        },
        {
          provide: GuestEMongoliaService,
          useFactory: (accounts: GuestAccountsPort) => new GuestEMongoliaService(deps(accounts)),
          inject,
        },
      ],
      exports: [
        GuestRegistrationService,
        GuestEMongoliaService,
        GUEST_POOL,
        GUEST_OTP,
        GUEST_EMONGOLIA,
      ],
    };
  }
}
