import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import {
  PaymentGatewayRegistry,
  UnavailableEBarimt,
  UnavailableKeyManagement,
  UnavailableObjectStorage,
  UnavailableXypIdentity,
  UnavailablePaymentGateway,
  UnavailablePhoneVerification,
} from '@prsystem/ports';
import { AppModule } from './app.module';
import { NoProvisioningSignal } from './modules/onboarding/contracts/provisioning-signal';
import { UnavailableSubscriptionState } from './modules/iam/contracts/subscription-state.port';
import { UnavailableStaffNotification } from './modules/iam/contracts/staff-notification.port';
import { UnregisteredOpenWork } from './modules/iam/contracts/open-work.port';
import { UnprovisionedPaymentAttempts } from './modules/stay/contracts/payment-attempts';
import { UnprovisionedDeposits } from './modules/stay/contracts/deposits';
import { UnprovisionedRestaurantOrders } from './modules/stay/contracts/restaurant-orders';
import { UnprovisionedRetention } from './modules/stay/contracts/retention';
import { UnavailableRestaurantDirectory } from './modules/iam/contracts/restaurant-directory.port';
import { buildOpenApiDocument } from './openapi-document';

/**
 * Generates openapi.json without binding a port or contacting any dependency.
 * Run by `pnpm run openapi`; the output is a build artefact, not a committed file.
 */
async function generate(): Promise<void> {
  // Explicitly without the scheduler capability. Document generation binds no
  // port and contacts no dependency, so it must not construct a privileged pool
  // — and stating that here means it cannot acquire one from an ambient
  // variable that happens to be set in the shell running the build.
  const app = await NestFactory.create<NestFastifyApplication>(
    // The IAM ports are supplied directly, so document generation constructs no
    // connection pool and no key material either.
    AppModule.forRoot({
      scheduler: { enabled: false },
      iam: {
        pool: new Pool({ max: 1 }),
        keys: new UnavailableKeyManagement(),
        subscription: new UnavailableSubscriptionState(),
        notifications: new UnavailableStaffNotification(),
        openWork: new UnregisteredOpenWork(),
        restaurants: new UnavailableRestaurantDirectory(),
      },
      // The Phase 05 ports are supplied the same way, for the same reason: the
      // document is a shape, and generating it must not open a connection or
      // construct key material.
      onboarding: {
        pool: new Pool({ max: 1 }),
        keys: new UnavailableKeyManagement(),
        gateways: new PaymentGatewayRegistry(
          new Map([
            ['QPAY', new UnavailablePaymentGateway('QPAY')],
            ['KHAAN', new UnavailablePaymentGateway('KHAAN')],
          ]),
        ),
        ebarimt: new UnavailableEBarimt(),
        phone: new UnavailablePhoneVerification(),
        notifications: new UnavailableStaffNotification(),
        signals: new NoProvisioningSignal(),
      },
      // The catalog has no port of its own; a pool that is never connected is
      // all it needs to describe its routes.
      catalog: { pool: new Pool({ max: 1 }) },
      minibar: { pool: new Pool({ max: 1 }) },
      billing: {
        pool: new Pool({ max: 1 }),
        gateways: new PaymentGatewayRegistry(new Map()),
      },
      finance: { pool: new Pool({ max: 1 }) },
      guest: { pool: new Pool({ max: 1 }), keys: new UnavailableKeyManagement() },
      public: { pool: new Pool({ max: 1 }) },
      booking: { pool: new Pool({ max: 1 }) },
      settlement: { pool: new Pool({ max: 1 }) },
      restaurant: { pool: new Pool({ max: 1 }), keys: new UnavailableKeyManagement() },
      review: { pool: new Pool({ max: 1 }) },
      reporting: { pool: new Pool({ max: 1 }), storage: new UnavailableObjectStorage() },
      stay: {
        pool: new Pool({ max: 1 }),
        keys: new UnavailableKeyManagement(),
        xyp: new UnavailableXypIdentity(),
        payments: new UnprovisionedPaymentAttempts(),
        deposits: new UnprovisionedDeposits(),
        restaurantOrders: new UnprovisionedRestaurantOrders(),
        retention: new UnprovisionedRetention(),
      },
    }),
    new FastifyAdapter(),
    { logger: false },
  );
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
