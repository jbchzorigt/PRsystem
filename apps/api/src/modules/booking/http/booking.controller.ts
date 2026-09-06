import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiError } from '@prsystem/contracts';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, principalOf } from '../../iam/http/session.guard';
import { body, idempotencyKey, requireUuid } from '../../iam/http/validation';
import { newBookingRequest } from '../services/booking-context';
import { BookingService } from '../services/booking.service';
import type { BookingView, HeldBooking } from '../services/booking.service';
import {
  optionalReason,
  rejectServerOwnedFields,
  requireDate,
  requireGuestName,
  requireProvider,
} from './booking-validation';

/**
 * The Guest's own bookings (doc 09 §7).
 *
 * Every route here is authenticated and every one of them binds the booker from
 * the session, never from the body. A booking id in a path selects which of the
 * caller's own bookings to act on; a booking belonging to somebody else answers
 * `NOT_FOUND`, exactly as one that does not exist does, so the surface cannot
 * be used to discover that another guest's booking exists.
 *
 * The hotel appears in no request. It is resolved on the server from the room
 * category, so nothing a client sends can choose the tenant a command runs in.
 */
@ApiTags('guest-bookings')
@Controller('guest/bookings')
export class BookingController {
  constructor(@Inject(BookingService) private readonly bookings: BookingService) {}

  @Post()
  @HttpCode(201)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Take the ten-minute hold and open a payment attempt (BK-DEC-009)' })
  @ApiResponse({ status: 409, description: 'NO_UNITS_LEFT: the category is fully booked' })
  async hold(
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    const held = await this.bookings.hold(
      {
        categoryId: requireUuid(payload['categoryId'], 'categoryId'),
        checkInDate: requireDate(payload['checkInDate'], 'checkInDate'),
        checkOutDate: requireDate(payload['checkOutDate'], 'checkOutDate'),
        stayingGuestName: requireGuestName(payload['stayingGuestName']),
        provider: requireProvider(payload['provider']),
        idempotencyKey: idempotencyKey(request),
      },
      this.asGuest(request),
    );
    return heldView(held);
  }

  @Get()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The bookings this guest made, and only those' })
  async mine(@Req() request: AuthenticatedRequest): Promise<{ bookings: unknown[] }> {
    const bookings = await this.bookings.mine(this.asGuest(request));
    return { bookings: bookings.map(view) };
  }

  @Get(':bookingId')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'One of this guest’s own bookings' })
  @ApiResponse({
    status: 404,
    description: 'Another guest’s booking is indistinguishable from none',
  })
  async one(
    @Param('bookingId') bookingIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    return view(
      await this.bookings.byId(requireUuid(bookingIdParam, 'bookingId'), this.asGuest(request)),
    );
  }

  @Post(':bookingId/payment-attempts')
  @HttpCode(201)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Switch provider: the live attempt is superseded, never duplicated' })
  async switchProvider(
    @Param('bookingId') bookingIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    const attempt = await this.bookings.switchProvider(
      {
        bookingId: requireUuid(bookingIdParam, 'bookingId'),
        provider: requireProvider(payload['provider']),
      },
      this.asGuest(request),
    );
    return {
      attemptId: attempt.attemptId,
      provider: attempt.provider,
      expiresAt: attempt.expiresAt.toISOString(),
    };
  }

  @Post(':bookingId/payment-attempts/:attemptId/invoice')
  @HttpCode(201)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Open the provider invoice for the live attempt (PAY-DEC-005)' })
  @ApiResponse({
    status: 412,
    description: 'PAYMENT_UNAVAILABLE: the gateway refused or is disabled',
  })
  async invoice(
    @Param('bookingId') bookingIdParam: string,
    @Param('attemptId') attemptIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const opened = await this.bookings.issueInvoice(
      {
        bookingId: requireUuid(bookingIdParam, 'bookingId'),
        attemptId: requireUuid(attemptIdParam, 'attemptId'),
      },
      this.asGuest(request),
    );
    return {
      attemptId: opened.attemptId,
      provider: opened.provider,
      ...(opened.payUrl === undefined ? {} : { payUrl: opened.payUrl }),
    };
  }

  @Post(':bookingId/cancellation')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Cancel own booking; the units go back at once' })
  async cancel(
    @Param('bookingId') bookingIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    const reason = optionalReason(payload['reason']);
    return view(
      await this.bookings.cancelByGuest(
        {
          bookingId: requireUuid(bookingIdParam, 'bookingId'),
          ...(reason === undefined ? {} : { reason }),
        },
        this.asGuest(request),
      ),
    );
  }

  /**
   * The Guest the session resolved to.
   *
   * A Hotel, Operation or Police principal reaching this surface is refused:
   * realms never merge, and a booking belongs to the Guest realm alone.
   */
  private asGuest(request: AuthenticatedRequest): ReturnType<typeof newBookingRequest> {
    const principal = principalOf(request);
    if (principal.realm !== 'guest') {
      throw new ApiError('FORBIDDEN', 'a booking belongs to the Guest realm');
    }
    return newBookingRequest(principal.accountId);
  }
}

function view(row: BookingView): Record<string, unknown> {
  return {
    bookingId: row.bookingId,
    bookingRef: row.bookingRef,
    hotelId: row.hotelId,
    categoryId: row.categoryId,
    stayingGuestName: row.stayingGuestName,
    checkInDate: row.checkInDate.toISOString().slice(0, 10),
    checkOutDate: row.checkOutDate.toISOString().slice(0, 10),
    nightCount: row.nightCount,
    state: row.state,
    holdState: row.holdState,
    paymentState: row.paymentState,
    refundState: row.refundState,
    holdExpiresAt: row.holdExpiresAt.toISOString(),
    totalAmountMnt: row.totalAmountMnt === null ? null : row.totalAmountMnt.toString(),
  };
}

function heldView(held: HeldBooking): Record<string, unknown> {
  return {
    bookingId: held.bookingId,
    bookingRef: held.bookingRef,
    holdExpiresAt: held.holdExpiresAt.toISOString(),
    nightCount: held.nightCount,
    totalAmountMnt: held.totalAmountMnt.toString(),
    // doc 11 §5: the cancellation terms are shown before the guest pays.
    cancellationPolicyVersion: held.cancellationPolicyVersion,
    freeCancellationUntil: held.freeCancellationUntil.toISOString(),
    attempt: {
      attemptId: held.attempt.attemptId,
      provider: held.attempt.provider,
      expiresAt: held.attempt.expiresAt.toISOString(),
    },
  };
}
