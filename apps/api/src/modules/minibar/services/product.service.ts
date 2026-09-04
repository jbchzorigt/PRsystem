import { ApiError } from '@prsystem/contracts';
import type { UnitOfWork } from '@prsystem/db';
import { appendOutboxEvent, completeIdempotencyKey, recordPlatformAudit } from '@prsystem/db';
import type { CorrectionType, MovementType } from '../domain/inventory';
import { locationOf } from '../domain/inventory';
import type {
  MovementRow,
  ProductRow,
  WarehouseStockRow,
} from '../repositories/inventory.repository';
import { InventoryRepository } from '../repositories/inventory.repository';
import { ConfigurationRepository } from '../repositories/configuration.repository';
import type { CommandActor, MinibarDependencies, RequestContext } from './minibar-context';
import { MinibarServiceBase, claim, sqlState } from './minibar-context';
import { authorizeCommand } from '../../iam/services/authorization.service';

/**
 * Products, their prices and costs, the warehouse and the ledger (doc 22 §§3–5,
 * doc 07 §4; `INV-DEC-001`…`005`, `PRICE-DEC-002`, `PRICE-DEC-008`).
 *
 * Every stock-changing command locks the product row first: that is the
 * serialisation point for the product's balances, so two receipts or two
 * refills for one product queue rather than both reading the same number. The
 * movement is then appended and the ledger trigger applies it; a location
 * that would go negative refuses the movement as a movement, and this service
 * turns that refusal into `INSUFFICIENT_STOCK`.
 *
 * A selling-price edit is audited with the old and new values and applies to
 * check-ins confirmed after it — never to an active stay, whose price book is
 * the check-in's snapshot (Phase 08).
 */

const PRODUCT_MANAGE = 'hotel.minibar.product_manage';
const COST_STOCK_MANAGE = 'hotel.minibar.cost_stock_manage';
const WASTE_ADJUSTMENT = 'hotel.minibar.waste_adjustment';
const NON_GUEST_STOCK_OUT = 'hotel.minibar.non_guest_stock_out';

export interface CreateProductInput {
  readonly hotelId: string;
  readonly idempotencyKey: string;
  readonly name: string;
  readonly category: string;
  readonly unit: string;
  readonly sellingPriceMnt: bigint;
  readonly purchaseCostMnt: bigint;
  /** doc 22 §3: the warehouse opening balance, and only that. */
  readonly openingQuantity: number;
  readonly state: 'ACTIVE' | 'INACTIVE';
}

export interface UpdateProductInput {
  readonly hotelId: string;
  readonly productId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly name?: string;
  readonly category?: string;
  readonly unit?: string;
  readonly sellingPriceMnt?: bigint;
}

export interface ReceiveStockInput {
  readonly hotelId: string;
  readonly productId: string;
  readonly idempotencyKey: string;
  readonly quantity: number;
  /** The unit cost of this receipt; also becomes the product's stated purchase cost. */
  readonly unitCostMnt: bigint;
}

export interface CorrectionInput {
  readonly hotelId: string;
  readonly productId: string;
  readonly idempotencyKey: string;
  readonly type: CorrectionType;
  readonly quantity: number;
  readonly reason: string;
  /** Absent for the warehouse; a room id for a room location. */
  readonly roomId?: string;
  /** For `ADJUST_PLUS` when no average cost exists yet (doc 22 §5). */
  readonly unitCostMnt?: bigint;
  /** A configuration change this correction resolves a variance of. */
  readonly configurationChangeId?: string;
  /**
   * A stay this non-guest stock-out belongs to (doc 22 §6.2). Naming one makes
   * the command a stay-scoped movement and requires the Manager's
   * `non_guest_stock_out` action beside the waste one; the checkout's report
   * subtracts what it takes out of the room from the guest's billable quantity.
   */
  readonly stayId?: string;
}

