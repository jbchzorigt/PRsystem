import { Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { SubscriptionStatePort } from '@prsystem/authz';
import { SUBSCRIPTION_STATE } from '../iam/iam.tokens';
import type { ReviewEligibilityPort } from './contracts/review-eligibility';
import { UnprovisionedReviewEligibility } from './contracts/review-eligibility';
import type { ReviewDependencies } from './services/review-context';
import { ReviewService } from './services/review.service';
import { ReviewReportService } from './services/report.service';
import { ReviewModerationService } from './services/moderation.service';
import { ReviewReplyService } from './services/reply.service';
import { ReviewController } from './http/review.controller';
import { ReviewModerationController } from './http/moderation.controller';
import { ReviewReplyController } from './http/reply.controller';
import { REVIEW_ELIGIBILITY, REVIEW_POOL } from './review.tokens';

/**
 * Verified-stay reviews, reports, moderation and the official reply (Phase 16).
 *
 * Three realms meet in one module and are kept apart by three different gates:
 * a Guest writes, edits, deletes and reports through ownership; a hotel replies
 * through a named hotel permission and its package cell; a Platform moderator
 * hides and restores through an explicitly granted `REVIEW_MODERATE` and a
 * step-up. No role name is authority anywhere in it (doc 10 §7.3).
 */
export interface ReviewModuleConfig {
  readonly databaseUrl: string;
}

export interface ReviewModuleOptions {
  readonly config?: ReviewModuleConfig;
  readonly iam?: DynamicModule;
  readonly pool?: Pool;
  readonly eligibility?: ReviewEligibilityPort;
  /** Tests only: the server's now. Production reads the transaction's time. */
  readonly clock?: () => Date;
}

class ReviewLifecycle implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly owned: boolean,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.owned) await this.pool.end().catch(() => undefined);
  }
}

@Module({})
export class ReviewModule {
  static forRoot(options: ReviewModuleOptions): DynamicModule {
    const pool =
      options.pool ??
      new Pool({
        connectionString:
          options.config?.databaseUrl ??
          (() => {
            throw new Error('ReviewModule needs either a configuration or a pool');
          })(),
        max: 10,
      });
    const ownsPool = options.pool === undefined;
    const eligibility = options.eligibility ?? new UnprovisionedReviewEligibility();
    const clock = options.clock;
    const deps = (subscription: SubscriptionStatePort): ReviewDependencies => ({
      pool,
      subscription,
      eligibility,
      ...(clock === undefined ? {} : { clock }),
    });
    const inject = [SUBSCRIPTION_STATE];

    return {
      module: ReviewModule,
      imports: [...(options.iam === undefined ? [] : [options.iam])],
      controllers: [ReviewController, ReviewModerationController, ReviewReplyController],
      providers: [
        { provide: REVIEW_POOL, useValue: pool },
        { provide: REVIEW_ELIGIBILITY, useValue: eligibility },
        { provide: ReviewLifecycle, useValue: new ReviewLifecycle(pool, ownsPool) },
        {
          provide: ReviewService,
          useFactory: (s: SubscriptionStatePort) => new ReviewService(deps(s)),
          inject,
        },
        {
          provide: ReviewReportService,
          useFactory: (s: SubscriptionStatePort) => new ReviewReportService(deps(s)),
          inject,
        },
        {
          provide: ReviewModerationService,
          useFactory: (s: SubscriptionStatePort) => new ReviewModerationService(deps(s)),
          inject,
        },
        {
          provide: ReviewReplyService,
          useFactory: (s: SubscriptionStatePort) => new ReviewReplyService(deps(s)),
          inject,
        },
      ],
      exports: [
        ReviewService,
        ReviewReportService,
        ReviewModerationService,
        ReviewReplyService,
        REVIEW_POOL,
      ],
    };
  }
}
