import { randomBytes } from 'node:crypto';
import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import {
  appendOutboxEvent,
  completeIdempotencyKey,
  recordPlatformAudit,
  registerProviderEvent,
} from '@prsystem/db';
import type { RawCallback } from '@prsystem/ports';
import { RestaurantRepository } from '../repositories/restaurant.repository';
import type { GuestSessionRow, OrderRow } from '../repositories/restaurant.repository';
import {
  advancesFulfillment,
  basketTotalMnt,
  captureOutcome,
  formatOrderNo,
  invoiceExpiry,
  isEtaChoice,
  isFulfillmentTerminal,
  orderStateFor,
  orderingWindowAt,
  requestOutcome,
  terminalFor,
} from '../domain/restaurant';
import type {
  FulfillmentState,
  HandoffMode,
  RequestSource,
  BasketLine,
} from '../domain/restaurant';
import type { CommandActor, RequestContext, RestaurantDependencies } from './restaurant-context';
import {
  RestaurantServiceBase,
  claim,
  hotelTimeZone,
  newRestaurantRequest,
} from './restaurant-context';

/**
 * The order, from a basket to a handover (doc 08 §§8, 10, 19–22).
 *
 * Four rules shape every command here.
 *
 * **The server decides what an order costs and whether it may exist at all.**
 * The basket names items and quantities; the price, the availability, the
 * schedule, the link and the stay are all re-read inside the transaction that
 * writes the order, because a check made before the lock was made against a
 * different world.
 *
 * **Only the provider confirms a payment.** A callback is a hint. The signature
 * is checked, the event is deduplicated, the provider's own status is
 * re-queried, and the amount and reference are matched against the stored
 * attempt before anything moves (doc 08 §11).
 *
 * **The acceptance race is resolved by the order's row lock, and by nothing
 * else** (`REST-DEC-002`). Whichever transaction takes the row first decides;
 * the other re-reads and gets a different, still-correct answer.
 *
 * **The money is the restaurant's.** Nothing here touches a folio, a deposit, a
 * drawer or a shift — doc 08 §8 and doc 24 §1 keep the two ledgers apart, and
 * the separation is structural rather than remembered.
 */

const MENU_MANAGE = 'restaurant.menu_manage';
const ORDER_PROCESS = 'restaurant.order_process';
const RECEPTION_CHECKOUT = 'hotel.stay.checkout_record';

export interface PlacedOrder {
  readonly orderId: string;
  readonly orderNo: string;
  readonly totalAmountMnt: bigint;
  readonly orderingClosesAt: Date;
  readonly attempt: { readonly attemptId: string; readonly expiresAt: Date };
}

export interface OrderView {
  readonly orderId: string;
  readonly orderNo: string;
  readonly restaurantId: string;
  readonly orderState: string;
  readonly fulfillmentState: string;
  readonly paymentState: string;
  readonly refundPolicy: string;
  readonly refundRequestState: string;
  readonly refundState: string;
  readonly handoffMode: string;
  readonly totalAmountMnt: bigint;
  readonly etaMinutes: number | null;
  readonly promisedReadyAt: Date | null;
  /**
   * doc 08 §7 / `RC-DEC-025`: the number to call, on the guest's own order and
   * nowhere else. Present only where the caller has been shown to own it.
   */
  readonly contactPhone?: string;
}

export function orderView(row: OrderRow, withPhone = false): OrderView {
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
    totalAmountMnt: row.totalAmountMnt,
    etaMinutes: row.etaMinutes,
    promisedReadyAt: row.promisedReadyAt,
    ...(withPhone ? { contactPhone: row.contactPhoneSnapshot } : {}),
  };
}

export class RestaurantOrderService extends RestaurantServiceBase {
  constructor(deps: RestaurantDependencies) {
    super(deps);
  }

  // -------------------------------------------------------------- the guest

  /** The menus a guest may order from right now, in their own hotel. */
  async menusFor(
    session: GuestSessionRow,
    request: RequestContext = newRestaurantRequest(),
  ): Promise<
    readonly { restaurantId: string; displayName: string; open: boolean; items: unknown[] }[]
  > {
    return this.inGuestScope(session.hotelId, session.stayId, request, async (uow) => {
      const repository = new RestaurantRepository(uow);
      const links = await uow.query<{ restaurant_id: string }>(
        `SELECT restaurant_id FROM platform.hotel_restaurant_link
          WHERE link_state = 'ACTIVE' AND NOT sla_paused`,
      );
      const zone = await hotelTimeZone(uow);
      const now = this.now(uow);
      const out = [];
      for (const link of links.rows) {
        const restaurant = await repository.restaurantById(link.restaurant_id);
        if (restaurant === undefined || restaurant.state !== 'ACTIVE') continue;
        const window = orderingWindowAt(
          now,
          zone,
          await repository.week(link.restaurant_id),
          await repository.overrides(link.restaurant_id),
        );
        const items = await repository.menuOf(link.restaurant_id);
        out.push({
          restaurantId: restaurant.restaurantId,
          displayName: restaurant.displayName,
          open: window.open,
          // doc 08 §7: the contact number is **not** here. It appears only on
          // an order the caller placed.
          items: items.map((item) => ({
            itemId: item.itemId,
            name: item.name,
            priceMnt: item.priceMnt.toString(),
            available: item.available,
          })),
        });
      }
      return out;
    });
  }

