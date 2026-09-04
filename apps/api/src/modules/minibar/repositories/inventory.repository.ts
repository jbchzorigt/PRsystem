import type { UnitOfWork } from '@prsystem/db';
import { ScopedRepository } from '@prsystem/db';
import type { Location, MovementType, StockLine } from '../domain/inventory';

/**
 * Products, the two stock locations and the ledger.
 *
 * The stock tables are read here and never written: the ledger trigger is
 * their only writer. What this repository serialises is the *product* — every
 * command that will post a movement for a product takes the product row
 * `FOR UPDATE` first, so two refills racing for the same warehouse balance
 * queue on it rather than both reading the same balance (doc 22 §11).
 */

export interface ProductRow {
  readonly productId: string;
  readonly name: string;
  readonly category: string | null;
  readonly unit: string | null;
  readonly sellingPriceMnt: bigint | null;
  readonly purchaseCostMnt: bigint | null;
  readonly state: 'ACTIVE' | 'RETIRING' | 'INACTIVE';
  readonly revision: number;
}

export interface WarehouseStockRow {
  readonly productId: string;
  readonly quantity: number;
  readonly avgCostMnt: bigint | null;
}

export interface MovementRow {
  readonly movementId: string;
  readonly productId: string;
  readonly movementType: MovementType;
  readonly location: Location;
  readonly roomId: string | null;
  readonly quantity: number;
  readonly unitCostMnt: bigint | null;
  readonly reason: string | null;
  readonly stayId: string | null;
  readonly taskId: string | null;
  readonly configurationChangeId: string | null;
  readonly originalMovementId: string | null;
  readonly actorAccountId: string | null;
  readonly occurredAt: Date;
}

export interface MovementInput {
  readonly productId: string;
  readonly movementType: MovementType;
  readonly location: Location;
  readonly roomId?: string;
  readonly quantity: number;
  /** Required for OPENING, PURCHASE and ADJUST_PLUS; the trigger fills the rest. */
  readonly unitCostMnt?: bigint;
  readonly reason?: string;
  readonly stayId?: string;
  readonly taskId?: string;
  readonly configurationChangeId?: string;
  readonly originalMovementId?: string;
  readonly actorAccountId?: string;
}

function bigintOrNull(value: unknown): bigint | null {
  return value === null || value === undefined ? null : BigInt(value as string);
}

const PRODUCT_COLUMNS = `product_id, name, category, unit, selling_price_mnt, purchase_cost_mnt,
  state, revision`;

function mapProduct(row: Record<string, unknown> | undefined): ProductRow | undefined {
  if (row === undefined) return undefined;
  return {
    productId: row['product_id'] as string,
    name: row['name'] as string,
    category: (row['category'] ?? null) as string | null,
    unit: (row['unit'] ?? null) as string | null,
    sellingPriceMnt: bigintOrNull(row['selling_price_mnt']),
    purchaseCostMnt: bigintOrNull(row['purchase_cost_mnt']),
    state: row['state'] as ProductRow['state'],
    revision: Number(row['revision']),
  };
}

const MOVEMENT_COLUMNS = `movement_id, product_id, movement_type, location, room_id, quantity,
  unit_cost_mnt, reason, stay_id, task_id, configuration_change_id, original_movement_id,
  actor_account_id, occurred_at`;

function mapMovement(row: Record<string, unknown>): MovementRow {
  return {
    movementId: row['movement_id'] as string,
    productId: row['product_id'] as string,
    movementType: row['movement_type'] as MovementType,
    location: row['location'] as Location,
    roomId: (row['room_id'] ?? null) as string | null,
    quantity: Number(row['quantity']),
    unitCostMnt: bigintOrNull(row['unit_cost_mnt']),
    reason: (row['reason'] ?? null) as string | null,
    stayId: (row['stay_id'] ?? null) as string | null,
    taskId: (row['task_id'] ?? null) as string | null,
    configurationChangeId: (row['configuration_change_id'] ?? null) as string | null,
    originalMovementId: (row['original_movement_id'] ?? null) as string | null,
    actorAccountId: (row['actor_account_id'] ?? null) as string | null,
    occurredAt: row['occurred_at'] as Date,
  };
}

