import type { UnitOfWork } from '@prsystem/db';
import type {
  DayOverride,
  DaySchedule,
  FulfillmentState,
  HandoffMode,
  OrderState,
  RefundPolicy,
  RefundRequestState,
  RestaurantPaymentState,
  RestaurantRefundState,
} from '../domain/restaurant';

/**
 * The restaurant module's own tables (doc 08 §§3–11).
 *
 * Two habits run through it. Every row that decides something is taken `FOR
 * UPDATE` before it is judged — the acceptance race of `REST-DEC-002` is
 * resolved by the order's own lock and by nothing else. And the guest-access
 * counter is locked before either half of its allowance moves, so two codes
 * confirmed at the same instant cannot both find room.
 */

export interface RestaurantRow {
  readonly restaurantId: string;
  readonly hotelId: string;
  readonly displayName: string;
  readonly cuisineKind: string;
  readonly contactPhone: string;
  readonly timezone: string;
  readonly state: 'ACTIVE' | 'SUSPENDED';
  readonly revision: number;
}

export interface LinkRow {
  readonly linkId: string;
  readonly hotelId: string;
  readonly restaurantId: string;
  readonly linkState: 'ACTIVE' | 'INACTIVE';
  readonly slaPaused: boolean;
  readonly revision: number;
}

export interface MenuItemRow {
  readonly itemId: string;
  readonly restaurantId: string;
  readonly menuCategoryId: string;
  readonly name: string;
  readonly priceMnt: bigint;
  readonly available: boolean;
  readonly state: 'ACTIVE' | 'INACTIVE';
  readonly revision: number;
}

export interface AccessCounterRow {
  readonly stayId: string;
  readonly hotelId: string;
  readonly roomId: string;
  readonly activeSessions: number;
  readonly pendingCodes: number;
  readonly closedAt: Date | null;
  readonly revision: number;
}

export interface AccessCodeRow {
  readonly codeId: string;
  readonly hotelId: string;
  readonly stayId: string;
  readonly roomId: string;
  readonly state: 'PENDING' | 'USED' | 'REVOKED' | 'EXPIRED';
  readonly attempts: number;
  readonly expiresAt: Date;
  readonly revision: number;
}

export interface GuestSessionRow {
  readonly guestSessionId: string;
  readonly hotelId: string;
  readonly stayId: string;
  readonly roomId: string;
  readonly state: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  readonly expiresAt: Date;
  readonly revision: number;
}

export interface OrderRow {
  readonly orderId: string;
  readonly hotelId: string;
  readonly restaurantId: string;
  readonly stayId: string;
  readonly roomId: string;
  readonly guestSessionId: string;
  readonly orderNo: string;
  readonly totalAmountMnt: bigint;
  readonly contactPhoneSnapshot: string;
  readonly orderingClosesAt: Date;
  readonly orderState: OrderState;
  readonly fulfillmentState: FulfillmentState;
  readonly paymentState: RestaurantPaymentState;
  readonly refundPolicy: RefundPolicy;
  readonly refundRequestState: RefundRequestState;
  readonly refundState: RestaurantRefundState;
  readonly handoffMode: HandoffMode;
  readonly refundReason: string | null;
  readonly paymentConfirmedAt: Date | null;
  readonly acceptedAt: Date | null;
  readonly etaMinutes: number | null;
  readonly promisedReadyAt: Date | null;
  readonly refundRequestedAt: Date | null;
  readonly revision: number;
}

export interface AttemptRow {
  readonly attemptId: string;
  readonly hotelId: string;
  readonly orderId: string;
  readonly restaurantId: string;
  readonly providerInvoiceId: string | null;
  readonly providerPaymentId: string | null;
  readonly amountMnt: bigint;
  readonly state: 'ACTIVE' | 'PAID' | 'FAILED' | 'EXPIRED';
  readonly orderingClosesAt: Date;
  readonly expiresAt: Date;
  readonly revision: number;
}

export interface RefundRow {
  readonly refundId: string;
  readonly hotelId: string;
  readonly orderId: string;
  readonly restaurantId: string;
  readonly amountMnt: bigint;
  readonly state: 'PENDING' | 'REFUNDED' | 'FAILED';
  readonly providerPaymentId: string;
  readonly providerRefundId: string | null;
  readonly revision: number;
}

const RESTAURANT_COLUMNS = `restaurant_id, hotel_id, display_name, cuisine_kind, contact_phone,
                            timezone, state, revision`;
const LINK_COLUMNS = `link_id, hotel_id, restaurant_id, link_state, sla_paused, revision`;
const ITEM_COLUMNS = `item_id, restaurant_id, menu_category_id, name, price_mnt, available, state,
                      revision`;
const COUNTER_COLUMNS = `stay_id, hotel_id, room_id, active_sessions, pending_codes, closed_at,
                         revision`;
const CODE_COLUMNS = `code_id, hotel_id, stay_id, room_id, state, attempts, expires_at, revision`;
const SESSION_COLUMNS = `guest_session_id, hotel_id, stay_id, room_id, state, expires_at, revision`;
const ORDER_COLUMNS = `order_id, hotel_id, restaurant_id, stay_id, room_id, guest_session_id,
                       order_no, total_amount_mnt, contact_phone_snapshot, ordering_closes_at,
                       order_state, fulfillment_state, payment_state, refund_policy,
                       refund_request_state, refund_state, handoff_mode, refund_reason,
                       payment_confirmed_at, accepted_at, eta_minutes, promised_ready_at,
                       refund_requested_at, revision`;
