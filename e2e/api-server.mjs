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
/* global process, URL, fetch, Buffer */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiRequire = createRequire(resolve(root, 'apps/api/package.json'));
const workerRequire = createRequire(resolve(root, 'apps/worker/package.json'));

const API_PORT = Number(process.env['E2E_API_PORT'] ?? '53200');
const CONSOLE_PORT = Number(process.env['E2E_CONSOLE_PORT'] ?? '53201');
/** The scratch database's name; the load tool names its own so it never collides with a Playwright run. */
const SUITE = process.env['E2E_SUITE'] ?? 'e2e';
const KMS_SEED = `synthetic-${SUITE}`;
const ADMIN_DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://prsystem:prsystem_local_dev@127.0.0.1:55442/prsystem';
/** The compose stack's Redis: the in-process worker consumers and the API's provisioning signal share it. */
const REDIS_URL = process.env['E2E_REDIS_URL'] ?? 'redis://127.0.0.1:56379';
/** One BullMQ prefix per run, so a previous run's repeatable jobs never fire into this one. */
const QUEUE_PREFIX = `e2e-${String(process.pid)}`;
/** Where the shell sent this process's stdout, for the leakage scan of the API's own log. */
const API_LOG = process.env['E2E_API_LOG'];

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
  wantedSweep: [
    {
      registrationNumber: 'ЙК88112201',
      familyName: 'Пүрэв',
      givenName: 'Хулан',
      dateOfBirth: '1988-11-22',
      parentName: 'Пүрэв',
      homeAddress: 'Чингэлтэй дүүрэг, 3-р хороо',
      homeDistrict: 'Чингэлтэй',
    },
    {
      registrationNumber: 'ЙК88112202',
      familyName: 'Сүх',
      givenName: 'Мөнхжин',
      dateOfBirth: '1988-11-22',
      parentName: 'Сүх',
      homeAddress: 'Багануур дүүрэг, 1-р хороо',
      homeDistrict: 'Багануур',
    },
    {
      registrationNumber: 'ЙК88112203',
      familyName: 'Жаргал',
      givenName: 'Энхмаа',
      dateOfBirth: '1988-11-22',
      parentName: 'Жаргал',
      homeAddress: 'Налайх дүүрэг, 2-р хороо',
      homeDistrict: 'Налайх',
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
    {
      registrationNumber: 'ЗИ92071004',
      familyName: 'Батаа',
      givenName: 'Сувд',
      dateOfBirth: '1992-07-10',
    },
    {
      registrationNumber: 'ЗИ92071005',
      familyName: 'Наранбаатар',
      givenName: 'Ганзориг',
      dateOfBirth: '1992-07-10',
    },
    {
      registrationNumber: 'ЗИ92071006',
      familyName: 'Оюунбилэг',
      givenName: 'Тэмүлэн',
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
  // Six for Phase 21's flows, three for the booking journey, three for the matcher journey.
  for (let index = 0; index < PROJECTS.length * 4; index += 1) rooms.push(await hotel.cleanRoom());
  // The booking journey's rooms carry a stocked minibar, so the checkout has a
  // report to inspect, lock and reconcile — set up the way the checkout suite
  // does it: a template, two products, a published version, and the
  // configuration change the Cleaner completes by stocking the room.
  const { key, request } = apiRequire('./dist/modules/stay/test-support/stay-harness.js');
  const templateId = await hotel.template('E2E Minibar');
  const product = async (name, price, opening) =>
    (
      await pub.minibar.products.createProduct(
        {
          hotelId: hotel.hotelId,
          idempotencyKey: key('mb'),
          name,
          category: 'Ундаа',
          unit: 'ш',
          sellingPriceMnt: price,
          purchaseCostMnt: 1000n,
          openingQuantity: opening,
          state: 'ACTIVE',
        },
        hotel.manager,
        request(hotel.manager),
      )
    ).productId;
  const water = await product('Ус', 3000n, 200);
  const cola = await product('Кола', 5000n, 200);
  const draft = await pub.minibar.versions.createDraft(
    {
      hotelId: hotel.hotelId,
      templateId,
      idempotencyKey: key('mb'),
      items: [
        { productId: water, targetQuantity: 2 },
        { productId: cola, targetQuantity: 1 },
      ],
    },
    hotel.manager,
    request(hotel.manager),
  );
  const versionId = (
    await pub.minibar.versions.publish(
      {
        hotelId: hotel.hotelId,
        templateId,
        versionId: draft.versionId,
        idempotencyKey: key('mb'),
        expectedRevision: draft.revision,
      },
      hotel.manager,
      request(hotel.manager),
    )
  ).versionId;
  for (const roomId of rooms.slice(PROJECTS.length * 2, PROJECTS.length * 3)) {
    await pub.minibar.configurations.requestChange(
      {
        hotelId: hotel.hotelId,
        roomId,
        idempotencyKey: key('mb'),
        kind: 'OFF_TO_ON',
        targetTemplateId: templateId,
        targetVersionId: versionId,
      },
      hotel.manager,
      request(hotel.manager),
    );
    const view = await pub.minibar.configurations.view(
      { hotelId: hotel.hotelId, roomId },
      hotel.manager,
      request(hotel.manager),
    );
    const task = view.openTask;
    const claimed = await pub.minibar.configurations.claimTask(
      {
        hotelId: hotel.hotelId,
        taskId: task.taskId,
        idempotencyKey: key('mb'),
        expectedRevision: task.revision,
      },
      hotel.cleaner,
      request(hotel.cleaner),
    );
    await pub.minibar.configurations.completeTask(
      {
        hotelId: hotel.hotelId,
        taskId: task.taskId,
        idempotencyKey: key('mb'),
        expectedRevision: claimed.revision,
        counted: [],
        transfers: task.bounds.map((b) => ({ productId: b.productId, quantity: b.maxQuantity })),
      },
      hotel.cleaner,
      request(hotel.cleaner),
    );
  }
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
  // The subscription journey: per project, one hotel in each state the portal
  // must render — expiring soon, in grace, expired — each with its Hotel
  // Admin. `expires_at` never moves backwards on a live row (the database says
  // so), so the states are seeded rather than driven.
  const { HOTEL_ADMIN_PASSWORD } = apiRequire(
    './dist/modules/operation/test-support/operation-harness.js',
  );
  const subscriptionHotels = [];
  for (const project of PROJECTS) {
    const lane = {};
    for (const [state, expiresInHours] of [
      ['expiring', 24 * 3],
      ['grace', -1],
      ['expired', -72],
    ]) {
      const seeded = await ops.hotel({
        name: `E2E Subscription ${state} ${project}`,
        packageCode: 'P25',
        termMonths: 1,
        expiresInHours,
      });
      lane[state] = {
        hotelId: seeded.hotelId,
        name: seeded.name,
        admin: { email: seeded.admin.email, password: HOTEL_ADMIN_PASSWORD },
      };
    }
    subscriptionHotels.push(lane);
  }

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
    LOG_LEVEL: 'info',
    API_HOST: '127.0.0.1',
    API_PORT: String(API_PORT),
    KMS_ADAPTER: 'local',
    KMS_SEED,
    DATABASE_URL: db.loginUrl(TEST_LOGIN_PRINCIPALS.api),
    POLICE_ENABLED: 'true',
    POLICE_DATABASE_URL: db.loginUrl(TEST_LOGIN_PRINCIPALS.police),
    REDIS_URL,
    QUEUE_PREFIX,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1025',
  });
  resetEnvCache();
  const { createApp } = apiRequire('./dist/bootstrap.js');
  const started = await createApp({ port: API_PORT });
  const app = started.app;

  // ХУР answers for the synthetic citizens, in both modules that ask it.
  for (const xyp of [app.get(XYP_IDENTITY), app.get(POLICE_XYP)]) {
    for (const citizen of [...CITIZENS.wanted, ...CITIZENS.wantedSweep, ...CITIZENS.ordinary]) {
      const { registrationNumber, ...answer } = citizen;
      xyp.register(registrationNumber, answer);
    }
  }
  const otp = app.get(GUEST_OTP);
  const member = (m) => ({ email: m.email, password: m.password });

  // ------------------------------------------------- the worker, in-process
  // The worker's own consumers and sweeps — the same code the worker
  // deployment runs — on the worker's own database login and the real Redis,
  // so provisioning, activation delivery, the Police matcher, the exports and
  // the settlement sweeps happen the way they do in production. They run in
  // this process rather than the worker's only so the console can read the
  // simulators they deliver through (an activation link, a payment).
  const { STAFF_NOTIFICATION } = apiRequire('./dist/modules/iam/iam.tokens.js');
  const { PAYMENT_GATEWAYS, PHONE_VERIFICATION, EBARIMT } = apiRequire(
    './dist/modules/onboarding/onboarding.tokens.js',
  );
  const { BOOKING_PAYMENTS } = apiRequire('./dist/modules/booking/booking.tokens.js');
  const { RESTAURANT_PAYMENTS } = apiRequire('./dist/modules/restaurant/restaurant.tokens.js');
  const { NoProvisioningSignal } = apiRequire(
    './dist/modules/onboarding/contracts/provisioning-signal.js',
  );
  const { attachOnboardingWorkerRuntime } = apiRequire('./dist/onboarding-worker.js');
  const { createPoliceMatcherRuntime } = apiRequire('./dist/police-worker.js');
  const { createReportingWorkerRuntime } = apiRequire('./dist/reporting-worker.js');
  const { createSettlementWorkerRuntime } = apiRequire('./dist/settlement-worker.js');
  const { selectKeyManagement } = apiRequire('@prsystem/ports');
  const { apiEnv } = apiRequire('@prsystem/config');
  const { createLogger } = apiRequire('@prsystem/telemetry');
  const { Pool } = apiRequire('pg');
  const onboardingJobs = workerRequire('./dist/jobs/onboarding.js');
  const policeJobs = workerRequire('./dist/jobs/police.js');
  const reportingJobs = workerRequire('./dist/jobs/reporting.js');
  const settlementJobs = workerRequire('./dist/jobs/settlement.js');
  const { connectionFromUrl } = workerRequire('./dist/queues.js');

  const workerUrl = db.loginUrl(TEST_LOGIN_PRINCIPALS.worker);
  const workerPool = new Pool({ connectionString: workerUrl, max: 6 });
  const workerLogger = createLogger({ level: 'warn', serviceName: 'prsystem-e2e-worker' });
  const staffNotifications = app.get(STAFF_NOTIFICATION);
  const onboardingPhone = app.get(PHONE_VERIFICATION);
  const onboardingRuntime = attachOnboardingWorkerRuntime({
    pool: workerPool,
    keys: selectKeyManagement({ appEnv: 'ci', kmsAdapter: 'local', seed: KMS_SEED }),
    gateways: app.get(PAYMENT_GATEWAYS),
    ebarimt: app.get(EBARIMT),
    phone: onboardingPhone,
    notifications: staffNotifications,
    signals: new NoProvisioningSignal(),
  });
  const adapters = apiEnv().adapters;
  const SWEEP_MS = 2000;
  const connection = () => connectionFromUrl(REDIS_URL);
  const consumers = [];
  consumers.push(
    await onboardingJobs.startOnboardingConsumers({
      connection: connection(),
      runtime: onboardingRuntime,
      logger: workerLogger,
      options: { prefix: QUEUE_PREFIX },
      schedule: (c, o) => onboardingJobs.scheduleOnboardingSweeps(c, { ...o, everyMs: SWEEP_MS }),
    }),
  );
  consumers.push(
    await policeJobs.startPoliceConsumers({
      connection: connection(),
      runtime: createPoliceMatcherRuntime({ databaseUrl: workerUrl }),
      logger: workerLogger,
      options: { prefix: QUEUE_PREFIX },
      schedule: (c, o) => policeJobs.schedulePoliceSweep(c, { ...o, everyMs: SWEEP_MS }),
    }),
  );
  const reportingRuntime = createReportingWorkerRuntime({
    databaseUrl: workerUrl,
    appEnv: 'ci',
    adapters,
  });
  consumers.push(
    await reportingJobs.startReportingConsumers({
      connection: connection(),
      runtime: reportingRuntime,
      logger: workerLogger,
      options: { prefix: QUEUE_PREFIX },
      schedule: (c, o) => reportingJobs.scheduleReportingSweeps(c, { ...o, everyMs: SWEEP_MS }),
    }),
  );
  const settlementRuntime = createSettlementWorkerRuntime({ databaseUrl: workerUrl, adapters });
  consumers.push(
    await settlementJobs.startSettlementConsumers({
      connection: connection(),
      runtime: settlementRuntime,
      logger: workerLogger,
      options: { prefix: QUEUE_PREFIX },
      schedule: (queues, c, o) =>
        settlementJobs.scheduleSettlementSweeps(queues, c, { ...o, everyMs: SWEEP_MS }),
    }),
  );
  process.stdout.write(`e2e worker consumers started under queue prefix ${QUEUE_PREFIX}\n`);

  // ------------------------------------------------------------ leakage
  // Every secret this run knows: the seeded and registered passwords, every
  // one-time code a simulator "sent", every authenticator code the console
  // handed out, every token a notification carried, and what the tests add
  // (session tokens, access codes, QR tokens, registration numbers). None of
  // them may appear in the API's log or in any durable record.
  const canaries = new Set();
  const addCanary = (value) => {
    if (typeof value === 'string' && value.length >= 6) canaries.add(value);
  };
  for (const c of [
    OPERATION_PASSWORD,
    HOTEL_ADMIN_PASSWORD,
    POLICE_PASSWORD,
    hotel.receptionMember.password,
  ])
    addCanary(c);
  for (const citizen of [...CITIZENS.wanted, ...CITIZENS.wantedSweep, ...CITIZENS.ordinary])
    addCanary(citizen.registrationNumber);
  const gateways = {
    booking: app.get(BOOKING_PAYMENTS),
    onboarding: app.get(PAYMENT_GATEWAYS),
    subscription: app.get(PAYMENT_GATEWAYS),
    restaurant: app.get(RESTAURANT_PAYMENTS),
  };

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
    subscriptionHotels,
    worker: { queuePrefix: QUEUE_PREFIX, sweepMs: SWEEP_MS },
    citizens: CITIZENS,
  };

  // ------------------------------------------------------------- console
  const invoiceIdFor = async (scope, body) => {
    if (typeof body.providerInvoiceId === 'string') return body.providerInvoiceId;
    const queries = {
      booking: [
        'SELECT provider_invoice_id FROM platform.booking_payment_attempt WHERE booking_id = $1 AND provider_invoice_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
        body.bookingId,
      ],
      onboarding: [
        'SELECT provider_invoice_id FROM platform.onboarding_payment_attempt WHERE application_id = $1 AND provider_invoice_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
        body.applicationId,
      ],
      subscription: [
        'SELECT provider_invoice_id FROM platform.subscription_billing_intent WHERE hotel_id = $1 AND provider_invoice_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
        body.hotelId,
      ],
      restaurant: [
        'SELECT provider_invoice_id FROM platform.restaurant_payment_attempt WHERE order_id = $1 AND provider_invoice_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
        body.orderId,
      ],
    };
    const [sql, param] = queries[scope];
    const result = await db.pool.query(sql, [param]);
    return result.rows[0]?.provider_invoice_id;
  };
  const CALLBACK_PATHS = {
    booking: (p) => `/payments/callbacks/${p.toLowerCase()}`,
    onboarding: (p) => `/onboarding/payments/${p.toLowerCase()}/callback`,
    subscription: (p, body) =>
      `/hotels/${body.hotelId}/subscription/payments/${p.toLowerCase()}/callback`,
    restaurant: (p) => `/restaurant/payments/callbacks/${p.toLowerCase()}`,
  };

  const scanText = (text, source, location, findings) => {
    for (const canary of canaries) {
      if (text.includes(canary))
        findings.push({
          source,
          location,
          canary: `${canary.slice(0, 2)}…${canary.slice(-2)} (${String(canary.length)} chars)`,
        });
    }
  };
  const scanRow = (json, source, location, findings) => {
    scanText(json, source, location, findings);
    // bytea columns arrive as hex; plaintext hidden in hex is still plaintext.
    for (const hex of json.match(/\\\\x[0-9a-f]{12,}/g) ?? []) {
      scanText(
        Buffer.from(hex.slice(3), 'hex').toString('utf8'),
        source,
        `${location} (bytea)`,
        findings,
      );
    }
  };
  async function leakageScan() {
    const findings = [];
    const scanned = { tables: 0, rows: 0, logBytes: 0, redisKeys: 0 };
    const tables = await db.pool.query(
      `SELECT table_schema, table_name FROM information_schema.tables
        WHERE table_schema IN ('platform', 'police', 'audit', 'police_audit') AND table_type = 'BASE TABLE'
        ORDER BY 1, 2`,
    );
    for (const { table_schema, table_name } of tables.rows) {
      scanned.tables += 1;
      const rows = await db.pool.query(
        `SELECT row_to_json(t)::text AS j FROM ${table_schema}.${table_name} t`,
      );
      for (const [index, row] of rows.rows.entries()) {
        scanned.rows += 1;
        scanRow(row.j, 'database', `${table_schema}.${table_name}#${String(index)}`, findings);
      }
    }
    if (API_LOG !== undefined && existsSync(API_LOG)) {
      const log = readFileSync(API_LOG, 'utf8');
      scanned.logBytes = log.length;
      log
        .split('\n')
        .forEach((line, index) => scanText(line, 'api-log', `line ${String(index + 1)}`, findings));
    }
    try {
      const IORedis = workerRequire('ioredis');
      const redis = new IORedis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await redis.connect();
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${QUEUE_PREFIX}*`, 'COUNT', 500);
        cursor = next;
        for (const key of keys) {
          scanned.redisKeys += 1;
          const type = await redis.type(key);
          let value = '';
          if (type === 'string') value = (await redis.get(key)) ?? '';
          else if (type === 'hash') value = JSON.stringify(await redis.hgetall(key));
          else if (type === 'list') value = JSON.stringify(await redis.lrange(key, 0, -1));
          else if (type === 'zset') value = JSON.stringify(await redis.zrange(key, 0, -1));
          else if (type === 'set') value = JSON.stringify(await redis.smembers(key));
          scanText(value, 'redis', key, findings);
        }
      } while (cursor !== '0');
      await redis.quit();
    } catch (error) {
      findings.push({
        source: 'redis',
        location: 'scan',
        canary: `unreadable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return { findings, scanned, canaries: canaries.size };
  }

  const readBody = (request) =>
    new Promise((done) => {
      let text = '';
      request.on('data', (chunk) => (text += chunk));
      request.on('end', () => done(text === '' ? {} : JSON.parse(text)));
    });

  const console_ = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${String(CONSOLE_PORT)}`);
    const reply = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const handle = async () => {
      if (url.pathname === '/seed') return reply(200, seed);
      if (url.pathname === '/otp') {
        // The simulators hold the normalised `+976########`; a test may ask with
        // the eight digits a person types. The last eight digits are the number.
        const digits = (url.searchParams.get('phone') ?? '').replace(/\D/g, '').slice(-8);
        for (const simulator of [otp, onboardingPhone]) {
          const deliveries = simulator.deliveries;
          for (let index = deliveries.length - 1; index >= 0; index -= 1) {
            if (deliveries[index].phone.replace(/\D/g, '').slice(-8) === digits) {
              addCanary(deliveries[index].code);
              return reply(200, { code: deliveries[index].code });
            }
          }
        }
        return reply(404, { error: 'no code was sent to that number' });
      }
      if (url.pathname === '/totp') {
        const operator = operators.get(url.searchParams.get('email') ?? '');
        if (operator === undefined) return reply(404, { error: 'not a seeded operator' });
        const code = operator.codeAt(new Date());
        addCanary(code);
        return reply(200, { code });
      }
      if (url.pathname === '/notification') {
        // The newest staff notification of a kind, for an address or a hotel —
        // the activation link the worker delivered, the invitation the API sent.
        const kind = url.searchParams.get('kind') ?? 'staff_invitation';
        const email = url.searchParams.get('email')?.toLowerCase();
        const hotelId = url.searchParams.get('hotelId');
        const all = staffNotifications.all();
        for (let index = all.length - 1; index >= 0; index -= 1) {
          const message = all[index];
          if (message.kind !== kind) continue;
          if (email !== undefined && message.emailNormalized?.toLowerCase() !== email) continue;
          if (hotelId !== null && message.hotelId !== hotelId) continue;
          addCanary(message.token);
          return reply(200, {
            kind: message.kind,
            hotelId: message.hotelId,
            invitationId: message.invitationId,
            email: message.emailNormalized,
            token: message.token,
          });
        }
        return reply(404, { error: 'no such notification' });
      }
      if (url.pathname === '/simulate/payment' && request.method === 'POST') {
        const body = await readBody(request);
        const scope = body.scope;
        const registry = gateways[scope];
        if (registry === undefined) return reply(400, { error: 'unknown scope' });
        const provider = (body.provider ?? 'QPAY').toUpperCase();
        const providerInvoiceId = await invoiceIdFor(scope, body);
        if (providerInvoiceId === undefined)
          return reply(404, { error: 'no invoice for that subject yet' });
        const gateway = registry.gateway(provider);
        gateway.pay(providerInvoiceId, new Date());
        return reply(200, {
          provider,
          providerInvoiceId,
          signature: gateway.signatureFor(providerInvoiceId),
          callbackPath: CALLBACK_PATHS[scope](provider, body),
        });
      }
      if (url.pathname === '/db/subscription-expiry' && request.method === 'POST') {
        const body = await readBody(request);
        await db.pool.query(
          `UPDATE platform.hotel_subscription SET expires_at = now() + make_interval(hours => $2), revision = revision + 1 WHERE hotel_id = $1`,
          [body.hotelId, Number(body.expiresInHours)],
        );
        return reply(200, { shifted: true });
      }
      if (url.pathname === '/db/payable') {
        const result = await db.pool.query(
          `SELECT payable_id, gross_paid_mnt::text, commission_mnt::text, hotel_payable_mnt::text, payout_state, eligible_at FROM platform.booking_payable WHERE booking_id = $1`,
          [url.searchParams.get('bookingId')],
        );
        return reply(200, { payables: result.rows });
      }
      if (url.pathname === '/db/match') {
        const result = await db.pool.query(
          `SELECT m.match_id, m.detected_at, m.check_in_recorded_at, a.created_at AS alert_created_at
             FROM police.police_match m LEFT JOIN police.match_alert a ON a.match_id = m.match_id
            WHERE m.stay_id = $1 ORDER BY a.created_at ASC NULLS LAST LIMIT 1`,
          [url.searchParams.get('stayId')],
        );
        const row = result.rows[0];
        if (row === undefined) return reply(404, { error: 'no match yet' });
        return reply(200, {
          matchId: row.match_id,
          detectedAt: row.detected_at,
          checkInRecordedAt: row.check_in_recorded_at,
          alertCreatedAt: row.alert_created_at,
          latencyMs:
            row.alert_created_at === null
              ? null
              : new Date(row.alert_created_at).getTime() -
                new Date(row.check_in_recorded_at).getTime(),
          detectLatencyMs:
            new Date(row.detected_at).getTime() - new Date(row.check_in_recorded_at).getTime(),
        });
      }
      if (url.pathname === '/db/outbox') {
        const result = await db.pool.query(
          `SELECT count(*) FILTER (WHERE d.published_at IS NULL)::int AS pending,
                  count(*) FILTER (WHERE d.published_at IS NOT NULL)::int AS published,
                  extract(epoch FROM (now() - min(e.occurred_at) FILTER (WHERE d.published_at IS NULL)))::float AS oldest_pending_seconds
             FROM platform.outbox_event e LEFT JOIN platform.outbox_delivery d ON d.event_id = e.event_id`,
        );
        return reply(200, result.rows[0]);
      }
      if (url.pathname === '/leakage/canaries' && request.method === 'POST') {
        const body = await readBody(request);
        for (const value of body.values ?? []) addCanary(value);
        return reply(200, { canaries: canaries.size });
      }
      if (url.pathname === '/leakage') return reply(200, await leakageScan());
      return reply(404, { error: 'unknown' });
    };
    handle().catch((error) =>
      reply(500, { error: error instanceof Error ? error.message : String(error) }),
    );
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
      for (const consumer of consumers) await consumer.close().catch(() => undefined);
      await onboardingRuntime.close().catch(() => undefined);
      await workerPool.end().catch(() => undefined);
      try {
        const IORedis = workerRequire('ioredis');
        const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
        let cursor = '0';
        do {
          const [next, keys] = await redis.scan(cursor, 'MATCH', `${QUEUE_PREFIX}*`, 'COUNT', 500);
          cursor = next;
          if (keys.length > 0) await redis.del(...keys);
        } while (cursor !== '0');
        await redis.quit();
      } catch {
        /* the keys are namespaced by this run's prefix and harmless if left */
      }
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
