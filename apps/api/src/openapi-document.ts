import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';

export const OPENAPI_PATH = '/docs';

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('PRsystem API')
    .setDescription(
      'Multi-tenant hotel booking and operations platform. Phase 02 scaffold: health endpoints only.',
    )
    .setVersion('0.0.0')
    .addTag('health', 'Liveness and readiness probes')
    .addTag('catalog', 'Hotel stay configuration, room categories, rooms and minibar entities')
    .addTag('catalog-lifecycle', 'ACTIVE → RETIRING → INACTIVE lifecycle of catalog entities')
    .addTag('tariffs', 'Server-resolved effective rates and confirmed rate snapshots')
    .addTag('minibar-inventory', 'Products, prices, costs, receipts, corrections and the ledger')
    .addTag('minibar-templates', 'Template versions: draft, publish, default, archive')
    .addTag('minibar-configuration', 'Room minibar configuration, pending changes and overrides')
    .addTag('minibar-tasks', 'Cleaner reconciliation and rollback tasks')
    .addTag('minibar-rollout', 'Multi-room Rollout batches')
    .addTag('reception-shift', 'The operational Reception shift a check-in is confirmed in')
    .addTag('housekeeping', 'Room cleaning state and its append-only history')
    .addTag('stay', 'Room board, quote, check-in, stay view and actual checkout')
    .addTag('stay-corrections', 'Active-stay actual-time correction requests and decisions')
    .addTag('fulfillment-conflicts', 'Overdue conflicts of confirmed bookings and their remedies')
    .build();

  return SwaggerModule.createDocument(app, config);
}
