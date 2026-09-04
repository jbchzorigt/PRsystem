import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, optionalUuid, requireUuid } from '../../iam/http/validation';
import { optionalString, requireMnt, requireRevision } from '../../catalog/http/catalog-validation';
import { newFinanceRequest } from '../services/finance-context';
import { CashService } from '../services/cash.service';
import type { LocationView, MovementView, TransferView } from '../services/finance-views';
import { requireDirection, requireLocationKind, requireText } from './finance-validation';

/**
 * The cash drawer and the ledger over it (doc 24; doc 18 §3).
 *
 * Every write carries an idempotency key and the revision it expects; the
 * service re-reads and re-authorizes inside the transaction that moves the
 * money, so nothing here decides anything.
 */
@ApiTags('cash')
@Controller('hotels/:hotelId/cash')
export class CashController {
  constructor(@Inject(CashService) private readonly cash: CashService) {}

  @Get('locations')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The hotel’s drawers and safe, with their balances (doc 24 §2)' })
  async locations(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ locations: readonly LocationView[] }> {
    return this.cash.locations(
      { hotelId: requireUuid(hotelIdParam, 'hotelId') },
      actorOf(request),
      newFinanceRequest(principalOf(request).accountId),
    );
  }

  @Post('locations')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Add a drawer or the hotel’s safe (hotel.cash.location_manage)' })
  @ApiResponse({ status: 409, description: 'DUPLICATE_LOCATION' })
  async createLocation(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LocationView> {
    const payload = body(request);
    const physicalLocation = optionalString(payload['physicalLocation'], 'physicalLocation', 200);
    const float = payload['configuredFloatMnt'];
    const location = await this.cash.createLocation(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        idempotencyKey: idempotencyKey(request),
        kind: requireLocationKind(payload['kind']),
        name: requireText(payload['name'], 'name', 120),
        code: requireText(payload['code'], 'code', 40),
        ...(physicalLocation === undefined ? {} : { physicalLocation }),
        ...(float === undefined || float === null
          ? {}
          : { configuredFloatMnt: requireMnt(float, 'configuredFloatMnt') }),
      },
      actorOf(request),
      newFinanceRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return location;
  }

  @Post('locations/:locationId')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Change a location’s state, float or place' })
  @ApiResponse({ status: 412, description: 'LOCATION_NOT_EMPTY' })
  async updateLocation(
    @Param('hotelId') hotelIdParam: string,
    @Param('locationId') locationIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<LocationView> {
    const payload = body(request);
    const state = payload['state'];
    const physicalLocation = optionalString(payload['physicalLocation'], 'physicalLocation', 200);
    const float = payload['configuredFloatMnt'];
    return this.cash.updateLocation(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        locationId: requireUuid(locationIdParam, 'locationId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        ...(state === 'ACTIVE' || state === 'INACTIVE' ? { state } : {}),
        ...(physicalLocation === undefined ? {} : { physicalLocation }),
        ...(float === undefined || float === null
          ? {}
          : { configuredFloatMnt: requireMnt(float, 'configuredFloatMnt') }),
      },
      actorOf(request),
      newFinanceRequest(principalOf(request).accountId),
    );
  }

  @Get('movements')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The ledger of one location or one shift (doc 24 §5)' })
  async movements(
    @Param('hotelId') hotelIdParam: string,
    @Query('locationId') locationIdQuery: string | undefined,
    @Query('shiftId') shiftIdQuery: string | undefined,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ movements: readonly MovementView[] }> {
    const locationId = optionalUuid(locationIdQuery, 'locationId');
    const shiftId = optionalUuid(shiftIdQuery, 'shiftId');
    return this.cash.movements(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        ...(locationId === undefined ? {} : { locationId }),
        ...(shiftId === undefined ? {} : { shiftId }),
      },
      actorOf(request),
      newFinanceRequest(principalOf(request).accountId),
    );
  }

  @Post('top-ups')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Put cash into a drawer that did not come from a guest' })
  async topUp(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MovementView> {
    const payload = body(request);
    const movement = await this.cash.topUp(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        idempotencyKey: idempotencyKey(request),
        locationId: requireUuid(payload['locationId'], 'locationId'),
        amountMnt: requireMnt(payload['amountMnt'], 'amountMnt'),
        reason: requireText(payload['reason'], 'reason', 300),
      },
      actorOf(request),
      newFinanceRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return movement;
  }

  @Post('corrections')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Correct the ledger with a new movement (CASH-DEC-004)' })
  async correct(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MovementView> {
    const payload = body(request);
    const movement = await this.cash.correct(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        idempotencyKey: idempotencyKey(request),
        originalMovementId: requireUuid(payload['originalMovementId'], 'originalMovementId'),
        amountMnt: requireMnt(payload['amountMnt'], 'amountMnt'),
        direction: requireDirection(payload['direction']),
        reason: requireText(payload['reason'], 'reason', 300),
      },
      actorOf(request),
      newFinanceRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return movement;
  }

  @Get('transfers')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The transfers still waiting to be counted' })
  async transfers(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ transfers: readonly TransferView[] }> {
    return this.cash.transfers(
      { hotelId: requireUuid(hotelIdParam, 'hotelId') },
      actorOf(request),
      newFinanceRequest(principalOf(request).accountId),
    );
  }

  @Post('transfers')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Send cash to another drawer or to the safe (CASH-DEC-006)' })
  @ApiResponse({ status: 412, description: 'INSUFFICIENT_CASH' })
  async initiateTransfer(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<TransferView> {
    const payload = body(request);
    const reason = optionalString(payload['reason'], 'reason', 300);
    const transfer = await this.cash.initiateTransfer(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        idempotencyKey: idempotencyKey(request),
        sourceLocationId: requireUuid(payload['sourceLocationId'], 'sourceLocationId'),
        destinationLocationId: requireUuid(
          payload['destinationLocationId'],
          'destinationLocationId',
        ),
        amountMnt: requireMnt(payload['amountMnt'], 'amountMnt'),
        ...(reason === undefined ? {} : { reason }),
      },
      actorOf(request),
      newFinanceRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return transfer;
  }

  @Post('transfers/:transferId/confirm')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The recipient counts what arrived and completes the transfer' })
  @ApiResponse({ status: 409, description: 'COUNT_MISMATCH' })
  async confirmTransfer(
    @Param('hotelId') hotelIdParam: string,
    @Param('transferId') transferIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<TransferView> {
    const payload = body(request);
    return this.cash.confirmTransfer(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        transferId: requireUuid(transferIdParam, 'transferId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        countedMnt: requireMnt(payload['countedMnt'], 'countedMnt'),
      },
      actorOf(request),
      newFinanceRequest(principalOf(request).accountId),
    );
  }

  @Post('transfers/:transferId/cancel')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Cancel a transfer and recount the source (doc 24 §9.3)' })
  async cancelTransfer(
    @Param('hotelId') hotelIdParam: string,
    @Param('transferId') transferIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<TransferView> {
    const payload = body(request);
    return this.cash.cancelTransfer(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        transferId: requireUuid(transferIdParam, 'transferId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireRevision(payload['expectedRevision']),
        recountMnt: requireMnt(payload['recountMnt'], 'recountMnt'),
        reason: requireText(payload['reason'], 'reason', 300),
      },
      actorOf(request),
      newFinanceRequest(principalOf(request).accountId),
    );
  }
}