export interface ProductView {
  readonly productId: string;
  readonly name: string;
  readonly category: string | null;
  readonly unit: string | null;
  readonly sellingPriceMnt: string | null;
  readonly purchaseCostMnt: string | null;
  readonly state: ProductRow['state'];
  readonly revision: number;
  readonly warehouseQuantity: number;
  readonly avgCostMnt: string | null;
}

export interface MovementView {
  readonly movementId: string;
  readonly productId: string;
  readonly movementType: MovementType;
  readonly location: string;
  readonly roomId: string | null;
  readonly quantity: number;
  readonly unitCostMnt: string | null;
  readonly reason: string | null;
  readonly stayId: string | null;
  readonly taskId: string | null;
  readonly configurationChangeId: string | null;
  readonly originalMovementId: string | null;
  readonly occurredAt: string;
}

export function movementView(row: MovementRow): MovementView {
  return {
    movementId: row.movementId,
    productId: row.productId,
    movementType: row.movementType,
    location: row.location,
    roomId: row.roomId,
    quantity: row.quantity,
    unitCostMnt: row.unitCostMnt === null ? null : row.unitCostMnt.toString(),
    reason: row.reason,
    stayId: row.stayId,
    taskId: row.taskId,
    configurationChangeId: row.configurationChangeId,
    originalMovementId: row.originalMovementId,
    occurredAt: row.occurredAt.toISOString(),
  };
}

function productView(row: ProductRow, stock: WarehouseStockRow): ProductView {
  return {
    productId: row.productId,
    name: row.name,
    category: row.category,
    unit: row.unit,
    sellingPriceMnt: row.sellingPriceMnt === null ? null : row.sellingPriceMnt.toString(),
    purchaseCostMnt: row.purchaseCostMnt === null ? null : row.purchaseCostMnt.toString(),
    state: row.state,
    revision: row.revision,
    warehouseQuantity: stock.quantity,
    avgCostMnt: stock.avgCostMnt === null ? null : stock.avgCostMnt.toString(),
  };
}

/** The ledger's refusal of a negative balance, as the caller should read it. */
export function insufficientStock(error: unknown): ApiError | undefined {
  if (sqlState(error) === '23514') {
    return new ApiError('CONFLICT', 'INSUFFICIENT_STOCK: the location does not hold that quantity');
  }
  return undefined;
}

export class ProductService extends MinibarServiceBase {
  constructor(deps: MinibarDependencies) {
    super(deps);
  }

