import { Controller, Get, Inject, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../../iam/http/session.guard';
import { SessionGuard, actorOf, principalOf } from '../../iam/http/session.guard';
import {
  body,
  idempotencyKey,
  optionalUuid,
  requireString,
  requireUuid,
} from '../../iam/http/validation';
import {
  optionalString,
  requireCreatableState,
  requireMnt,
} from '../../catalog/http/catalog-validation';
import { newMinibarRequest } from '../services/minibar-context';
import { ProductService } from '../services/product.service';
import type { MovementView, ProductView } from '../services/product.service';
import { requireCorrectionType, requireQuantity } from './minibar-validation';

/**
 * Products, prices, costs, receipts, corrections and the ledger (doc 22 §§3–5).
 *
 * The three write permissions are doc 18 §3's three rows — product and
 * selling price, cost and receipt, waste and adjustment — and each handler
 * names exactly one. Every write carries a client idempotency key. On
 * 20,000₮ every one of them is the opaque `NOT_FOUND` (doc 22 §1).
 */
@ApiTags('minibar-inventory')
@Controller('hotels/:hotelId/minibar/products')
export class ProductController {
  constructor(@Inject(ProductService) private readonly products: ProductService) {}

  @Get()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Products with their warehouse balance and average cost' })
  async list(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<readonly ProductView[]> {
    return this.products.listProducts(
      requireUuid(hotelIdParam, 'hotelId'),
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
  }

  @Post()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Create a product with its opening warehouse balance (product_manage)' })
  @ApiResponse({ status: 404, description: 'Not a Manager here, or not a minibar package' })
  async create(
    @Param('hotelId') hotelIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ProductView> {
    const payload = body(request);
    const created = await this.products.createProduct(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        idempotencyKey: idempotencyKey(request),
        name: requireString(payload['name'], 'name', 120),
        category: requireString(payload['category'], 'category', 60),
        unit: requireString(payload['unit'], 'unit', 20),
        sellingPriceMnt: requireMnt(payload['sellingPriceMnt'], 'sellingPriceMnt'),
        purchaseCostMnt: requireMnt(payload['purchaseCostMnt'], 'purchaseCostMnt'),
        openingQuantity: requireQuantity(payload['openingQuantity'] ?? 0, 'openingQuantity', 0),
        state: requireCreatableState(payload['state']) as 'ACTIVE' | 'INACTIVE',
      },
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return created;
  }

  @Patch(':productId')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Edit name, category, unit or selling price; a price edit is audited' })
  async update(
    @Param('hotelId') hotelIdParam: string,
    @Param('productId') productIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProductView> {
    const payload = body(request);
    const name = optionalString(payload['name'], 'name', 120);
    const category = optionalString(payload['category'], 'category', 60);
    const unit = optionalString(payload['unit'], 'unit', 20);
    return this.products.updateProduct(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        productId: requireUuid(productIdParam, 'productId'),
        idempotencyKey: idempotencyKey(request),
        expectedRevision: requireQuantity(payload['expectedRevision'], 'expectedRevision', 0),
        ...(name === undefined ? {} : { name }),
        ...(category === undefined ? {} : { category }),
        ...(unit === undefined ? {} : { unit }),
        ...(payload['sellingPriceMnt'] === undefined
          ? {}
          : { sellingPriceMnt: requireMnt(payload['sellingPriceMnt'], 'sellingPriceMnt') }),
      },
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
  }

  @Post(':productId/receipts')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Receive purchased stock into the warehouse (cost_stock_manage)' })
  async receive(
    @Param('hotelId') hotelIdParam: string,
    @Param('productId') productIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MovementView> {
    const payload = body(request);
    const movement = await this.products.receiveStock(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        productId: requireUuid(productIdParam, 'productId'),
        idempotencyKey: idempotencyKey(request),
        quantity: requireQuantity(payload['quantity'], 'quantity'),
        unitCostMnt: requireMnt(payload['unitCostMnt'], 'unitCostMnt'),
      },
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return movement;
  }

  @Post(':productId/corrections')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Waste or a count adjustment, with a reason (waste_adjustment)' })
  @ApiResponse({ status: 409, description: 'The location does not hold that quantity' })
  async correct(
    @Param('hotelId') hotelIdParam: string,
    @Param('productId') productIdParam: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MovementView> {
    const payload = body(request);
    const roomId = optionalUuid(payload['roomId'], 'roomId');
    const changeId = optionalUuid(payload['configurationChangeId'], 'configurationChangeId');
    const movement = await this.products.recordCorrection(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        productId: requireUuid(productIdParam, 'productId'),
        idempotencyKey: idempotencyKey(request),
        type: requireCorrectionType(payload['type']),
        quantity: requireQuantity(payload['quantity'], 'quantity'),
        reason: requireString(payload['reason'], 'reason', 300),
        ...(roomId === undefined ? {} : { roomId }),
        ...(changeId === undefined ? {} : { configurationChangeId: changeId }),
        ...(payload['unitCostMnt'] === undefined
          ? {}
          : { unitCostMnt: requireMnt(payload['unitCostMnt'], 'unitCostMnt') }),
      },
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
    reply.status(201);
    return movement;
  }

  @Get(':productId/ledger')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'The immutable movement ledger of a product, newest first' })
  async ledger(
    @Param('hotelId') hotelIdParam: string,
    @Param('productId') productIdParam: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<readonly MovementView[]> {
    return this.products.ledger(
      {
        hotelId: requireUuid(hotelIdParam, 'hotelId'),
        productId: requireUuid(productIdParam, 'productId'),
      },
      actorOf(request),
      newMinibarRequest(principalOf(request).accountId),
    );
  }
}
