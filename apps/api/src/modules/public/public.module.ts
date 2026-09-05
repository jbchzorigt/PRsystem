import { Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { GeoPort } from '@prsystem/ports';
import { selectGeo } from '@prsystem/ports';
import type { CategoryHoldsPort } from './contracts/category-holds';
import { UnprovisionedCategoryHolds } from './contracts/category-holds';
import { PublicController } from './http/public.controller';
import { PublicSearchService } from './services/search.service';
import { PUBLIC_CATEGORY_HOLDS, PUBLIC_GEO, PUBLIC_POOL } from './public.tokens';

/**
 * Public discovery (Phase 12): unauthenticated hotel search and detail.
 *
 * It owns no table. What it reads it reads through the listing projection
 * migration `0013` defines, which is the only path across tenants and is a
 * reviewed SQL boundary rather than an application filter (doc 09 §5).
 *
 * The confirmed bookings it will eventually subtract belong to Phase 13, and
 * arrive through `CategoryHoldsPort`. The default answers "nothing is
 * held" and refuses to keep answering once `platform.booking` exists.
 */
export interface PublicModuleConfig {
  readonly databaseUrl: string;
  readonly appEnv: string;
}

export interface PublicModuleOptions {
  readonly config?: PublicModuleConfig;
  readonly pool?: Pool;
  readonly geo?: GeoPort;
  readonly bookings?: CategoryHoldsPort;
}

class PublicLifecycle implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly owned: boolean,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.owned) await this.pool.end().catch(() => undefined);
  }
}

@Module({})
export class PublicModule {
  static forRoot(options: PublicModuleOptions): DynamicModule {
    const pool =
      options.pool ??
      new Pool({
        connectionString:
          options.config?.databaseUrl ??
          (() => {
            throw new Error('PublicModule needs either a configuration or a pool');
          })(),
        max: 10,
      });
    const ownsPool = options.pool === undefined;
    const geo = options.geo ?? selectGeo(options.config?.appEnv ?? 'production');
    const bookings = options.bookings ?? new UnprovisionedCategoryHolds();

    return {
      module: PublicModule,
      controllers: [PublicController],
      providers: [
        { provide: PUBLIC_POOL, useValue: pool },
        { provide: PUBLIC_GEO, useValue: geo },
        { provide: PUBLIC_CATEGORY_HOLDS, useValue: bookings },
        { provide: PublicLifecycle, useValue: new PublicLifecycle(pool, ownsPool) },
        {
          provide: PublicSearchService,
          useValue: new PublicSearchService({ pool, geo, bookings }),
        },
      ],
      exports: [PublicSearchService, PUBLIC_POOL, PUBLIC_GEO],
    };
  }
}