const ATTEMPT_COLUMNS = `attempt_id, hotel_id, order_id, restaurant_id, provider_invoice_id,
                         provider_payment_id, amount_mnt, state, ordering_closes_at, expires_at,
                         revision`;
const REFUND_COLUMNS = `refund_id, hotel_id, order_id, restaurant_id, amount_mnt, state,
                        provider_payment_id, provider_refund_id, revision`;

type Row = Record<string, unknown>;

const big = (value: unknown): bigint => BigInt(String(value));

function mapRestaurant(row: Row | undefined): RestaurantRow | undefined {
  if (row === undefined) return undefined;
  return {
    restaurantId: row['restaurant_id'] as string,
    hotelId: row['hotel_id'] as string,
    displayName: row['display_name'] as string,
    cuisineKind: row['cuisine_kind'] as string,
    contactPhone: row['contact_phone'] as string,
    timezone: row['timezone'] as string,
    state: row['state'] as RestaurantRow['state'],
    revision: Number(row['revision']),
  };
}

function mapLink(row: Row | undefined): LinkRow | undefined {
  if (row === undefined) return undefined;
  return {
    linkId: row['link_id'] as string,
    hotelId: row['hotel_id'] as string,
    restaurantId: row['restaurant_id'] as string,
    linkState: row['link_state'] as LinkRow['linkState'],
    slaPaused: row['sla_paused'] === true,
    revision: Number(row['revision']),
  };
}

function mapItem(row: Row | undefined): MenuItemRow | undefined {
  if (row === undefined) return undefined;
  return {
    itemId: row['item_id'] as string,
    restaurantId: row['restaurant_id'] as string,
    menuCategoryId: row['menu_category_id'] as string,
    name: row['name'] as string,
    priceMnt: big(row['price_mnt']),
    available: row['available'] === true,
    state: row['state'] as MenuItemRow['state'],
    revision: Number(row['revision']),
  };
}

function mapCounter(row: Row | undefined): AccessCounterRow | undefined {
  if (row === undefined) return undefined;
  return {
    stayId: row['stay_id'] as string,
    hotelId: row['hotel_id'] as string,
    roomId: row['room_id'] as string,
    activeSessions: Number(row['active_sessions']),
    pendingCodes: Number(row['pending_codes']),
    closedAt: (row['closed_at'] as Date | null) ?? null,
    revision: Number(row['revision']),
  };
}

function mapCode(row: Row | undefined): AccessCodeRow | undefined {
  if (row === undefined) return undefined;
  return {
    codeId: row['code_id'] as string,
    hotelId: row['hotel_id'] as string,
    stayId: row['stay_id'] as string,
    roomId: row['room_id'] as string,
    state: row['state'] as AccessCodeRow['state'],
    attempts: Number(row['attempts']),
    expiresAt: row['expires_at'] as Date,
    revision: Number(row['revision']),
  };
}

function mapSession(row: Row | undefined): GuestSessionRow | undefined {
  if (row === undefined) return undefined;
  return {
    guestSessionId: row['guest_session_id'] as string,
    hotelId: row['hotel_id'] as string,
    stayId: row['stay_id'] as string,
    roomId: row['room_id'] as string,
    state: row['state'] as GuestSessionRow['state'],
    expiresAt: row['expires_at'] as Date,
    revision: Number(row['revision']),
  };
}

function mapOrder(row: Row | undefined): OrderRow | undefined {
  if (row === undefined) return undefined;
  return {
    orderId: row['order_id'] as string,
    hotelId: row['hotel_id'] as string,
    restaurantId: row['restaurant_id'] as string,
    stayId: row['stay_id'] as string,
    roomId: row['room_id'] as string,
    guestSessionId: row['guest_session_id'] as string,
    orderNo: row['order_no'] as string,
    totalAmountMnt: big(row['total_amount_mnt']),
    contactPhoneSnapshot: row['contact_phone_snapshot'] as string,
    orderingClosesAt: row['ordering_closes_at'] as Date,
    orderState: row['order_state'] as OrderState,
    fulfillmentState: row['fulfillment_state'] as FulfillmentState,
    paymentState: row['payment_state'] as RestaurantPaymentState,
    refundPolicy: row['refund_policy'] as RefundPolicy,
    refundRequestState: row['refund_request_state'] as RefundRequestState,
    refundState: row['refund_state'] as RestaurantRefundState,
    handoffMode: row['handoff_mode'] as HandoffMode,
    refundReason: (row['refund_reason'] as string | null) ?? null,
    paymentConfirmedAt: (row['payment_confirmed_at'] as Date | null) ?? null,
    acceptedAt: (row['accepted_at'] as Date | null) ?? null,
    etaMinutes: row['eta_minutes'] === null ? null : Number(row['eta_minutes']),
    promisedReadyAt: (row['promised_ready_at'] as Date | null) ?? null,
    refundRequestedAt: (row['refund_requested_at'] as Date | null) ?? null,
    revision: Number(row['revision']),
  };
}

