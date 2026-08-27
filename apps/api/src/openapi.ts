import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { buildOpenApiDocument } from './openapi-document';

/**
 * Generates openapi.json without binding a port or contacting any dependency.
 * Run by `pnpm run openapi`; the output is a build artefact, not a committed file.
 */
async function generate(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();

  const document = buildOpenApiDocument(app);
  const target = resolve(process.cwd(), 'openapi.json');
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  await app.close();
  process.stdout.write(`openapi document written to ${target}\n`);
}

generate().catch((error: unknown) => {
  process.stderr.write(`openapi generation failed: ${String(error)}\n`);
  process.exitCode = 1;
});
