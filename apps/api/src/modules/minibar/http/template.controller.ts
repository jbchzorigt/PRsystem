import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, optionalUuid, requireUuid } from '../../iam/http/validation';
import { optionalString, requireRevision } from '../../catalog/http/catalog-validation';
import { newMinibarRequest } from '../services/minibar-context';
import { VersionService } from '../services/version.service';
import type { VersionView } from '../services/version.service';
import { requireTargetLines } from './minibar-validation';

/**
 * Template versions (doc 26 §§24–32). Draft and edit under `template_draft`,
 * Publish and Set default under `template_publish`, Archive under
 * `template_archive`; the list under `config_view` (Reception as `.read`).
 */
@ApiTags('minibar-templates')
@Controller('hotels/:hotelId/minibar/templates/:templateId/versions')
export class TemplateVersionController {
  constructor(@Inject(VersionService) private readonly versions: VersionService) {}

  @Get()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Every version of a template with its items' })
  async list(
    @Param('hotelId') hotelIdParam: string,
    @Param('templateId') templateIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<readonly VersionView[]> {
    return this.versions.listVersions(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        templateId: requireUuid(templateIdParam, 'templateId'),
      },
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
  }

  @Post()
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Create a draft, empty, with items, or cloned from a version (template_draft)',
  })
  async createDraft(
    @Param('hotelId') hotelIdParam: string,
    @Param('templateId') templateIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<VersionView> {
    const payload = body(request);
    const cloneOfVersionId = optionalUuid(payload['cloneOfVersionId'], 'cloneOfVersionId');
    const created = await this.versions.createDraft(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        templateId: requireUuid(templateIdParam, 'templateId'),
        idempotencyKey: idempotencyKey(request),
        ...(cloneOfVersionId === undefined ? {} : { cloneOfVersionId }),
        ...(payload['items'] === undefined
          ? {}
          : { items: requireTargetLines(payload['items'], 'items') }),
      },
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return created;
  }

  @Put(':versionId/items')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: "Replace a draft's product list and targets (template_draft)" })
  @ApiResponse({ status: 409, description: 'The version is not a draft' })
  async replaceItems(
    @Param('hotelId') hotelIdParam: string,
    @Param('templateId') templateIdParam: string,
    @Param('versionId') versionIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<VersionView> {
    const payload = body(request);
    return this.versions.replaceDraftItems(
      {
        ...this.command(hotelIdParam, templateIdParam, versionIdParam, request),
        items: requireTargetLines(payload['items'], 'items'),
      },
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
  }

  @Post(':versionId/publish')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Publish a draft; the first published version becomes the Default' })
  @ApiResponse({ status: 412, description: 'PUBLISH_REFUSED with every failing rule' })
  async publish(
    @Param('hotelId') hotelIdParam: string,
    @Param('templateId') templateIdParam: string,
    @Param('versionId') versionIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<VersionView> {
    return this.versions.publish(
      this.command(hotelIdParam, templateIdParam, versionIdParam, request),
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
  }

  @Post(':versionId/default')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Set default: one atomic move of the Default inside the template' })
  async setDefault(
    @Param('hotelId') hotelIdParam: string,
    @Param('templateId') templateIdParam: string,
    @Param('versionId') versionIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<VersionView> {
    return this.versions.setDefault(
      this.command(hotelIdParam, templateIdParam, versionIdParam, request),
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
  }

  @Post(':versionId/archive')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Archive a published, non-default, unreferenced version (template_archive)',
  })
  @ApiResponse({ status: 409, description: 'ARCHIVE_BLOCKED with the references' })
  async archive(
    @Param('hotelId') hotelIdParam: string,
    @Param('templateId') templateIdParam: string,
    @Param('versionId') versionIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<VersionView> {
    return this.versions.archive(
      this.command(hotelIdParam, templateIdParam, versionIdParam, request),
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
  }

  @Post(':versionId/delete')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Delete a never-published, unreferenced draft (template_draft)' })
  async deleteDraft(
    @Param('hotelId') hotelIdParam: string,
    @Param('templateId') templateIdParam: string,
    @Param('versionId') versionIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ readonly versionId: string; readonly deleted: true }> {
    return this.versions.deleteDraft(
      this.command(hotelIdParam, templateIdParam, versionIdParam, request),
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
  }

  private command(
    hotelIdParam: string,
    templateIdParam: string,
    versionIdParam: string,
    request: AuthenticatedRequest,
  ): {
    hotelId: string;
    templateId: string;
    versionId: string;
    idempotencyKey: string;
    expectedRevision: number;
    reason?: string;
  } {
    const payload = body(request);
    const reason = optionalString(payload['reason'], 'reason', 300);
    return {
      hotelId: requireUuid(hotelIdParam, 'hotelId'),
      templateId: requireUuid(templateIdParam, 'templateId'),
      versionId: requireUuid(versionIdParam, 'versionId'),
      idempotencyKey: idempotencyKey(request),
      expectedRevision: requireRevision(payload['expectedRevision']),
      ...(reason === undefined ? {} : { reason }),
    };
  }
}