function mapAttempt(row: Row | undefined): AttemptRow | undefined {
  if (row === undefined) return undefined;
  return {
    attemptId: row['attempt_id'] as string,
    hotelId: row['hotel_id'] as string,
    orderId: row['order_id'] as string,
    restaurantId: row['restaurant_id'] as string,
    providerInvoiceId: (row['provider_invoice_id'] as string | null) ?? null,
    providerPaymentId: (row['provider_payment_id'] as string | null) ?? null,
    amountMnt: big(row['amount_mnt']),
    state: row['state'] as AttemptRow['state'],
    orderingClosesAt: row['ordering_closes_at'] as Date,
    expiresAt: row['expires_at'] as Date,
    revision: Number(row['revision']),
  };
}

function mapRefund(row: Row | undefined): RefundRow | undefined {
  if (row === undefined) return undefined;
  return {
    refundId: row['refund_id'] as string,
    hotelId: row['hotel_id'] as string,
    orderId: row['order_id'] as string,
    restaurantId: row['restaurant_id'] as string,
    amountMnt: big(row['amount_mnt']),
    state: row['state'] as RefundRow['state'],
    providerPaymentId: row['provider_payment_id'] as string,
    providerRefundId: (row['provider_refund_id'] as string | null) ?? null,
    revision: Number(row['revision']),
  };
}

export class RestaurantRepository {
  constructor(private readonly uow: UnitOfWork) {}

  // --------------------------------------------------------------- restaurant

  async createRestaurant(input: {
    hotelId: string;
    displayName: string;
    cuisineKind: string;
    description: string | null;
    addressLine: string;
    latitudeMicro: number;
    longitudeMicro: number;
    contactPhone: string;
  }): Promise<RestaurantRow> {
    const result = await this.uow.query<Row>(
      `INSERT INTO platform.restaurant
         (hotel_id, display_name, cuisine_kind, description, address_line, latitude_micro,
          longitude_micro, contact_phone)
       VALUES ($1::uuid, $2, $3, $4::text, $5, $6, $7, $8)
       RETURNING ${RESTAURANT_COLUMNS}`,
      [
        input.hotelId,
        input.displayName,
        input.cuisineKind,
        input.description,
        input.addressLine,
        input.latitudeMicro,
        input.longitudeMicro,
        input.contactPhone,
      ],
    );
    const row = mapRestaurant(result.rows[0]);
    if (row === undefined) throw new Error('the restaurant insert returned no row');
    return row;
  }

