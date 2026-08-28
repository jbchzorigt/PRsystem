import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { MaintenanceModule } from './maintenance/maintenance.module';

@Module({
  // MaintenanceModule owns the D-09 scheduler pool and service. It exposes no
  // controller: the capability is internal to the control plane in Phase 03.
  imports: [HealthModule, MaintenanceModule],
})
export class AppModule {}
