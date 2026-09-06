import { Body, Controller, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiError } from '@prsystem/contracts';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, requireUuid } from '../../iam/http/validation';
import { newBookingRequest } from '../services/booking-context';
import { BookingService } from '../services/booking.service';
import type { BookingView } from '../services/booking.service';
import { optionalReason, requireReason } from './booking-validation';

/**
 * doc 18 §3.3: the two things hotel staff may do to an online booking.
 *
 * Both are named permissions the Phase 04 pipeline evaluates inside the
 * command's own transaction — `booking.no_show_confirm` for Reception or
 * Manager, `booking.cancelled_hotel` for Manager or Manager Plus — and neither
 * is granted by a role name. There is deliberately no route that marks a refund
 * successful: doc 18 §3.3 refuses that to every column, and only a verified
 * provider result moves the refund axis.
 */
@ApiTags('booking-operations')
@Controller('hotels/:hotelId/bookings')
export class BookingOperationsController {
  constructor(@Inject(BookingService) private readonly bookings: BookingService) {}

  @Post(':bookingId/no-show')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Confirm a no-show after the arrival date’s 23:59:59, hotel-local (PAY-DEC-007)',
  })
  @ApiResponse({
    status: 412,
    description: 'BEFORE_NO_SHOW_CUTOFF: the arrival date has not ended',
  })
  async noShow(
    @Param('hotelId') hotelIdParam: string,
    @Param('bookingId') bookingIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    const reason = optionalReason(payload['reason']);
    return view(
      await this.bookings.confirmNoShow(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          bookingId: requireUuid(bookingIdParam, 'bookingId'),
          idempotencyKey: idempotencyKey(request),
          ...(reason === undefined ? {} : { reason }),
        },
        actorOf(request),
        this.asStaff(request),
      ),
    );
  }

  @Post(':bookingId/hotel-cancellation')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Cancel a booking the hotel cannot honour (BK-DEC-014)' })
  async cancelByHotel(
    @Param('hotelId') hotelIdParam: string,
    @Param('bookingId') bookingIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    return view(
      await this.bookings.cancelByHotel(
        {
          hotelId: requireUuid(hotelIdParam, 'hotelId'),
          bookingId: requireUuid(bookingIdParam, 'bookingId'),
          idempotencyKey: idempotencyKey(request),
          reason: requireReason(payload['reason']),
        },
        actorOf(request),
        this.asStaff(request),
      ),
    );
  }

  /** The hotel principal the session resolved to. Realms never merge. */
  private asStaff(request: AuthenticatedRequest): ReturnType<typeof newBookingRequest> {
    const principal = principalOf(request);
    if (principal.realm !== 'hotel') {
      throw new ApiError('FORBIDDEN', 'this action belongs to the Hotel realm');
    }
    return newBookingRequest(principal.accountId);
  }
}

function view(row: BookingView): Record<string, unknown> {
  return {
    bookingId: row.bookingId,
    bookingRef: row.bookingRef,
    state: row.state,
    holdState: row.holdState,
    paymentState: row.paymentState,
    refundState: row.refundState,
    totalAmountMnt: row.totalAmountMnt === null ? null : row.totalAmountMnt.toString(),
  };
}
