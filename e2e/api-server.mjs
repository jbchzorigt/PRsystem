/**
 * The real API, on a scratch database, with the people the portal flows need.
 *
 * This is the Phase 21 end-to-end fixture: nothing here is a mock of the API.
 * `createApp` from the built API is started exactly as production starts it,
 * in the `ci` application environment, where every external port is its
 * deterministic simulator (CLAUDE.md §9). What the tests then drive is the
 * production build of each portal talking to this server over HTTP.
 *
 * The identities are synthetic (CLAUDE.md §8): harness constants, never a real
 * person. A loopback-only console tells a test the seeded ids and hands it the
 * one-time codes a simulator "sent", the way a recipient would read them off
 * the message. The console binds 127.0.0.1, is started only by the Playwright
 * web-server hook, and is not part of any deployable application.
 */
/* global process, URL, fetch */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiRequire = createRequire(resolve(root, 'apps/api/package.json'));

const API_PORT = Number(process.env['E2E_API_PORT'] ?? '53200');
const CONSOLE_PORT = Number(process.env['E2E_CONSOLE_PORT'] ?? '53201');
const SUITE = 'e2e';
const KMS_SEED = `synthetic-${SUITE}`;
const ADMIN_DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://prsystem:prsystem_local_dev@127.0.0.1:55442/prsystem';

// The three Playwright projects share one server; each takes its own rooms,
// citizens and hotels by index so a mobile run never races a desktop run for
// the same row.
const PROJECTS = ['mobile', 'tablet', 'desktop'];

/** `LL YYMMDD NN`: two Cyrillic letters, a birth date, a serial (doc 12 §6). */
const CITIZENS = {
  wanted: [
    {
      registrationNumber: 'ЕЖ85031501',
      familyName: 'Батсүх',
      givenName: 'Тэмүүлэн',
      dateOfBirth: '1985-03-15',
      parentName: 'Батсүх',
      homeAddress: 'Баянзүрх дүүрэг, 5-р хороо',
      homeDistrict: 'Баянзүрх',
    },
    {
      registrationNumber: 'ЕЖ85031502',
      familyName: 'Ганбат',
      givenName: 'Сарнай',
      dateOfBirth: '1985-03-15',
      parentName: 'Ганбат',
      homeAddress: 'Хан-Уул дүүрэг, 2-р хороо',
      homeDistrict: 'Хан-Уул',
    },
    {
      registrationNumber: 'ЕЖ85031503',
      familyName: 'Дорж',
      givenName: 'Анужин',
      dateOfBirth: '1985-03-15',
      parentName: 'Дорж',
      homeAddress: 'Сүхбаатар дүүрэг, 8-р хороо',
      homeDistrict: 'Сүхбаатар',
    },
  ],
  ordinary: [
    {
      registrationNumber: 'ЗИ92071001',
      familyName: 'Эрдэнэ',
      givenName: 'Болор',
      dateOfBirth: '1992-07-10',
    },
    {
      registrationNumber: 'ЗИ92071002',
      familyName: 'Мөнх',
      givenName: 'Наран',
      dateOfBirth: '1992-07-10',
    },
    {
      registrationNumber: 'ЗИ92071003',
      familyName: 'Цэрэн',
      givenName: 'Оюун',
      dateOfBirth: '1992-07-10',
    },
  ],
};

