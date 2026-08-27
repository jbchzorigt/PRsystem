import { Module } from '@nestjs/common';
import { env } from '@prsystem/config';
import { HealthController } from './health.controller';
import { ReadinessService } from './readiness.service';
import { PostgresProbe, RedisProbe } from './probes';
import type { DependencyProbe } from './health.types';

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: ReadinessService,
      useFactory: (): ReadinessService => {
        // Environment is resolved on the first probe, not while the container is
        // built: readiness must report a degraded dependency, never abort start-up
        // or the build-time OpenAPI generation.
        const probes: DependencyProbe[] = [
          PostgresProbe.deferred(() => env().DATABASE_URL),
          RedisProbe.deferred(() => env().REDIS_URL),
        ];
        return new ReadinessService(probes);
      },
    },
  ],
})
export class HealthModule {}
