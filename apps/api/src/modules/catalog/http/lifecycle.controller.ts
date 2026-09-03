import { Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, requireUuid } from '../../iam/http/validation';
import { newCatalogRequest } from '../services/catalog-context';
import { LifecycleService } from '../services/lifecycle.service';
import type {
  DeletionView,
  LifecycleCommandInput,
  LifecycleView,
  TransitionView,
} from '../services/lifecycle.service';
import { optionalString, requireEntityKind, requireRevision } from './catalog-validation';

/**
 * The entity lifecycle (doc 26; `RML-DEC-001`…`006`, `RC-DEC-040`).
 *
 * One surface for the four entity kinds, keyed by the path segment: `rooms`,
 * `categories`, `minibar-products`, `minibar-templates`. Which permission a
 * command needs follows from the kind — the catalog pair for rooms and
 * categories, the minibar pair for products and templates — and the read is
 * `hotel.catalog.lifecycle_view`, which Reception holds as `.read`.
 *
 * Every command carries the revision the caller read and a client idempotency
 * key. A stale revision is a `409`; the same key with the same payload replays
 * the stored answer; a transition the state machine does not draw is a `409`
 * that names the state the entity is in.
 */
@ApiTags('catalog-lifecycle')
@Controller('hotels/:hotelId/catalog/:entityKind/:entityId/lifecycle')
export class LifecycleController {
  constructor(@Inject(LifecycleService) private readonly lifecycle: LifecycleService) {}

  @Get()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Lifecycle state, dependencies and blockers (lifecycle_view / .read)' })
  async view(
    @Param('hotelId') hotelIdParam: string,
    @Param('entityKind') kindParam: string,
    @Param('entityId') entityIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<LifecycleView> {
    return this.lifecycle.view(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        kind: requireEntityKind(kindParam),
        entityId: requireUuid(entityIdParam, 'entityId'),
      },
      actorOf(request),
      newCatalogRequest(principalOf(request).accountId),
    );
  }

  @Post('deactivation')
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Request deactivation: INACTIVE at once, or RETIRING with its blockers',
  })
  @ApiResponse({ status: 409, description: 'Not ACTIVE, or the revision moved' })
  @ApiResponse({ status: 503, description: 'A dependency source could not be read' })
  async requestDeactivation(
    @Param('hotelId') hotelIdParam: string,
    @Param('entityKind') kindParam: string,
    @Param('entityId') entityIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<TransitionView> {
    return this.lifecycle.requestDeactivation(
      this.command(hotelIdParam, kindParam, entityIdParam, request),
      actorOf(request),
      newCatalogRequest(principalOf(request).accountId),
    );
  }

  @Post('deactivation/cancel')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Withdraw a pending deactivation: RETIRING back to ACTIVE' })
  @ApiResponse({ status: 412, description: 'The related category is not active' })
  async cancelDeactivation(
    @Param('hotelId') hotelIdParam: string,
    @Param('entityKind') kindParam: string,
    @Param('entityId') entityIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<TransitionView> {
    return this.lifecycle.cancelDeactivation(
      this.command(hotelIdParam, kindParam, entityIdParam, request),
      actorOf(request),
      newCatalogRequest(principalOf(request).accountId),
    );
  }

  @Post('reactivation')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Reactivate an INACTIVE entity after dependency validation' })
  @ApiResponse({ status: 412, description: 'The related category is not active' })
  async reactivate(
    @Param('hotelId') hotelIdParam: string,
    @Param('entityKind') kindParam: string,
    @Param('entityId') entityIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<TransitionView> {
    return this.lifecycle.reactivate(
      this.command(hotelIdParam, kindParam, entityIdParam, request),
      actorOf(request),
      newCatalogRequest(principalOf(request).accountId),
    );
  }

  @Post('finalization')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Complete a RETIRING deactivation once every blocker is resolved' })
  @ApiResponse({ status: 412, description: 'Operational dependencies are still outstanding' })
  async finalize(
    @Param('hotelId') hotelIdParam: string,
    @Param('entityKind') kindParam: string,
    @Param('entityId') entityIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<TransitionView> {
    return this.lifecycle.finalizeRetirement(
      this.command(hotelIdParam, kindParam, entityIdParam, request),
      actorOf(request),
      newCatalogRequest(principalOf(request).accountId),
    );
  }

  @Post('hard-delete')
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Delete a never-used entity (entity_hard_delete); refused once referenced',
  })
  @ApiResponse({
    status: 409,
    description: 'The entity is referenced, RETIRING, or the revision moved',
  })
  async hardDelete(
    @Param('hotelId') hotelIdParam: string,
    @Param('entityKind') kindParam: string,
    @Param('entityId') entityIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<DeletionView> {
    return this.lifecycle.hardDelete(
      this.command(hotelIdParam, kindParam, entityIdParam, request),
      actorOf(request),
      newCatalogRequest(principalOf(request).accountId),
    );
  }

  private command(
    hotelIdParam: string,
    kindParam: string,
    entityIdParam: string,
    request: AuthenticatedRequest,
  ): LifecycleCommandInput {
    const payload = body(request);
    const reason = optionalString(payload['reason'], 'reason', 300);
    return {
      hotelId: requireUuid(hotelIdParam, 'hotelId'),
      kind: requireEntityKind(kindParam),
      entityId: requireUuid(entityIdParam, 'entityId'),
      idempotencyKey: idempotencyKey(request),
      expectedRevision: requireRevision(payload['expectedRevision']),
      ...(reason === undefined ? {} : { reason }),
    };
  }
}
