import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { ReadinessService } from './readiness.service';
import type { LivenessReport, ReadinessReport } from './health.types';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@Inject(ReadinessService) private readonly readiness: ReadinessService) {}

  /**
   * Liveness: is the process running? Deliberately has no dependency checks, so a
   * database outage never causes the orchestrator to restart a healthy process.
   */
  @Get('live')
  @ApiOperation({ summary: 'Process liveness' })
  @ApiOkResponse({ description: 'Process is alive' })
  live(): LivenessReport {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  /**
   * Readiness: can this instance serve traffic? Fails closed — any unreachable
   * dependency yields 503 so the instance is removed from rotation.
   */
  @Get('ready')
  @ApiOperation({ summary: 'Dependency readiness' })
  @ApiOkResponse({ description: 'All dependencies reachable' })
  @ApiResponse({ status: 503, description: 'At least one dependency is unreachable' })
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    reply.status(report.status === 'ok' ? 200 : 503);
    return report;
  }
}