  async restaurantById(restaurantId: string): Promise<RestaurantRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${RESTAURANT_COLUMNS} FROM platform.restaurant WHERE restaurant_id = $1`,
      [restaurantId],
    );
    return mapRestaurant(result.rows[0]);
  }

  async updateContactPhone(input: {
    restaurantId: string;
    expectedRevision: number;
    contactPhone: string;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.restaurant SET contact_phone = $3, revision = revision + 1
        WHERE restaurant_id = $1 AND revision = $2`,
      [input.restaurantId, input.expectedRevision, input.contactPhone],
    );
    return (result.rowCount ?? 0) === 1;
  }

  // ---------------------------------------------------------------- the link

  async createLink(input: { hotelId: string; restaurantId: string }): Promise<LinkRow> {
    const result = await this.uow.query<Row>(
      `INSERT INTO platform.hotel_restaurant_link (hotel_id, restaurant_id)
       VALUES ($1::uuid, $2::uuid)
       RETURNING ${LINK_COLUMNS}`,
      [input.hotelId, input.restaurantId],
    );
    const row = mapLink(result.rows[0]);
    if (row === undefined) throw new Error('the link insert returned no row');
    return row;
  }

  async linkFor(restaurantId: string): Promise<LinkRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${LINK_COLUMNS} FROM platform.hotel_restaurant_link WHERE restaurant_id = $1`,
      [restaurantId],
    );
    return mapLink(result.rows[0]);
  }

  async lockLink(restaurantId: string): Promise<LinkRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${LINK_COLUMNS} FROM platform.hotel_restaurant_link
        WHERE restaurant_id = $1 FOR UPDATE`,
      [restaurantId],
    );
    return mapLink(result.rows[0]);
  }

  async updateLink(input: {
    linkId: string;
    expectedRevision: number;
    linkState?: 'ACTIVE' | 'INACTIVE';
    slaPaused?: boolean;
    slaPausedReason?: string | null;
    slaPausedAt?: Date | null;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.hotel_restaurant_link
          SET link_state = coalesce($3::text, link_state),
              sla_paused = coalesce($4::boolean, sla_paused),
              sla_paused_at = CASE WHEN $4::boolean IS NULL THEN sla_paused_at
                                   WHEN $4::boolean THEN coalesce($5::timestamptz, now())
                                   ELSE NULL END,
              sla_paused_reason = CASE WHEN $4::boolean IS NULL THEN sla_paused_reason
                                       WHEN $4::boolean THEN $6::text
                                       ELSE NULL END,
              revision = revision + 1
        WHERE link_id = $1 AND revision = $2`,
      [
        input.linkId,
        input.expectedRevision,
        input.linkState ?? null,
        input.slaPaused ?? null,
        input.slaPausedAt ?? null,
        input.slaPausedReason ?? null,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  // ------------------------------------------------------------- the schedule

  async setWeek(input: {
    hotelId: string;
    restaurantId: string;
    days: readonly DaySchedule[];
  }): Promise<void> {
    for (const day of input.days) {
      await this.uow.query(
        `INSERT INTO platform.restaurant_schedule
           (hotel_id, restaurant_id, weekday, closed, opens_at, closes_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::time, $6::time)
         ON CONFLICT (restaurant_id, weekday) DO UPDATE
            SET closed = EXCLUDED.closed, opens_at = EXCLUDED.opens_at,
                closes_at = EXCLUDED.closes_at,
                revision = platform.restaurant_schedule.revision + 1`,
        [input.hotelId, input.restaurantId, day.weekday, day.closed, day.opensAt, day.closesAt],
      );
    }
  }

  async week(restaurantId: string): Promise<readonly DaySchedule[]> {
    const result = await this.uow.query<Row>(
      `SELECT weekday, closed, opens_at::text AS opens_at, closes_at::text AS closes_at
         FROM platform.restaurant_schedule WHERE restaurant_id = $1 ORDER BY weekday`,
      [restaurantId],
    );
    return result.rows.map((row) => ({
      weekday: Number(row['weekday']),
      closed: row['closed'] === true,
      opensAt: (row['opens_at'] as string | null) ?? null,
      closesAt: (row['closes_at'] as string | null) ?? null,
    }));
  }

  async addOverride(input: {
    hotelId: string;
    restaurantId: string;
    localDate: string;
    closed: boolean;
    opensAt: string | null;
    closesAt: string | null;
    reason: string | null;
  }): Promise<void> {
    await this.uow.query(
      `INSERT INTO platform.restaurant_schedule_override
         (hotel_id, restaurant_id, local_date, closed, opens_at, closes_at, reason)
       VALUES ($1::uuid, $2::uuid, $3::date, $4, $5::time, $6::time, $7::text)`,
      [
        input.hotelId,
        input.restaurantId,
        input.localDate,
        input.closed,
        input.opensAt,
        input.closesAt,
        input.reason,
      ],
    );
  }

  async overrides(restaurantId: string): Promise<readonly DayOverride[]> {
    const result = await this.uow.query<Row>(
      `SELECT to_char(local_date, 'YYYY-MM-DD') AS local_date, closed,
              opens_at::text AS opens_at, closes_at::text AS closes_at
         FROM platform.restaurant_schedule_override WHERE restaurant_id = $1`,
      [restaurantId],
    );
    return result.rows.map((row) => ({
      localDate: row['local_date'] as string,
      closed: row['closed'] === true,
      opensAt: (row['opens_at'] as string | null) ?? null,
      closesAt: (row['closes_at'] as string | null) ?? null,
    }));
  }

  // ----------------------------------------------------------------- the menu

  async createCategory(input: {
    hotelId: string;
    restaurantId: string;
    name: string;
    sortOrder: number;
  }): Promise<string> {
    const result = await this.uow.query<Row>(
      `INSERT INTO platform.restaurant_menu_category (hotel_id, restaurant_id, name, sort_order)
       VALUES ($1::uuid, $2::uuid, $3, $4)
       RETURNING menu_category_id`,
      [input.hotelId, input.restaurantId, input.name, input.sortOrder],
    );
    return result.rows[0]?.['menu_category_id'] as string;
  }

  async createItem(input: {
    hotelId: string;
    restaurantId: string;
    menuCategoryId: string;
    name: string;
    description: string | null;
    priceMnt: bigint;
  }): Promise<MenuItemRow> {
    const result = await this.uow.query<Row>(
      `INSERT INTO platform.restaurant_menu_item
         (hotel_id, restaurant_id, menu_category_id, name, description, price_mnt)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::text, $6::bigint)
       RETURNING ${ITEM_COLUMNS}`,
      [
        input.hotelId,
        input.restaurantId,
        input.menuCategoryId,
        input.name,
        input.description,
        input.priceMnt.toString(),
      ],
    );
    const row = mapItem(result.rows[0]);
    if (row === undefined) throw new Error('the menu item insert returned no row');
    return row;
  }

  async updateItem(input: {
    itemId: string;
    expectedRevision: number;
    available?: boolean;
    state?: 'ACTIVE' | 'INACTIVE';
    priceMnt?: bigint;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.restaurant_menu_item
          SET available = coalesce($3::boolean, available),
              state = coalesce($4::text, state),
              price_mnt = coalesce($5::bigint, price_mnt),
              revision = revision + 1
        WHERE item_id = $1 AND revision = $2`,
      [
        input.itemId,
        input.expectedRevision,
        input.available ?? null,
        input.state ?? null,
        input.priceMnt === undefined ? null : input.priceMnt.toString(),
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /** The menu a guest is shown: live items of a live category, in order. */
  async menuOf(restaurantId: string): Promise<readonly MenuItemRow[]> {
    const result = await this.uow.query<Row>(
      `SELECT i.item_id, i.restaurant_id, i.menu_category_id, i.name, i.price_mnt, i.available,
              i.state, i.revision
         FROM platform.restaurant_menu_item i
         JOIN platform.restaurant_menu_category c ON c.menu_category_id = i.menu_category_id
        WHERE i.restaurant_id = $1 AND i.state = 'ACTIVE' AND c.state = 'ACTIVE'
        ORDER BY c.sort_order, i.name`,
      [restaurantId],
    );
    return result.rows
      .map((row) => mapItem(row))
      .filter((row): row is MenuItemRow => row !== undefined);
  }

  /**
   * The items a basket names, locked in a fixed order.
   *
   * The lock matters: doc 08 §11 makes an item going out of stock between the
   * price being read and the order being written a real case, and a fixed order
   * is what keeps two baskets sharing an item from deadlocking.
   */
  async lockItems(itemIds: readonly string[]): Promise<readonly MenuItemRow[]> {
    if (itemIds.length === 0) return [];
    const result = await this.uow.query<Row>(
      `SELECT ${ITEM_COLUMNS} FROM platform.restaurant_menu_item
        WHERE item_id = ANY ($1::uuid[]) ORDER BY item_id FOR UPDATE`,
      [[...itemIds].sort()],
    );
    return result.rows
      .map((row) => mapItem(row))
      .filter((row): row is MenuItemRow => row !== undefined);
  }

  // ------------------------------------------------------------ guest access

  async issueRoomToken(input: {
    hotelId: string;
    roomId: string;
    tokenHash: string;
    version: number;
  }): Promise<string> {
    const result = await this.uow.query<Row>(
      `INSERT INTO platform.room_access_token (hotel_id, room_id, token_hash, token_version)
       VALUES ($1::uuid, $2::uuid, $3, $4)
       RETURNING room_access_id`,
      [input.hotelId, input.roomId, input.tokenHash, input.version],
    );
    return result.rows[0]?.['room_access_id'] as string;
  }

  async rotateRoomToken(roomId: string, at: Date): Promise<number> {
    const result = await this.uow.query<Row>(
      `UPDATE platform.room_access_token
          SET state = 'ROTATED', rotated_at = $2, revision = revision + 1
        WHERE room_id = $1 AND state = 'ACTIVE'
        RETURNING token_version`,
      [roomId, at],
    );
    return Number(result.rows[0]?.['token_version'] ?? 0);
  }

  /** The counter `RC-DEC-027` enforces the allowance on, created on first use. */
  async lockAccessCounter(input: {
    hotelId: string;
    stayId: string;
    roomId: string;
  }): Promise<AccessCounterRow> {
    await this.uow.query(
      `INSERT INTO platform.stay_guest_access (stay_id, hotel_id, room_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid)
       ON CONFLICT (stay_id) DO NOTHING`,
      [input.stayId, input.hotelId, input.roomId],
    );
    const result = await this.uow.query<Row>(
      `SELECT ${COUNTER_COLUMNS} FROM platform.stay_guest_access
        WHERE stay_id = $1 FOR UPDATE`,
      [input.stayId],
    );
    const row = mapCounter(result.rows[0]);
    if (row === undefined) throw new Error('the guest-access counter vanished');
    return row;
  }

  /** The stay's counter, unlocked — nothing exists until a code is issued. */
  async accessCounterOf(stayId: string): Promise<AccessCounterRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${COUNTER_COLUMNS} FROM platform.stay_guest_access WHERE stay_id = $1`,
      [stayId],
    );
    return mapCounter(result.rows[0]);
  }

  async setAccessCounts(input: {
    stayId: string;
    expectedRevision: number;
    activeSessions: number;
    pendingCodes: number;
    closedAt?: Date;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.stay_guest_access
          SET active_sessions = $3, pending_codes = $4,
              closed_at = coalesce($5::timestamptz, closed_at),
              revision = revision + 1
        WHERE stay_id = $1 AND revision = $2`,
      [
        input.stayId,
        input.expectedRevision,
        input.activeSessions,
        input.pendingCodes,
        input.closedAt ?? null,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async createCode(input: {
    hotelId: string;
    stayId: string;
    roomId: string;
    codeHash: string;
    keyVersion: string;
    expiresAt: Date;
    issuedByAccountId: string;
  }): Promise<AccessCodeRow> {
    const result = await this.uow.query<Row>(
      `INSERT INTO platform.guest_access_code
         (hotel_id, stay_id, room_id, code_hash, key_version, expires_at, issued_by_account_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz, $7::uuid)
       RETURNING ${CODE_COLUMNS}`,
      [
        input.hotelId,
        input.stayId,
        input.roomId,
        input.codeHash,
        input.keyVersion,
        input.expiresAt,
        input.issuedByAccountId,
      ],
    );
    const row = mapCode(result.rows[0]);
    if (row === undefined) throw new Error('the access code insert returned no row');
    return row;
  }

  /**
   * The pending code for a room, by its hash.
   *
   * Selected by hash and by room, never enumerated: a caller who does not
   * already hold the code learns nothing from this.
   */
  async lockCodeByHash(roomId: string, codeHash: string): Promise<AccessCodeRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${CODE_COLUMNS} FROM platform.guest_access_code
        WHERE room_id = $1 AND code_hash = $2 AND state = 'PENDING' FOR UPDATE`,
      [roomId, codeHash],
    );
    return mapCode(result.rows[0]);
  }

  async settleCode(input: {
    codeId: string;
    expectedRevision: number;
    state: 'USED' | 'REVOKED' | 'EXPIRED';
    at: Date;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.guest_access_code
          SET state = $3, settled_at = $4, revision = revision + 1
        WHERE code_id = $1 AND revision = $2 AND state = 'PENDING'`,
      [input.codeId, input.expectedRevision, input.state, input.at],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /** Revokes every code still unused for a stay. Returns how many. */
  async revokePendingCodes(stayId: string, at: Date): Promise<number> {
    const result = await this.uow.query(
      `UPDATE platform.guest_access_code
          SET state = 'REVOKED', settled_at = $2, revision = revision + 1
        WHERE stay_id = $1 AND state = 'PENDING'`,
      [stayId, at],
    );
    return result.rowCount ?? 0;
  }

  async countWrongGuess(codeId: string, expectedRevision: number): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.guest_access_code SET attempts = attempts + 1, revision = revision + 1
        WHERE code_id = $1 AND revision = $2 AND state = 'PENDING'`,
      [codeId, expectedRevision],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async createSession(input: {
    hotelId: string;
    stayId: string;
    roomId: string;
    tokenHash: string;
    codeId: string;
    expiresAt: Date;
  }): Promise<GuestSessionRow> {
    const result = await this.uow.query<Row>(
      `INSERT INTO platform.guest_session
         (hotel_id, stay_id, room_id, token_hash, code_id, expires_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::timestamptz)
       RETURNING ${SESSION_COLUMNS}`,
      [input.hotelId, input.stayId, input.roomId, input.tokenHash, input.codeId, input.expiresAt],
    );
    const row = mapSession(result.rows[0]);
    if (row === undefined) throw new Error('the guest session insert returned no row');
    return row;
  }

  async sessionByToken(tokenHash: string): Promise<GuestSessionRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${SESSION_COLUMNS} FROM platform.guest_session WHERE token_hash = $1`,
      [tokenHash],
    );
    return mapSession(result.rows[0]);
  }

  async sessionById(guestSessionId: string): Promise<GuestSessionRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${SESSION_COLUMNS} FROM platform.guest_session WHERE guest_session_id = $1`,
      [guestSessionId],
    );
    return mapSession(result.rows[0]);
  }

  /** Closes one session, or every one of a stay. Returns how many closed. */
  async revokeSessions(input: {
    stayId: string;
    guestSessionId?: string;
    at: Date;
    reason: string;
  }): Promise<number> {
    const result = await this.uow.query(
      `UPDATE platform.guest_session
          SET state = 'REVOKED', revoked_at = $2, revoked_reason = $3, revision = revision + 1
        WHERE stay_id = $1 AND state = 'ACTIVE'
          AND ($4::uuid IS NULL OR guest_session_id = $4::uuid)`,
      [input.stayId, input.at, input.reason, input.guestSessionId ?? null],
    );
    return result.rowCount ?? 0;
  }

  // ---------------------------------------------------------------- the order

  async createOrder(input: {
    hotelId: string;
    restaurantId: string;
    stayId: string;
    roomId: string;
    guestSessionId: string;
    orderNo: string;
    totalAmountMnt: bigint;
    contactPhoneSnapshot: string;
    orderingClosesAt: Date;
    guestNote: string | null;
  }): Promise<OrderRow> {
    const result = await this.uow.query<Row>(
      `INSERT INTO platform.restaurant_order
         (hotel_id, restaurant_id, stay_id, room_id, guest_session_id, order_no,
          total_amount_mnt, contact_phone_snapshot, ordering_closes_at, guest_note)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::bigint, $8,
               $9::timestamptz, $10::text)
       RETURNING ${ORDER_COLUMNS}`,
      [
        input.hotelId,
        input.restaurantId,
        input.stayId,
        input.roomId,
        input.guestSessionId,
        input.orderNo,
        input.totalAmountMnt.toString(),
        input.contactPhoneSnapshot,
        input.orderingClosesAt,
        input.guestNote,
      ],
    );
    const row = mapOrder(result.rows[0]);
    if (row === undefined) throw new Error('the order insert returned no row');
    return row;
  }

  async addOrderItems(input: {
    hotelId: string;
    orderId: string;
    stayId: string;
    lines: readonly { itemId: string; name: string; unitPriceMnt: bigint; quantity: number }[];
  }): Promise<void> {
    for (const line of input.lines) {
      await this.uow.query(
        `INSERT INTO platform.restaurant_order_item
           (hotel_id, order_id, stay_id, item_id, name_snapshot, unit_price_mnt, quantity,
            line_total_mnt)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::bigint, $7, $8::bigint)`,
        [
          input.hotelId,
          input.orderId,
          input.stayId,
          line.itemId,
          line.name,
          line.unitPriceMnt.toString(),
          line.quantity,
          (line.unitPriceMnt * BigInt(line.quantity)).toString(),
        ],
      );
    }
  }

  async orderById(orderId: string): Promise<OrderRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${ORDER_COLUMNS} FROM platform.restaurant_order WHERE order_id = $1`,
      [orderId],
    );
    return mapOrder(result.rows[0]);
  }

  /** The row every decision in this module is taken on. */
  async lockOrder(orderId: string): Promise<OrderRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${ORDER_COLUMNS} FROM platform.restaurant_order
        WHERE order_id = $1 FOR UPDATE`,
      [orderId],
    );
    return mapOrder(result.rows[0]);
  }

  /** Compare-and-set on `revision`, with the states the caller expects. */
  async transition(input: {
    orderId: string;
    expectedRevision: number;
    orderState?: OrderState;
    fulfillmentState?: FulfillmentState;
    paymentState?: RestaurantPaymentState;
    refundPolicy?: RefundPolicy;
    refundRequestState?: RefundRequestState;
    refundState?: RestaurantRefundState;
    handoffMode?: HandoffMode;
    refundReason?: string;
    rejectReason?: string | null;
    paymentConfirmedAt?: Date;
    acceptedAt?: Date;
    etaMinutes?: number;
    promisedReadyAt?: Date;
    refundRequestedAt?: Date;
    checkoutNotifiedAt?: Date;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.restaurant_order
          SET order_state = coalesce($3::text, order_state),
              fulfillment_state = coalesce($4::text, fulfillment_state),
              payment_state = coalesce($5::text, payment_state),
              refund_policy = coalesce($6::text, refund_policy),
              refund_request_state = coalesce($7::text, refund_request_state),
              refund_state = coalesce($8::text, refund_state),
              handoff_mode = coalesce($9::text, handoff_mode),
              refund_reason = coalesce($10::text, refund_reason),
              reject_reason = CASE WHEN $11::boolean THEN $12::text ELSE reject_reason END,
              payment_confirmed_at = coalesce($13::timestamptz, payment_confirmed_at),
              accepted_at = coalesce($14::timestamptz, accepted_at),
              eta_minutes = coalesce($15::integer, eta_minutes),
              promised_ready_at = coalesce($16::timestamptz, promised_ready_at),
              refund_requested_at = coalesce($17::timestamptz, refund_requested_at),
              checkout_notified_at = coalesce($18::timestamptz, checkout_notified_at),
              revision = revision + 1
        WHERE order_id = $1 AND revision = $2`,
      [
        input.orderId,
        input.expectedRevision,
        input.orderState ?? null,
        input.fulfillmentState ?? null,
        input.paymentState ?? null,
        input.refundPolicy ?? null,
        input.refundRequestState ?? null,
        input.refundState ?? null,
        input.handoffMode ?? null,
        input.refundReason ?? null,
        input.rejectReason !== undefined,
        input.rejectReason ?? null,
        input.paymentConfirmedAt ?? null,
        input.acceptedAt ?? null,
        input.etaMinutes ?? null,
        input.promisedReadyAt ?? null,
        input.refundRequestedAt ?? null,
        input.checkoutNotifiedAt ?? null,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async record(input: {
    hotelId: string;
    orderId: string;
    stayId: string;
    axis:
      | 'order'
      | 'fulfillment'
      | 'payment'
      | 'refund_policy'
      | 'refund_request'
      | 'refund'
      | 'handoff';
    eventType: string;
    fromState: string | null;
    toState: string | null;
    actorRef: string;
    reason?: string;
  }): Promise<void> {
    await this.uow.query(
      `INSERT INTO platform.restaurant_order_event
         (hotel_id, order_id, stay_id, axis, event_type, from_state, to_state, actor_ref, reason)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::text, $7::text, $8, $9::text)`,
      [
        input.hotelId,
        input.orderId,
        input.stayId,
        input.axis,
        input.eventType,
        input.fromState,
        input.toState,
        input.actorRef,
        input.reason ?? null,
      ],
    );
  }

  async ordersForStay(stayId: string, limit = 50): Promise<readonly OrderRow[]> {
    const result = await this.uow.query<Row>(
      `SELECT ${ORDER_COLUMNS} FROM platform.restaurant_order
        WHERE stay_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [stayId, limit],
    );
    return result.rows
      .map((row) => mapOrder(row))
      .filter((row): row is OrderRow => row !== undefined);
  }

  /**
   * `RC-DEC-028`: the paid orders of a stay that have not finished.
   *
   * What Reception is shown at checkout, and what the final confirmation
   * re-reads: an order that reached a terminal fulfilment in between needs no
   * choice recorded for it.
   */
  async unfinishedForStay(stayId: string): Promise<readonly OrderRow[]> {
    const result = await this.uow.query<Row>(
      `SELECT ${ORDER_COLUMNS} FROM platform.restaurant_order
        WHERE stay_id = $1 AND payment_state = 'PAID'
          AND fulfillment_state <> ALL (ARRAY['DELIVERED_TO_ROOM', 'HANDED_TO_RECEPTION',
                                              'PICKED_UP_BY_GUEST', 'CANCELLED'])
        ORDER BY created_at`,
      [stayId],
    );
    return result.rows
      .map((row) => mapOrder(row))
      .filter((row): row is OrderRow => row !== undefined);
  }

  /** doc 08 §11: the production queue — paid, accepted or awaiting acceptance. */
  async queueFor(restaurantId: string, limit = 100): Promise<readonly OrderRow[]> {
    const result = await this.uow.query<Row>(
      `SELECT ${ORDER_COLUMNS} FROM platform.restaurant_order
        WHERE restaurant_id = $1 AND payment_state = 'PAID'
          AND fulfillment_state = ANY (ARRAY['AWAITING_ACCEPTANCE', 'ACCEPTED', 'PREPARING',
                                             'READY', 'OUT_FOR_DELIVERY'])
        ORDER BY payment_confirmed_at LIMIT $2`,
      [restaurantId, limit],
    );
    return result.rows
      .map((row) => mapOrder(row))
      .filter((row): row is OrderRow => row !== undefined);
  }

  // ------------------------------------------------------------ the invoice

  async createAttempt(input: {
    hotelId: string;
    orderId: string;
    restaurantId: string;
    amountMnt: bigint;
    orderingClosesAt: Date;
    expiresAt: Date;
  }): Promise<AttemptRow> {
    const result = await this.uow.query<Row>(
      `INSERT INTO platform.restaurant_payment_attempt
         (hotel_id, order_id, restaurant_id, amount_mnt, ordering_closes_at, expires_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::timestamptz, $6::timestamptz)
       RETURNING ${ATTEMPT_COLUMNS}`,
      [
        input.hotelId,
        input.orderId,
        input.restaurantId,
        input.amountMnt.toString(),
        input.orderingClosesAt,
        input.expiresAt,
      ],
    );
    const row = mapAttempt(result.rows[0]);
    if (row === undefined) throw new Error('the payment attempt insert returned no row');
    return row;
  }

  async attemptFor(orderId: string): Promise<AttemptRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${ATTEMPT_COLUMNS} FROM platform.restaurant_payment_attempt
        WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [orderId],
    );
    return mapAttempt(result.rows[0]);
  }

  async attemptByInvoice(providerInvoiceId: string): Promise<AttemptRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${ATTEMPT_COLUMNS} FROM platform.restaurant_payment_attempt
        WHERE provider_invoice_id = $1`,
      [providerInvoiceId],
    );
    return mapAttempt(result.rows[0]);
  }

  async setInvoice(input: {
    attemptId: string;
    expectedRevision: number;
    providerInvoiceId: string;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.restaurant_payment_attempt
          SET provider_invoice_id = $3, revision = revision + 1
        WHERE attempt_id = $1 AND revision = $2 AND state = 'ACTIVE'
          AND provider_invoice_id IS NULL`,
      [input.attemptId, input.expectedRevision, input.providerInvoiceId],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async settleAttempt(input: {
    attemptId: string;
    expectedRevision: number;
    state: 'PAID' | 'FAILED' | 'EXPIRED';
    reason: string;
    providerPaymentId?: string;
    at: Date;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.restaurant_payment_attempt
          SET state = $3, settled_at = $4, settled_reason = $5,
              provider_payment_id = coalesce($6::text, provider_payment_id),
              revision = revision + 1
        WHERE attempt_id = $1 AND revision = $2 AND state = 'ACTIVE'`,
      [
        input.attemptId,
        input.expectedRevision,
        input.state,
        input.at,
        input.reason,
        input.providerPaymentId ?? null,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  // ---------------------------------------------------------------- refunds

  async createRefund(input: {
    hotelId: string;
    orderId: string;
    restaurantId: string;
    amountMnt: bigint;
    providerPaymentId: string;
    initiatedByAccountId: string;
  }): Promise<RefundRow> {
    const result = await this.uow.query<Row>(
      `INSERT INTO platform.restaurant_refund
         (hotel_id, order_id, restaurant_id, amount_mnt, provider_payment_id,
          initiated_by_account_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::bigint, $5, $6::uuid)
       RETURNING ${REFUND_COLUMNS}`,
      [
        input.hotelId,
        input.orderId,
        input.restaurantId,
        input.amountMnt.toString(),
        input.providerPaymentId,
        input.initiatedByAccountId,
      ],
    );
    const row = mapRefund(result.rows[0]);
    if (row === undefined) throw new Error('the refund insert returned no row');
    return row;
  }

  async lockRefund(refundId: string): Promise<RefundRow | undefined> {
    const result = await this.uow.query<Row>(
      `SELECT ${REFUND_COLUMNS} FROM platform.restaurant_refund
        WHERE refund_id = $1 FOR UPDATE`,
      [refundId],
    );
    return mapRefund(result.rows[0]);
  }

  async settleRefund(input: {
    refundId: string;
    expectedRevision: number;
    state: 'REFUNDED' | 'FAILED';
    providerRefundId?: string;
    failureCode?: string;
    at: Date;
  }): Promise<boolean> {
    const result = await this.uow.query(
      `UPDATE platform.restaurant_refund
          SET state = $3, provider_refund_id = coalesce($4::text, provider_refund_id),
              failure_code = $5::text, settled_at = $6, revision = revision + 1
        WHERE refund_id = $1 AND revision = $2 AND state = 'PENDING'`,
      [
        input.refundId,
        input.expectedRevision,
        input.state,
        input.providerRefundId ?? null,
        input.failureCode ?? null,
        input.at,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }
}