  /**
   * doc 08 §8: a basket becomes an order, and an order becomes an invoice.
   *
   * Every condition of doc 08 §5 is re-checked here, inside the transaction
   * that writes the row: the package and the link, the restaurant, the
   * schedule, each item's availability and price, and the stay.
   */
  async placeOrder(
    input: {
      restaurantId: string;
      lines: readonly { itemId: string; quantity: number }[];
      note?: string;
      idempotencyKey: string;
    },
    session: GuestSessionRow,
    request: RequestContext = newRestaurantRequest(),
  ): Promise<PlacedOrder> {
    if (input.lines.length === 0) {
      throw new ApiError('VALIDATION_FAILED', 'an order needs at least one item');
    }
    return this.inGuestScope(session.hotelId, session.stayId, request, async (uow) => {
      const claimed = await claim(uow, 'restaurant.order', input.idempotencyKey, {
        restaurantId: input.restaurantId,
        stayId: session.stayId,
      });
      if (claimed.kind === 'replay') return claimed.body as PlacedOrder;

      const repository = new RestaurantRepository(uow);
      const now = this.now(uow);

      // doc 08 §8: a stay that is checking out places no new order.
      const stay = await this.deps.stays.byId(uow, session.stayId);
      if (stay === undefined || stay.state !== 'ACTIVE') {
        throw new ApiError('PRECONDITION_FAILED', 'STAY_NOT_ACTIVE: this stay is not ordering');
      }
      const restaurant = await repository.restaurantById(input.restaurantId);
      if (restaurant === undefined || restaurant.state !== 'ACTIVE') {
        throw new ApiError('NOT_FOUND', 'no such restaurant');
      }
      const link = await repository.linkFor(input.restaurantId);
      if (link === undefined || link.linkState !== 'ACTIVE') {
        throw new ApiError('PRECONDITION_FAILED', 'RESTAURANT_INACTIVE: this restaurant is closed');
      }
      // `RC-DEC-031`: a link paused for an unresolved refund takes no new order,
      // while everything already placed carries on.
      if (link.slaPaused) {
        throw new ApiError(
          'PRECONDITION_FAILED',
          'RESTAURANT_PAUSED: this restaurant is not taking new orders',
        );
      }
      const zone = await hotelTimeZone(uow);
      const window = orderingWindowAt(
        now,
        zone,
        await repository.week(input.restaurantId),
        await repository.overrides(input.restaurantId),
      );
      // doc 08 §5: the button's state decides nothing; this does.
      if (!window.open || window.closesAt === undefined) {
        throw new ApiError(
          'PRECONDITION_FAILED',
          'ORDERING_CLOSED: the restaurant is not taking orders now',
        );
      }

      // The items, locked in a fixed order, and priced by the server.
      const wanted = input.lines.map((line) => line.itemId);
      const items = await repository.lockItems(wanted);
      const basket: BasketLine[] = [];
      for (const line of input.lines) {
        const item = items.find((candidate) => candidate.itemId === line.itemId);
        if (item === undefined || item.restaurantId !== input.restaurantId) {
          throw new ApiError('NOT_FOUND', 'that item is not on this menu');
        }
        if (item.state !== 'ACTIVE' || !item.available) {
          throw new ApiError('PRECONDITION_FAILED', `ITEM_UNAVAILABLE: ${item.name}`);
        }
        if (line.quantity < 1 || line.quantity > 50) {
          throw new ApiError('VALIDATION_FAILED', 'quantity must be between 1 and 50');
        }
        basket.push({
          itemId: item.itemId,
          name: item.name,
          unitPriceMnt: item.priceMnt,
          quantity: line.quantity,
        });
      }
      const total = basketTotalMnt(basket);
      if (total <= 0n) throw new ApiError('VALIDATION_FAILED', 'an order cannot cost nothing');

      const order = await repository.createOrder({
        hotelId: session.hotelId,
        restaurantId: input.restaurantId,
        stayId: session.stayId,
        roomId: session.roomId,
        guestSessionId: session.guestSessionId,
        orderNo: formatOrderNo(randomBytes(16)),
        totalAmountMnt: total,
        contactPhoneSnapshot: restaurant.contactPhone,
        orderingClosesAt: window.closesAt,
        guestNote: input.note ?? null,
      });
      await repository.addOrderItems({
        hotelId: session.hotelId,
        orderId: order.orderId,
        stayId: session.stayId,
        lines: basket,
      });
      // `RC-DEC-023`: the invoice cannot outlive the day's close, and the CHECK
      // on the row is what refuses one that would.
      const attempt = await repository.createAttempt({
        hotelId: session.hotelId,
        orderId: order.orderId,
        restaurantId: input.restaurantId,
        amountMnt: total,
        orderingClosesAt: window.closesAt,
        expiresAt: invoiceExpiry(now, window.closesAt),
      });
      await repository.record({
        hotelId: session.hotelId,
        orderId: order.orderId,
        stayId: session.stayId,
        axis: 'order',
        eventType: 'order.placed',
        fromState: null,
        toState: 'PENDING_PAYMENT',
        actorRef: `guest-session:${session.guestSessionId}`,
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'restaurant_order',
        aggregateId: order.orderId,
        eventType: 'restaurant.order_placed',
        payload: { orderId: order.orderId, restaurantId: input.restaurantId },
      });

      const placed: PlacedOrder = {
        orderId: order.orderId,
        orderNo: order.orderNo,
        totalAmountMnt: total,
        orderingClosesAt: window.closesAt,
        attempt: { attemptId: attempt.attemptId, expiresAt: attempt.expiresAt },
      };
      await completeIdempotencyKey(uow, claimed.idempotencyId, 201, placed);
      return placed;
    });
  }