export class InventoryRepository extends ScopedRepository {
  constructor(uow: UnitOfWork) {
    super(uow);
  }

  get unitOfWork(): UnitOfWork {
    return this.uow;
  }

  // -------------------------------------------------------------- products

  async productById(productId: string): Promise<ProductRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${PRODUCT_COLUMNS} FROM platform.minibar_product
        WHERE hotel_id = $1 AND product_id = $2`,
      [this.hotelId, productId],
    );
    return mapProduct(result.rows[0]);
  }

  /** The per-product serialisation point for every stock movement. */
  async lockProduct(productId: string): Promise<ProductRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${PRODUCT_COLUMNS} FROM platform.minibar_product
        WHERE hotel_id = $1 AND product_id = $2 FOR UPDATE`,
      [this.hotelId, productId],
    );
    return mapProduct(result.rows[0]);
  }

  /** Locks several products in id order, so two commands never cross. */
  async lockProducts(productIds: readonly string[]): Promise<Map<string, ProductRow>> {
    const locked = new Map<string, ProductRow>();
    for (const productId of [...new Set(productIds)].sort()) {
      const row = await this.lockProduct(productId);
      if (row !== undefined) locked.set(productId, row);
    }
    return locked;
  }

  async products(): Promise<readonly ProductRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${PRODUCT_COLUMNS} FROM platform.minibar_product WHERE hotel_id = $1 ORDER BY name`,
      [this.hotelId],
    );
    return result.rows.map((row) => mapProduct(row) as ProductRow);
  }

  async productsByIds(productIds: readonly string[]): Promise<Map<string, ProductRow>> {
    if (productIds.length === 0) return new Map();
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${PRODUCT_COLUMNS} FROM platform.minibar_product
        WHERE hotel_id = $1 AND product_id = ANY($2::uuid[])`,
      [this.hotelId, [...productIds]],
    );
    return new Map(
      result.rows.map((row) => [row['product_id'] as string, mapProduct(row) as ProductRow]),
    );
  }

  async createProduct(input: {
    name: string;
    category: string;
    unit: string;
    sellingPriceMnt: bigint;
    purchaseCostMnt: bigint;
    state: 'ACTIVE' | 'INACTIVE';
  }): Promise<ProductRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.minibar_product
         (hotel_id, name, category, unit, selling_price_mnt, purchase_cost_mnt, state, deactivated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 = 'INACTIVE' THEN now() END)
       RETURNING ${PRODUCT_COLUMNS}`,
      [
        this.hotelId,
        input.name,
        input.category,
        input.unit,
        input.sellingPriceMnt.toString(),
        input.purchaseCostMnt.toString(),
        input.state,
      ],
    );
    const row = mapProduct(result.rows[0]);
    if (row === undefined) throw new Error('the product insert returned no row');
    return row;
  }

  async updateProduct(input: {
    productId: string;
    expectedRevision: number;
    name?: string;
    category?: string;
    unit?: string;
    sellingPriceMnt?: bigint;
    purchaseCostMnt?: bigint;
  }): Promise<ProductRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `UPDATE platform.minibar_product
          SET name = COALESCE($3, name),
              category = COALESCE($4, category),
              unit = COALESCE($5, unit),
              selling_price_mnt = COALESCE($6::bigint, selling_price_mnt),
              purchase_cost_mnt = COALESCE($7::bigint, purchase_cost_mnt),
              revision = revision + 1
        WHERE hotel_id = $1 AND product_id = $2 AND revision = $8
        RETURNING ${PRODUCT_COLUMNS}`,
      [
        this.hotelId,
        input.productId,
        input.name ?? null,
        input.category ?? null,
        input.unit ?? null,
        input.sellingPriceMnt?.toString() ?? null,
        input.purchaseCostMnt?.toString() ?? null,
        input.expectedRevision,
      ],
    );
    return mapProduct(result.rows[0]);
  }

  // ----------------------------------------------------------------- stock

  async warehouseStock(productId: string): Promise<WarehouseStockRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT product_id, quantity, avg_cost_mnt FROM platform.minibar_warehouse_stock
        WHERE hotel_id = $1 AND product_id = $2`,
      [this.hotelId, productId],
    );
    const row = result.rows[0];
    if (row === undefined) return { productId, quantity: 0, avgCostMnt: null };
    return {
      productId,
      quantity: Number(row['quantity']),
      avgCostMnt: bigintOrNull(row['avg_cost_mnt']),
    };
  }

  async warehouseStocks(): Promise<readonly WarehouseStockRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT product_id, quantity, avg_cost_mnt FROM platform.minibar_warehouse_stock
        WHERE hotel_id = $1 ORDER BY product_id`,
      [this.hotelId],
    );
    return result.rows.map((row) => ({
      productId: row['product_id'] as string,
      quantity: Number(row['quantity']),
      avgCostMnt: bigintOrNull(row['avg_cost_mnt']),
    }));
  }

  async roomStock(roomId: string): Promise<readonly StockLine[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT product_id, quantity FROM platform.room_minibar_stock
        WHERE hotel_id = $1 AND room_id = $2 AND quantity > 0 ORDER BY product_id`,
      [this.hotelId, roomId],
    );
    return result.rows.map((row) => ({
      productId: row['product_id'] as string,
      quantity: Number(row['quantity']),
    }));
  }

  /** The whole hotel's physical quantity of one product, as the average is weighted over it. */
  async totalHeld(productId: string): Promise<number> {
    const result = await this.uow.query<{ n: string }>(
      `SELECT (coalesce((SELECT quantity FROM platform.minibar_warehouse_stock
                          WHERE hotel_id = $1 AND product_id = $2), 0)
             + coalesce((SELECT sum(quantity) FROM platform.room_minibar_stock
                          WHERE hotel_id = $1 AND product_id = $2), 0))::text AS n`,
      [this.hotelId, productId],
    );
    return Number(result.rows[0]?.n ?? '0');
  }

  // ---------------------------------------------------------------- ledger

  async appendMovement(input: MovementInput): Promise<MovementRow> {
    const result = await this.uow.query<Record<string, unknown>>(
      `INSERT INTO platform.inventory_movement
         (hotel_id, product_id, movement_type, location, room_id, quantity, unit_cost_mnt, reason,
          stay_id, task_id, configuration_change_id, original_movement_id, actor_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING ${MOVEMENT_COLUMNS}`,
      [
        this.hotelId,
        input.productId,
        input.movementType,
        input.location,
        input.roomId ?? null,
        input.quantity,
        input.unitCostMnt?.toString() ?? null,
        input.reason ?? null,
        input.stayId ?? null,
        input.taskId ?? null,
        input.configurationChangeId ?? null,
        input.originalMovementId ?? null,
        input.actorAccountId ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('the movement insert returned no row');
    return mapMovement(row);
  }

  async movementsForProduct(productId: string, limit = 200): Promise<readonly MovementRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${MOVEMENT_COLUMNS} FROM platform.inventory_movement
        WHERE hotel_id = $1 AND product_id = $2
        ORDER BY occurred_at DESC, movement_id DESC LIMIT $3`,
      [this.hotelId, productId, limit],
    );
    return result.rows.map(mapMovement);
  }

  async movementsForChange(changeId: string): Promise<readonly MovementRow[]> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${MOVEMENT_COLUMNS} FROM platform.inventory_movement
        WHERE hotel_id = $1 AND configuration_change_id = $2
        ORDER BY occurred_at, movement_id`,
      [this.hotelId, changeId],
    );
    return result.rows.map(mapMovement);
  }

  /** A movement already posted for this task and product, for an idempotent retry. */
  async movementForTask(taskId: string, productId: string): Promise<MovementRow | undefined> {
    const result = await this.uow.query<Record<string, unknown>>(
      `SELECT ${MOVEMENT_COLUMNS} FROM platform.inventory_movement
        WHERE hotel_id = $1 AND task_id = $2 AND product_id = $3
          AND original_movement_id IS NULL
        ORDER BY occurred_at LIMIT 1`,
      [this.hotelId, taskId, productId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapMovement(row);
  }
}
