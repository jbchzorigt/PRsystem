import {
  LocalKeyManagement,
  PaymentGatewayRegistry,
  SimulatedPaymentGateway,
} from '@prsystem/ports';
import type { PaymentGateways, PaymentProvider } from '@prsystem/ports';
import type { CommandActor } from '../../iam/services/iam-context';
import type { StayHarness, StayHotel } from '../../stay/test-support/stay-harness';
import {
  createStayHarness,
  key,
  request,
  syntheticGuest,
} from '../../stay/test-support/stay-harness';
import { RepositoryRestaurantOrders } from '../contracts/stay-checkout';
import { RepositoryStayFacts } from '../contracts/stay-facts';
import type { RestaurantDependencies } from '../services/restaurant-context';
import { newRestaurantRequest } from '../services/restaurant-context';
import { GuestAccessService } from '../services/guest-access.service';
import { RestaurantAdminService } from '../services/restaurant.service';
import { RestaurantOrderService } from '../services/order.service';
import { RestaurantRefundService } from '../services/refund.service';
import { RestaurantExpiryService } from '../services/expiry.service';

/**
 * The Phase 15 harness: the stay harness — which already gives a hotel, rooms,
 * Reception and a real check-in — plus the restaurant services over the same
 * pool and the same movable clock.
 *
 * The checkout is wired to the **real** `RepositoryRestaurantOrders`, not the
 * simulator, so what a checkout refuses and what it closes is this module's own
 * SQL rather than a stub that happens to agree with it.
 *
 * Every hotel here is on `P30`, because doc 08 §3 puts the whole module inside
 * the 30,000₮ entitlement; a test that needs the refusal asks for a smaller
 * package explicitly.
 */

export interface RestaurantFixture {
  readonly hotel: StayHotel;
  readonly restaurantId: string;
  readonly linkId: string;
  /** The Restaurant Manager, scoped to this restaurant and no other. */
  readonly manager: CommandActor;
  readonly categoryId: string;
  /** One item, priced, available. */
  readonly itemId: string;
  readonly priceMnt: bigint;
  /** Adds another item to the same category. */
  addItem(name: string, priceMnt: bigint): Promise<string>;
}

export interface StayFixture {
  readonly stayId: string;
  readonly roomId: string;
  readonly hotelId: string;
}

export interface RestaurantHarness {
  readonly stay: StayHarness;
  readonly deps: RestaurantDependencies;
  readonly admin: StayHarness['admin'];
  readonly api: StayHarness['api'];
  readonly restaurants: RestaurantAdminService;
  readonly access: GuestAccessService;
  readonly orders: RestaurantOrderService;
  readonly refunds: RestaurantRefundService;
  readonly expiry: RestaurantExpiryService;
  gateway(provider?: PaymentProvider): SimulatedPaymentGateway;
  /** A P30 hotel with a registered, linked restaurant open around the clock. */
  restaurant(name: string, options?: { open?: boolean }): Promise<RestaurantFixture>;
  /** A guest checked into a clean room of that hotel. */
  stayIn(fixture: RestaurantFixture): Promise<StayFixture>;
  /** The room QR, a Reception code, and the session they open together. */
  session(
    fixture: RestaurantFixture,
    stay: StayFixture,
  ): Promise<{ token: string; guestSessionId: string }>;
  /** Places one order and pays it through the simulator. */
  paidOrder(
    fixture: RestaurantFixture,
    stay: StayFixture,
    session: { token: string },
  ): Promise<{ orderId: string; orderNo: string; totalAmountMnt: bigint }>;
  /** Moves the server's now for every restaurant and stay command. */
  advance(minutes: number): void;
  resetClock(): void;
  now(): Date;
  close(): Promise<void>;
}

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  closed: false,
  opensAt: '00:00:00',
  // 23:59 rather than midnight: doc 08 §5's window is a wall-clock pair, and a
  // closing equal to the opening would be a zero-length day.
  closesAt: '23:59:00',
}));