  /**
   * Opens the QPay invoice on the *restaurant's* merchant (`RC-DEC-021`).
   *
   * The provider call happens between two transactions, never inside one: a
   * lock held across a network call is a lock held for as long as the provider
   * takes to answer.
   */
  async openInvoice(
    input: { orderId: string },
    session: GuestSessionRow,
    request: RequestContext = newRestaurantRequest(),
  ): Promise<{ attemptId: string; payUrl?: string }> {
    const opened = await this.inGuestScope(
      session.hotelId,
      session.stayId,
      request,
      async (uow) => {
        const repository = new RestaurantRepository(uow);
        const order = await repository.orderById(input.orderId);
        if (order === undefined || order.guestSessionId !== session.guestSessionId) {
          throw new ApiError('NOT_FOUND', 'no such order');
        }
        const attempt = await repository.attemptFor(order.orderId);
        if (attempt === undefined || attempt.state !== 'ACTIVE') {
          throw new ApiError('CONFLICT', 'that order has no live invoice');
        }
        return { order, attempt };
      },
    );
    if (opened.attempt.providerInvoiceId !== null) {
      return { attemptId: opened.attempt.attemptId };
    }

    const gateway = this.deps.payments.gateway('QPAY');
    const created = await gateway.createInvoice(
      {
        intentId: opened.attempt.attemptId,
        amountMnt: opened.attempt.amountMnt,
        currency: 'MNT',
        merchantRef: opened.order.orderNo,
        expiresAt: opened.attempt.expiresAt,
        idempotencyKey: `restaurant-attempt:${opened.attempt.attemptId}`,
      },
      { correlationId: request.correlationId },
    );
    if (!created.ok) {
      throw new ApiError(
        'PRECONDITION_FAILED',
        `PAYMENT_UNAVAILABLE: the restaurant's payment provider refused (${created.error.kind})`,
      );
    }
    await this.inGuestScope(session.hotelId, session.stayId, request, async (uow) => {
      const repository = new RestaurantRepository(uow);
      const attempt = await repository.attemptFor(opened.order.orderId);
      if (attempt === undefined || attempt.providerInvoiceId !== null) return;
      await repository.setInvoice({
        attemptId: attempt.attemptId,
        expectedRevision: attempt.revision,
        providerInvoiceId: created.value.providerInvoiceId,
      });
    });
    return {
      attemptId: opened.attempt.attemptId,
      ...(created.value.payUrl === undefined ? {} : { payUrl: created.value.payUrl }),
    };
  }

  /**
   * A provider callback, from the wire to a domain transition (doc 08 §11).
   *
   * The order is the one doc 08 §11 fixes: signature first, then the hotel
   * resolved on the server from the invoice, then the provider event
   * deduplicated, then the provider's own status re-queried, then the amount,
   * currency and reference matched against the *stored* attempt. Only then a
   * transition — and if the window has closed, or the link or an item went
   * inactive meanwhile, the transition is a full refund obligation rather than
   * a confirmation (`REST-DEC-005`).
   */
  async handleCallback(
    raw: RawCallback,
    request: RequestContext = newRestaurantRequest(),
  ): Promise<{ outcome: string; orderId?: string }> {
    const gateway = this.deps.payments.gateway(raw.provider);
    const verified = await gateway.verifyCallback(raw, { correlationId: request.correlationId });
    if (!verified.ok) return { outcome: 'rejected' };

    const located = await this.attemptOfInvoice(verified.value.payload.providerInvoiceId);
    if (located === undefined) return { outcome: 'rejected' };

    const first = await this.inHotelScope(located.hotelId, request, async (uow) => {
      const outcome = await registerProviderEvent(uow, {
        provider: raw.provider,
        providerEventId: verified.value.providerEventId,
        eventKind: 'restaurant.payment',
        rawPayload: JSON.stringify({
          providerInvoiceId: verified.value.payload.providerInvoiceId,
          providerPaymentId: verified.value.payload.providerPaymentId ?? null,
          status: raw.status ?? null,
        }),
        metadata: {
          providerInvoiceId: verified.value.payload.providerInvoiceId,
          status: raw.status ?? 'unknown',
        },
      });
      return outcome.kind === 'first_delivery';
    });
    if (!first) return { outcome: 'duplicate', orderId: located.orderId };

    const status = await gateway.queryStatus(
      { providerInvoiceId: verified.value.payload.providerInvoiceId },
      { correlationId: request.correlationId },
    );
    if (!status.ok) return { outcome: 'unverified', orderId: located.orderId };
    if (status.value.state !== 'PAID') {
      return { outcome: status.value.state.toLowerCase(), orderId: located.orderId };
    }
    const providerPaymentId = status.value.providerPaymentId;
    if (providerPaymentId === undefined) {
      return { outcome: 'unverified', orderId: located.orderId };
    }

    return this.applyCapture(
      {
        hotelId: located.hotelId,
        orderId: located.orderId,
        attemptId: located.attemptId,
        providerPaymentId,
        ...(status.value.paidAmountMnt === undefined
          ? {}
          : { paidAmountMnt: status.value.paidAmountMnt }),
        ...(status.value.currency === undefined ? {} : { currency: status.value.currency }),
        ...(status.value.merchantRef === undefined
          ? {}
          : { merchantRef: status.value.merchantRef }),
      },
      request,
    );
  }