async function main() {
  process.env['DATABASE_URL'] = ADMIN_DATABASE_URL;
  // The ownership contract every migration run requires (see
  // packages/testing/src/setup-migration-owners.ts): the scratch database is
  // created over the admin connection, so the admin user is its owner.
  process.env['PRSYSTEM_APPROVED_OPERATOR_OWNERS'] ??= new URL(ADMIN_DATABASE_URL).username;
  const { TEST_LOGIN_PRINCIPALS } = apiRequire('@prsystem/testing');
  const { resetEnvCache } = apiRequire('@prsystem/config');
  const { createPublicHarness } = apiRequire(
    './dist/modules/public/test-support/public-harness.js',
  );
  const { attachOperationHarness, OPERATION_PASSWORD } = apiRequire(
    './dist/modules/operation/test-support/operation-harness.js',
  );
  const { derivePassword } = apiRequire('./dist/modules/iam/services/password.service.js');
  const { GUEST_OTP } = apiRequire('./dist/modules/guest/guest.tokens.js');
  const { XYP_IDENTITY } = apiRequire('./dist/modules/stay/stay.tokens.js');
  const { POLICE_XYP } = apiRequire('./dist/modules/police/police.tokens.js');

  // ------------------------------------------------------------- database
  const pub = await createPublicHarness(SUITE);
  const db = pub.db;

  // ------------------------------------------------------------- hotels
  const hotel = await pub.publishedHotel('E2E Зочид буудал');
  // PAY-DEC-001: a hotel takes online bookings under an explicit commission
  // contract; the harness writes the row the way the booking suite does.
  await pub.admin.query(
    `INSERT INTO platform.hotel_commission_contract
       (hotel_id, contract_version, party_type, commission_rate_bps,
        cancellation_policy_version, effective_from)
     VALUES ($1::uuid, 1, 'NEGOTIATED', 1000, 1, now() - interval '1 day')`,
    [hotel.hotelId],
  );
  const rooms = [];
  for (let index = 0; index < PROJECTS.length * 2; index += 1) rooms.push(await hotel.cleanRoom());
  const restaurantHotel = await pub.hotel('E2E Ресторан буудал', 'P30');
  const restaurantRooms = [];
  for (let index = 0; index < PROJECTS.length; index += 1)
    restaurantRooms.push(await restaurantHotel.cleanRoom());
  // doc 18: registering a restaurant is Manager Plus's on the P30 package.
  const managerPlus = await pub.seed(restaurantHotel.hotelId, 'manager-plus-e2e@stay.test', [
    'MANAGER_PLUS',
  ]);

  // ------------------------------------------------------------- operation
  const ops = attachOperationHarness(db, SUITE, { keySeed: KMS_SEED });
  // A TOTP code is accepted once per step, so every flow that signs in gets
  // its own operator: one admin per project for the operation flow, one per
  // project for the accessibility audit, and one super admin per project.
  const ADMIN_PERMISSIONS = [
    'OPERATION_READ',
    'SUBSCRIPTION_REMINDER_SEND',
    'SUBSCRIPTION_PASSWORD_RESET_INITIATE',
  ];
  const operators = new Map();
  async function operator(role, permissions) {
    const seeded = await ops.operator({ role, permissions });
    operators.set(seeded.email, seeded);
    return { email: seeded.email, password: OPERATION_PASSWORD };
  }
  const admins = [];
  const auditAdmins = [];
  const superAdmins = [];
  for (let index = 0; index < PROJECTS.length; index += 1) {
    admins.push(await operator('OPERATION_ADMIN', ADMIN_PERMISSIONS));
    auditAdmins.push(await operator('OPERATION_ADMIN', ADMIN_PERMISSIONS));
    superAdmins.push(
      await operator('PLATFORM_SUPER_ADMIN', [
        'OPERATION_READ',
        'SUBSCRIPTION_SUSPEND',
        'ACCOUNT_OWNERSHIP_RECOVERY_APPROVE',
        'PLATFORM_OPERATION_ACCESS_MANAGE',
      ]),
    );
  }
  const operationHotels = [];
  for (const [index, project] of PROJECTS.entries()) {
    operationHotels.push(
      await ops.hotel({
        name: `E2E Ops буудал ${project}`,
        district: ['Баянгол', 'Чингэлтэй', 'Сонгинохайрхан'][index],
        packageCode: ['P20', 'P25', 'P30'][index],
        termMonths: [1, 3, 12][index],
        expiresInHours: [24 * 60, 24 * 3, 24 * 30][index],
        ownerType: index === 1 ? 'ORGANIZATION' : 'CITIZEN',
      }),
    );
  }
  await ops.hotel({ name: 'E2E Ops дууссан буудал', expiresInHours: -24 * 5 });

  // ------------------------------------------------------------- police
  const POLICE_PASSWORD = ['synthetic', 'police', 'passphrase'].join('-');
  const derived = await derivePassword(POLICE_PASSWORD);
  async function policeAccount(email, role, permissions) {
    const created = await db.pool.query(
      `INSERT INTO platform.user_account
         (realm, realm_role, police_scope_ref, email_normalized, state, email_verified_at)
       VALUES ('police', $1, 'UNIT-E2E', $2, 'ACTIVE', now())
       RETURNING account_id`,
      [role, email],
    );
    const accountId = created.rows[0].account_id;
    await db.pool.query(
      `INSERT INTO platform.account_credential (account_id, secret_hash, params_version)
       VALUES ($1::uuid, $2, $3)`,
      [accountId, derived.secretHash, derived.paramsVersion],
    );
    for (const permission of permissions) {
      await db.pool.query(
        `INSERT INTO platform.account_permission_grant
           (account_id, realm, realm_role, permission, granted_by_account_id)
         VALUES ($1::uuid, 'police', $2, $3, $1::uuid) ON CONFLICT DO NOTHING`,
        [accountId, role, permission],
      );
    }
    return { accountId, email, password: POLICE_PASSWORD };
  }
  const policeAdmin = await policeAccount('admin@police.e2e.test', 'POLICE_ADMIN', [
    'WANTED_CASE_CREATE',
    'WANTED_CASE_STATE_MANAGE',
    'WANTED_CASE_EXPORT',
  ]);
  const policeOfficer = await policeAccount('officer@police.e2e.test', 'POLICE_OFFICER', []);

  // ------------------------------------------------------------- the API
  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    API_PORT: String(API_PORT),
    KMS_ADAPTER: 'local',
    KMS_SEED,
    DATABASE_URL: db.loginUrl(TEST_LOGIN_PRINCIPALS.api),
    POLICE_ENABLED: 'true',
    POLICE_DATABASE_URL: db.loginUrl(TEST_LOGIN_PRINCIPALS.police),
    REDIS_URL: 'redis://127.0.0.1:59998',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1025',
  });
  resetEnvCache();
  const { createApp } = apiRequire('./dist/bootstrap.js');
  const started = await createApp({ port: API_PORT });
  const app = started.app;

  // ХУР answers for the synthetic citizens, in both modules that ask it.
  for (const xyp of [app.get(XYP_IDENTITY), app.get(POLICE_XYP)]) {
    for (const citizen of [...CITIZENS.wanted, ...CITIZENS.ordinary]) {
      const { registrationNumber, ...answer } = citizen;
      xyp.register(registrationNumber, answer);
    }
  }
  const otp = app.get(GUEST_OTP);
  const member = (m) => ({ email: m.email, password: m.password });

  // ------------------------------------------------- through the API itself
  // What a hotel configures before its first walk-in, and what Manager Plus
  // and the Restaurant Manager set up before a guest can order — done over
  // the running API with the seeded people's own sessions, so the rows are
  // exactly what production would hold.
  const apiUrl = `http://127.0.0.1:${String(started.port)}/api/v1`;
  let calls = 0;
  async function call(method, path, token, body) {
    calls += 1;
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `e2e-seed-${String(calls)}`,
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const parsed = text === '' ? {} : JSON.parse(text);
    if (!response.ok) throw new Error(`${method} ${path} → ${String(response.status)} ${text}`);
    return parsed;
  }
  const signIn = async (m) =>
    (await call('POST', '/auth/sign-in', undefined, { email: m.email, password: m.password }))
      .token;

  for (const [h, m] of [
    [hotel, hotel.managerMember],
    [restaurantHotel, managerPlus],
  ]) {
    await call('PUT', `/hotels/${h.hotelId}/deposit-configuration`, await signIn(m), {
      amountMnt: '50000',
    });
  }
  const managerPlusToken = await signIn(managerPlus);
  const restaurants = [];
  for (const [index, project] of PROJECTS.entries()) {
    const registered = await call(
      'POST',
      `/hotels/${restaurantHotel.hotelId}/restaurants`,
      managerPlusToken,
      {
        displayName: `E2E Ресторан ${project}`,
        cuisineKind: 'Монгол',
        addressLine: 'Энх тайвны өргөн чөлөө 1',
        latitudeMicro: 47918000 + index,
        longitudeMicro: 106917000 + index,
        contactPhone: '+97611223344',
      },
    );
    const restaurantId = registered.restaurantId;
    const restaurantManager = await pub.minibar.catalog.iam.seedMembership({
      hotelId: restaurantHotel.hotelId,
      restaurantId,
      email: `restaurant-manager-${project}-e2e@stay.test`,
      roles: ['RESTAURANT_MANAGER'],
    });
    const token = await signIn(restaurantManager);
    const prefix = `/hotels/${restaurantHotel.hotelId}/restaurants/${restaurantId}`;
    await call('POST', `${prefix}/schedule`, token, {
      days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        closed: false,
        opensAt: '00:00',
        closesAt: '23:59',
      })),
    });
    const category = await call('POST', `${prefix}/menu/categories`, token, {
      name: 'Үндсэн хоол',
    });
    await call('POST', `${prefix}/menu/items`, token, {
      menuCategoryId: category.menuCategoryId ?? category.categoryId,
      name: 'Цуйван',
      priceMnt: '18000',
    });
    restaurants.push({ restaurantId, manager: member(restaurantManager) });
  }

  const seed = {
    api: `http://127.0.0.1:${String(started.port)}`,
    projects: PROJECTS,
    hotel: {
      hotelId: hotel.hotelId,
      name: 'E2E Зочид буудал',
      categoryId: hotel.categoryId,
      rooms,
      reception: member(hotel.receptionMember),
      manager: member(hotel.managerMember),
      cleaner: member(hotel.cleanerMember),
    },
    restaurantHotel: {
      hotelId: restaurantHotel.hotelId,
      name: 'E2E Ресторан буудал',
      rooms: restaurantRooms,
      reception: member(restaurantHotel.receptionMember),
      manager: member(restaurantHotel.managerMember),
      managerPlus: member(managerPlus),
      restaurants,
    },
    operation: {
      admins,
      auditAdmins,
      superAdmins,
      hotels: operationHotels.map((h) => ({
        hotelId: h.hotelId,
        name: h.name,
        district: h.district,
        contactPhone: h.contactPhone,
      })),
    },
    police: { admin: policeAdmin, officer: policeOfficer },
    citizens: CITIZENS,
  };

  // ------------------------------------------------------------- console
  const console_ = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${String(CONSOLE_PORT)}`);
    const reply = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/seed') return reply(200, seed);
    if (url.pathname === '/otp') {
      // The simulator holds the normalised `+976########`; a test may ask with
      // the eight digits a person types. The last eight digits are the number.
      const digits = (url.searchParams.get('phone') ?? '').replace(/\D/g, '').slice(-8);
      const deliveries = otp.deliveries;
      for (let index = deliveries.length - 1; index >= 0; index -= 1) {
        if (deliveries[index].phone.replace(/\D/g, '').slice(-8) === digits)
          return reply(200, { code: deliveries[index].code });
      }
      return reply(404, { error: 'no code was sent to that number' });
    }
    if (url.pathname === '/totp') {
      const operator = operators.get(url.searchParams.get('email') ?? '');
      if (operator === undefined) return reply(404, { error: 'not a seeded operator' });
      return reply(200, { code: operator.codeAt(new Date()) });
    }
    return reply(404, { error: 'unknown' });
  });
  await new Promise((done) => console_.listen(CONSOLE_PORT, '127.0.0.1', done));
  process.stdout.write(
    `e2e api on ${seed.api}, console on http://127.0.0.1:${String(CONSOLE_PORT)}\n`,
  );

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console_.close();
    try {
      await app.close();
    } finally {
      try {
        await ops.close();
      } catch {
        /* the pools may already be gone */
      }
      try {
        await pub.close();
      } catch {
        /* idem */
      }
      try {
        await db.drop();
      } catch {
        /* the next run drops it with FORCE anyway */
      }
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((error) => {
  process.stderr.write(
    `e2e api-server failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