  /** doc 22 §3: the product, and its opening balance as one `OPENING` movement. */
  async createProduct(
    input: CreateProductInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ProductView> {
    if (!Number.isInteger(input.openingQuantity) || input.openingQuantity < 0) {
      throw new ApiError('VALIDATION_FAILED', 'the opening quantity is a non-negative integer');
    }
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      PRODUCT_MANAGE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'minibar.create_product', input.idempotencyKey, {
          name: input.name,
          category: input.category,
          unit: input.unit,
          sellingPriceMnt: input.sellingPriceMnt.toString(),
          purchaseCostMnt: input.purchaseCostMnt.toString(),
          openingQuantity: input.openingQuantity,
          state: input.state,
        });
        if (claimed.kind === 'replay') return claimed.body as ProductView;
        await authorize();
        // An opening balance is a stock receipt: doc 18 §3 states cost, opening
        // stock and receipt as their own row, so it is checked as well.
        if (input.openingQuantity > 0) {
          await this.authorizeAlso(uow, gate, input.hotelId, COST_STOCK_MANAGE);
        }

        const inventory = new InventoryRepository(uow);
        const created = await inventory.createProduct({
          name: input.name,
          category: input.category,
          unit: input.unit,
          sellingPriceMnt: input.sellingPriceMnt,
          purchaseCostMnt: input.purchaseCostMnt,
          state: input.state,
        });
        if (input.openingQuantity > 0) {
          await inventory.appendMovement({
            productId: created.productId,
            movementType: 'OPENING',
            location: 'WAREHOUSE',
            quantity: input.openingQuantity,
            unitCostMnt: input.purchaseCostMnt,
            actorAccountId: gate.principal.accountId,
          });
        }
        const stock = await inventory.warehouseStock(created.productId);
        await this.record(uow, gate.principal.accountId, {
          entityId: created.productId,
          eventType: 'CREATED',
          action: 'minibar.product.create',
          outbox: 'minibar.product.created',
          payload: { state: created.state, openingQuantity: input.openingQuantity },
        });
        const view = productView(created, stock);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, view);
        return view;
      },
    );
  }

  /** Name, category, unit and selling price. The price edit is audited old → new (doc 25 §4). */
  async updateProduct(
    input: UpdateProductInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<ProductView> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      PRODUCT_MANAGE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'minibar.update_product', input.idempotencyKey, {
          productId: input.productId,
          expectedRevision: input.expectedRevision,
          sellingPriceMnt: input.sellingPriceMnt?.toString() ?? null,
        });
        if (claimed.kind === 'replay') return claimed.body as ProductView;

        const inventory = new InventoryRepository(uow);
        const existing = await inventory.lockProduct(input.productId);
        await authorize();
        if (existing === undefined) throw new ApiError('NOT_FOUND', 'not found');
        const updated = await inventory.updateProduct({
          productId: input.productId,
          expectedRevision: input.expectedRevision,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.category === undefined ? {} : { category: input.category }),
          ...(input.unit === undefined ? {} : { unit: input.unit }),
          ...(input.sellingPriceMnt === undefined
            ? {}
            : { sellingPriceMnt: input.sellingPriceMnt }),
        });
        if (updated === undefined) throw new ApiError('CONFLICT', 'the product moved; re-read it');
        const priceChanged =
          input.sellingPriceMnt !== undefined && input.sellingPriceMnt !== existing.sellingPriceMnt;
        await this.record(uow, gate.principal.accountId, {
          entityId: updated.productId,
          eventType: priceChanged ? 'PRICE_CHANGED' : 'UPDATED',
          action: priceChanged ? 'minibar.product.price_change' : 'minibar.product.update',
          outbox: 'minibar.product.updated',
          payload: priceChanged
            ? {
                previousSellingPriceMnt: existing.sellingPriceMnt?.toString() ?? null,
                sellingPriceMnt: updated.sellingPriceMnt?.toString() ?? null,
                appliesFrom: 'next confirmed check-in',
              }
            : {},
        });
        const view = productView(updated, await inventory.warehouseStock(updated.productId));
        await completeIdempotencyKey(uow, claimed.idempotencyId, 200, view);
        return view;
      },
    );
  }

  /** A purchase receipt into the warehouse; moves the weighted average (doc 22 §5). */
  async receiveStock(
    input: ReceiveStockInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<MovementView> {
    if (!Number.isInteger(input.quantity) || input.quantity < 1) {
      throw new ApiError('VALIDATION_FAILED', 'the quantity is a positive integer');
    }
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      COST_STOCK_MANAGE,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'minibar.receive_stock', input.idempotencyKey, {
          productId: input.productId,
          quantity: input.quantity,
          unitCostMnt: input.unitCostMnt.toString(),
        });
        if (claimed.kind === 'replay') return claimed.body as MovementView;

        const inventory = new InventoryRepository(uow);
        const product = await inventory.lockProduct(input.productId);
        await authorize();
        if (product === undefined) throw new ApiError('NOT_FOUND', 'not found');
        // Stock may still be received for a retiring product (doc 26 §6 keeps
        // its warehouse stock in play); an inactive one takes no new receipt.
        if (product.state === 'INACTIVE') {
          throw new ApiError('CONFLICT', 'ENTITY_NOT_ACTIVE: the product is inactive');
        }
        const movement = await inventory.appendMovement({
          productId: input.productId,
          movementType: 'PURCHASE',
          location: 'WAREHOUSE',
          quantity: input.quantity,
          unitCostMnt: input.unitCostMnt,
          actorAccountId: gate.principal.accountId,
        });
        await inventory.updateProduct({
          productId: input.productId,
          expectedRevision: product.revision,
          purchaseCostMnt: input.unitCostMnt,
        });
        const stock = await inventory.warehouseStock(input.productId);
        await this.record(uow, gate.principal.accountId, {
          entityId: input.productId,
          eventType: 'STOCK_RECEIVED',
          action: 'minibar.stock.receive',
          outbox: 'minibar.stock.received',
          payload: {
            movementId: movement.movementId,
            quantity: input.quantity,
            unitCostMnt: input.unitCostMnt.toString(),
            avgCostMnt: stock.avgCostMnt?.toString() ?? null,
          },
        });
        const view = movementView(movement);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, view);
        return view;
      },
    );
  }

  /**
   * Waste and count adjustments, with a reason and no second approval
   * (doc 22 §4). A room correction linked to a configuration change is how a
   * Manager resolves a count variance (doc 26 §18, §20).
   */
  async recordCorrection(
    input: CorrectionInput,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<MovementView> {
    if (!Number.isInteger(input.quantity) || input.quantity < 1) {
      throw new ApiError('VALIDATION_FAILED', 'the quantity is a positive integer');
    }
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: input.hotelId },
      WASTE_ADJUSTMENT,
      request,
      async (uow, gate, authorize) => {
        const claimed = await claim(uow, 'minibar.record_correction', input.idempotencyKey, {
          productId: input.productId,
          type: input.type,
          quantity: input.quantity,
          roomId: input.roomId ?? null,
          configurationChangeId: input.configurationChangeId ?? null,
        });
        if (claimed.kind === 'replay') return claimed.body as MovementView;

        const inventory = new InventoryRepository(uow);
        const configurations = new ConfigurationRepository(uow);
        const product = await inventory.lockProduct(input.productId);
        await authorize();
        // doc 18 §3 and doc 22 §6.2: a correction that belongs to an active
        // stay is a non-guest stock-out, and that is its own named action —
        // the waste permission alone does not reach the guest's bill.
        if (input.stayId !== undefined) {
          await this.authorizeAlso(uow, gate, input.hotelId, NON_GUEST_STOCK_OUT);
        }
        if (product === undefined) throw new ApiError('NOT_FOUND', 'not found');

        let change = undefined;
        if (input.configurationChangeId !== undefined) {
          change = await configurations.lockChange(input.configurationChangeId);
          if (change === undefined) throw new ApiError('NOT_FOUND', 'not found');
          if (input.roomId === undefined || change.roomId !== input.roomId) {
            throw new ApiError('VALIDATION_FAILED', "the correction names the change's own room");
          }
        }

        // doc 22 §6.2: a return leaves a room, so it names one.
        if (input.type === 'RETURN_TO_WAREHOUSE' && input.roomId === undefined) {
          throw new ApiError('VALIDATION_FAILED', 'a return to the warehouse names the room');
        }

        let unitCost: bigint | undefined;
        if (input.type === 'ADJUST_PLUS') {
          const stock = await inventory.warehouseStock(input.productId);
          const total = await inventory.totalHeld(input.productId);
          unitCost = input.unitCostMnt ?? (total > 0 ? (stock.avgCostMnt ?? undefined) : undefined);
          if (unitCost === undefined) {
            // doc 22 §5: with nothing held and no cost established, the Manager states one.
            throw new ApiError(
              'PRECONDITION_FAILED',
              'COST_UNSET: no average cost exists for this product; state a unit cost',
            );
          }
        }

        let movement;
        try {
          movement = await inventory.appendMovement({
            productId: input.productId,
            movementType: input.type,
            location: locationOf(input.type, input.roomId),
            ...(input.roomId === undefined ? {} : { roomId: input.roomId }),
            quantity: input.quantity,
            ...(unitCost === undefined ? {} : { unitCostMnt: unitCost }),
            reason: input.reason,
            ...(input.configurationChangeId === undefined
              ? {}
              : { configurationChangeId: input.configurationChangeId }),
            ...(input.stayId === undefined ? {} : { stayId: input.stayId }),
            actorAccountId: gate.principal.accountId,
          });
        } catch (error) {
          throw insufficientStock(error) ?? error;
        }
        if (change !== undefined) {
          await configurations.markMovementStarted(change.changeId, change.revision);
        }
        await this.record(uow, gate.principal.accountId, {
          entityId: input.productId,
          eventType: input.type,
          action: `minibar.stock.${input.type.toLowerCase()}`,
          outbox: 'minibar.stock.corrected',
          reason: input.reason,
          payload: {
            movementId: movement.movementId,
            quantity: input.quantity,
            location: movement.location,
            roomId: input.roomId ?? null,
            configurationChangeId: input.configurationChangeId ?? null,
          },
        });
        const view = movementView(movement);
        await completeIdempotencyKey(uow, claimed.idempotencyId, 201, view);
        return view;
      },
    );
  }

  /** Products with their warehouse balance and average cost. */
  async listProducts(
    hotelId: string,
    actor: CommandActor,
    request: RequestContext,
  ): Promise<readonly ProductView[]> {
    return this.runAuthorizedHotelCommandAny(
      actor,
      { hotelId },
      [PRODUCT_MANAGE, COST_STOCK_MANAGE],
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const inventory = new InventoryRepository(uow);
        const stocks = new Map((await inventory.warehouseStocks()).map((s) => [s.productId, s]));
        return (await inventory.products()).map((product) =>
          productView(
            product,
            stocks.get(product.productId) ?? {
              productId: product.productId,
              quantity: 0,
              avgCostMnt: null,
            },
          ),
        );
      },
    );
  }

  /** The ledger of one product, newest first. */
  async ledger(
    target: { hotelId: string; productId: string },
    actor: CommandActor,
    request: RequestContext,
  ): Promise<readonly MovementView[]> {
    return this.runAuthorizedHotelCommand(
      actor,
      { hotelId: target.hotelId },
      COST_STOCK_MANAGE,
      request,
      async (uow, _gate, authorize) => {
        await authorize();
        const inventory = new InventoryRepository(uow);
        if ((await inventory.productById(target.productId)) === undefined) {
          throw new ApiError('NOT_FOUND', 'not found');
        }
        return (await inventory.movementsForProduct(target.productId)).map(movementView);
      },
    );
  }

  // ------------------------------------------------------------ internals

  private async authorizeAlso(
    uow: UnitOfWork,
    gate: { principal: CommandActor['principal']; sessionId: string },
    hotelId: string,
    permission: string,
  ): Promise<void> {
    await authorizeCommand({
      uow,
      endpointRealm: 'hotel',
      permission,
      principal: gate.principal,
      target: { hotelId },
      subscription: this.deps.subscription,
      sessionId: gate.sessionId,
      ...(gate.principal.stepUpAt === undefined ? {} : { stepUpAt: gate.principal.stepUpAt }),
      targetType: 'hotel',
      targetRef: hotelId,
    });
  }

  private async record(
    uow: UnitOfWork,
    actorAccountId: string,
    detail: {
      entityId: string;
      eventType: string;
      action: string;
      outbox: string;
      reason?: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await new ConfigurationRepository(uow).appendEvent({
      entityType: 'PRODUCT',
      entityId: detail.entityId,
      eventType: detail.eventType,
      ...(detail.reason === undefined ? {} : { reason: detail.reason }),
      payload: detail.payload,
      actorAccountId,
    });
    await recordPlatformAudit(uow, {
      action: detail.action,
      outcome: 'allowed',
      targetType: 'minibar_product',
      targetRef: detail.entityId,
      ...(detail.reason === undefined ? {} : { reason: detail.reason }),
      payload: detail.payload,
    });
    await appendOutboxEvent(uow, {
      aggregateType: 'minibar_product',
      aggregateId: detail.entityId,
      eventType: detail.outbox,
      payload: detail.payload,
    });
  }
}