  /** Applies a verified capture on the order's own lock. */
  async applyCapture(
    input: {
      hotelId: string;
      orderId: string;
      attemptId: string;
      providerPaymentId: string;
      paidAmountMnt?: bigint;
      currency?: string;
      merchantRef?: string;
    },
    request: RequestContext = newRestaurantRequest(),
  ): Promise<{ outcome: string; orderId: string }> {
    return this.inHotelScope(input.hotelId, request, async (uow) => {
      const repository = new RestaurantRepository(uow);
      const order = await repository.lockOrder(input.orderId);
      if (order === undefined) throw new ApiError('NOT_FOUND', 'no such order');
      const attempt = await repository.attemptFor(order.orderId);
      if (attempt === undefined) throw new ApiError('NOT_FOUND', 'no such payment attempt');

      // doc 08 §11: the provider's claims, matched against what was stored.
      if (input.currency !== undefined && input.currency !== 'MNT') {
        return this.mismatch(uow, order, 'currency');
      }
      if (input.merchantRef !== undefined && input.merchantRef !== order.orderNo) {
        return this.mismatch(uow, order, 'merchant');
      }
      if (input.paidAmountMnt !== undefined && input.paidAmountMnt !== attempt.amountMnt) {
        return this.mismatch(uow, order, 'amount');
      }

      const now = this.now(uow);
      const link = await repository.lockLink(order.restaurantId);
      const restaurant = await repository.restaurantById(order.restaurantId);
      const itemsActive = await this.itemsStillLive(uow, order.orderId);
      const outcome = captureOutcome(order, {
        linkActive:
          link !== undefined && link.linkState === 'ACTIVE' && restaurant?.state === 'ACTIVE',
        itemsActive,
        expired: attempt.expiresAt.getTime() <= now.getTime(),
      });

      if (outcome.kind === 'already_confirmed') {
        await repository.record({
          hotelId: order.hotelId,
          orderId: order.orderId,
          stayId: order.stayId,
          axis: 'payment',
          eventType: 'payment.replayed',
          fromState: 'PAID',
          toState: 'PAID',
          actorRef: 'provider',
        });
        return { outcome: 'already_confirmed', orderId: order.orderId };
      }

      if (attempt.state === 'ACTIVE') {
        await repository.settleAttempt({
          attemptId: attempt.attemptId,
          expectedRevision: attempt.revision,
          state: 'PAID',
          reason: outcome.kind === 'confirm' ? 'captured' : outcome.reason,
          providerPaymentId: input.providerPaymentId,
          at: now,
        });
      }

      if (outcome.kind === 'mandatory_refund') {
        // `REST-DEC-005`: the money is real, so the payment axis moves; the
        // order is not reopened and never enters the production queue.
        const moved = await repository.transition({
          orderId: order.orderId,
          expectedRevision: order.revision,
          orderState: 'CANCELLED',
          fulfillmentState: 'CANCELLED',
          paymentState: 'PAID',
          paymentConfirmedAt: now,
          refundPolicy: 'MANDATORY',
          refundRequestState: 'APPROVED',
          refundReason: outcome.reason,
          refundRequestedAt: now,
        });
        if (!moved) throw new ApiError('CONFLICT', 'that order changed under this capture');
        await repository.record({
          hotelId: order.hotelId,
          orderId: order.orderId,
          stayId: order.stayId,
          axis: 'refund_policy',
          eventType: 'refund.mandatory_raised',
          fromState: 'NONE',
          toState: 'MANDATORY',
          actorRef: 'provider',
          reason: outcome.reason,
        });
        await recordPlatformAudit(uow, {
          action: 'restaurant.late_payment_refund',
          outcome: 'allowed',
          targetType: 'restaurant_order',
          targetRef: order.orderId,
          payload: { reason: outcome.reason },
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'restaurant_order',
          aggregateId: order.orderId,
          eventType: 'restaurant.refund_required',
          payload: { orderId: order.orderId, reason: outcome.reason },
        });
        return { outcome: 'mandatory_refund', orderId: order.orderId };
      }

      const advanced = await repository.transition({
        orderId: order.orderId,
        expectedRevision: order.revision,
        orderState: 'CONFIRMED',
        fulfillmentState: 'AWAITING_ACCEPTANCE',
        paymentState: 'PAID',
        paymentConfirmedAt: now,
      });
      if (!advanced) throw new ApiError('CONFLICT', 'that order changed under this capture');
      await repository.record({
        hotelId: order.hotelId,
        orderId: order.orderId,
        stayId: order.stayId,
        axis: 'order',
        eventType: 'order.confirmed',
        fromState: 'PENDING_PAYMENT',
        toState: 'CONFIRMED',
        actorRef: 'provider',
      });
      await appendOutboxEvent(uow, {
        aggregateType: 'restaurant_order',
        aggregateId: order.orderId,
        eventType: 'restaurant.order_confirmed',
        payload: {
          orderId: order.orderId,
          restaurantId: order.restaurantId,
          roomId: order.roomId,
        },
      });
      return { outcome: 'confirmed', orderId: order.orderId };
    });
  }

