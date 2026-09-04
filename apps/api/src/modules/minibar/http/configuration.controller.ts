import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import {
  body,
  idempotencyKey,
  optionalUuid,
  requireString,
  requireUuid,
} from '../../iam/http/validation';
import { optionalString, requireRevision } from '../../catalog/http/catalog-validation';
import { ConfigurationService } from '../services/configuration.service';
import type { ChangeView, ConfigurationView } from '../services/configuration.service';
import { newMinibarRequest } from '../services/minibar-context';
import { requireChangeKind } from './minibar-validation';

/**
 * A room's minibar configuration and its pending change (doc 26 §§14–23, §33;
 * doc 22 §§6–8). Reception reads; the Manager requests, cancels, resolves and
 * opens short; a Rollout of one room is a change of kind `VERSION_ROLLOUT`
 * under `rollout_single`.
 */
@ApiTags('minibar-configuration')
@Controller('hotels/:hotelId/minibar/rooms/:roomId')
export class ConfigurationController {
  constructor(
    @Inject(ConfigurationService) private readonly configurations: ConfigurationService,
  ) {}

  @Get('configuration')
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Current configuration, stock, pending change, task and check-in blockers',
  })
  async view(
    @Param('hotelId') hotelIdParam: string,
    @Param('roomId') roomIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConfigurationView> {
    return this.configurations.view(
      { hotelId: requireUuid(hotelIdParam, 'hotelId'), roomId: requireUuid(roomIdParam, 'roomId') },
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
  }

  @Post('configuration/changes')
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary:
      'Request a change: ON_TO_OFF, OFF_TO_ON, TEMPLATE_SWITCH (config_change_manage) or VERSION_ROLLOUT (rollout_single)',
  })
  @ApiResponse({ status: 409, description: 'PENDING_CHANGE, or INELIGIBLE with the reason' })
  @ApiResponse({ status: 503, description: 'A safe-point source could not be read' })
  async requestChange(
    @Param('hotelId') hotelIdParam: string,
    @Param('roomId') roomIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ChangeView> {
    const payload = body(request);
    const targetTemplateId = optionalUuid(payload['targetTemplateId'], 'targetTemplateId');
    const targetVersionId = optionalUuid(payload['targetVersionId'], 'targetVersionId');
    const reason = optionalString(payload['reason'], 'reason', 300);
    const created = await this.configurations.requestChange(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        roomId: requireUuid(roomIdParam, 'roomId'),
        idempotencyKey: idempotencyKey(request),
        kind: requireChangeKind(payload['kind']),
        ...(targetTemplateId === undefined ? {} : { targetTemplateId }),
        ...(targetVersionId === undefined ? {} : { targetVersionId }),
        ...(reason === undefined ? {} : { reason }),
      },
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return created;
  }

  @Post('configuration/changes/:changeId/cancel')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Cancel a change no movement has been posted for (config_change_manage)',
  })
  @ApiResponse({ status: 409, description: 'MOVEMENT_STARTED: roll back instead' })
  async cancel(
    @Param('hotelId') hotelIdParam: string,
    @Param('changeId') changeIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ChangeView> {
    return this.configurations.cancelChange(
      this.command(hotelIdParam, changeIdParam, request),
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
  }

  @Post('configuration/changes/:changeId/rollback')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Roll back a change whose movements were posted (config_resolution)' })
  async rollback(
    @Param('hotelId') hotelIdParam: string,
    @Param('changeId') changeIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ChangeView> {
    return this.configurations.requestRollback(
      this.command(hotelIdParam, changeIdParam, request),
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
  }

  @Post('configuration/changes/:changeId/resolve')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary:
      'Re-evaluate a blocked change; with applyWithOverride, apply a shortage as SHORT under an audited exception (config_resolution)',
  })
  @ApiResponse({ status: 409, description: 'VARIANCE_UNRESOLVED, EXCESS_STOCK or STOCK_SHORT' })
  async resolve(
    @Param('hotelId') hotelIdParam: string,
    @Param('changeId') changeIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ChangeView> {
    const payload = body(request);
    const override = payload['applyWithOverride'];
    return this.configurations.resolveChange(
      {
        ...this.command(hotelIdParam, changeIdParam, request),
        ...(override === undefined || override === null
          ? {}
          : {
              applyWithOverride: {
                reason: requireString(
                  (override as Record<string, unknown>)['reason'],
                  'applyWithOverride.reason',
                  300,
                ),
              },
            }),
      },
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
  }

  @Post('shortage-overrides')
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary:
      'Open a SHORT minibar for the next stay under an audited exception (shortage_override)',
  })
  async override(
    @Param('hotelId') hotelIdParam: string,
    @Param('roomId') roomIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{
    readonly overrideId: string;
    readonly roomId: string;
    readonly minibarStatus: string;
  }> {
    const payload = body(request);
    const created = await this.configurations.createOverride(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        roomId: requireUuid(roomIdParam, 'roomId'),
        idempotencyKey: idempotencyKey(request),
        reason: requireString(payload['reason'], 'reason', 300),
      },
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return created;
  }

  private command(
    hotelIdParam: string,
    changeIdParam: string,
    request: AuthenticatedRequest,
  ): {
    hotelId: string;
    changeId: string;
    idempotencyKey: string;
    expectedRevision: number;
    reason?: string;
  } {
    const payload = body(request);
    const reason = optionalString(payload['reason'], 'reason', 300);
    return {
      hotelId: requireUuid(hotelIdParam, 'hotelId'),
      changeId: requireUuid(changeIdParam, 'changeId'),
      idempotencyKey: idempotencyKey(request),
      expectedRevision: requireRevision(payload['expectedRevision']),
      ...(reason === undefined ? {} : { reason }),
    };
  }
}
