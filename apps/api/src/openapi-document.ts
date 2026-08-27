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
    .build();

  return SwaggerModule.createDocument(app, config);
}