  // --------------------------------------------------------- the restaurant

  /**
   * `REST-DEC-003`: accepting an order means promising one of four ETAs.
   *
   * The lock is taken before the decision, so an acceptance racing a refund
   * request is settled by whichever commits first — and if the request won, the
   * order is already `CANCELLED` and this refuses.
   */
  async accept(
    input: { hotelId: string; orderId: string; etaMinutes: number; idempotencyKey: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<OrderView> {
    if (!isEtaChoice(input.etaMinutes)) {
      throw new ApiError('VALIDATION_FAILED', 'the ETA must be 15, 30, 45 or 60 minutes');
    }
    return this.onOwnOrder(
      input.hotelId,
      input.orderId,
      ORDER_PROCESS,
      actor,
      request,
      async (uow, order, gate) => {
        const claimed = await claim(uow, 'restaurant.accept', input.idempotencyKey, {
          orderId: input.orderId,
        });
        if (claimed.kind === 'replay') return claimed.body as OrderView;
        if (order.paymentState !== 'PAID') {
          throw new ApiError('CONFLICT', 'an unpaid order is not in the production queue');
        }
        if (order.fulfillmentState !== 'AWAITING_ACCEPTANCE') {
          // `REST-DEC-002`: a mandatory request that committed first has already
          // cancelled this, and there is nothing left to accept.
          throw new ApiError('CONFLICT', 'that order is no longer awaiting acceptance');
        }
        const now = this.now(uow);
        const promised = new Date(now.getTime() + input.etaMinutes * 60_000);
        const repository = new RestaurantRepository(uow);
        const moved = await repository.transition({
          orderId: order.orderId,
          expectedRevision: order.revision,
          fulfillmentState: 'ACCEPTED',
          acceptedAt: now,
          etaMinutes: input.etaMinutes,
          promisedReadyAt: promised,
        });
        if (!moved) throw new ApiError('CONFLICT', 'that order changed under this command');
        await repository.record({
          hotelId: order.hotelId,
          orderId: order.orderId,
          stayId: order.stayId,
          axis: 'fulfillment',
          eventType: 'fulfillment.accepted',
          fromState: 'AWAITING_ACCEPTANCE',
          toState: 'ACCEPTED',
          actorRef: gate.principal.accountId,
          reason: `eta ${String(input.etaMinutes)}m`,
        });
        const view = orderView(await this.reread(uow, order.orderId));
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, view);
        return view;
      },
    );
  }

  /** doc 08 §10: preparing, ready, out for delivery, and the real handovers. */
  async advance(
    input: {
      hotelId: string;
      orderId: string;
      to: FulfillmentState;
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<OrderView> {
    return this.onOwnOrder(
      input.hotelId,
      input.orderId,
      ORDER_PROCESS,
      actor,
      request,
      async (uow, order, gate) => {
        const claimed = await claim(uow, 'restaurant.fulfil', input.idempotencyKey, {
          orderId: input.orderId,
          to: input.to,
        });
        if (claimed.kind === 'replay') return claimed.body as OrderView;
        if (!advancesFulfillment(order.fulfillmentState, input.to)) {
          throw new ApiError('CONFLICT', 'that is not a step this order can take');
        }
        // doc 08 §19: a handover has to match the mode it was agreed under, and
        // the database refuses one that does not.
        const expected = terminalFor(order.handoffMode);
        if (isFulfillmentTerminal(input.to) && input.to !== 'CANCELLED' && input.to !== expected) {
          throw new ApiError(
            'CONFLICT',
            `HANDOFF_MISMATCH: this order is to be handed over as ${order.handoffMode}`,
          );
        }
        const repository = new RestaurantRepository(uow);
        const moved = await repository.transition({
          orderId: order.orderId,
          expectedRevision: order.revision,
          fulfillmentState: input.to,
          orderState: orderStateFor(input.to, order.paymentState),
        });
        if (!moved) throw new ApiError('CONFLICT', 'that order changed under this command');
        await repository.record({
          hotelId: order.hotelId,
          orderId: order.orderId,
          stayId: order.stayId,
          axis: 'fulfillment',
          eventType: `fulfillment.${input.to.toLowerCase()}`,
          fromState: order.fulfillmentState,
          toState: input.to,
          actorRef: gate.principal.accountId,
        });
        const view = orderView(await this.reread(uow, order.orderId));
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, view);
        return view;
      },
    );
  }

  /**
   * doc 08 §22: the restaurant cannot fulfil, so it owes the whole amount back.
   *
   * Mandatory and approved in the same transaction — there is no refusal to
   * offer, because the restaurant is the one refusing.
   */
  async cancelByRestaurant(
    input: { hotelId: string; orderId: string; idempotencyKey: string; reason?: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<OrderView> {
    return this.onOwnOrder(
      input.hotelId,
      input.orderId,
      ORDER_PROCESS,
      actor,
      request,
      async (uow, order, gate) => {
        const claimed = await claim(uow, 'restaurant.cancel', input.idempotencyKey, {
          orderId: input.orderId,
        });
        if (claimed.kind === 'replay') return claimed.body as OrderView;
        const now = this.now(uow);
        const outcome = requestOutcome(order, 'RESTAURANT_CANCEL', now);
        if (outcome.kind !== 'mandatory') {
          throw new ApiError('CONFLICT', 'that order cannot be cancelled now');
        }
        const view = await this.raiseRequest(uow, order, {
          policy: 'MANDATORY',
          requestState: 'APPROVED',
          reason: outcome.reason,
          actorRef: gate.principal.accountId,
          now,
          ...(input.reason === undefined ? {} : { note: input.reason }),
        });
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, view);
        return view;
      },
    );
  }

  /** doc 08 §21.1: the restaurant approves or refuses a discretionary request. */
  async decideRequest(
    input: {
      hotelId: string;
      orderId: string;
      decision: 'APPROVE' | 'REJECT';
      rejectReason?: 'PREPARATION_STARTED' | 'FOOD_READY' | 'OUT_FOR_DELIVERY' | 'HANDED_OVER';
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<OrderView> {
    return this.onOwnOrder(
      input.hotelId,
      input.orderId,
      ORDER_PROCESS,
      actor,
      request,
      async (uow, order, gate) => {
        const claimed = await claim(uow, 'restaurant.request_decision', input.idempotencyKey, {
          orderId: input.orderId,
          decision: input.decision,
        });
        if (claimed.kind === 'replay') return claimed.body as OrderView;
        if (order.refundRequestState !== 'OPEN') {
          throw new ApiError('CONFLICT', 'there is no open request on that order');
        }
        if (order.refundPolicy !== 'DISCRETIONARY') {
          // `REST-DEC-002`: a mandatory request carries no refusal.
          throw new ApiError('CONFLICT', 'a mandatory refund cannot be refused');
        }
        const repository = new RestaurantRepository(uow);
        const now = this.now(uow);
        if (input.decision === 'REJECT') {
          if (input.rejectReason === undefined) {
            throw new ApiError('VALIDATION_FAILED', 'a refusal states one of the four reasons');
          }
          const moved = await repository.transition({
            orderId: order.orderId,
            expectedRevision: order.revision,
            refundRequestState: 'REJECTED',
            rejectReason: input.rejectReason,
          });
          if (!moved) throw new ApiError('CONFLICT', 'that order changed under this command');
          await repository.record({
            hotelId: order.hotelId,
            orderId: order.orderId,
            stayId: order.stayId,
            axis: 'refund_request',
            eventType: 'request.rejected',
            fromState: 'OPEN',
            toState: 'REJECTED',
            actorRef: gate.principal.accountId,
            reason: input.rejectReason,
          });
        } else {
          // doc 08 §21.1: approving cancels the order unless it has already been
          // handed over, and moves no money by itself.
          const cancels = !isFulfillmentTerminal(order.fulfillmentState);
          const moved = await repository.transition({
            orderId: order.orderId,
            expectedRevision: order.revision,
            refundRequestState: 'APPROVED',
            ...(cancels ? { fulfillmentState: 'CANCELLED', orderState: 'CANCELLED' } : {}),
          });
          if (!moved) throw new ApiError('CONFLICT', 'that order changed under this command');
          await repository.record({
            hotelId: order.hotelId,
            orderId: order.orderId,
            stayId: order.stayId,
            axis: 'refund_request',
            eventType: 'request.approved',
            fromState: 'OPEN',
            toState: 'APPROVED',
            actorRef: gate.principal.accountId,
          });
        }
        void now;
        const view = orderView(await this.reread(uow, order.orderId));
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, view);
        return view;
      },
    );
  }

  // ------------------------------------------------- the request, and checkout

  /** doc 08 §20: the guest asks, once the action has opened. */
  async requestRefundAsGuest(
    input: { orderId: string; idempotencyKey: string },
    session: GuestSessionRow,
    request: RequestContext = newRestaurantRequest(),
  ): Promise<OrderView> {
    return this.inGuestScope(session.hotelId, session.stayId, request, async (uow) => {
      const claimed = await claim(uow, 'restaurant.guest_request', input.idempotencyKey, {
        orderId: input.orderId,
      });
      if (claimed.kind === 'replay') return claimed.body as OrderView;
      const repository = new RestaurantRepository(uow);
      const order = await repository.lockOrder(input.orderId);
      if (order === undefined || order.stayId !== session.stayId) {
        throw new ApiError('NOT_FOUND', 'no such order');
      }
      const view = await this.applyRequest(
        uow,
        order,
        'GUEST',
        `guest-session:${session.guestSessionId}`,
      );
      await completeIdempotencyKey(uow, claimed.idempotencyId, 200, view);
      return view;
    });
  }

  /** doc 08 §20: Reception asks on the guest's behalf, once it has opened. */
  async requestRefundAsReception(
    input: { hotelId: string; orderId: string; idempotencyKey: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<OrderView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      RECEPTION_CHECKOUT,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'restaurant.reception_request', input.idempotencyKey, {
          orderId: input.orderId,
        });
        if (claimed.kind === 'replay') return claimed.body as OrderView;
        await authorize();
        const order = await new RestaurantRepository(uow).lockOrder(input.orderId);
        if (order === undefined) throw new ApiError('NOT_FOUND', 'no such order');
        const view = await this.applyRequest(uow, order, 'RECEPTION', gate.principal.accountId);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, view);
        return view;
      },
    );
  }

  /**
   * `RC-DEC-029`: Reception records one of three choices per unfinished order.
   *
   * The choice is not a handover and not a refund: the first two say how the
   * order will be given to the guest, and the third raises a request the
   * restaurant still has to resolve.
   */
  async recordHandoff(
    input: {
      hotelId: string;
      orderId: string;
      mode: HandoffMode;
      idempotencyKey: string;
    },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<OrderView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      RECEPTION_CHECKOUT,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'restaurant.handoff', input.idempotencyKey, {
          orderId: input.orderId,
          mode: input.mode,
        });
        if (claimed.kind === 'replay') return claimed.body as OrderView;
        await authorize();
        const repository = new RestaurantRepository(uow);
        const order = await repository.lockOrder(input.orderId);
        if (order === undefined) throw new ApiError('NOT_FOUND', 'no such order');
        if (isFulfillmentTerminal(order.fulfillmentState)) {
          // doc 08 §8: an order that finished in the meantime needs no choice.
          throw new ApiError('CONFLICT', 'that order has already finished');
        }
        const now = this.now(uow);
        const moved = await repository.transition({
          orderId: order.orderId,
          expectedRevision: order.revision,
          handoffMode: input.mode,
          checkoutNotifiedAt: now,
        });
        if (!moved) throw new ApiError('CONFLICT', 'that order changed under this command');
        await repository.record({
          hotelId: order.hotelId,
          orderId: order.orderId,
          stayId: order.stayId,
          axis: 'handoff',
          eventType: 'handoff.recorded',
          fromState: order.handoffMode,
          toState: input.mode,
          actorRef: gate.principal.accountId,
        });
        await appendOutboxEvent(uow, {
          aggregateType: 'restaurant_order',
          aggregateId: order.orderId,
          eventType: 'restaurant.checkout_handoff',
          payload: { orderId: order.orderId, mode: input.mode },
        });

        let view = orderView(await this.reread(uow, order.orderId));
        if (input.mode === 'REFUND_REQUEST') {
          const relocked = await repository.lockOrder(order.orderId);
          if (relocked === undefined) throw new Error('the order vanished under its own lock');
          view = await this.applyRequest(uow, relocked, 'CHECKOUT', gate.principal.accountId);
        }
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, view);
        return view;
      },
    );
  }

  /** `RC-DEC-028`: the paid, unfinished orders Reception must be shown. */
  async unfinishedForStay(
    hotelId: string,
    stayId: string,
    request: RequestContext = newRestaurantRequest(),
  ): Promise<readonly OrderView[]> {
    return this.inHotelScope(hotelId, request, async (uow) => {
      const rows = await new RestaurantRepository(uow).unfinishedForStay(stayId);
      // Reception is shown the number to call, because doc 08 §8 asks for it by
      // name on this screen.
      return rows.map((row) => orderView(row, true));
    });
  }

  /** The guest's own orders, and only theirs. */
  async ordersForSession(
    session: GuestSessionRow,
    request: RequestContext = newRestaurantRequest(),
  ): Promise<readonly OrderView[]> {
    return this.inGuestScope(session.hotelId, session.stayId, request, async (uow) => {
      const rows = await new RestaurantRepository(uow).ordersForStay(session.stayId);
      // `RC-DEC-025`: the contact number is on the guest's own order and on no
      // other surface.
      return rows.map((row) => orderView(row, true));
    });
  }

  // ------------------------------------------------------------------ helpers

  private async applyRequest(
    uow: UnitOfWork,
    order: OrderRow,
    source: RequestSource,
    actorRef: string,
  ): Promise<OrderView> {
    const now = this.now(uow);
    const outcome = requestOutcome(order, source, now);
    if (outcome.kind === 'refused') {
      throw new ApiError(
        'PRECONDITION_FAILED',
        outcome.reason === 'TOO_EARLY'
          ? 'REQUEST_NOT_OPEN: a cancellation cannot be asked for yet'
          : outcome.reason === 'ALREADY_OPEN'
            ? 'REQUEST_EXISTS: this order already has a request'
            : 'ORDER_FINISHED: that order can no longer be cancelled',
      );
    }
    return this.raiseRequest(uow, order, {
      policy: outcome.kind === 'mandatory' ? 'MANDATORY' : 'DISCRETIONARY',
      requestState: outcome.kind === 'mandatory' ? 'APPROVED' : 'OPEN',
      reason: outcome.reason,
      actorRef,
      now,
    });
  }

  /**
   * Writes the request, and — where the policy is mandatory — cancels the order
   * in the same transaction (`REST-DEC-002`).
   *
   * A mandatory request approves itself. That is not the money moving: doc 08
   * §21 is explicit that approved means owed, and only the restaurant's own
   * refund reaching the provider makes it paid back.
   */
  private async raiseRequest(
    uow: UnitOfWork,
    order: OrderRow,
    input: {
      policy: 'MANDATORY' | 'DISCRETIONARY';
      requestState: 'APPROVED' | 'OPEN';
      reason: string;
      actorRef: string;
      now: Date;
      note?: string;
    },
  ): Promise<OrderView> {
    const repository = new RestaurantRepository(uow);
    const cancels = input.policy === 'MANDATORY' && !isFulfillmentTerminal(order.fulfillmentState);
    const moved = await repository.transition({
      orderId: order.orderId,
      expectedRevision: order.revision,
      refundPolicy: input.policy,
      refundRequestState: input.requestState,
      refundReason: input.reason,
      refundRequestedAt: input.now,
      ...(cancels ? { fulfillmentState: 'CANCELLED', orderState: 'CANCELLED' } : {}),
    });
    if (!moved) throw new ApiError('CONFLICT', 'that order changed under this command');
    await repository.record({
      hotelId: order.hotelId,
      orderId: order.orderId,
      stayId: order.stayId,
      axis: 'refund_request',
      eventType: `request.${input.requestState.toLowerCase()}`,
      fromState: 'NONE',
      toState: input.requestState,
      actorRef: input.actorRef,
      reason: input.note ?? input.reason,
    });
    await recordPlatformAudit(uow, {
      action: 'restaurant.refund_requested',
      outcome: 'allowed',
      targetType: 'restaurant_order',
      targetRef: order.orderId,
      payload: { policy: input.policy, reason: input.reason },
    });
    await appendOutboxEvent(uow, {
      aggregateType: 'restaurant_order',
      aggregateId: order.orderId,
      eventType: 'restaurant.refund_requested',
      payload: { orderId: order.orderId, policy: input.policy, reason: input.reason },
    });
    return orderView(await this.reread(uow, order.orderId));
  }

  private async mismatch(
    uow: UnitOfWork,
    order: OrderRow,
    field: string,
  ): Promise<{ outcome: string; orderId: string }> {
    await new RestaurantRepository(uow).record({
      hotelId: order.hotelId,
      orderId: order.orderId,
      stayId: order.stayId,
      axis: 'payment',
      eventType: 'payment.mismatch',
      fromState: order.paymentState,
      toState: order.paymentState,
      actorRef: 'provider',
      reason: field,
    });
    await recordPlatformAudit(uow, {
      action: 'restaurant.capture_mismatch',
      outcome: 'denied',
      targetType: 'restaurant_order',
      targetRef: order.orderId,
      payload: { field },
    });
    return { outcome: 'mismatch', orderId: order.orderId };
  }

  private async itemsStillLive(uow: UnitOfWork, orderId: string): Promise<boolean> {
    const result = await uow.query<{ stale: string }>(
      `SELECT count(*)::text AS stale
         FROM platform.restaurant_order_item oi
         JOIN platform.restaurant_menu_item mi ON mi.item_id = oi.item_id
        WHERE oi.order_id = $1 AND (mi.state <> 'ACTIVE' OR NOT mi.available)`,
      [orderId],
    );
    return Number(result.rows[0]?.stale ?? '0') === 0;
  }

  private async reread(uow: UnitOfWork, orderId: string): Promise<OrderRow> {
    const row = await new RestaurantRepository(uow).orderById(orderId);
    if (row === undefined) throw new Error('the order vanished under its own lock');
    return row;
  }

  /**
   * A restaurant command on an order of *its own* restaurant.
   *
   * The restaurant is read from the order and handed to the pipeline as the
   * target, so a Restaurant Manager of another restaurant is refused by the
   * Phase 04 scope comparison rather than by anything written here.
   */
  private async onOwnOrder<T>(
    hotelId: string,
    orderId: string,
    permission: string,
    actor: CommandActor,
    request: RequestContext,
    work: (
      uow: UnitOfWork,
      order: OrderRow,
      gate: Parameters<Parameters<RestaurantOrderService['runAuthorizedHotelCommand']>[4]>[1],
    ) => Promise<T>,
  ): Promise<T> {
    const restaurantId = await this.inHotelScope(hotelId, request, async (uow) => {
      const order = await new RestaurantRepository(uow).orderById(orderId);
      return order?.restaurantId;
    });
    if (restaurantId === undefined) throw new ApiError('NOT_FOUND', 'no such order');
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId, restaurantId },
      permission,
      request,
      async (uow, gate, authorize) => {
        const order = await new RestaurantRepository(uow).lockOrder(orderId);
        await authorize();
        if (order === undefined) throw new ApiError('NOT_FOUND', 'no such order');
        return work(uow, order, gate);
      },
    );
  }

  private async attemptOfInvoice(
    providerInvoiceId: string,
  ): Promise<{ attemptId: string; hotelId: string; orderId: string } | undefined> {
    const rows = await this.deps.pool.query<{
      attempt_id: string;
      hotel_id: string;
      order_id: string;
    }>(
      `SELECT attempt_id, hotel_id, order_id
         FROM platform.restaurant_attempt_of_invoice($1)`,
      [providerInvoiceId],
    );
    const row = rows.rows[0];
    if (row === undefined) return undefined;
    return { attemptId: row.attempt_id, hotelId: row.hotel_id, orderId: row.order_id };
  }
}

export const RESTAURANT_MENU_PERMISSION = MENU_MANAGE;
