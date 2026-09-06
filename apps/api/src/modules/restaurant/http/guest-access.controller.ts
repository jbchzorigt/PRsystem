import { Body, Controller, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, optionalUuid, requireUuid } from '../../iam/http/validation';
import { newRestaurantRequest } from '../services/restaurant-context';
import { GuestAccessService } from '../services/guest-access.service';
import { rejectServerOwnedFields } from './restaurant-validation';

/**
 * Reception's side of the guest's way in (doc 08 §7, `RC-DEC-026/027`).
 *
 * The room QR is issued once and replaced when it is believed lost; the
 * one-time code is read to the guest and returned here exactly once. Neither
 * secret is stored in plaintext, neither reaches an audit payload, and a
 * replayed idempotency key does **not** hand the code back a second time.
 *
 * The five-device allowance is the database's `CHECK`, not a count taken here.
 */
@ApiTags('restaurant-guest-access')
@Controller('hotels/:hotelId')
export class GuestAccessController {
  constructor(@Inject(GuestAccessService) private readonly access: GuestAccessService) {}

  @Post('rooms/:roomId/qr-token')
  @HttpCode(201)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Issue or replace the room’s permanent QR; the old one dies at once' })
  async roomToken(
    @Param('hotelId') hotelIdParam: string,
    @Param('roomId') roomIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    return {
      ...(await this.access.issueRoomToken(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          roomId: requireUuid(roomIdParam, 'roomId'),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  @Post('stays/:stayId/guest-access-codes')
  @HttpCode(201)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'A one-time code for one device, inside the five-device allowance' })
  @ApiResponse({ status: 409, description: 'GUEST_ACCESS_LIMIT: revoke a device first' })
  async code(
    @Param('hotelId') hotelIdParam: string,
    @Param('stayId') stayIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const issued = await this.access.issueGuestCode(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        stayId: requireUuid(stayIdParam, 'stayId'),
        idempotencyKey: idempotencyKey(request),
      },
      actorOf(request),
      this.context(request),
    );
    return {
      codeId: issued.codeId,
      // Read to the guest and then gone. Only its keyed hash was stored.
      code: issued.code,
      expiresAt: issued.expiresAt.toISOString(),
      remainingAllowance: issued.remainingAllowance,
    };
  }

  @Post('stays/:stayId/guest-access-revocations')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Close one device, or every device of the stay' })
  async revoke(
    @Param('hotelId') hotelIdParam: string,
    @Param('stayId') stayIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    const guestSessionId = optionalUuid(payload['sessionId'], 'sessionId');
    return {
      ...(await this.access.revoke(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          stayId: requireUuid(stayIdParam, 'stayId'),
          ...(guestSessionId === undefined ? {} : { guestSessionId }),
          idempotencyKey: idempotencyKey(request),
        },
        actorOf(request),
        this.context(request),
      )),
    };
  }

  private context(request: AuthenticatedRequest): ReturnType<typeof newRestaurantRequest> {
    return newRestaurantRequest(principalOf(request).accountId);
  }
}