export async function createRestaurantHarness(suite: string): Promise<RestaurantHarness> {
  const stay = await createStayHarness(suite, {
    restaurantOrders: new RepositoryRestaurantOrders(),
  });
  let offsetMs = 0;
  const clock = (): Date => new Date(Date.now() + offsetMs);
  const simulators = new Map<PaymentProvider, SimulatedPaymentGateway>([
    ['QPAY', new SimulatedPaymentGateway('QPAY')],
    ['KHAAN', new SimulatedPaymentGateway('KHAAN')],
  ]);
  const payments: PaymentGateways = new PaymentGatewayRegistry(simulators);
  const deps: RestaurantDependencies = {
    pool: stay.api,
    subscription: stay.minibar.catalog.subscription,
    payments,
    keys: new LocalKeyManagement({ appEnv: 'test', seed: `synthetic-restaurant-${suite}` }),
    stays: new RepositoryStayFacts(),
    clock,
  };
  const restaurants = new RestaurantAdminService(deps);
  const access = new GuestAccessService(deps);
  const orders = new RestaurantOrderService(deps);
  let sequence = 0;
  const withShift = new Set<string>();

  return {
    stay,
    deps,
    admin: stay.admin,
    api: stay.api,
    restaurants,
    access,
    orders,
    refunds: new RestaurantRefundService(deps),
    expiry: new RestaurantExpiryService(deps),

    gateway(provider = 'QPAY') {
      const simulator = simulators.get(provider);
      if (simulator === undefined) throw new Error(`no simulator for ${provider}`);
      return simulator;
    },

    async restaurant(name, options = {}) {
      sequence += 1;
      const suffix = `${String(sequence).padStart(3, '0')}-${suite}`;
      const hotel = await stay.hotel(name, 'P30');
      const managerPlusMember = await stay.seed(hotel.hotelId, `mplus-${suffix}@rest.test`, [
        'MANAGER_PLUS',
      ]);
      const managerPlus = await stay.actorFor(managerPlusMember);
      const registered = await restaurants.register(
        {
          hotelId: hotel.hotelId,
          displayName: `${name} Restaurant`,
          cuisineKind: 'MONGOLIAN',
          addressLine: 'Улаанбаатар, Сүхбаатар дүүрэг',
          latitudeMicro: 47_918_000,
          longitudeMicro: 106_917_000,
          contactPhone: '+97699001122',
          idempotencyKey: key('reg'),
        },
        managerPlus,
        request(managerPlus),
      );
      // `RBAC-DEC-016`: the Restaurant Manager's membership carries the
      // restaurant, and `own_restaurant` is what compares the two.
      const managerMember = await stay.minibar.catalog.iam.seedMembership({
        hotelId: hotel.hotelId,
        email: `rmanager-${suffix}@rest.test`,
        roles: ['RESTAURANT_MANAGER'],
        restaurantId: registered.restaurantId,
      });
      const manager = await stay.actorFor(managerMember);
      if (options.open !== false) {
        await restaurants.setSchedule(
          {
            hotelId: hotel.hotelId,
            restaurantId: registered.restaurantId,
            days: ALL_DAY,
            idempotencyKey: key('sched'),
          },
          manager,
          request(manager),
        );
      }
      const category = await restaurants.addCategory(
        {
          hotelId: hotel.hotelId,
          restaurantId: registered.restaurantId,
          name: 'Үндсэн хоол',
          idempotencyKey: key('cat'),
        },
        manager,
        request(manager),
      );
      const priceMnt = 12_000n;
      const item = await restaurants.addItem(
        {
          hotelId: hotel.hotelId,
          restaurantId: registered.restaurantId,
          menuCategoryId: category.menuCategoryId,
          name: 'Цуйван',
          priceMnt,
          idempotencyKey: key('item'),
        },
        manager,
        request(manager),
      );
      return {
        hotel,
        restaurantId: registered.restaurantId,
        linkId: registered.linkId,
        manager,
        categoryId: category.menuCategoryId,
        itemId: item.itemId,
        priceMnt,
        async addItem(itemName, itemPrice) {
          const added = await restaurants.addItem(
            {
              hotelId: hotel.hotelId,
              restaurantId: registered.restaurantId,
              menuCategoryId: category.menuCategoryId,
              name: itemName,
              priceMnt: itemPrice,
              idempotencyKey: key('item'),
            },
            manager,
            request(manager),
          );
          return added.itemId;
        },
      };
    },

    async stayIn(fixture) {
      const roomId = await fixture.hotel.cleanRoom();
      // doc 24 §2: a check-in needs an open Reception shift. One per hotel is
      // enough, and opening a second is refused, so this is idempotent by
      // catching that refusal rather than by remembering.
      if (!withShift.has(fixture.hotel.hotelId)) {
        withShift.add(fixture.hotel.hotelId);
        await stay.shifts.open(
          {
            hotelId: fixture.hotel.hotelId,
            idempotencyKey: key('shift'),
            openingCountedMnt: 0n,
          },
          fixture.hotel.reception,
          request(fixture.hotel.reception),
        );
      }
      const confirmed = await stay.checkIns.checkIn(
        {
          hotelId: fixture.hotel.hotelId,
          roomId,
          idempotencyKey: key('ci'),
          source: 'WALK_IN',
          stayType: 'NIGHTLY',
          nightCount: 1,
          guest: syntheticGuest(),
        },
        fixture.hotel.reception,
        request(fixture.hotel.reception),
      );
      return { stayId: confirmed.stayId, roomId, hotelId: fixture.hotel.hotelId };
    },

    async session(fixture, stayFixture) {
      const qr = await access.issueRoomToken(
        {
          hotelId: fixture.hotel.hotelId,
          roomId: stayFixture.roomId,
          idempotencyKey: key('qr'),
        },
        fixture.hotel.manager,
        request(fixture.hotel.manager),
      );
      const code = await access.issueGuestCode(
        {
          hotelId: fixture.hotel.hotelId,
          stayId: stayFixture.stayId,
          idempotencyKey: key('code'),
        },
        fixture.hotel.reception,
        request(fixture.hotel.reception),
      );
      const opened = await access.openSession({ roomToken: qr.token, code: code.code });
      return { token: opened.token, guestSessionId: opened.guestSessionId };
    },

    async paidOrder(fixture, _stayFixture, session) {
      const resolved = await access.resolveSession(session.token);
      if (resolved === undefined) throw new Error('the harness session did not resolve');
      const placed = await orders.placeOrder(
        {
          restaurantId: fixture.restaurantId,
          lines: [{ itemId: fixture.itemId, quantity: 1 }],
          idempotencyKey: key('order'),
        },
        resolved,
      );
      const invoice = await orders.openInvoice({ orderId: placed.orderId }, resolved);
      void invoice;
      const attempt = await stay.admin.query<{ provider_invoice_id: string }>(
        `SELECT provider_invoice_id FROM platform.restaurant_payment_attempt
          WHERE order_id = $1 AND state = 'ACTIVE'`,
        [placed.orderId],
      );
      const providerInvoiceId = attempt.rows[0]?.provider_invoice_id;
      if (providerInvoiceId === undefined) throw new Error('no live invoice to pay');
      const simulator = simulators.get('QPAY');
      if (simulator === undefined) throw new Error('the QPAY simulator is missing');
      const providerPaymentId = simulator.pay(providerInvoiceId, clock());
      const outcome = await orders.handleCallback(
        {
          provider: 'QPAY',
          providerInvoiceId,
          providerPaymentId,
          signature: simulator.signatureFor(providerInvoiceId),
        },
        newRestaurantRequest(),
      );
      if (outcome.outcome !== 'confirmed') {
        throw new Error(`the payment did not apply: ${outcome.outcome}`);
      }
      return {
        orderId: placed.orderId,
        orderNo: placed.orderNo,
        totalAmountMnt: placed.totalAmountMnt,
      };
    },

    advance(minutes) {
      offsetMs = minutes * 60_000;
      stay.travel(minutes);
    },

    resetClock() {
      offsetMs = 0;
      stay.travel(0);
    },

    now: clock,

    close() {
      return stay.close();
    },
  };
}

export { key, request };
