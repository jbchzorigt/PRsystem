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
import { body, idempotencyKey, requireUuid } from '../../iam/http/validation';
import { GuestAccessService } from '../services/guest-access.service';
import { RestaurantOrderService } from '../services/order.service';
import type { OrderView } from '../services/order.service';
import type { GuestSessionRequest } from './guest-session.guard';
import { RestaurantGuestGuard, guestSessionOf } from './guest-session.guard';
import {
  optionalNote,
  rejectServerOwnedFields,
  requireAccessCode,
  requireBasket,
  requireRoomToken,
} from './restaurant-validation';

/**
 * The room guest's surface (doc 08 §§7–9, 19).
 *
 * Two properties hold across every route.
 *
 * **The caller never names their own scope.** No route accepts a hotel, a room
 * or a stay: all three come from the session the server resolved out of the
 * presented token, and the transaction is confined to that stay by
 * `app.guest_stay_id` and the restrictive policies that read it.
 *
 * **Another room's order is indistinguishable from none.** An order id that
 * belongs to a different stay answers `NOT_FOUND`, so this surface cannot be
 * used to discover that somebody else's order exists.
 */
@ApiTags('restaurant-guest')
@Controller('restaurant/guest')
export class GuestOrderController {
  constructor(
    @Inject(GuestAccessService) private readonly access: GuestAccessService,
    @Inject(RestaurantOrderService) private readonly orders: RestaurantOrderService,
  ) {}

  @Post('sessions')
  @HttpCode(201)
  @ApiOperation({ summary: 'Redeem the room QR and a one-time code for a session (RC-DEC-026)' })
  @ApiResponse({
    status: 401,
    description: 'A wrong QR, a wrong code and a stale one are one answer',
  })
  async open(
    @Req() request: GuestSessionRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    const opened = await this.access.openSession({
      roomToken: requireRoomToken(payload['roomToken']),
      code: requireAccessCode(payload['code']),
    });
    return {
      guestSessionId: opened.guestSessionId,
      // Returned once. Only its hash was stored.
      token: opened.token,
      expiresAt: opened.expiresAt.toISOString(),
    };
  }

  @Get('menus')
  @UseGuards(RestaurantGuestGuard)
  @ApiOperation({ summary: 'The linked restaurants of this room’s hotel, and what they serve' })
  async menus(@Req() request: GuestSessionRequest): Promise<{ restaurants: unknown[] }> {
    const session = guestSessionOf(request);
    return { restaurants: [...(await this.orders.menusFor(session))] };
  }

  @Post('orders')
  @HttpCode(201)
  @UseGuards(RestaurantGuestGuard)
  @ApiOperation({ summary: 'Place an order; the server prices it and opens the invoice window' })
  @ApiResponse({ status: 409, description: 'ORDERING_CLOSED or an item became unavailable' })
  async place(
    @Req() request: GuestSessionRequest,
    @Body() _body: unknown,
  ): Promise<Record<string, unknown>> {
    const payload = body(request);
    rejectServerOwnedFields(payload);
    const note = optionalNote(payload['note']);
    const placed = await this.orders.placeOrder(
      {
        restaurantId: requireUuid(payload['restaurantId'], 'restaurantId'),
        lines: requireBasket(payload['lines']),
        ...(note === undefined ? {} : { note }),
        idempotencyKey: idempotencyKey(request),
      },
      guestSessionOf(request),
    );
    return {
      orderId: placed.orderId,
      orderNo: placed.orderNo,
      totalAmountMnt: placed.totalAmountMnt.toString(),
      orderingClosesAt: placed.orderingClosesAt.toISOString(),
      attempt: {
        attemptId: placed.attempt.attemptId,
        expiresAt: placed.attempt.expiresAt.toISOString(),
      },
    };
  }

  @Post('orders/:orderId/invoice')
  @HttpCode(201)
  @UseGuards(RestaurantGuestGuard)
  @ApiOperation({ summary: 'Open the provider invoice against the restaurant’s own merchant' })
  @ApiResponse({
    status: 412,
    description: 'PAYMENT_UNAVAILABLE: the gateway refused or is disabled',
  })
  async invoice(
    @Param('orderId') orderIdParam: string,
    @Req() request: GuestSessionRequest,
  ): Promise<Record<string, unknown>> {
    const opened = await this.orders.openInvoice(
      { orderId: requireUuid(orderIdParam, 'orderId') },
      guestSessionOf(request),
    );
    return {
      attemptId: opened.attemptId,
      ...(opened.payUrl === undefined ? {} : { payUrl: opened.payUrl }),
    };
  }

  @Get('orders')
  @UseGuards(RestaurantGuestGuard)
  @ApiOperation({ summary: 'The orders of this stay, and only those' })
  async mine(@Req() request: GuestSessionRequest): Promise<{ orders: unknown[] }> {
    const orders = await this.orders.ordersForSession(guestSessionOf(request));
    return { orders: orders.map(view) };
  }

  @Post('orders/:orderId/refund-request')
  @HttpCode(200)
  @UseGuards(RestaurantGuestGuard)
  @ApiOperation({ summary: 'Ask the restaurant to cancel and refund (REST-DEC-002)' })
  @ApiResponse({ status: 409, description: 'The order had already moved on' })
  async refund(
    @Param('orderId') orderIdParam: string,
    @Req() request: GuestSessionRequest,
  ): Promise<Record<string, unknown>> {
    return view(
      await this.orders.requestRefundAsGuest(
        {
          orderId: requireUuid(orderIdParam, 'orderId'),
          idempotencyKey: idempotencyKey(request),
        },
        guestSessionOf(request),
      ),
    );
  }
}

/**
 * What a guest is shown of their own order.
 *
 * The contact number is included here and nowhere else: doc 08 §7 gives it to
 * the guest who placed the order, and `RC-DEC-025` keeps it off the menu list.
 */
export function view(row: OrderView): Record<string, unknown> {
  return {
    orderId: row.orderId,
    orderNo: row.orderNo,
    restaurantId: row.restaurantId,
    orderState: row.orderState,
    fulfillmentState: row.fulfillmentState,
    paymentState: row.paymentState,
    refundPolicy: row.refundPolicy,
    refundRequestState: row.refundRequestState,
    refundState: row.refundState,
    handoffMode: row.handoffMode,
    totalAmountMnt: row.totalAmountMnt.toString(),
    etaMinutes: row.etaMinutes,
    promisedReadyAt: row.promisedReadyAt === null ? null : row.promisedReadyAt.toISOString(),
    ...(row.contactPhone === undefined ? {} : { contactPhone: row.contactPhone }),
  };
}
