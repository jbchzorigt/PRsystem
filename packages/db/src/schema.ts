import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * `bytea`, which Drizzle 0.45.2 has no built-in column for.
 *
 * Envelope ciphertext and wrapped data keys are bytes. Storing them as text
 * would mean an encoding nobody declared, so the column keeps its real type and
 * `customType` reports the exact type name the comparator reads back from the
 * catalogue.
 */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * Drizzle schema representation of the Phase 03 kernel.
 *
 * The migration SQL is authoritative — it carries the policies, grants, triggers
 * and constraints that Drizzle's DSL cannot express, and ADR-0004 keeps
 * versioned SQL as the migration mechanism. This declaration exists so the
 * shape can be *compared*: `migrate.test.ts` fails if a kernel table, column or
 * nullability in the database and in this file disagree.
 *
 * It states everything the DSL can state faithfully: types, nullability,
 * defaults, identity, and simple, composite and unique keys. Defaults are given
 * as their exact PostgreSQL text rather than as JavaScript values, because a
 * rendered value is a guess about how PostgreSQL would spell it and this file is
 * compared character for character against the canonical snapshot.
 *
 * It also states foreign keys with their referential action, check constraints
 * with the exact PostgreSQL text of the predicate, and ordinary, unique and
 * partial indexes. Those were previously described as non-expressible; Drizzle
 * 0.45.2 expresses all of them, and describing them otherwise left real schema
 * properties declared in one place only.
 *
 * Anything the DSL cannot express — RLS and policies, grants, triggers,
 * partitioning, exclusion constraints — stays in `schema-snapshot.ts` and in the
 * normalized `pg_dump` comparison, with the reason for each recorded there. What
 * must not happen is a change here passing silently because the snapshot still
 * matches the database; `schema-projection.ts` compares this declaration against
 * the snapshot for exactly that reason.
 */
export const platform = pgSchema('platform');
export const auditSchema = pgSchema('audit');
export const policeAudit = pgSchema('police_audit');

export const idempotencyKey = platform
  .table(
    'idempotency_key',
    {
      idempotencyId: uuid('idempotency_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      hotelId: uuid('hotel_id').notNull(),
      realm: text('realm').notNull(),
      actorRef: text('actor_ref').notNull(),
      clientRef: text('client_ref').notNull(),
      operation: text('operation').notNull(),
      idempotencyKey: text('idempotency_key').notNull(),
      requestHash: text('request_hash').notNull(),
      state: text('state')
        .notNull()
        .default(sql`'in_progress'::text`),
      responseStatus: integer('response_status'),
      responseBody: jsonb('response_body'),
      correlationId: text('correlation_id'),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      completedAt: timestamp('completed_at', { withTimezone: true }),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    },
    (table) => [
      check(
        'idempotency_key_not_blank',
        sql`((length(idempotency_key) >= 8) AND (length(idempotency_key) <= 200))`,
      ),
      check(
        'idempotency_state_known',
        sql`(state = ANY (ARRAY['in_progress'::text, 'succeeded'::text, 'failed'::text]))`,
      ),
      check(
        'idempotency_terminal_has_response',
        sql`(((state = 'in_progress'::text) AND (response_status IS NULL) AND (completed_at IS NULL)) OR ((state <> 'in_progress'::text) AND (response_status IS NOT NULL) AND (completed_at IS NOT NULL)))`,
      ),
      index('idempotency_key_expiry_idx').on(table.expiresAt),
      uniqueIndex('idempotency_key_scope_uq').on(
        table.realm,
        table.actorRef,
        table.operation,
        table.idempotencyKey,
      ),
      // Tenant isolation (ADR-0017). Declared here as well as in SQL so the two
      // descriptions of the same policy are compared rather than trusted: RLS
      // enablement and policy definitions are expressible in Drizzle 0.45.2, and
      // were previously classified as unsupported.
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const outboxEvent = platform
  .table(
    'outbox_event',
    {
      eventId: bigint('event_id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
      eventUuid: uuid('event_uuid')
        .notNull()
        .default(sql`gen_random_uuid()`),
      hotelId: uuid('hotel_id').notNull(),
      aggregateType: text('aggregate_type').notNull(),
      aggregateId: text('aggregate_id').notNull(),
      eventType: text('event_type').notNull(),
      eventVersion: integer('event_version')
        .notNull()
        .default(sql`1`),
      payload: jsonb('payload').notNull(),
      correlationId: text('correlation_id'),
      causationId: text('causation_id'),
      occurredAt: timestamp('occurred_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
    },
    (table) => [
      unique('outbox_event_uuid_uq').on(table.eventUuid),
      check('outbox_event_version_positive', sql`(event_version >= 1)`),
      check('outbox_payload_sanitised', sql`(NOT platform.contains_denied_key(payload))`),
      index('outbox_event_aggregate_idx').on(table.aggregateType, table.aggregateId, table.eventId),
      // Tenant isolation (ADR-0017). Declared here as well as in SQL so the two
      // descriptions of the same policy are compared rather than trusted: RLS
      // enablement and policy definitions are expressible in Drizzle 0.45.2, and
      // were previously classified as unsupported.
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const outboxDelivery = platform
  .table(
    'outbox_delivery',
    {
      eventId: bigint('event_id', { mode: 'bigint' }).primaryKey(),
      hotelId: uuid('hotel_id').notNull(),
      state: text('state')
        .notNull()
        .default(sql`'pending'::text`),
      attempts: integer('attempts')
        .notNull()
        .default(sql`0`),
      availableAt: timestamp('available_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      claimedBy: text('claimed_by'),
      claimedUntil: timestamp('claimed_until', { withTimezone: true }),
      publishedAt: timestamp('published_at', { withTimezone: true }),
      lastError: text('last_error'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
    },
    (table) => [
      check('outbox_delivery_attempts_non_negative', sql`(attempts >= 0)`),
      check(
        'outbox_delivery_published_has_time',
        sql`((state = 'published'::text) = (published_at IS NOT NULL))`,
      ),
      check(
        'outbox_delivery_state_known',
        sql`(state = ANY (ARRAY['pending'::text, 'claimed'::text, 'published'::text, 'failed'::text]))`,
      ),
      foreignKey({
        name: 'outbox_delivery_event_id_fkey',
        columns: [table.eventId],
        foreignColumns: [outboxEvent.eventId],
      }).onDelete('restrict'),
      index('outbox_delivery_claimable_idx')
        .on(table.availableAt, table.eventId)
        .where(sql`state = ANY (ARRAY['pending'::text, 'claimed'::text])`),
      // Tenant isolation (ADR-0017). Declared here as well as in SQL so the two
      // descriptions of the same policy are compared rather than trusted: RLS
      // enablement and policy definitions are expressible in Drizzle 0.45.2, and
      // were previously classified as unsupported.
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const inboxConsumption = platform
  .table(
    'inbox_consumption',
    {
      consumptionId: uuid('consumption_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      hotelId: uuid('hotel_id').notNull(),
      consumer: text('consumer').notNull(),
      dedupKey: text('dedup_key').notNull(),
      source: text('source').notNull(),
      firstConsumedAt: timestamp('first_consumed_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
    },
    (table) => [
      unique('inbox_consumption_uq').on(table.consumer, table.dedupKey),
      // Tenant isolation (ADR-0017). Declared here as well as in SQL so the two
      // descriptions of the same policy are compared rather than trusted: RLS
      // enablement and policy definitions are expressible in Drizzle 0.45.2, and
      // were previously classified as unsupported.
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const providerEvent = platform
  .table(
    'provider_event',
    {
      providerEventRowId: uuid('provider_event_row_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      hotelId: uuid('hotel_id').notNull(),
      provider: text('provider').notNull(),
      providerEventId: text('provider_event_id').notNull(),
      eventKind: text('event_kind').notNull(),
      payloadHash: text('payload_hash').notNull(),
      metadata: jsonb('metadata')
        .notNull()
        .default(sql`'{}'::jsonb`),
      receivedAt: timestamp('received_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
    },
    (table) => [
      unique('provider_event_uq').on(table.provider, table.providerEventId),
      check('provider_event_hash_shape', sql`(payload_hash ~ '^[0-9a-f]{64}$'::text)`),
      check('provider_event_metadata_sanitised', sql`(NOT platform.contains_denied_key(metadata))`),
      // Tenant isolation (ADR-0017). Declared here as well as in SQL so the two
      // descriptions of the same policy are compared rather than trusted: RLS
      // enablement and policy definitions are expressible in Drizzle 0.45.2, and
      // were previously classified as unsupported.
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const jobRun = platform
  .table(
    'job_run',
    {
      jobRunId: uuid('job_run_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      hotelId: uuid('hotel_id').notNull(),
      jobName: text('job_name').notNull(),
      jobIdentity: text('job_identity').notNull(),
      /** D-09: who issued the job, as distinct from who executes it. */
      issuerRef: text('issuer_ref'),
      state: text('state')
        .notNull()
        .default(sql`'running'::text`),
      scope: jsonb('scope')
        .notNull()
        .default(sql`'{}'::jsonb`),
      asOf: timestamp('as_of', { withTimezone: true }),
      startedAt: timestamp('started_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      finishedAt: timestamp('finished_at', { withTimezone: true }),
      errorName: text('error_name'),
    },
    (table) => [
      check(
        'job_run_error_name_bounded',
        sql`((error_name IS NULL) OR ((length(error_name) >= 1) AND (length(error_name) <= 128)))`,
      ),
      check('job_run_identity_shape', sql`(job_identity ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'::text)`),
      check(
        'job_run_issuer_shape',
        sql`((issuer_ref IS NULL) OR (issuer_ref ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'::text))`,
      ),
      check('job_run_job_name_shape', sql`(job_name ~ '^[a-z][a-z0-9_.]{2,127}$'::text)`),
      check(
        'job_run_privileged_has_issuer',
        sql`((job_name !~~ 'platform.maintenance.%'::text) OR (issuer_ref IS NOT NULL))`,
      ),
      check(
        'job_run_state_known',
        sql`(state = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text]))`,
      ),
      check(
        'job_run_terminal_has_finish',
        sql`((state = 'running'::text) = (finished_at IS NULL))`,
      ),
      index('job_run_name_idx').on(table.jobName, table.startedAt.desc().nullsFirst()),
      // Tenant isolation (ADR-0017). Declared here as well as in SQL so the two
      // descriptions of the same policy are compared rather than trusted: RLS
      // enablement and policy definitions are expressible in Drizzle 0.45.2, and
      // were previously classified as unsupported.
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const exportArtifact = platform
  .table(
    'export_artifact',
    {
      exportId: uuid('export_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      hotelId: uuid('hotel_id').notNull(),
      jobRunId: uuid('job_run_id'),
      exportKind: text('export_kind').notNull(),
      storageKey: text('storage_key').notNull(),
      contentHash: text('content_hash').notNull(),
      rowCount: integer('row_count')
        .notNull()
        .default(sql`0`),
      asOf: timestamp('as_of', { withTimezone: true }).notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      expiresAt: timestamp('expires_at', { withTimezone: true }),
    },
    (table) => [
      check('export_artifact_hash_shape', sql`(content_hash ~ '^[0-9a-f]{64}$'::text)`),
      check('export_artifact_rows_non_negative', sql`(row_count >= 0)`),
      foreignKey({
        name: 'export_artifact_job_run_id_fkey',
        columns: [table.jobRunId],
        foreignColumns: [jobRun.jobRunId],
      }),
      // Tenant isolation (ADR-0017). Declared here as well as in SQL so the two
      // descriptions of the same policy are compared rather than trusted: RLS
      // enablement and policy definitions are expressible in Drizzle 0.45.2, and
      // were previously classified as unsupported.
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const projectionCheckpoint = platform.table(
  'projection_checkpoint',
  {
    projection: text('projection').primaryKey(),
    lastEventId: bigint('last_event_id', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    asOf: timestamp('as_of', { withTimezone: true }),
    status: text('status')
      .notNull()
      .default(sql`'idle'::text`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    revision: integer('revision')
      .notNull()
      .default(sql`0`),
  },
  () => [
    check('projection_last_event_non_negative', sql`(last_event_id >= 0)`),
    check(
      'projection_status_known',
      sql`(status = ANY (ARRAY['idle'::text, 'running'::text, 'rebuilding'::text, 'failed'::text]))`,
    ),
  ],
);

export const externalGate = platform.table(
  'external_gate',
  {
    gateCode: text('gate_code').primaryKey(),
    description: text('description').notNull(),
    enabled: boolean('enabled')
      .notNull()
      .default(sql`false`),
    blocker: text('blocker'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  () => [check('external_gate_code_shape', sql`(gate_code ~ '^EXT-\\d{2}$'::text)`)],
);

export const internalGate = platform.table(
  'internal_gate',
  {
    controlCode: text('control_code').primaryKey(),
    description: text('description').notNull(),
    enabled: boolean('enabled')
      .notNull()
      .default(sql`false`),
    blocker: text('blocker'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  () => [check('internal_gate_code_shape', sql`(control_code ~ '^INT-[A-Z]{2,8}-\\d{2}$'::text)`)],
);

export const featureFlag = platform.table('feature_flag', {
  flagKey: text('flag_key').primaryKey(),
  description: text('description').notNull(),
  enabled: boolean('enabled')
    .notNull()
    .default(sql`false`),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const operationalAlert = platform.table(
  'operational_alert',
  {
    alertId: uuid('alert_id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    alertCode: text('alert_code').notNull(),
    severity: text('severity').notNull(),
    detail: jsonb('detail')
      .notNull()
      .default(sql`'{}'::jsonb`),
    raisedAt: timestamp('raised_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'operational_alert_severity_known',
      sql`(severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text]))`,
    ),
    index('operational_alert_open_idx')
      .on(table.alertCode, table.raisedAt.desc().nullsFirst())
      .where(sql`resolved_at IS NULL`),
  ],
);

/**
 * The two append-only audit streams. Declared as their root partitioned tables:
 * the partitions themselves are created by
 * `platform.ensure_month_partitions`, which is SQL-only territory and is
 * covered by the normalized dump rather than by this declaration.
 */
export const platformEvent = auditSchema.table(
  'platform_event',
  {
    eventId: uuid('event_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    realm: text('realm').notNull(),
    action: text('action').notNull(),
    outcome: text('outcome').notNull(),
    actorRef: text('actor_ref'),
    hotelId: uuid('hotel_id'),
    targetType: text('target_type'),
    targetRef: text('target_ref'),
    reason: text('reason'),
    correlationId: text('correlation_id'),
    causationId: text('causation_id'),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => [
    primaryKey({ name: 'platform_event_pk', columns: [table.occurredAt, table.eventId] }),
    check(
      'platform_event_outcome_known',
      sql`(outcome = ANY (ARRAY['allowed'::text, 'denied'::text, 'failed'::text]))`,
    ),
    check('platform_event_payload_sanitised', sql`(NOT platform.contains_denied_key(payload))`),
  ],
);

export const securityEvent = policeAudit.table(
  'security_event',
  {
    eventId: uuid('event_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    action: text('action').notNull(),
    outcome: text('outcome').notNull(),
    actorRef: text('actor_ref'),
    caseRef: text('case_ref'),
    reason: text('reason'),
    correlationId: text('correlation_id'),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => [
    primaryKey({ name: 'security_event_pk', columns: [table.occurredAt, table.eventId] }),
    check(
      'security_event_outcome_known',
      sql`(outcome = ANY (ARRAY['allowed'::text, 'denied'::text, 'failed'::text]))`,
    ),
    check('security_event_payload_sanitised', sql`(NOT platform.contains_denied_key(payload))`),
  ],
);

/**
 * Phase 04 — IAM, tenancy, RBAC and the staff lifecycle.
 *
 * The same contract as the kernel tables above: the migration SQL is
 * authoritative, and this declaration exists so the shape can be compared
 * rather than trusted. Triggers, grants and `FORCE ROW LEVEL SECURITY` stay in
 * `schema-snapshot.ts` because Drizzle 0.45.2 has no form for them; everything
 * the DSL can state — columns, defaults, keys, foreign keys with their action,
 * checks, partial unique indexes, RLS enablement and policies — is stated here.
 *
 * Two columns deliberately carry no foreign key. `restaurant_id` and
 * `subject_ref` point at aggregates owned by Phases 15, 11 and 09; creating
 * those tables here to satisfy a constraint would put IAM in charge of them.
 * The reference is opaque and the owning phase completes the linkage.
 */

export const hotel = platform
  .table(
    'hotel',
    {
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      displayName: text('display_name').notNull(),
      hotelId: uuid('hotel_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
      timezone: text('timezone')
        .notNull()
        .default(sql`'Asia/Ulaanbaatar'::text`),
    },
    () => [
      check(
        'hotel_display_name_bounded',
        sql`((length(display_name) >= 1) AND (length(display_name) <= 200))`,
      ),
      check('hotel_revision_non_negative', sql`(revision >= 0)`),
      check('hotel_state_known', sql`(state = ANY (ARRAY['ACTIVE'::text, 'SUSPENDED'::text]))`),
      check('hotel_timezone_known', sql`(timezone = 'Asia/Ulaanbaatar'::text)`),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const userAccount = platform.table(
  'user_account',
  {
    accountId: uuid('account_id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    authEpoch: integer('auth_epoch')
      .notNull()
      .default(sql`0`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    emailNormalized: text('email_normalized').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    policeScopeRef: text('police_scope_ref'),
    realm: text('realm').notNull(),
    realmRole: text('realm_role'),
    revision: integer('revision')
      .notNull()
      .default(sql`0`),
    state: text('state')
      .notNull()
      .default(sql`'ACTIVE'::text`),
  },
  (table) => [
    check('user_account_auth_epoch_non_negative', sql`(auth_epoch >= 0)`),
    check('user_account_email_normalised', sql`(email_normalized = lower(email_normalized))`),
    check(
      'user_account_email_shape',
      sql`(email_normalized ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'::text)`,
    ),
    check(
      'user_account_police_scope_is_police',
      sql`((police_scope_ref IS NULL) OR (realm = 'police'::text))`,
    ),
    check(
      'user_account_realm_known',
      sql`(realm = ANY (ARRAY['hotel'::text, 'operation'::text, 'police'::text]))`,
    ),
    check(
      'user_account_realm_role_matches_realm',
      sql`
CASE realm
    WHEN 'operation'::text THEN (realm_role = ANY (ARRAY['OPERATION_ADMIN'::text, 'PLATFORM_SUPER_ADMIN'::text]))
    WHEN 'police'::text THEN (realm_role = ANY (ARRAY['POLICE_OFFICER'::text, 'POLICE_ADMIN'::text]))
    ELSE (realm_role IS NULL)
END`,
    ),
    check('user_account_revision_non_negative', sql`(revision >= 0)`),
    check(
      'user_account_state_known',
      sql`(state = ANY (ARRAY['PENDING_ACTIVATION'::text, 'ACTIVE'::text, 'SUSPENDED'::text, 'DISABLED'::text]))`,
    ),
    unique('user_account_principal_uq').on(table.accountId, table.realm, table.realmRole),
    unique('user_account_realm_email_uq').on(table.realm, table.emailNormalized),
    unique('user_account_realm_identity_uq').on(table.accountId, table.realm),
    pgPolicy('resolver_read', {
      for: 'select',
      to: ['prsystem_maintenance_fn'],
      using: sql`true`,
    }),
  ],
);

export const accountCredential = platform.table(
  'account_credential',
  {
    accountId: uuid('account_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    credentialId: uuid('credential_id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    kind: text('kind')
      .notNull()
      .default(sql`'password'::text`),
    paramsVersion: text('params_version').notNull(),
    revision: integer('revision')
      .notNull()
      .default(sql`0`),
    secretHash: text('secret_hash').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    check('account_credential_kind_known', sql`(kind = 'password'::text)`),
    check(
      'account_credential_params_shape',
      sql`(params_version ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text)`,
    ),
    check('account_credential_revision_non_negative', sql`(revision >= 0)`),
    check(
      'account_credential_secret_is_derived',
      sql`(secret_hash ~ '^scrypt\\$v=[0-9]+\\$n=[0-9]+,r=[0-9]+,p=[0-9]+\\$[A-Za-z0-9+/=]+\\$[A-Za-z0-9+/=]+$'::text)`,
    ),
    unique('account_credential_one_per_kind').on(table.accountId, table.kind),
    foreignKey({
      name: 'account_credential_account_id_fkey',
      columns: [table.accountId],
      foreignColumns: [userAccount.accountId],
    }).onDelete('restrict'),
  ],
);

export const serverSession = platform.table(
  'server_session',
  {
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    accountEpoch: integer('account_epoch').notNull(),
    accountId: uuid('account_id').notNull(),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    realm: text('realm').notNull(),
    revision: integer('revision')
      .notNull()
      .default(sql`0`),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    sessionId: uuid('session_id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    stepUpAt: timestamp('step_up_at', { withTimezone: true }),
    tokenHash: text('token_hash').notNull(),
    tokenKeyVersion: text('token_key_version').notNull(),
  },
  (table) => [
    check('server_session_epoch_non_negative', sql`(account_epoch >= 0)`),
    check('server_session_expiry_ordered', sql`(idle_expires_at <= absolute_expires_at)`),
    check(
      'server_session_realm_known',
      sql`(realm = ANY (ARRAY['hotel'::text, 'operation'::text, 'police'::text]))`,
    ),
    check('server_session_revision_non_negative', sql`(revision >= 0)`),
    check(
      'server_session_revoked_has_reason',
      sql`((revoked_at IS NULL) = (revoked_reason IS NULL))`,
    ),
    check('server_session_token_shape', sql`(token_hash ~ '^[0-9a-f]{64}$'::text)`),
    unique('server_session_identity_uq').on(table.sessionId, table.accountId, table.realm),
    unique('server_session_token_uq').on(table.tokenHash),
    foreignKey({
      name: 'server_session_account_realm_fkey',
      columns: [table.accountId, table.realm],
      foreignColumns: [userAccount.accountId, userAccount.realm],
    }).onDelete('restrict'),
  ],
);

export const staffMembership = platform
  .table(
    'staff_membership',
    {
      accountId: uuid('account_id'),
      activatedAt: timestamp('activated_at', { withTimezone: true }),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      createdByAccountId: uuid('created_by_account_id'),
      hotelId: uuid('hotel_id').notNull(),
      invitedEmailNormalized: text('invited_email_normalized').notNull(),
      isPrimaryAdmin: boolean('is_primary_admin')
        .notNull()
        .default(sql`false`),
      membershipId: uuid('membership_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      membershipRevision: integer('membership_revision')
        .notNull()
        .default(sql`0`),
      restaurantId: uuid('restaurant_id'),
      state: text('state')
        .notNull()
        .default(sql`'PENDING'::text`),
      stateChangedAt: timestamp('state_changed_at', { withTimezone: true }),
      stateReason: text('state_reason'),
    },
    (table) => [
      check(
        'staff_membership_active_has_account',
        sql`((state = 'PENDING'::text) OR (account_id IS NOT NULL))`,
      ),
      check(
        'staff_membership_email_normalised',
        sql`(invited_email_normalized = lower(invited_email_normalized))`,
      ),
      check(
        'staff_membership_primary_is_active',
        sql`((NOT is_primary_admin) OR (state = ANY (ARRAY['PENDING'::text, 'ACTIVE'::text])))`,
      ),
      check(
        'staff_membership_primary_is_hotel_scope',
        sql`((NOT is_primary_admin) OR (restaurant_id IS NULL))`,
      ),
      check('staff_membership_revision_non_negative', sql`(membership_revision >= 0)`),
      check(
        'staff_membership_state_known',
        sql`(state = ANY (ARRAY['PENDING'::text, 'ACTIVE'::text, 'SUSPENDED'::text, 'TERMINATED'::text]))`,
      ),
      unique('staff_membership_account_scope_uq').on(
        table.hotelId,
        table.membershipId,
        table.accountId,
      ),
      unique('staff_membership_scope_uq').on(table.hotelId, table.membershipId),
      foreignKey({
        name: 'staff_membership_account_id_fkey',
        columns: [table.accountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'staff_membership_created_by_fkey',
        columns: [table.createdByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'staff_membership_hotel_id_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      index('staff_membership_account_idx')
        .on(table.accountId, table.hotelId)
        .where(sql`account_id IS NOT NULL`),
      uniqueIndex('staff_membership_hotel_account_uq')
        .on(table.hotelId, table.accountId)
        .where(sql`(restaurant_id IS NULL) AND (account_id IS NOT NULL)`),
      uniqueIndex('staff_membership_hotel_email_uq')
        .on(table.hotelId, table.invitedEmailNormalized)
        .where(sql`restaurant_id IS NULL`),
      uniqueIndex('staff_membership_primary_admin_uq')
        .on(table.hotelId)
        .where(sql`is_primary_admin IS TRUE`),
      uniqueIndex('staff_membership_restaurant_account_uq')
        .on(table.hotelId, table.restaurantId, table.accountId)
        .where(sql`(restaurant_id IS NOT NULL) AND (account_id IS NOT NULL)`),
      uniqueIndex('staff_membership_restaurant_email_uq')
        .on(table.hotelId, table.restaurantId, table.invitedEmailNormalized)
        .where(sql`restaurant_id IS NOT NULL`),
      pgPolicy('resolver_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`true`,
      }),
      pgPolicy('own_membership_read', {
        for: 'select',
        using: sql`((platform.current_hotel_id() = '00000000-0000-0000-0000-000000000000'::uuid) AND (account_id = platform.current_account_id()))`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const sessionScopeGrant = platform
  .table(
    'session_scope_grant',
    {
      accountId: uuid('account_id').notNull(),
      grantedAt: timestamp('granted_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      hotelId: uuid('hotel_id').notNull(),
      membershipId: uuid('membership_id').notNull(),
      membershipRevision: integer('membership_revision').notNull(),
      realm: text('realm').notNull(),
      revokedAt: timestamp('revoked_at', { withTimezone: true }),
      revokedReason: text('revoked_reason'),
      scopeGrantId: uuid('scope_grant_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      sessionId: uuid('session_id').notNull(),
    },
    (table) => [
      check('session_scope_grant_realm_is_hotel', sql`(realm = 'hotel'::text)`),
      check('session_scope_grant_revision_non_negative', sql`(membership_revision >= 0)`),
      check(
        'session_scope_grant_revoked_has_reason',
        sql`((revoked_at IS NULL) = (revoked_reason IS NULL))`,
      ),
      foreignKey({
        name: 'session_scope_grant_membership_fkey',
        columns: [table.hotelId, table.membershipId, table.accountId],
        foreignColumns: [
          staffMembership.hotelId,
          staffMembership.membershipId,
          staffMembership.accountId,
        ],
      }).onDelete('restrict'),
      foreignKey({
        name: 'session_scope_grant_session_fkey',
        columns: [table.sessionId, table.accountId, table.realm],
        foreignColumns: [serverSession.sessionId, serverSession.accountId, serverSession.realm],
      }).onDelete('restrict'),
      uniqueIndex('session_scope_grant_live_uq')
        .on(table.sessionId, table.membershipId)
        .where(sql`revoked_at IS NULL`),
      pgPolicy('own_account_scope', {
        using: sql`((platform.current_hotel_id() = '00000000-0000-0000-0000-000000000000'::uuid) AND (account_id = platform.current_account_id()))`,
        withCheck: sql`((platform.current_hotel_id() = '00000000-0000-0000-0000-000000000000'::uuid) AND (account_id = platform.current_account_id()))`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const membershipRoleGrant = platform
  .table(
    'membership_role_grant',
    {
      grantedAt: timestamp('granted_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      grantedByAccountId: uuid('granted_by_account_id'),
      hotelId: uuid('hotel_id').notNull(),
      membershipId: uuid('membership_id').notNull(),
      revokedAt: timestamp('revoked_at', { withTimezone: true }),
      revokedByAccountId: uuid('revoked_by_account_id'),
      revokedReason: text('revoked_reason'),
      role: text('role').notNull(),
      roleGrantId: uuid('role_grant_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
    },
    (table) => [
      check(
        'membership_role_grant_revocation_complete',
        sql`((revoked_at IS NULL) = (revoked_by_account_id IS NULL))`,
      ),
      check(
        'membership_role_grant_role_known',
        sql`(role = ANY (ARRAY['HOTEL_ADMIN'::text, 'MANAGER'::text, 'MANAGER_PLUS'::text, 'RECEPTION'::text, 'CLEANER'::text, 'RESTAURANT_MANAGER'::text]))`,
      ),
      foreignKey({
        name: 'membership_role_grant_granted_by_fkey',
        columns: [table.grantedByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'membership_role_grant_membership_fkey',
        columns: [table.hotelId, table.membershipId],
        foreignColumns: [staffMembership.hotelId, staffMembership.membershipId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'membership_role_grant_revoked_by_fkey',
        columns: [table.revokedByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      uniqueIndex('membership_role_grant_active_uq')
        .on(table.hotelId, table.membershipId, table.role)
        .where(sql`revoked_at IS NULL`),
      // doc 06 §2: readable before any hotel scope exists, for the principal's
      // own memberships only. The subquery is itself subject to
      // `staff_membership`'s policies.
      pgPolicy('own_membership_roles_read', {
        for: 'select',
        using: sql`((platform.current_hotel_id() = '00000000-0000-0000-0000-000000000000'::uuid) AND (EXISTS ( SELECT 1
   FROM platform.staff_membership m
  WHERE ((m.hotel_id = membership_role_grant.hotel_id) AND (m.membership_id = membership_role_grant.membership_id) AND (m.account_id = platform.current_account_id())))))`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const staffInvitation = platform
  .table(
    'staff_invitation',
    {
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      createdByAccountId: uuid('created_by_account_id').notNull(),
      emailNormalized: text('email_normalized').notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      hotelId: uuid('hotel_id').notNull(),
      invitationId: uuid('invitation_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      membershipId: uuid('membership_id').notNull(),
      state: text('state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
      supersededByInvitationId: uuid('superseded_by_invitation_id'),
      terminalAt: timestamp('terminal_at', { withTimezone: true }),
      terminalReason: text('terminal_reason'),
      tokenHash: text('token_hash').notNull(),
      tokenKeyVersion: text('token_key_version').notNull(),
    },
    (table) => [
      check('staff_invitation_email_normalised', sql`(email_normalized = lower(email_normalized))`),
      check('staff_invitation_expiry_after_creation', sql`(expires_at > created_at)`),
      check(
        'staff_invitation_state_known',
        sql`(state = ANY (ARRAY['ACTIVE'::text, 'ACCEPTED'::text, 'SUPERSEDED'::text, 'EXPIRED'::text, 'REVOKED'::text]))`,
      ),
      check(
        'staff_invitation_terminal_has_time',
        sql`((state = 'ACTIVE'::text) = (terminal_at IS NULL))`,
      ),
      check('staff_invitation_token_shape', sql`(token_hash ~ '^[0-9a-f]{64}$'::text)`),
      unique('staff_invitation_scope_uq').on(table.hotelId, table.invitationId),
      unique('staff_invitation_token_uq').on(table.tokenHash),
      foreignKey({
        name: 'staff_invitation_created_by_fkey',
        columns: [table.createdByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'staff_invitation_membership_fkey',
        columns: [table.hotelId, table.membershipId],
        foreignColumns: [staffMembership.hotelId, staffMembership.membershipId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'staff_invitation_superseded_by_fkey',
        columns: [table.supersededByInvitationId],
        foreignColumns: [table.invitationId],
      }).onDelete('restrict'),
      uniqueIndex('staff_invitation_one_active_uq')
        .on(table.hotelId, table.membershipId)
        .where(sql`state = 'ACTIVE'::text`),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const invitationRequestedRole = platform
  .table(
    'invitation_requested_role',
    {
      hotelId: uuid('hotel_id').notNull(),
      invitationId: uuid('invitation_id').notNull(),
      role: text('role').notNull(),
    },
    (table) => [
      check(
        'invitation_requested_role_known',
        sql`(role = ANY (ARRAY['HOTEL_ADMIN'::text, 'MANAGER'::text, 'MANAGER_PLUS'::text, 'RECEPTION'::text, 'CLEANER'::text, 'RESTAURANT_MANAGER'::text]))`,
      ),
      primaryKey({
        name: 'invitation_requested_role_pk',
        columns: [table.hotelId, table.invitationId, table.role],
      }),
      foreignKey({
        name: 'invitation_requested_role_invitation_fkey',
        columns: [table.hotelId, table.invitationId],
        foreignColumns: [staffInvitation.hotelId, staffInvitation.invitationId],
      }).onDelete('restrict'),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const passwordResetIntake = platform.table(
  'password_reset_intake',
  {
    attempts: integer('attempts')
      .notNull()
      .default(sql`0`),
    claimToken: uuid('claim_token'),
    emailNormalized: text('email_normalized').notNull(),
    initiatedBy: text('initiated_by')
      .notNull()
      .default(sql`'self'::text`),
    initiatedByAccountId: uuid('initiated_by_account_id'),
    intakeId: uuid('intake_id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    lastError: text('last_error'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    outcome: text('outcome'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    requestedAt: timestamp('requested_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    state: text('state')
      .notNull()
      .default(sql`'PENDING'::text`),
  },
  (table) => [
    check('password_reset_intake_attempts_non_negative', sql`(attempts >= 0)`),
    check(
      'password_reset_intake_email_normalised',
      sql`(email_normalized = lower(email_normalized))`,
    ),
    check(
      'password_reset_intake_claim_is_leased',
      sql`((state = 'CLAIMED'::text) = (claim_token IS NOT NULL))`,
    ),
    check(
      'password_reset_intake_initiator_known',
      sql`(initiated_by = ANY (ARRAY['self'::text, 'hotel_admin'::text]))`,
    ),
    check(
      'password_reset_intake_initiator_recorded',
      sql`((initiated_by = 'self'::text) = (initiated_by_account_id IS NULL))`,
    ),
    check(
      'password_reset_intake_lease_paired',
      sql`((claim_token IS NULL) = (lease_expires_at IS NULL))`,
    ),
    check(
      'password_reset_intake_outcome_known',
      sql`((outcome IS NULL) OR (outcome = ANY (ARRAY['sent'::text, 'ignored'::text, 'throttled'::text, 'unavailable'::text, 'dead_letter'::text])))`,
    ),
    check(
      'password_reset_intake_processed_has_time',
      sql`((state = ANY (ARRAY['PROCESSED'::text, 'DEAD_LETTER'::text])) = (processed_at IS NOT NULL))`,
    ),
    check(
      'password_reset_intake_state_known',
      sql`(state = ANY (ARRAY['PENDING'::text, 'CLAIMED'::text, 'PROCESSED'::text, 'DEAD_LETTER'::text]))`,
    ),
    foreignKey({
      name: 'password_reset_intake_initiator_fkey',
      columns: [table.initiatedByAccountId],
      foreignColumns: [userAccount.accountId],
    }).onDelete('restrict'),
    index('password_reset_intake_queue_idx').on(table.state, table.nextAttemptAt),
    index('password_reset_intake_lease_idx')
      .on(table.leaseExpiresAt)
      .where(sql`state = 'CLAIMED'::text`),
  ],
);

export const passwordResetRequest = platform.table(
  'password_reset_request',
  {
    accountId: uuid('account_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    deliveryId: uuid('delivery_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    initiatedBy: text('initiated_by').notNull(),
    initiatedByAccountId: uuid('initiated_by_account_id'),
    intakeId: uuid('intake_id').notNull(),
    resetId: uuid('reset_id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    secretCiphertext: text('secret_ciphertext'),
    secretKeyVersion: text('secret_key_version'),
    secretWrappedDek: text('secret_wrapped_dek'),
    state: text('state')
      .notNull()
      .default(sql`'ACTIVE'::text`),
    terminalAt: timestamp('terminal_at', { withTimezone: true }),
    terminalReason: text('terminal_reason'),
    tokenHash: text('token_hash').notNull(),
    tokenKeyVersion: text('token_key_version').notNull(),
  },
  (table) => [
    check('password_reset_request_expiry_after_creation', sql`(expires_at > created_at)`),
    check(
      'password_reset_request_initiator_known',
      sql`(initiated_by = ANY (ARRAY['self'::text, 'hotel_admin'::text]))`,
    ),
    check(
      'password_reset_request_initiator_recorded',
      sql`((initiated_by = 'self'::text) = (initiated_by_account_id IS NULL))`,
    ),
    check(
      'password_reset_request_secret_complete',
      sql`(num_nonnulls(secret_ciphertext, secret_wrapped_dek, secret_key_version) = ANY (ARRAY[0, 3]))`,
    ),
    check(
      'password_reset_request_settled_holds_no_secret',
      sql`((secret_ciphertext IS NULL) OR ((state = 'ACTIVE'::text) AND (delivered_at IS NULL)))`,
    ),
    check(
      'password_reset_request_state_known',
      sql`(state = ANY (ARRAY['ACTIVE'::text, 'USED'::text, 'SUPERSEDED'::text, 'EXPIRED'::text, 'REVOKED'::text]))`,
    ),
    check(
      'password_reset_request_terminal_has_time',
      sql`((state = 'ACTIVE'::text) = (terminal_at IS NULL))`,
    ),
    check('password_reset_request_token_shape', sql`(token_hash ~ '^[0-9a-f]{64}$'::text)`),
    unique('password_reset_request_delivery_uq').on(table.deliveryId),
    unique('password_reset_request_token_uq').on(table.tokenHash),
    foreignKey({
      name: 'password_reset_request_account_id_fkey',
      columns: [table.accountId],
      foreignColumns: [userAccount.accountId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'password_reset_request_initiator_fkey',
      columns: [table.initiatedByAccountId],
      foreignColumns: [userAccount.accountId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'password_reset_request_intake_fkey',
      columns: [table.intakeId],
      foreignColumns: [passwordResetIntake.intakeId],
    }).onDelete('restrict'),
    uniqueIndex('password_reset_request_intake_active_uq')
      .on(table.intakeId)
      .where(sql`state = 'ACTIVE'::text`),
    uniqueIndex('password_reset_request_one_active_uq')
      .on(table.accountId)
      .where(sql`state = 'ACTIVE'::text`),
  ],
);

export const workHandoffDiscovery = platform
  .table(
    'work_handoff_discovery',
    {
      attempts: integer('attempts')
        .notNull()
        .default(sql`0`),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      discoveryId: uuid('discovery_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      expectedState: text('expected_state').notNull(),
      hotelId: uuid('hotel_id').notNull(),
      idempotencySeed: text('idempotency_seed').notNull(),
      lastError: text('last_error'),
      membershipId: uuid('membership_id').notNull(),
      membershipRevision: integer('membership_revision').notNull(),
      openedReason: text('opened_reason').notNull(),
      settledAt: timestamp('settled_at', { withTimezone: true }),
      settledReason: text('settled_reason'),
      state: text('state')
        .notNull()
        .default(sql`'PENDING'::text`),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
    },
    (table) => [
      check('work_handoff_discovery_attempts_non_negative', sql`(attempts >= 0)`),
      check(
        'work_handoff_discovery_expected_state_known',
        sql`(expected_state = ANY (ARRAY['SUSPENDED'::text, 'TERMINATED'::text]))`,
      ),
      check(
        'work_handoff_discovery_reason_known',
        sql`(opened_reason = ANY (ARRAY['suspension'::text, 'termination'::text]))`,
      ),
      check(
        'work_handoff_discovery_reason_matches_state',
        sql`(((opened_reason = 'suspension'::text) AND (expected_state = 'SUSPENDED'::text)) OR ((opened_reason = 'termination'::text) AND (expected_state = 'TERMINATED'::text)))`,
      ),
      check('work_handoff_discovery_revision_non_negative', sql`(membership_revision >= 0)`),
      check(
        'work_handoff_discovery_seed_shape',
        sql`((length(idempotency_seed) >= 8) AND (length(idempotency_seed) <= 200))`,
      ),
      check(
        'work_handoff_discovery_settled_has_time',
        sql`((state <> 'PENDING'::text) = (settled_at IS NOT NULL))`,
      ),
      check(
        'work_handoff_discovery_state_known',
        sql`(state = ANY (ARRAY['PENDING'::text, 'COMPLETED'::text, 'SUPERSEDED'::text]))`,
      ),
      unique('work_handoff_discovery_scope_uq').on(table.hotelId, table.discoveryId),
      foreignKey({
        name: 'work_handoff_discovery_membership_fkey',
        columns: [table.hotelId, table.membershipId],
        foreignColumns: [staffMembership.hotelId, staffMembership.membershipId],
      }).onDelete('restrict'),
      index('work_handoff_discovery_queue_idx').on(table.hotelId, table.state, table.createdAt),
      uniqueIndex('work_handoff_discovery_open_uq')
        .on(table.hotelId, table.membershipId)
        .where(sql`state = 'PENDING'::text`),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const accountPermissionGrant = platform.table(
  'account_permission_grant',
  {
    accountId: uuid('account_id').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    grantedByAccountId: uuid('granted_by_account_id').notNull(),
    permission: text('permission').notNull(),
    permissionGrantId: uuid('permission_grant_id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    realm: text('realm').notNull(),
    realmRole: text('realm_role').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByAccountId: uuid('revoked_by_account_id'),
    revokedReason: text('revoked_reason'),
  },
  (table) => [
    check(
      'account_permission_grant_grantable',
      sql`
CASE realm_role
    WHEN 'OPERATION_ADMIN'::text THEN (permission = ANY (ARRAY['DEPOSIT_REFUND_RECONCILE'::text, 'ONBOARDING_PROVISION_RETRY'::text, 'OPERATION_READ'::text, 'REVIEW_MODERATE'::text, 'SUBSCRIPTION_EBARIMT_RETRY'::text, 'SUBSCRIPTION_PASSWORD_RESET_INITIATE'::text, 'SUBSCRIPTION_PAYMENT_RECONCILE'::text, 'SUBSCRIPTION_REMINDER_SEND'::text]))
    WHEN 'PLATFORM_SUPER_ADMIN'::text THEN (permission = ANY (ARRAY['ACCOUNT_OWNERSHIP_RECOVERY_APPROVE'::text, 'DEPOSIT_REFUND_RECONCILE'::text, 'ONBOARDING_PROVISION_RETRY'::text, 'OPERATION_READ'::text, 'PLATFORM_OPERATION_ACCESS_MANAGE'::text, 'REVIEW_MODERATE'::text, 'SUBSCRIPTION_CONTACT_CHANGE_APPROVE'::text, 'SUBSCRIPTION_EBARIMT_RETRY'::text, 'SUBSCRIPTION_PASSWORD_RESET_INITIATE'::text, 'SUBSCRIPTION_PAYMENT_RECONCILE'::text, 'SUBSCRIPTION_REMINDER_SEND'::text, 'SUBSCRIPTION_SUSPEND'::text]))
    WHEN 'POLICE_OFFICER'::text THEN (permission = ANY (ARRAY['FALSE_MATCH_APPROVE'::text, 'FOUND_CORRECTION_APPROVE'::text, 'WANTED_CASE_STATE_MANAGE'::text, 'WANTED_IDENTITY_APPROVE'::text]))
    WHEN 'POLICE_ADMIN'::text THEN (permission = ANY (ARRAY['FALSE_MATCH_APPROVE'::text, 'FOUND_CORRECTION_APPROVE'::text, 'WANTED_CASE_CREATE'::text, 'WANTED_CASE_EXPORT'::text, 'WANTED_CASE_STATE_MANAGE'::text, 'WANTED_IDENTITY_APPROVE'::text]))
    ELSE false
END`,
    ),
    check(
      'account_permission_grant_revocation_complete',
      sql`((revoked_at IS NULL) = (revoked_by_account_id IS NULL))`,
    ),
    foreignKey({
      name: 'account_permission_grant_principal_fkey',
      columns: [table.accountId, table.realm, table.realmRole],
      foreignColumns: [userAccount.accountId, userAccount.realm, userAccount.realmRole],
    }).onDelete('restrict'),
    foreignKey({
      name: 'account_permission_grant_granted_by_fkey',
      columns: [table.grantedByAccountId],
      foreignColumns: [userAccount.accountId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'account_permission_grant_revoked_by_fkey',
      columns: [table.revokedByAccountId],
      foreignColumns: [userAccount.accountId],
    }).onDelete('restrict'),
    uniqueIndex('account_permission_grant_active_uq')
      .on(table.accountId, table.permission)
      .where(sql`revoked_at IS NULL`),
  ],
);

export const workHandoffItem = platform
  .table(
    'work_handoff_item',
    {
      assigneeMembershipId: uuid('assignee_membership_id'),
      assignmentVersion: integer('assignment_version')
        .notNull()
        .default(sql`0`),
      claimantMembershipId: uuid('claimant_membership_id'),
      continuationOfItemId: uuid('continuation_of_item_id'),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      hotelId: uuid('hotel_id').notNull(),
      itemId: uuid('item_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      movementStarted: boolean('movement_started')
        .notNull()
        .default(sql`false`),
      openedReason: text('opened_reason').notNull(),
      previousActorMembershipId: uuid('previous_actor_membership_id').notNull(),
      resolvedAt: timestamp('resolved_at', { withTimezone: true }),
      restaurantId: uuid('restaurant_id'),
      state: text('state').notNull(),
      subjectKind: text('subject_kind').notNull(),
      subjectRef: uuid('subject_ref').notNull(),
    },
    (table) => [
      check(
        'work_handoff_item_assigned_has_both',
        sql`((state <> 'ASSIGNED'::text) OR ((claimant_membership_id IS NOT NULL) AND (assignee_membership_id IS NOT NULL)))`,
      ),
      check(
        'work_handoff_item_claimed_has_claimant',
        sql`((state <> 'CLAIMED'::text) OR (claimant_membership_id IS NOT NULL))`,
      ),
      check(
        'work_handoff_item_continuation_is_cleaner',
        sql`((continuation_of_item_id IS NULL) OR (subject_kind = 'cleaner_task'::text))`,
      ),
      check(
        'work_handoff_item_open_has_no_actor',
        sql`((state <> ALL (ARRAY['TAKEOVER_REQUIRED'::text, 'REASSIGNMENT_REQUIRED'::text, 'UNASSIGNED_REQUIRES_ACTION'::text])) OR ((claimant_membership_id IS NULL) AND (assignee_membership_id IS NULL)))`,
      ),
      check(
        'work_handoff_item_reason_known',
        sql`(opened_reason = ANY (ARRAY['suspension'::text, 'termination'::text]))`,
      ),
      check(
        'work_handoff_item_resolved_has_time',
        sql`((state = 'RESOLVED'::text) = (resolved_at IS NOT NULL))`,
      ),
      check(
        'work_handoff_item_restaurant_scope',
        sql`((subject_kind = 'restaurant_order'::text) = (restaurant_id IS NOT NULL))`,
      ),
      check(
        'work_handoff_item_state_known',
        sql`(state = ANY (ARRAY['TAKEOVER_REQUIRED'::text, 'REASSIGNMENT_REQUIRED'::text, 'CLAIMED'::text, 'ASSIGNED'::text, 'RESOLVED'::text, 'UNASSIGNED_REQUIRES_ACTION'::text]))`,
      ),
      check(
        'work_handoff_item_subject_known',
        sql`(subject_kind = ANY (ARRAY['reception_shift'::text, 'cleaner_task'::text, 'restaurant_order'::text]))`,
      ),
      check('work_handoff_item_version_non_negative', sql`(assignment_version >= 0)`),
      unique('work_handoff_item_scope_uq').on(table.hotelId, table.itemId),
      foreignKey({
        name: 'work_handoff_item_assignee_fkey',
        columns: [table.hotelId, table.assigneeMembershipId],
        foreignColumns: [staffMembership.hotelId, staffMembership.membershipId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'work_handoff_item_claimant_fkey',
        columns: [table.hotelId, table.claimantMembershipId],
        foreignColumns: [staffMembership.hotelId, staffMembership.membershipId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'work_handoff_item_continuation_fkey',
        columns: [table.continuationOfItemId],
        foreignColumns: [table.itemId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'work_handoff_item_previous_actor_fkey',
        columns: [table.hotelId, table.previousActorMembershipId],
        foreignColumns: [staffMembership.hotelId, staffMembership.membershipId],
      }).onDelete('restrict'),
      uniqueIndex('work_handoff_item_open_subject_uq')
        .on(table.hotelId, table.subjectKind, table.subjectRef)
        .where(sql`state <> 'RESOLVED'::text`),
      index('work_handoff_item_queue_idx').on(table.hotelId, table.state, table.createdAt),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const workHandoffEvent = platform
  .table(
    'work_handoff_event',
    {
      actorMembershipId: uuid('actor_membership_id'),
      eventId: uuid('event_id')
        .notNull()
        .default(sql`gen_random_uuid()`),
      hotelId: uuid('hotel_id').notNull(),
      idempotencyKey: text('idempotency_key').notNull(),
      itemId: uuid('item_id').notNull(),
      kind: text('kind').notNull(),
      newAssigneeMembershipId: uuid('new_assignee_membership_id'),
      occurredAt: timestamp('occurred_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      previousAssigneeMembershipId: uuid('previous_assignee_membership_id'),
      reason: text('reason'),
      seq: integer('seq').notNull(),
    },
    (table) => [
      check(
        'work_handoff_event_idempotency_shape',
        sql`((length(idempotency_key) >= 8) AND (length(idempotency_key) <= 200))`,
      ),
      check(
        'work_handoff_event_kind_known',
        sql`(kind = ANY (ARRAY['opened'::text, 'claimed'::text, 'released'::text, 'assigned'::text, 'resolved'::text, 'unassigned'::text, 'continuation_created'::text]))`,
      ),
      check('work_handoff_event_seq_positive', sql`(seq >= 1)`),
      unique('work_handoff_event_idempotency_uq').on(
        table.hotelId,
        table.itemId,
        table.idempotencyKey,
      ),
      primaryKey({
        name: 'work_handoff_event_pk',
        columns: [table.hotelId, table.itemId, table.seq],
      }),
      foreignKey({
        name: 'work_handoff_event_actor_fkey',
        columns: [table.hotelId, table.actorMembershipId],
        foreignColumns: [staffMembership.hotelId, staffMembership.membershipId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'work_handoff_event_item_fkey',
        columns: [table.hotelId, table.itemId],
        foreignColumns: [workHandoffItem.hotelId, workHandoffItem.itemId],
      }).onDelete('restrict'),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

// ------------------------------------------------------------------- Phase 05

export const subscriptionOwner = platform
  .table(
    'subscription_owner',
    {
      countryCode: text('country_code')
        .notNull()
        .default(sql`'MN'::text`),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      displayName: text('display_name').notNull(),
      identifierCiphertext: bytea('identifier_ciphertext').notNull(),
      identifierKeyVersion: text('identifier_key_version').notNull(),
      identifierLookupKeyVersion: text('identifier_lookup_key_version').notNull(),
      identifierLookupToken: text('identifier_lookup_token').notNull(),
      identifierWrappedDek: bytea('identifier_wrapped_dek').notNull(),
      identityType: text('identity_type').notNull(),
      ownerId: uuid('owner_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      ownerType: text('owner_type').notNull(),
      representativeName: text('representative_name'),
      representativePosition: text('representative_position'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      verifiedEmailNormalized: text('verified_email_normalized'),
      verifiedPhone: text('verified_phone'),
    },
    (table) => [
      check('subscription_owner_country_shape', sql`(country_code ~ '^[A-Z]{2}$'::text)`),
      check(
        'subscription_owner_display_name_bounded',
        sql`((length(display_name) >= 1) AND (length(display_name) <= 200))`,
      ),
      check(
        'subscription_owner_email_normalised',
        sql`((verified_email_normalized IS NULL) OR (verified_email_normalized = lower(verified_email_normalized)))`,
      ),
      check(
        'subscription_owner_identity_type_known',
        sql`(identity_type = ANY (ARRAY['registration_number'::text]))`,
      ),
      check(
        'subscription_owner_lookup_shape',
        sql`(identifier_lookup_token ~ '^[0-9a-f]{64}$'::text)`,
      ),
      check(
        'subscription_owner_representative_matches_type',
        sql`
CASE owner_type
    WHEN 'ORGANIZATION'::text THEN ((representative_name IS NOT NULL) AND (representative_position IS NOT NULL))
    ELSE ((representative_name IS NULL) AND (representative_position IS NULL))
END`,
      ),
      check('subscription_owner_revision_non_negative', sql`(revision >= 0)`),
      check(
        'subscription_owner_type_known',
        sql`(owner_type = ANY (ARRAY['CITIZEN'::text, 'ORGANIZATION'::text]))`,
      ),
      unique('subscription_owner_identifier_uq').on(
        table.identityType,
        table.countryCode,
        table.identifierLookupToken,
      ),
      pgPolicy('applicant_read', {
        for: 'select',
        using: sql`(EXISTS ( SELECT 1
   FROM platform.onboarding_application a
  WHERE ((a.application_id = platform.current_onboarding_ref()) AND (a.owner_id = subscription_owner.owner_id))))`,
      }),
      pgPolicy('operation_review', {
        using: sql`(platform.current_realm() = 'operation'::text)`,
        withCheck: sql`(platform.current_realm() = 'operation'::text)`,
      }),
      pgPolicy('provisioner_create', {
        for: 'insert',
        to: ['prsystem_maintenance_fn'],
        withCheck: sql`(EXISTS ( SELECT 1
   FROM platform.onboarding_application a
  WHERE ((a.application_id = platform.current_onboarding_ref()) AND (a.owner_identity_type = subscription_owner.identity_type) AND (a.owner_country_code = subscription_owner.country_code) AND (a.owner_identifier_lookup_token = subscription_owner.identifier_lookup_token))))`,
      }),
      pgPolicy('resolver_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`true`,
      }),
    ],
  )
  .enableRLS();

export const onboardingApplication = platform
  .table(
    'onboarding_application',
    {
      addressLine: text('address_line').notNull(),
      adminEmailNormalized: text('admin_email_normalized').notNull(),
      applicantTokenHash: text('applicant_token_hash').notNull(),
      applicantTokenKeyVersion: text('applicant_token_key_version').notNull(),
      applicationId: uuid('application_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      contactPhone: text('contact_phone').notNull(),
      contactPhoneVerifiedAt: timestamp('contact_phone_verified_at', { withTimezone: true }),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      currency: text('currency')
        .notNull()
        .default(sql`'MNT'::text`),
      discountMnt: bigint('discount_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      district: text('district').notNull(),
      duplicateReviewRequired: boolean('duplicate_review_required')
        .notNull()
        .default(sql`false`),
      existingAccountId: uuid('existing_account_id'),
      existingAccountProofMethod: text('existing_account_proof_method'),
      existingAccountProvedAt: timestamp('existing_account_proved_at', { withTimezone: true }),
      hotelDisplayName: text('hotel_display_name').notNull(),
      hotelPublicPhone: text('hotel_public_phone').notNull(),
      khoroo: text('khoroo').notNull(),
      latitudeMicro: integer('latitude_micro').notNull(),
      longitudeMicro: integer('longitude_micro').notNull(),
      monthlyPriceMnt: bigint('monthly_price_mnt', { mode: 'bigint' }).notNull(),
      ownerCountryCode: text('owner_country_code')
        .notNull()
        .default(sql`'MN'::text`),
      ownerDisplayName: text('owner_display_name').notNull(),
      ownerId: uuid('owner_id'),
      ownerIdentifierCiphertext: bytea('owner_identifier_ciphertext').notNull(),
      ownerIdentifierKeyVersion: text('owner_identifier_key_version').notNull(),
      ownerIdentifierLookupKeyVersion: text('owner_identifier_lookup_key_version').notNull(),
      ownerIdentifierLookupToken: text('owner_identifier_lookup_token').notNull(),
      ownerIdentifierWrappedDek: bytea('owner_identifier_wrapped_dek').notNull(),
      ownerIdentityType: text('owner_identity_type')
        .notNull()
        .default(sql`'registration_number'::text`),
      ownerType: text('owner_type').notNull(),
      packageCode: text('package_code').notNull(),
      packageFeatureVersion: text('package_feature_version').notNull(),
      paidAttemptId: uuid('paid_attempt_id'),
      paymentConfirmedAt: timestamp('payment_confirmed_at', { withTimezone: true }),
      priceBookVersion: text('price_book_version').notNull(),
      provisionAttempts: integer('provision_attempts')
        .notNull()
        .default(sql`0`),
      provisionAvailableAt: timestamp('provision_available_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      provisionClaimToken: uuid('provision_claim_token'),
      provisionClaimedUntil: timestamp('provision_claimed_until', { withTimezone: true }),
      provisionLastError: text('provision_last_error'),
      provisionedHotelId: uuid('provisioned_hotel_id'),
      representativeName: text('representative_name'),
      representativePosition: text('representative_position'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'DRAFT'::text`),
      stateChangedAt: timestamp('state_changed_at', { withTimezone: true }),
      stateReason: text('state_reason'),
      subscriptionContactPhone: text('subscription_contact_phone').notNull(),
      taxConfigVersion: text('tax_config_version').notNull(),
      termMonths: integer('term_months').notNull(),
      totalAmountMnt: bigint('total_amount_mnt', { mode: 'bigint' }).notNull(),
      vatInclusive: boolean('vat_inclusive')
        .notNull()
        .default(sql`true`),
      vatRateBp: integer('vat_rate_bp').notNull(),
    },
    (table) => [
      check(
        'onboarding_application_address_bounded',
        sql`((length(address_line) >= 1) AND (length(address_line) <= 300))`,
      ),
      check('onboarding_application_country_shape', sql`(owner_country_code ~ '^[A-Z]{2}$'::text)`),
      check('onboarding_application_currency_known', sql`(currency = 'MNT'::text)`),
      check('onboarding_application_discount_zero', sql`(discount_mnt = 0)`),
      check(
        'onboarding_application_email_normalised',
        sql`(admin_email_normalized = lower(admin_email_normalized))`,
      ),
      check(
        'onboarding_application_email_shape',
        sql`(admin_email_normalized ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'::text)`,
      ),
      check(
        'onboarding_application_identity_type_known',
        sql`(owner_identity_type = ANY (ARRAY['registration_number'::text]))`,
      ),
      check(
        'onboarding_application_latitude_range',
        sql`((latitude_micro >= '-90000000'::integer) AND (latitude_micro <= 90000000))`,
      ),
      check(
        'onboarding_application_longitude_range',
        sql`((longitude_micro >= '-180000000'::integer) AND (longitude_micro <= 180000000))`,
      ),
      check(
        'onboarding_application_lookup_shape',
        sql`(owner_identifier_lookup_token ~ '^[0-9a-f]{64}$'::text)`,
      ),
      check(
        'onboarding_application_monthly_price_matches_package',
        sql`(monthly_price_mnt =
CASE package_code
    WHEN 'P20'::text THEN 20000
    WHEN 'P25'::text THEN 25000
    WHEN 'P30'::text THEN 30000
    ELSE NULL::integer
END)`,
      ),
      check(
        'onboarding_application_package_known',
        sql`(package_code = ANY (ARRAY['P20'::text, 'P25'::text, 'P30'::text]))`,
      ),
      check(
        'onboarding_application_paid_states_have_payment',
        sql`((state = ANY (ARRAY['PAID_OWNER_VERIFICATION_REQUIRED'::text, 'PAID_PENDING_PROVISIONING'::text, 'PROVISIONING'::text, 'PROVISIONING_FAILED'::text, 'PROVISIONED'::text])) = (paid_attempt_id IS NOT NULL))`,
      ),
      check(
        'onboarding_application_payment_time_matches_attempt',
        sql`((paid_attempt_id IS NULL) = (payment_confirmed_at IS NULL))`,
      ),
      check(
        'onboarding_application_account_proof_complete',
        sql`(num_nonnulls(existing_account_id, existing_account_proof_method, existing_account_proved_at) = ANY (ARRAY[0, 3]))`,
      ),
      check(
        'onboarding_application_account_proof_method_known',
        sql`((existing_account_proof_method IS NULL) OR (existing_account_proof_method = ANY (ARRAY['SIGNED_IN'::text, 'PASSWORD_RECOVERY'::text])))`,
      ),
      check(
        'onboarding_application_claim_complete',
        sql`(num_nonnulls(provision_claim_token, provision_claimed_until) = ANY (ARRAY[0, 2]))`,
      ),
      check(
        'onboarding_application_provision_attempts_non_negative',
        sql`(provision_attempts >= 0)`,
      ),
      check(
        'onboarding_application_provisioned_has_hotel',
        sql`((state = 'PROVISIONED'::text) = (provisioned_hotel_id IS NOT NULL))`,
      ),
      check(
        'onboarding_application_representative_matches_type',
        sql`
CASE owner_type
    WHEN 'ORGANIZATION'::text THEN ((representative_name IS NOT NULL) AND (representative_position IS NOT NULL))
    ELSE ((representative_name IS NULL) AND (representative_position IS NULL))
END`,
      ),
      check('onboarding_application_revision_non_negative', sql`(revision >= 0)`),
      check(
        'onboarding_application_state_known',
        sql`(state = ANY (ARRAY['DRAFT'::text, 'OWNER_VERIFICATION_REQUIRED'::text, 'PENDING_PAYMENT'::text, 'PAYMENT_UNCERTAIN'::text, 'PAYMENT_FAILED'::text, 'PAYMENT_EXPIRED'::text, 'PAID_OWNER_VERIFICATION_REQUIRED'::text, 'PAID_PENDING_PROVISIONING'::text, 'PROVISIONING'::text, 'PROVISIONING_FAILED'::text, 'PROVISIONED'::text]))`,
      ),
      check('onboarding_application_term_known', sql`(term_months = ANY (ARRAY[1, 3, 7, 12]))`),
      check(
        'onboarding_application_token_shape',
        sql`(applicant_token_hash ~ '^[0-9a-f]{64}$'::text)`,
      ),
      check(
        'onboarding_application_total_is_product',
        sql`(total_amount_mnt = ((monthly_price_mnt * term_months) - discount_mnt))`,
      ),
      check(
        'onboarding_application_type_known',
        sql`(owner_type = ANY (ARRAY['CITIZEN'::text, 'ORGANIZATION'::text]))`,
      ),
      check(
        'onboarding_application_vat_rate_range',
        sql`((vat_rate_bp >= 0) AND (vat_rate_bp <= 10000))`,
      ),
      unique('onboarding_application_token_uq').on(table.applicantTokenHash),
      foreignKey({
        name: 'onboarding_application_existing_account_fkey',
        columns: [table.existingAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'onboarding_application_hotel_fkey',
        columns: [table.provisionedHotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'onboarding_application_owner_fkey',
        columns: [table.ownerId],
        foreignColumns: [subscriptionOwner.ownerId],
      }).onDelete('restrict'),
      uniqueIndex('onboarding_application_hotel_uq')
        .on(table.provisionedHotelId)
        .where(sql`provisioned_hotel_id IS NOT NULL`),
      index('onboarding_application_owner_lookup_idx').on(table.ownerIdentifierLookupToken),
      index('onboarding_application_state_idx').on(table.state, table.createdAt),
      pgPolicy('applicant_scope', {
        using: sql`(application_id = platform.current_onboarding_ref())`,
        withCheck: sql`(application_id = platform.current_onboarding_ref())`,
      }),
      pgPolicy('operation_review', {
        using: sql`(platform.current_realm() = 'operation'::text)`,
        withCheck: sql`(platform.current_realm() = 'operation'::text)`,
      }),
      pgPolicy('resolver_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`true`,
      }),
    ],
  )
  .enableRLS();

export const onboardingPhoneVerification = platform
  .table(
    'onboarding_phone_verification',
    {
      applicationId: uuid('application_id').notNull(),
      attempts: integer('attempts')
        .notNull()
        .default(sql`0`),
      codeDigest: text('code_digest'),
      codeKeyVersion: text('code_key_version'),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      maxAttempts: integer('max_attempts').notNull(),
      phone: text('phone').notNull(),
      purpose: text('purpose')
        .notNull()
        .default(sql`'owner_phone'::text`),
      settledAt: timestamp('settled_at', { withTimezone: true }),
      state: text('state')
        .notNull()
        .default(sql`'PENDING'::text`),
      verificationId: uuid('verification_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
    },
    (table) => [
      check(
        'onboarding_phone_verification_attempts_bounded',
        sql`((attempts >= 0) AND (attempts <= max_attempts))`,
      ),
      check(
        'onboarding_phone_verification_code_complete',
        sql`(num_nonnulls(code_digest, code_key_version) = ANY (ARRAY[0, 2]))`,
      ),
      check(
        'onboarding_phone_verification_digest_shape',
        sql`((code_digest IS NULL) OR (code_digest ~ '^[0-9a-f]{64}$'::text))`,
      ),
      check('onboarding_phone_verification_expiry_after_creation', sql`(expires_at > created_at)`),
      check('onboarding_phone_verification_max_attempts_positive', sql`(max_attempts >= 1)`),
      check(
        'onboarding_phone_verification_purpose_known',
        sql`(purpose = ANY (ARRAY['owner_phone'::text]))`,
      ),
      check(
        'onboarding_phone_verification_settled_has_time',
        sql`((state = 'PENDING'::text) = (settled_at IS NULL))`,
      ),
      check(
        'onboarding_phone_verification_settled_holds_no_code',
        sql`((code_digest IS NULL) OR (state = 'PENDING'::text))`,
      ),
      check(
        'onboarding_phone_verification_state_known',
        sql`(state = ANY (ARRAY['PENDING'::text, 'VERIFIED'::text, 'EXPIRED'::text, 'FAILED'::text]))`,
      ),
      foreignKey({
        name: 'onboarding_phone_verification_application_fkey',
        columns: [table.applicationId],
        foreignColumns: [onboardingApplication.applicationId],
      }).onDelete('restrict'),
      uniqueIndex('onboarding_phone_verification_pending_uq')
        .on(table.applicationId, table.purpose)
        .where(sql`state = 'PENDING'::text`),
      pgPolicy('applicant_scope', {
        using: sql`(application_id = platform.current_onboarding_ref())`,
        withCheck: sql`(application_id = platform.current_onboarding_ref())`,
      }),
      pgPolicy('operation_review', {
        using: sql`(platform.current_realm() = 'operation'::text)`,
        withCheck: sql`(platform.current_realm() = 'operation'::text)`,
      }),
    ],
  )
  .enableRLS();

export const onboardingOwnerProof = platform
  .table(
    'onboarding_owner_proof',
    {
      applicationId: uuid('application_id').notNull(),
      attempts: integer('attempts')
        .notNull()
        .default(sql`0`),
      challengeDigest: text('challenge_digest'),
      challengeKeyVersion: text('challenge_key_version'),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      decidedAt: timestamp('decided_at', { withTimezone: true }),
      decidedByAccountId: uuid('decided_by_account_id'),
      decisionReason: text('decision_reason'),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      maskedDestination: text('masked_destination'),
      method: text('method').notNull(),
      ownerId: uuid('owner_id').notNull(),
      proofId: uuid('proof_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      state: text('state')
        .notNull()
        .default(sql`'PENDING'::text`),
    },
    (table) => [
      check('onboarding_owner_proof_attempts_non_negative', sql`(attempts >= 0)`),
      check(
        'onboarding_owner_proof_challenge_complete',
        sql`(num_nonnulls(challenge_digest, challenge_key_version) = ANY (ARRAY[0, 2]))`,
      ),
      check(
        'onboarding_owner_proof_decided_has_time',
        sql`((state = 'PENDING'::text) = (decided_at IS NULL))`,
      ),
      check(
        'onboarding_owner_proof_digest_shape',
        sql`((challenge_digest IS NULL) OR (challenge_digest ~ '^[0-9a-f]{64}$'::text))`,
      ),
      check('onboarding_owner_proof_expiry_after_creation', sql`(expires_at > created_at)`),
      check(
        'onboarding_owner_proof_method_known',
        sql`(method = ANY (ARRAY['AUTHENTICATED_ACCOUNT'::text, 'STORED_CONTACT_CHALLENGE'::text, 'OFFLINE_VERIFICATION'::text]))`,
      ),
      check(
        'onboarding_owner_proof_offline_has_decider',
        sql`((method <> 'OFFLINE_VERIFICATION'::text) OR (state = 'PENDING'::text) OR (decided_by_account_id IS NOT NULL))`,
      ),
      check(
        'onboarding_owner_proof_settled_holds_no_challenge',
        sql`((challenge_digest IS NULL) OR (state = 'PENDING'::text))`,
      ),
      check(
        'onboarding_owner_proof_state_known',
        sql`(state = ANY (ARRAY['PENDING'::text, 'PASSED'::text, 'FAILED'::text, 'EXPIRED'::text]))`,
      ),
      foreignKey({
        name: 'onboarding_owner_proof_application_fkey',
        columns: [table.applicationId],
        foreignColumns: [onboardingApplication.applicationId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'onboarding_owner_proof_decided_by_fkey',
        columns: [table.decidedByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'onboarding_owner_proof_owner_fkey',
        columns: [table.ownerId],
        foreignColumns: [subscriptionOwner.ownerId],
      }).onDelete('restrict'),
      uniqueIndex('onboarding_owner_proof_passed_uq')
        .on(table.applicationId)
        .where(sql`state = 'PASSED'::text`),
      uniqueIndex('onboarding_owner_proof_pending_uq')
        .on(table.applicationId)
        .where(sql`state = 'PENDING'::text`),
      pgPolicy('applicant_scope', {
        using: sql`(application_id = platform.current_onboarding_ref())`,
        withCheck: sql`(application_id = platform.current_onboarding_ref())`,
      }),
      pgPolicy('operation_review', {
        using: sql`(platform.current_realm() = 'operation'::text)`,
        withCheck: sql`(platform.current_realm() = 'operation'::text)`,
      }),
      pgPolicy('resolver_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`true`,
      }),
    ],
  )
  .enableRLS();

export const onboardingPaymentAttempt = platform
  .table(
    'onboarding_payment_attempt',
    {
      amountMnt: bigint('amount_mnt', { mode: 'bigint' }).notNull(),
      applicationId: uuid('application_id').notNull(),
      attemptId: uuid('attempt_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      currency: text('currency')
        .notNull()
        .default(sql`'MNT'::text`),
      discountMnt: bigint('discount_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      merchantRef: text('merchant_ref').notNull(),
      monthlyPriceMnt: bigint('monthly_price_mnt', { mode: 'bigint' }).notNull(),
      packageCode: text('package_code').notNull(),
      packageFeatureVersion: text('package_feature_version').notNull(),
      priceBookVersion: text('price_book_version').notNull(),
      provider: text('provider').notNull(),
      providerInvoiceId: text('provider_invoice_id'),
      providerFeeMnt: bigint('provider_fee_mnt', { mode: 'bigint' }),
      providerPaymentId: text('provider_payment_id'),
      reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
      reconciledByAccountId: uuid('reconciled_by_account_id'),
      reconciliationOutcome: text('reconciliation_outcome'),
      reconciliationReason: text('reconciliation_reason'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'PENDING'::text`),
      taxConfigVersion: text('tax_config_version').notNull(),
      termMonths: integer('term_months').notNull(),
      terminalAt: timestamp('terminal_at', { withTimezone: true }),
      terminalReason: text('terminal_reason'),
      vatRateBp: integer('vat_rate_bp').notNull(),
    },
    (table) => [
      check(
        'onboarding_payment_attempt_amount_is_product',
        sql`(amount_mnt = ((monthly_price_mnt * term_months) - discount_mnt))`,
      ),
      check('onboarding_payment_attempt_amount_positive', sql`(amount_mnt > 0)`),
      check(
        'onboarding_payment_attempt_confirmed_has_provider_payment',
        sql`((confirmed_at IS NULL) = (provider_payment_id IS NULL))`,
      ),
      check('onboarding_payment_attempt_currency_known', sql`(currency = 'MNT'::text)`),
      check('onboarding_payment_attempt_discount_zero', sql`(discount_mnt = 0)`),
      check('onboarding_payment_attempt_expiry_after_creation', sql`(expires_at > created_at)`),
      check(
        'onboarding_payment_attempt_package_known',
        sql`(package_code = ANY (ARRAY['P20'::text, 'P25'::text, 'P30'::text]))`,
      ),
      check(
        'onboarding_payment_attempt_paid_has_confirmation',
        sql`((state = ANY (ARRAY['PAID'::text, 'PAID_REQUIRES_RECONCILIATION'::text])) <= (confirmed_at IS NOT NULL))`,
      ),
      check(
        'onboarding_payment_attempt_provider_known',
        sql`(provider = ANY (ARRAY['QPAY'::text, 'KHAAN'::text]))`,
      ),
      check(
        'onboarding_payment_attempt_reconciled_complete',
        sql`(num_nonnulls(reconciliation_outcome, reconciled_by_account_id, reconciled_at) = ANY (ARRAY[0, 3]))`,
      ),
      check(
        'onboarding_payment_attempt_reconciliation_outcome_known',
        sql`((reconciliation_outcome IS NULL) OR (reconciliation_outcome = ANY (ARRAY['PROVIDER_CORRECTED_NOT_PAID'::text, 'EXTERNALLY_VOIDED'::text, 'FINANCE_CLOSED_EXCEPTION'::text])))`,
      ),
      check('onboarding_payment_attempt_revision_non_negative', sql`(revision >= 0)`),
      check(
        'onboarding_payment_attempt_state_known',
        sql`(state = ANY (ARRAY['PREPARING'::text, 'PENDING'::text, 'PAYMENT_UNCERTAIN'::text, 'PAID'::text, 'FAILED'::text, 'EXPIRED'::text, 'CANCELLED'::text, 'ABANDONED'::text, 'REFUSED'::text, 'PAID_REQUIRES_RECONCILIATION'::text]))`,
      ),
      check(
        'onboarding_payment_attempt_invoice_once_live',
        sql`((state = 'PREPARING'::text) OR ((state = 'REFUSED'::text) AND (provider_invoice_id IS NULL)) OR ((state <> 'REFUSED'::text) AND (provider_invoice_id IS NOT NULL)))`,
      ),
      check('onboarding_payment_attempt_term_known', sql`(term_months = ANY (ARRAY[1, 3, 7, 12]))`),
      check(
        'onboarding_payment_attempt_terminal_has_time',
        sql`((state = ANY (ARRAY['PREPARING'::text, 'PENDING'::text, 'PAYMENT_UNCERTAIN'::text])) = (terminal_at IS NULL))`,
      ),
      check('onboarding_payment_attempt_fee_non_negative', sql`(provider_fee_mnt >= 0)`),
      check('onboarding_payment_attempt_fee_within_amount', sql`(provider_fee_mnt <= amount_mnt)`),
      check(
        'onboarding_payment_attempt_vat_rate_range',
        sql`((vat_rate_bp >= 0) AND (vat_rate_bp <= 10000))`,
      ),
      unique('onboarding_payment_attempt_invoice_uq').on(table.provider, table.providerInvoiceId),
      foreignKey({
        name: 'onboarding_payment_attempt_application_fkey',
        columns: [table.applicationId],
        foreignColumns: [onboardingApplication.applicationId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'onboarding_payment_attempt_reconciled_by_fkey',
        columns: [table.reconciledByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      uniqueIndex('onboarding_payment_attempt_active_uq')
        .on(table.applicationId)
        .where(sql`state = ANY (ARRAY['PENDING'::text, 'PAYMENT_UNCERTAIN'::text])`),
      uniqueIndex('onboarding_payment_attempt_merchant_ref_uq').on(table.merchantRef),
      index('onboarding_payment_attempt_application_idx').on(table.applicationId, table.createdAt),
      uniqueIndex('onboarding_payment_attempt_provider_payment_uq')
        .on(table.provider, table.providerPaymentId)
        .where(sql`provider_payment_id IS NOT NULL`),
      index('onboarding_payment_attempt_reconciliation_idx')
        .on(table.state, table.confirmedAt)
        .where(sql`state = 'PAID_REQUIRES_RECONCILIATION'::text`),
      pgPolicy('applicant_scope', {
        using: sql`(application_id = platform.current_onboarding_ref())`,
        withCheck: sql`(application_id = platform.current_onboarding_ref())`,
      }),
      pgPolicy('operation_review', {
        using: sql`(platform.current_realm() = 'operation'::text)`,
        withCheck: sql`(platform.current_realm() = 'operation'::text)`,
      }),
      pgPolicy('resolver_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`true`,
      }),
    ],
  )
  .enableRLS();

export const onboardingEvent = platform
  .table(
    'onboarding_event',
    {
      actorRef: text('actor_ref').notNull(),
      applicationId: uuid('application_id').notNull(),
      correlationId: text('correlation_id'),
      detail: jsonb('detail')
        .notNull()
        .default(sql`'{}'::jsonb`),
      eventId: bigint('event_id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
      fromState: text('from_state'),
      occurredAt: timestamp('occurred_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      reason: text('reason'),
      toState: text('to_state').notNull(),
    },
    (table) => [
      check('onboarding_event_detail_sanitised', sql`(NOT platform.contains_denied_key(detail))`),
      foreignKey({
        name: 'onboarding_event_application_fkey',
        columns: [table.applicationId],
        foreignColumns: [onboardingApplication.applicationId],
      }).onDelete('restrict'),
      index('onboarding_event_application_idx').on(table.applicationId, table.eventId),
      pgPolicy('applicant_scope', {
        using: sql`(application_id = platform.current_onboarding_ref())`,
        withCheck: sql`(application_id = platform.current_onboarding_ref())`,
      }),
      pgPolicy('operation_review', {
        using: sql`(platform.current_realm() = 'operation'::text)`,
        withCheck: sql`(platform.current_realm() = 'operation'::text)`,
      }),
    ],
  )
  .enableRLS();

export const hotelProfile = platform
  .table(
    'hotel_profile',
    {
      addressLine: text('address_line').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      district: text('district').notNull(),
      duplicateReviewRequired: boolean('duplicate_review_required')
        .notNull()
        .default(sql`false`),
      hotelId: uuid('hotel_id').primaryKey(),
      khoroo: text('khoroo').notNull(),
      latitudeMicro: integer('latitude_micro').notNull(),
      listingState: text('listing_state')
        .notNull()
        .default(sql`'UNLISTED'::text`),
      longitudeMicro: integer('longitude_micro').notNull(),
      publicName: text('public_name').notNull(),
      publicPhone: text('public_phone').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
    },
    (table) => [
      check(
        'hotel_profile_address_bounded',
        sql`((length(address_line) >= 1) AND (length(address_line) <= 300))`,
      ),
      check(
        'hotel_profile_latitude_range',
        sql`((latitude_micro >= '-90000000'::integer) AND (latitude_micro <= 90000000))`,
      ),
      check(
        'hotel_profile_listing_state_known',
        sql`(listing_state = ANY (ARRAY['UNLISTED'::text, 'PUBLISHED'::text]))`,
      ),
      check(
        'hotel_profile_longitude_range',
        sql`((longitude_micro >= '-180000000'::integer) AND (longitude_micro <= 180000000))`,
      ),
      check(
        'hotel_profile_review_blocks_listing',
        sql`((NOT duplicate_review_required) OR (listing_state = 'UNLISTED'::text))`,
      ),
      check('hotel_profile_revision_non_negative', sql`(revision >= 0)`),
      foreignKey({
        name: 'hotel_profile_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const hotelOwnerLink = platform
  .table(
    'hotel_owner_link',
    {
      applicationId: uuid('application_id').notNull(),
      hotelId: uuid('hotel_id').primaryKey(),
      linkedAt: timestamp('linked_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      ownerId: uuid('owner_id').notNull(),
      ownerType: text('owner_type').notNull(),
    },
    (table) => [
      check(
        'hotel_owner_link_type_known',
        sql`(owner_type = ANY (ARRAY['CITIZEN'::text, 'ORGANIZATION'::text]))`,
      ),
      unique('hotel_owner_link_application_uq').on(table.applicationId),
      foreignKey({
        name: 'hotel_owner_link_application_fkey',
        columns: [table.applicationId],
        foreignColumns: [onboardingApplication.applicationId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'hotel_owner_link_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'hotel_owner_link_owner_fkey',
        columns: [table.ownerId],
        foreignColumns: [subscriptionOwner.ownerId],
      }).onDelete('restrict'),
      pgPolicy('resolver_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`true`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const hotelSubscription = platform
  .table(
    'hotel_subscription',
    {
      billingRevision: integer('billing_revision')
        .notNull()
        .default(sql`1`),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      effectivePackage: text('effective_package').notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      hotelId: uuid('hotel_id').notNull(),
      packageFloor: text('package_floor').notNull(),
      pendingUpgradeEffectiveAt: timestamp('pending_upgrade_effective_at', { withTimezone: true }),
      pendingUpgradePackage: text('pending_upgrade_package'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
      subscriptionId: uuid('subscription_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      suspendedAt: timestamp('suspended_at', { withTimezone: true }),
      suspensionReason: text('suspension_reason'),
      termMonths: integer('term_months').notNull(),
      timezone: text('timezone')
        .notNull()
        .default(sql`'Asia/Ulaanbaatar'::text`),
    },
    (table) => [
      check('hotel_subscription_billing_revision_positive', sql`(billing_revision >= 1)`),
      check('hotel_subscription_expiry_after_start', sql`(expires_at > starts_at)`),
      check(
        'hotel_subscription_floor_known',
        sql`(package_floor = ANY (ARRAY['P20'::text, 'P25'::text, 'P30'::text]))`,
      ),
      check(
        'hotel_subscription_floor_not_below_effective',
        sql`(platform.package_rank(package_floor) >= platform.package_rank(effective_package))`,
      ),
      check(
        'hotel_subscription_package_known',
        sql`(effective_package = ANY (ARRAY['P20'::text, 'P25'::text, 'P30'::text]))`,
      ),
      check(
        'hotel_subscription_pending_complete',
        sql`(num_nonnulls(pending_upgrade_package, pending_upgrade_effective_at) = ANY (ARRAY[0, 2]))`,
      ),
      check(
        'hotel_subscription_pending_is_an_upgrade',
        sql`((pending_upgrade_package IS NULL) OR (platform.package_rank(pending_upgrade_package) > platform.package_rank(effective_package)))`,
      ),
      check(
        'hotel_subscription_pending_within_floor',
        sql`((pending_upgrade_package IS NULL) OR (platform.package_rank(package_floor) >= platform.package_rank(pending_upgrade_package)))`,
      ),
      check('hotel_subscription_revision_non_negative', sql`(revision >= 0)`),
      check(
        'hotel_subscription_suspension_complete',
        sql`((suspended_at IS NULL) = (suspension_reason IS NULL))`,
      ),
      check('hotel_subscription_term_known', sql`(term_months = ANY (ARRAY[1, 3, 7, 12]))`),
      check('hotel_subscription_timezone_known', sql`(timezone = 'Asia/Ulaanbaatar'::text)`),
      unique('hotel_subscription_hotel_uq').on(table.hotelId),
      unique('hotel_subscription_scope_uq').on(table.hotelId, table.subscriptionId),
      foreignKey({
        name: 'hotel_subscription_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      index('hotel_subscription_boundary_idx')
        .on(table.pendingUpgradeEffectiveAt)
        .where(sql`pending_upgrade_package IS NOT NULL`),
      pgPolicy('resolver_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`true`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const subscriptionBillingIntent = platform
  .table(
    'subscription_billing_intent',
    {
      amountMnt: bigint('amount_mnt', { mode: 'bigint' }).notNull(),
      confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      currency: text('currency')
        .notNull()
        .default(sql`'MNT'::text`),
      currentPackage: text('current_package').notNull(),
      discountMnt: bigint('discount_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      effectiveAt: timestamp('effective_at', { withTimezone: true }),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      hotelId: uuid('hotel_id').notNull(),
      intentId: uuid('intent_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      kind: text('kind').notNull(),
      merchantRef: text('merchant_ref').notNull(),
      monthlyPriceMnt: bigint('monthly_price_mnt', { mode: 'bigint' }).notNull(),
      packageFeatureVersion: text('package_feature_version').notNull(),
      priceBookVersion: text('price_book_version').notNull(),
      priceDeltaMnt: bigint('price_delta_mnt', { mode: 'bigint' }),
      provider: text('provider').notNull(),
      providerInvoiceId: text('provider_invoice_id'),
      providerFeeMnt: bigint('provider_fee_mnt', { mode: 'bigint' }),
      quotedSnapshot: jsonb('quoted_snapshot'),
      providerPaymentId: text('provider_payment_id'),
      quotedBillingRevision: integer('quoted_billing_revision').notNull(),
      quotedExpiresAt: timestamp('quoted_expires_at', { withTimezone: true }).notNull(),
      reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
      reconciledByAccountId: uuid('reconciled_by_account_id'),
      reconciliationOutcome: text('reconciliation_outcome'),
      reconciliationReason: text('reconciliation_reason'),
      remainingServiceMonths: integer('remaining_service_months'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'PENDING'::text`),
      subscriptionId: uuid('subscription_id').notNull(),
      targetPackage: text('target_package').notNull(),
      taxConfigVersion: text('tax_config_version').notNull(),
      termMonths: integer('term_months'),
      terminalAt: timestamp('terminal_at', { withTimezone: true }),
      terminalReason: text('terminal_reason'),
      vatRateBp: integer('vat_rate_bp').notNull(),
    },
    (table) => [
      check('subscription_billing_intent_amount_positive', sql`(amount_mnt > 0)`),
      check(
        'subscription_billing_intent_confirmed_has_provider_payment',
        sql`((confirmed_at IS NULL) = (provider_payment_id IS NULL))`,
      ),
      check('subscription_billing_intent_currency_known', sql`(currency = 'MNT'::text)`),
      check('subscription_billing_intent_discount_zero', sql`(discount_mnt = 0)`),
      check('subscription_billing_intent_expiry_after_creation', sql`(expires_at > created_at)`),
      check(
        'subscription_billing_intent_kind_known',
        sql`(kind = ANY (ARRAY['RENEWAL'::text, 'UPGRADE'::text]))`,
      ),
      check(
        'subscription_billing_intent_package_known',
        sql`((current_package = ANY (ARRAY['P20'::text, 'P25'::text, 'P30'::text])) AND (target_package = ANY (ARRAY['P20'::text, 'P25'::text, 'P30'::text])))`,
      ),
      check(
        'subscription_billing_intent_provider_known',
        sql`(provider = ANY (ARRAY['QPAY'::text, 'KHAAN'::text]))`,
      ),
      check(
        'subscription_billing_intent_quoted_revision_positive',
        sql`(quoted_billing_revision >= 1)`,
      ),
      check(
        'subscription_billing_intent_reconciled_complete',
        sql`(num_nonnulls(reconciliation_outcome, reconciled_by_account_id, reconciled_at) = ANY (ARRAY[0, 3]))`,
      ),
      check(
        'subscription_billing_intent_reconciliation_outcome_known',
        sql`((reconciliation_outcome IS NULL) OR (reconciliation_outcome = ANY (ARRAY['PROVIDER_CORRECTED_NOT_PAID'::text, 'EXTERNALLY_VOIDED'::text, 'FINANCE_CLOSED_EXCEPTION'::text])))`,
      ),
      check(
        'subscription_billing_intent_renewal_not_below_floor',
        sql`((kind <> 'RENEWAL'::text) OR (platform.package_rank(target_package) >= platform.package_rank(current_package)))`,
      ),
      check(
        'subscription_billing_intent_renewal_shape',
        sql`((kind <> 'RENEWAL'::text) OR ((term_months = ANY (ARRAY[1, 3, 7, 12])) AND (price_delta_mnt IS NULL) AND (remaining_service_months IS NULL) AND (effective_at IS NULL) AND (amount_mnt = ((monthly_price_mnt * term_months) - discount_mnt))))`,
      ),
      check('subscription_billing_intent_revision_non_negative', sql`(revision >= 0)`),
      check(
        'subscription_billing_intent_state_known',
        sql`(state = ANY (ARRAY['PREPARING'::text, 'PENDING'::text, 'PAID'::text, 'FAILED'::text, 'EXPIRED'::text, 'CANCELLED'::text, 'STALE'::text, 'ABANDONED'::text, 'REFUSED'::text, 'PAID_REQUIRES_RECONCILIATION'::text]))`,
      ),
      check(
        'subscription_billing_intent_terminal_has_time',
        sql`((state = ANY (ARRAY['PREPARING'::text, 'PENDING'::text])) = (terminal_at IS NULL))`,
      ),
      check(
        'subscription_billing_intent_invoice_once_live',
        sql`((state = 'PREPARING'::text) OR ((state = 'REFUSED'::text) AND (provider_invoice_id IS NULL)) OR ((state <> 'REFUSED'::text) AND (provider_invoice_id IS NOT NULL)))`,
      ),
      check(
        'subscription_billing_intent_upgrade_shape',
        sql`((kind <> 'UPGRADE'::text) OR ((term_months IS NULL) AND (price_delta_mnt IS NOT NULL) AND (remaining_service_months IS NOT NULL) AND (remaining_service_months >= 1) AND (effective_at IS NOT NULL) AND (platform.package_rank(target_package) > platform.package_rank(current_package)) AND (amount_mnt = (price_delta_mnt * remaining_service_months))))`,
      ),
      check('subscription_billing_intent_fee_non_negative', sql`(provider_fee_mnt >= 0)`),
      check('subscription_billing_intent_fee_within_amount', sql`(provider_fee_mnt <= amount_mnt)`),
      check(
        'subscription_billing_intent_vat_rate_range',
        sql`((vat_rate_bp >= 0) AND (vat_rate_bp <= 10000))`,
      ),
      unique('subscription_billing_intent_invoice_uq').on(table.provider, table.providerInvoiceId),
      unique('subscription_billing_intent_scope_uq').on(table.hotelId, table.intentId),
      foreignKey({
        name: 'subscription_billing_intent_reconciled_by_fkey',
        columns: [table.reconciledByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'subscription_billing_intent_subscription_fkey',
        columns: [table.hotelId, table.subscriptionId],
        foreignColumns: [hotelSubscription.hotelId, hotelSubscription.subscriptionId],
      }).onDelete('restrict'),
      uniqueIndex('subscription_billing_intent_active_uq')
        .on(table.subscriptionId)
        .where(sql`state = 'PENDING'::text`),
      uniqueIndex('subscription_billing_intent_merchant_ref_uq').on(table.merchantRef),
      uniqueIndex('subscription_billing_intent_provider_payment_uq')
        .on(table.provider, table.providerPaymentId)
        .where(sql`provider_payment_id IS NOT NULL`),
      index('subscription_billing_intent_reconciliation_idx')
        .on(table.state, table.confirmedAt)
        .where(sql`state = 'PAID_REQUIRES_RECONCILIATION'::text`),
      pgPolicy('operation_review', {
        using: sql`(platform.current_realm() = 'operation'::text)`,
        withCheck: sql`(platform.current_realm() = 'operation'::text)`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const subscriptionPayment = platform
  .table(
    'subscription_payment',
    {
      applicationId: uuid('application_id'),
      confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      currency: text('currency')
        .notNull()
        .default(sql`'MNT'::text`),
      discountMnt: bigint('discount_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      grossAmountMnt: bigint('gross_amount_mnt', { mode: 'bigint' }).notNull(),
      hotelId: uuid('hotel_id').notNull(),
      intentId: uuid('intent_id'),
      merchantRef: text('merchant_ref').notNull(),
      monthlyPriceMnt: bigint('monthly_price_mnt', { mode: 'bigint' }).notNull(),
      netAmountMnt: bigint('net_amount_mnt', { mode: 'bigint' }),
      packageCode: text('package_code').notNull(),
      packageFeatureVersion: text('package_feature_version').notNull(),
      paymentId: uuid('payment_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      priceBookVersion: text('price_book_version').notNull(),
      provider: text('provider').notNull(),
      providerFeeMnt: bigint('provider_fee_mnt', { mode: 'bigint' }),
      providerPaymentId: text('provider_payment_id').notNull(),
      purpose: text('purpose').notNull(),
      subscriptionId: uuid('subscription_id').notNull(),
      taxConfigVersion: text('tax_config_version').notNull(),
      termMonths: integer('term_months'),
      vatAmountMnt: bigint('vat_amount_mnt', { mode: 'bigint' }).notNull(),
      vatRateBp: integer('vat_rate_bp').notNull(),
    },
    (table) => [
      check(
        'subscription_payment_amounts_positive',
        sql`((gross_amount_mnt > 0) AND (vat_amount_mnt >= 0) AND (provider_fee_mnt >= 0))`,
      ),
      check('subscription_payment_currency_known', sql`(currency = 'MNT'::text)`),
      check('subscription_payment_discount_zero', sql`(discount_mnt = 0)`),
      check(
        'subscription_payment_net_is_gross_less_fee',
        sql`(((provider_fee_mnt IS NULL) AND (net_amount_mnt IS NULL)) OR ((provider_fee_mnt IS NOT NULL) AND (net_amount_mnt = (gross_amount_mnt - provider_fee_mnt))))`,
      ),
      check(
        'subscription_payment_package_known',
        sql`(package_code = ANY (ARRAY['P20'::text, 'P25'::text, 'P30'::text]))`,
      ),
      check(
        'subscription_payment_provider_known',
        sql`(provider = ANY (ARRAY['QPAY'::text, 'KHAAN'::text]))`,
      ),
      check(
        'subscription_payment_purpose_known',
        sql`(purpose = ANY (ARRAY['ONBOARDING'::text, 'RENEWAL'::text, 'UPGRADE'::text]))`,
      ),
      check(
        'subscription_payment_source_named',
        sql`(num_nonnulls(application_id, intent_id) = 1)`,
      ),
      check(
        'subscription_payment_term_matches_purpose',
        sql`((purpose = 'UPGRADE'::text) = (term_months IS NULL))`,
      ),
      check(
        'subscription_payment_vat_rate_range',
        sql`((vat_rate_bp >= 0) AND (vat_rate_bp <= 10000))`,
      ),
      check('subscription_payment_vat_within_gross', sql`(vat_amount_mnt <= gross_amount_mnt)`),
      unique('subscription_payment_provider_uq').on(table.provider, table.providerPaymentId),
      unique('subscription_payment_scope_uq').on(table.hotelId, table.paymentId),
      foreignKey({
        name: 'subscription_payment_application_fkey',
        columns: [table.applicationId],
        foreignColumns: [onboardingApplication.applicationId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'subscription_payment_intent_fkey',
        columns: [table.hotelId, table.intentId],
        foreignColumns: [subscriptionBillingIntent.hotelId, subscriptionBillingIntent.intentId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'subscription_payment_subscription_fkey',
        columns: [table.hotelId, table.subscriptionId],
        foreignColumns: [hotelSubscription.hotelId, hotelSubscription.subscriptionId],
      }).onDelete('restrict'),
      index('subscription_payment_subscription_idx').on(
        table.hotelId,
        table.subscriptionId,
        table.confirmedAt,
      ),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const subscriptionEvent = platform
  .table(
    'subscription_event',
    {
      actorRef: text('actor_ref').notNull(),
      billingRevision: integer('billing_revision').notNull(),
      detail: jsonb('detail')
        .notNull()
        .default(sql`'{}'::jsonb`),
      eventId: bigint('event_id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
      eventType: text('event_type').notNull(),
      fromExpiresAt: timestamp('from_expires_at', { withTimezone: true }),
      fromPackage: text('from_package'),
      hotelId: uuid('hotel_id').notNull(),
      occurredAt: timestamp('occurred_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      paymentId: uuid('payment_id'),
      subscriptionId: uuid('subscription_id').notNull(),
      toExpiresAt: timestamp('to_expires_at', { withTimezone: true }),
      toPackage: text('to_package'),
    },
    (table) => [
      check('subscription_event_billing_revision_positive', sql`(billing_revision >= 1)`),
      check('subscription_event_detail_sanitised', sql`(NOT platform.contains_denied_key(detail))`),
      check(
        'subscription_event_type_known',
        sql`(event_type = ANY (ARRAY['PROVISIONED'::text, 'RENEWED'::text, 'UPGRADE_PAID'::text, 'UPGRADE_APPLIED'::text, 'SUSPENDED'::text, 'REACTIVATED'::text]))`,
      ),
      foreignKey({
        name: 'subscription_event_payment_fkey',
        columns: [table.hotelId, table.paymentId],
        foreignColumns: [subscriptionPayment.hotelId, subscriptionPayment.paymentId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'subscription_event_subscription_fkey',
        columns: [table.hotelId, table.subscriptionId],
        foreignColumns: [hotelSubscription.hotelId, hotelSubscription.subscriptionId],
      }).onDelete('restrict'),
      index('subscription_event_subscription_idx').on(
        table.hotelId,
        table.subscriptionId,
        table.eventId,
      ),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const ebarimtIssuance = platform
  .table(
    'ebarimt_issuance',
    {
      attempts: integer('attempts')
        .notNull()
        .default(sql`0`),
      availableAt: timestamp('available_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      claimToken: uuid('claim_token'),
      claimedUntil: timestamp('claimed_until', { withTimezone: true }),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      deliveredAt: timestamp('delivered_at', { withTimezone: true }),
      deliveryAttempts: integer('delivery_attempts')
        .notNull()
        .default(sql`0`),
      deliveryAvailableAt: timestamp('delivery_available_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      deliveryClaimToken: uuid('delivery_claim_token'),
      deliveryClaimedUntil: timestamp('delivery_claimed_until', { withTimezone: true }),
      deliveryState: text('delivery_state')
        .notNull()
        .default(sql`'PENDING'::text`),
      hotelId: uuid('hotel_id').notNull(),
      issuanceId: uuid('issuance_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      lastError: text('last_error'),
      paymentId: uuid('payment_id').notNull(),
      receiptAmountMnt: bigint('receipt_amount_mnt', { mode: 'bigint' }),
      receiptIssuedAt: timestamp('receipt_issued_at', { withTimezone: true }),
      receiptNumber: text('receipt_number'),
      receiptQr: text('receipt_qr'),
      receiptVatAmountMnt: bigint('receipt_vat_amount_mnt', { mode: 'bigint' }),
      retriedByAccountId: uuid('retried_by_account_id'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'PENDING'::text`),
    },
    (table) => [
      check('ebarimt_issuance_attempts_non_negative', sql`(attempts >= 0)`),
      check(
        'ebarimt_issuance_claim_complete',
        sql`(num_nonnulls(claim_token, claimed_until) = ANY (ARRAY[0, 2]))`,
      ),
      check(
        'ebarimt_issuance_delivered_has_time',
        sql`((delivery_state = 'SENT'::text) = (delivered_at IS NOT NULL))`,
      ),
      check(
        'ebarimt_issuance_delivery_requires_issue',
        sql`((delivery_state = 'PENDING'::text) OR (state = 'ISSUED'::text))`,
      ),
      check(
        'ebarimt_issuance_delivery_state_known',
        sql`(delivery_state = ANY (ARRAY['PENDING'::text, 'SENT'::text, 'FAILED'::text]))`,
      ),
      check('ebarimt_issuance_delivery_attempts_non_negative', sql`(delivery_attempts >= 0)`),
      check(
        'ebarimt_issuance_delivery_claim_complete',
        sql`(num_nonnulls(delivery_claim_token, delivery_claimed_until) = ANY (ARRAY[0, 2]))`,
      ),
      check(
        'ebarimt_issuance_receipt_complete',
        sql`(num_nonnulls(receipt_number, receipt_qr, receipt_amount_mnt, receipt_vat_amount_mnt, receipt_issued_at) = ANY (ARRAY[0, 5]))`,
      ),
      check(
        'ebarimt_issuance_receipt_matches_state',
        sql`((state = 'ISSUED'::text) = (receipt_number IS NOT NULL))`,
      ),
      check('ebarimt_issuance_revision_non_negative', sql`(revision >= 0)`),
      check(
        'ebarimt_issuance_state_known',
        sql`(state = ANY (ARRAY['PENDING'::text, 'CLAIMED'::text, 'ISSUED'::text, 'MANUAL_RESOLUTION'::text]))`,
      ),
      unique('ebarimt_issuance_payment_uq').on(table.hotelId, table.paymentId),
      unique('ebarimt_issuance_scope_uq').on(table.hotelId, table.issuanceId),
      foreignKey({
        name: 'ebarimt_issuance_payment_fkey',
        columns: [table.hotelId, table.paymentId],
        foreignColumns: [subscriptionPayment.hotelId, subscriptionPayment.paymentId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'ebarimt_issuance_retried_by_fkey',
        columns: [table.retriedByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      index('ebarimt_issuance_manual_idx')
        .on(table.hotelId, table.createdAt)
        .where(sql`state = 'MANUAL_RESOLUTION'::text`),
      index('ebarimt_issuance_queue_idx')
        .on(table.availableAt, table.issuanceId)
        .where(sql`state = ANY (ARRAY['PENDING'::text, 'CLAIMED'::text])`),
      pgPolicy('operation_review', {
        using: sql`(platform.current_realm() = 'operation'::text)`,
        withCheck: sql`(platform.current_realm() = 'operation'::text)`,
      }),
      pgPolicy('resolver_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`true`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const cashLocation = platform
  .table(
    'cash_location',
    {
      cashLocationId: uuid('cash_location_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      code: text('code').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      hotelId: uuid('hotel_id').notNull(),
      isDefaultDrawer: boolean('is_default_drawer')
        .notNull()
        .default(sql`false`),
      kind: text('kind').notNull(),
      name: text('name').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
    },
    (table) => [
      check(
        'cash_location_default_is_a_drawer',
        sql`((NOT is_default_drawer) OR (kind = 'DRAWER'::text))`,
      ),
      check(
        'cash_location_default_is_active',
        sql`((NOT is_default_drawer) OR (state = 'ACTIVE'::text))`,
      ),
      check('cash_location_kind_known', sql`(kind = ANY (ARRAY['DRAWER'::text, 'SAFE'::text]))`),
      check('cash_location_name_bounded', sql`((length(name) >= 1) AND (length(name) <= 100))`),
      check('cash_location_revision_non_negative', sql`(revision >= 0)`),
      check(
        'cash_location_state_known',
        sql`(state = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text]))`,
      ),
      unique('cash_location_code_uq').on(table.hotelId, table.code),
      unique('cash_location_name_uq').on(table.hotelId, table.name),
      unique('cash_location_scope_uq').on(table.hotelId, table.cashLocationId),
      foreignKey({
        name: 'cash_location_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      uniqueIndex('cash_location_default_drawer_uq')
        .on(table.hotelId)
        .where(sql`is_default_drawer IS TRUE`),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const hotelAdminActivation = platform
  .table(
    'hotel_admin_activation',
    {
      accountId: uuid('account_id').notNull(),
      activatedAt: timestamp('activated_at', { withTimezone: true }),
      activationId: uuid('activation_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      applicationId: uuid('application_id').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      emailNormalized: text('email_normalized').notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true }),
      hotelId: uuid('hotel_id').notNull(),
      membershipId: uuid('membership_id').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'PENDING_ACTIVATION'::text`),
      tokenHash: text('token_hash'),
      tokenKeyVersion: text('token_key_version'),
    },
    (table) => [
      check(
        'hotel_admin_activation_activated_has_time',
        sql`((state = 'PENDING_ACTIVATION'::text) = (activated_at IS NULL))`,
      ),
      check(
        'hotel_admin_activation_email_normalised',
        sql`(email_normalized = lower(email_normalized))`,
      ),
      check('hotel_admin_activation_revision_non_negative', sql`(revision >= 0)`),
      check(
        'hotel_admin_activation_state_known',
        sql`(state = ANY (ARRAY['PENDING_ACTIVATION'::text, 'ACTIVE'::text, 'SUSPENDED'::text]))`,
      ),
      check(
        'hotel_admin_activation_token_complete',
        sql`(num_nonnulls(token_hash, token_key_version, expires_at) = ANY (ARRAY[0, 3]))`,
      ),
      check(
        'hotel_admin_activation_token_only_while_pending',
        sql`((token_hash IS NULL) OR (state = 'PENDING_ACTIVATION'::text))`,
      ),
      check(
        'hotel_admin_activation_token_shape',
        sql`((token_hash IS NULL) OR (token_hash ~ '^[0-9a-f]{64}$'::text))`,
      ),
      unique('hotel_admin_activation_application_uq').on(table.applicationId),
      unique('hotel_admin_activation_membership_uq').on(table.hotelId, table.membershipId),
      unique('hotel_admin_activation_scope_uq').on(table.hotelId, table.activationId),
      unique('hotel_admin_activation_token_uq').on(table.tokenHash),
      foreignKey({
        name: 'hotel_admin_activation_account_fkey',
        columns: [table.accountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'hotel_admin_activation_application_fkey',
        columns: [table.applicationId],
        foreignColumns: [onboardingApplication.applicationId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'hotel_admin_activation_membership_fkey',
        columns: [table.hotelId, table.membershipId],
        foreignColumns: [staffMembership.hotelId, staffMembership.membershipId],
      }).onDelete('restrict'),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const activationDelivery = platform
  .table(
    'activation_delivery',
    {
      activationId: uuid('activation_id').notNull(),
      attempts: integer('attempts')
        .notNull()
        .default(sql`0`),
      availableAt: timestamp('available_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      claimToken: uuid('claim_token'),
      claimedUntil: timestamp('claimed_until', { withTimezone: true }),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      deliveredAt: timestamp('delivered_at', { withTimezone: true }),
      deliveryId: uuid('delivery_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      emailNormalized: text('email_normalized').notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      hotelId: uuid('hotel_id').notNull(),
      lastError: text('last_error'),
      secretCiphertext: bytea('secret_ciphertext'),
      secretKeyVersion: text('secret_key_version'),
      secretWrappedDek: bytea('secret_wrapped_dek'),
      state: text('state')
        .notNull()
        .default(sql`'PENDING'::text`),
    },
    (table) => [
      check('activation_delivery_attempts_non_negative', sql`(attempts >= 0)`),
      check(
        'activation_delivery_claim_complete',
        sql`(num_nonnulls(claim_token, claimed_until) = ANY (ARRAY[0, 2]))`,
      ),
      check(
        'activation_delivery_delivered_has_time',
        sql`((state = 'SENT'::text) = (delivered_at IS NOT NULL))`,
      ),
      check(
        'activation_delivery_email_normalised',
        sql`(email_normalized = lower(email_normalized))`,
      ),
      check(
        'activation_delivery_secret_complete',
        sql`(num_nonnulls(secret_ciphertext, secret_wrapped_dek, secret_key_version) = ANY (ARRAY[0, 3]))`,
      ),
      check(
        'activation_delivery_settled_holds_no_secret',
        sql`((secret_ciphertext IS NULL) OR (state = ANY (ARRAY['PENDING'::text, 'CLAIMED'::text])))`,
      ),
      check(
        'activation_delivery_state_known',
        sql`(state = ANY (ARRAY['PENDING'::text, 'CLAIMED'::text, 'SENT'::text, 'DEAD_LETTER'::text]))`,
      ),
      unique('activation_delivery_activation_uq').on(table.hotelId, table.activationId),
      foreignKey({
        name: 'activation_delivery_activation_fkey',
        columns: [table.hotelId, table.activationId],
        foreignColumns: [hotelAdminActivation.hotelId, hotelAdminActivation.activationId],
      }).onDelete('restrict'),
      index('activation_delivery_queue_idx')
        .on(table.availableAt, table.deliveryId)
        .where(sql`state = ANY (ARRAY['PENDING'::text, 'CLAIMED'::text])`),
      pgPolicy('resolver_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`true`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * Phase 06 — the hotel catalog.
 *
 * Every tariff column is nullable because *unset* is a state the resolver has to
 * see: a level that has configured nothing inherits, and a hotel that has
 * configured nothing has no effective price at all (`STAY-DEC-005`). Hourly and
 * nightly are separate columns at every level because doc 05 §13.1 resolves them
 * independently.
 */
export const hotelStayConfiguration = platform
  .table(
    'hotel_stay_configuration',
    {
      cleaningBufferMinutes: integer('cleaning_buffer_minutes'),
      configVersion: integer('config_version')
        .notNull()
        .default(sql`1`),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      fixedCheckoutMinute: integer('fixed_checkout_minute'),
      hotelId: uuid('hotel_id').primaryKey(),
      hourlyRateMnt: bigint('hourly_rate_mnt', { mode: 'bigint' }),
      nightlyRateMnt: bigint('nightly_rate_mnt', { mode: 'bigint' }),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
    },
    (table) => [
      check(
        'hotel_stay_configuration_buffer_range',
        sql`((cleaning_buffer_minutes IS NULL) OR ((cleaning_buffer_minutes >= 0) AND (cleaning_buffer_minutes <= 1440)))`,
      ),
      check(
        'hotel_stay_configuration_checkout_minute_range',
        sql`((fixed_checkout_minute IS NULL) OR ((fixed_checkout_minute >= 0) AND (fixed_checkout_minute <= 1439)))`,
      ),
      check(
        'hotel_stay_configuration_hourly_non_negative',
        sql`((hourly_rate_mnt IS NULL) OR (hourly_rate_mnt >= 0))`,
      ),
      check(
        'hotel_stay_configuration_nightly_non_negative',
        sql`((nightly_rate_mnt IS NULL) OR (nightly_rate_mnt >= 0))`,
      ),
      check('hotel_stay_configuration_revision_non_negative', sql`(revision >= 0)`),
      check('hotel_stay_configuration_version_positive', sql`(config_version >= 1)`),
      foreignKey({
        name: 'hotel_stay_configuration_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const roomCategory = platform
  .table(
    'room_category',
    {
      categoryId: uuid('category_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      cleaningBufferMinutes: integer('cleaning_buffer_minutes'),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
      description: text('description'),
      hotelId: uuid('hotel_id').notNull(),
      hourlyRateMnt: bigint('hourly_rate_mnt', { mode: 'bigint' }),
      name: text('name').notNull(),
      nightlyRateMnt: bigint('nightly_rate_mnt', { mode: 'bigint' }),
      retirementReason: text('retirement_reason'),
      retirementRequestedAt: timestamp('retirement_requested_at', { withTimezone: true }),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
    },
    (table) => [
      check(
        'room_category_active_is_clear',
        sql`((state <> 'ACTIVE'::text) OR ((retirement_requested_at IS NULL) AND (deactivated_at IS NULL)))`,
      ),
      check(
        'room_category_buffer_range',
        sql`((cleaning_buffer_minutes IS NULL) OR ((cleaning_buffer_minutes >= 0) AND (cleaning_buffer_minutes <= 1440)))`,
      ),
      check(
        'room_category_description_bounded',
        sql`((description IS NULL) OR ((length(description) >= 1) AND (length(description) <= 500)))`,
      ),
      check(
        'room_category_hourly_non_negative',
        sql`((hourly_rate_mnt IS NULL) OR (hourly_rate_mnt >= 0))`,
      ),
      check(
        'room_category_inactive_has_time',
        sql`((state <> 'INACTIVE'::text) OR (deactivated_at IS NOT NULL))`,
      ),
      check('room_category_name_bounded', sql`((length(name) >= 1) AND (length(name) <= 120))`),
      check(
        'room_category_nightly_non_negative',
        sql`((nightly_rate_mnt IS NULL) OR (nightly_rate_mnt >= 0))`,
      ),
      check(
        'room_category_retiring_has_request',
        sql`((state <> 'RETIRING'::text) OR (retirement_requested_at IS NOT NULL))`,
      ),
      check('room_category_revision_non_negative', sql`(revision >= 0)`),
      check(
        'room_category_state_known',
        sql`(state = ANY (ARRAY['ACTIVE'::text, 'RETIRING'::text, 'INACTIVE'::text]))`,
      ),
      unique('room_category_hotel_scope_uq').on(table.hotelId, table.categoryId),
      foreignKey({
        name: 'room_category_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const room = platform
  .table(
    'room',
    {
      categoryId: uuid('category_id').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
      floorLabel: text('floor_label'),
      hotelId: uuid('hotel_id').notNull(),
      hourlyRateMnt: bigint('hourly_rate_mnt', { mode: 'bigint' }),
      nightlyRateMnt: bigint('nightly_rate_mnt', { mode: 'bigint' }),
      retirementReason: text('retirement_reason'),
      retirementRequestedAt: timestamp('retirement_requested_at', { withTimezone: true }),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      roomId: uuid('room_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      roomNumber: text('room_number').notNull(),
      state: text('state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
    },
    (table) => [
      check(
        'room_active_is_clear',
        sql`((state <> 'ACTIVE'::text) OR ((retirement_requested_at IS NULL) AND (deactivated_at IS NULL)))`,
      ),
      check(
        'room_floor_bounded',
        sql`((floor_label IS NULL) OR ((length(floor_label) >= 1) AND (length(floor_label) <= 20)))`,
      ),
      check('room_hourly_non_negative', sql`((hourly_rate_mnt IS NULL) OR (hourly_rate_mnt >= 0))`),
      check(
        'room_inactive_has_time',
        sql`((state <> 'INACTIVE'::text) OR (deactivated_at IS NOT NULL))`,
      ),
      check(
        'room_nightly_non_negative',
        sql`((nightly_rate_mnt IS NULL) OR (nightly_rate_mnt >= 0))`,
      ),
      check(
        'room_number_bounded',
        sql`((length(room_number) >= 1) AND (length(room_number) <= 20))`,
      ),
      check(
        'room_retiring_has_request',
        sql`((state <> 'RETIRING'::text) OR (retirement_requested_at IS NOT NULL))`,
      ),
      check('room_revision_non_negative', sql`(revision >= 0)`),
      check(
        'room_state_known',
        sql`(state = ANY (ARRAY['ACTIVE'::text, 'RETIRING'::text, 'INACTIVE'::text]))`,
      ),
      unique('room_hotel_scope_uq').on(table.hotelId, table.roomId),
      unique('room_number_unique_per_hotel').on(table.hotelId, table.roomNumber),
      foreignKey({
        name: 'room_category_fkey',
        columns: [table.hotelId, table.categoryId],
        foreignColumns: [roomCategory.hotelId, roomCategory.categoryId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'room_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      index('room_category_idx').on(table.hotelId, table.categoryId),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * Identity and lifecycle only.
 *
 * Selling price, purchase cost, stock and the template versions are Phase 07's,
 * and they are added to this row rather than to a second product model
 * (`RML-DEC-015`, doc 26 §§6–7).
 */
export const minibarProduct = platform
  .table(
    'minibar_product',
    {
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
      category: text('category'),
      hotelId: uuid('hotel_id').notNull(),
      name: text('name').notNull(),
      productId: uuid('product_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      purchaseCostMnt: bigint('purchase_cost_mnt', { mode: 'bigint' }),
      retirementReason: text('retirement_reason'),
      retirementRequestedAt: timestamp('retirement_requested_at', { withTimezone: true }),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      sellingPriceMnt: bigint('selling_price_mnt', { mode: 'bigint' }),
      state: text('state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
      unit: text('unit'),
    },
    (table) => [
      check(
        'minibar_product_active_is_clear',
        sql`((state <> 'ACTIVE'::text) OR ((retirement_requested_at IS NULL) AND (deactivated_at IS NULL)))`,
      ),
      check(
        'minibar_product_inactive_has_time',
        sql`((state <> 'INACTIVE'::text) OR (deactivated_at IS NOT NULL))`,
      ),
      check('minibar_product_name_bounded', sql`((length(name) >= 1) AND (length(name) <= 120))`),
      check(
        'minibar_product_retiring_has_request',
        sql`((state <> 'RETIRING'::text) OR (retirement_requested_at IS NOT NULL))`,
      ),
      check(
        'minibar_product_category_bounded',
        sql`((category IS NULL) OR ((length(category) >= 1) AND (length(category) <= 60)))`,
      ),
      check(
        'minibar_product_purchase_cost_non_negative',
        sql`((purchase_cost_mnt IS NULL) OR (purchase_cost_mnt >= 0))`,
      ),
      check(
        'minibar_product_selling_price_non_negative',
        sql`((selling_price_mnt IS NULL) OR (selling_price_mnt >= 0))`,
      ),
      check(
        'minibar_product_unit_bounded',
        sql`((unit IS NULL) OR ((length(unit) >= 1) AND (length(unit) <= 20)))`,
      ),
      check('minibar_product_revision_non_negative', sql`(revision >= 0)`),
      check(
        'minibar_product_state_known',
        sql`(state = ANY (ARRAY['ACTIVE'::text, 'RETIRING'::text, 'INACTIVE'::text]))`,
      ),
      unique('minibar_product_hotel_scope_uq').on(table.hotelId, table.productId),
      foreignKey({
        name: 'minibar_product_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const minibarTemplate = platform
  .table(
    'minibar_template',
    {
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
      description: text('description'),
      hotelId: uuid('hotel_id').notNull(),
      name: text('name').notNull(),
      retirementReason: text('retirement_reason'),
      retirementRequestedAt: timestamp('retirement_requested_at', { withTimezone: true }),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
      templateId: uuid('template_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
    },
    (table) => [
      check(
        'minibar_template_active_is_clear',
        sql`((state <> 'ACTIVE'::text) OR ((retirement_requested_at IS NULL) AND (deactivated_at IS NULL)))`,
      ),
      check(
        'minibar_template_inactive_has_time',
        sql`((state <> 'INACTIVE'::text) OR (deactivated_at IS NOT NULL))`,
      ),
      check(
        'minibar_template_description_bounded',
        sql`((description IS NULL) OR ((length(description) >= 1) AND (length(description) <= 500)))`,
      ),
      check('minibar_template_name_bounded', sql`((length(name) >= 1) AND (length(name) <= 120))`),
      check(
        'minibar_template_retiring_has_request',
        sql`((state <> 'RETIRING'::text) OR (retirement_requested_at IS NOT NULL))`,
      ),
      check('minibar_template_revision_non_negative', sql`(revision >= 0)`),
      check(
        'minibar_template_state_known',
        sql`(state = ANY (ARRAY['ACTIVE'::text, 'RETIRING'::text, 'INACTIVE'::text]))`,
      ),
      unique('minibar_template_hotel_scope_uq').on(table.hotelId, table.templateId),
      foreignKey({
        name: 'minibar_template_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The catalog's append-only history.
 *
 * `entity_id` carries no foreign key on purpose: `RML-DEC-005` allows a
 * never-used entity to be hard-deleted, and the record of that deletion has to
 * survive the row it describes.
 */
export const catalogEvent = platform
  .table(
    'catalog_event',
    {
      actorAccountId: uuid('actor_account_id'),
      configVersion: integer('config_version'),
      entityId: uuid('entity_id').notNull(),
      entityType: text('entity_type').notNull(),
      eventId: uuid('event_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      eventType: text('event_type').notNull(),
      fromState: text('from_state'),
      hotelId: uuid('hotel_id').notNull(),
      occurredAt: timestamp('occurred_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      payload: jsonb('payload')
        .notNull()
        .default(sql`'{}'::jsonb`),
      reason: text('reason'),
      toState: text('to_state'),
    },
    (table) => [
      check(
        'catalog_event_entity_type_known',
        sql`(entity_type = ANY (ARRAY['ROOM'::text, 'ROOM_CATEGORY'::text, 'MINIBAR_PRODUCT'::text, 'MINIBAR_TEMPLATE'::text, 'HOTEL_STAY_CONFIGURATION'::text]))`,
      ),
      check(
        'catalog_event_payload_has_no_denied_key',
        sql`(NOT platform.contains_denied_key(payload))`,
      ),
      check(
        'catalog_event_reason_bounded',
        sql`((reason IS NULL) OR ((length(reason) >= 1) AND (length(reason) <= 300)))`,
      ),
      check(
        'catalog_event_state_known',
        sql`(((from_state IS NULL) OR (from_state = ANY (ARRAY['ACTIVE'::text, 'RETIRING'::text, 'INACTIVE'::text]))) AND ((to_state IS NULL) OR (to_state = ANY (ARRAY['ACTIVE'::text, 'RETIRING'::text, 'INACTIVE'::text]))))`,
      ),
      check(
        'catalog_event_type_known',
        sql`(event_type = ANY (ARRAY['CREATED'::text, 'UPDATED'::text, 'TARIFF_SET'::text, 'TARIFF_CLEARED'::text, 'CONFIGURATION_SET'::text, 'RETIREMENT_REQUESTED'::text, 'RETIREMENT_CANCELLED'::text, 'DEACTIVATED'::text, 'REACTIVATED'::text, 'HARD_DELETED'::text]))`,
      ),
      check(
        'catalog_event_version_positive',
        sql`((config_version IS NULL) OR (config_version >= 1))`,
      ),
      foreignKey({
        name: 'catalog_event_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      index('catalog_event_entity_idx').on(
        table.hotelId,
        table.entityType,
        table.entityId,
        table.occurredAt,
      ),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The confirmation snapshot (`STAY-DEC-005`, doc 05 §13.2).
 *
 * Append-only, and carrying what re-proves the price: the unit rate, the level
 * it came from, the entity at that level and the configuration version in force.
 * The `ONLINE_BOOKING` check is the decision itself in constraint form — an
 * online price can never have come from a room override.
 */
export const stayRateSnapshot = platform
  .table(
    'stay_rate_snapshot',
    {
      capturedAt: timestamp('captured_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      categoryId: uuid('category_id').notNull(),
      cleaningBufferMinutes: integer('cleaning_buffer_minutes').notNull(),
      fixedCheckoutMinute: integer('fixed_checkout_minute'),
      hotelId: uuid('hotel_id').notNull(),
      pricingConfigVersion: integer('pricing_config_version').notNull(),
      roomId: uuid('room_id'),
      snapshotId: uuid('snapshot_id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      sourceEntityId: uuid('source_entity_id').notNull(),
      sourceLevel: text('source_level').notNull(),
      stayType: text('stay_type').notNull(),
      subjectRef: uuid('subject_ref').notNull(),
      subjectType: text('subject_type').notNull(),
      unitPriceMnt: bigint('unit_price_mnt', { mode: 'bigint' }).notNull(),
    },
    (table) => [
      check(
        'stay_rate_snapshot_buffer_range',
        sql`((cleaning_buffer_minutes >= 0) AND (cleaning_buffer_minutes <= 1440))`,
      ),
      check(
        'stay_rate_snapshot_checkout_minute_range',
        sql`((fixed_checkout_minute IS NULL) OR ((fixed_checkout_minute >= 0) AND (fixed_checkout_minute <= 1439)))`,
      ),
      check(
        'stay_rate_snapshot_nightly_has_checkout',
        sql`((stay_type = 'NIGHTLY'::text) = (fixed_checkout_minute IS NOT NULL))`,
      ),
      check(
        'stay_rate_snapshot_online_never_room_source',
        sql`((subject_type <> 'ONLINE_BOOKING'::text) OR (source_level <> 'ROOM'::text))`,
      ),
      check('stay_rate_snapshot_price_non_negative', sql`(unit_price_mnt >= 0)`),
      check(
        'stay_rate_snapshot_room_source_has_room',
        sql`((source_level <> 'ROOM'::text) OR (room_id IS NOT NULL))`,
      ),
      check(
        'stay_rate_snapshot_source_level_known',
        sql`(source_level = ANY (ARRAY['ROOM'::text, 'CATEGORY'::text, 'HOTEL'::text]))`,
      ),
      check(
        'stay_rate_snapshot_source_matches_level',
        sql`(((source_level = 'ROOM'::text) AND (source_entity_id = room_id)) OR ((source_level = 'CATEGORY'::text) AND (source_entity_id = category_id)) OR ((source_level = 'HOTEL'::text) AND (source_entity_id = hotel_id)))`,
      ),
      check(
        'stay_rate_snapshot_stay_type_known',
        sql`(stay_type = ANY (ARRAY['HOURLY'::text, 'NIGHTLY'::text]))`,
      ),
      check(
        'stay_rate_snapshot_subject_known',
        sql`(subject_type = ANY (ARRAY['WALK_IN_STAY'::text, 'ONLINE_BOOKING'::text]))`,
      ),
      check('stay_rate_snapshot_version_positive', sql`(pricing_config_version >= 1)`),
      unique('stay_rate_snapshot_subject_uq').on(
        table.hotelId,
        table.subjectType,
        table.subjectRef,
      ),
      foreignKey({
        name: 'stay_rate_snapshot_category_fkey',
        columns: [table.hotelId, table.categoryId],
        foreignColumns: [roomCategory.hotelId, roomCategory.categoryId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'stay_rate_snapshot_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'stay_rate_snapshot_room_fkey',
        columns: [table.hotelId, table.roomId],
        foreignColumns: [room.hotelId, room.roomId],
      }).onDelete('restrict'),
      index('stay_rate_snapshot_category_idx').on(table.hotelId, table.categoryId),
      index('stay_rate_snapshot_room_idx').on(table.hotelId, table.roomId),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The PostgreSQL enum types this declaration covers.
 *
 * An explicit inventory, not something derived from the columns that happen to
 * use one. An exported `pgEnum` nothing references is still a type Drizzle Kit
 * creates, so discovering enums through table columns alone left the declaration
 * and the database disagreeing with an empty diff.
 *
 * Empty on purpose: every kernel state column is `text` with a check
 * constraint, so the allowed values live in a constraint the comparator already
 * reads. `schema-inventory.test.ts` holds this list to every enum the module
 * exports, so adding one without registering it fails.
 */
export const DECLARED_ENUMS = [] as const;

// ---------------------------------------------------------------------
// Phase 07 — minibar inventory and templates.
// ---------------------------------------------------------------------

/**
 * The warehouse balance and average cost of one product. Written only by the
 * ledger trigger; no runtime holds a write grant (`INV-DEC-002`, doc 22 §2).
 */
export const minibarWarehouseStock = platform
  .table(
    'minibar_warehouse_stock',
    {
      avgCostMnt: bigint('avg_cost_mnt', { mode: 'bigint' }),
      hotelId: uuid('hotel_id').notNull(),
      productId: uuid('product_id').primaryKey().notNull(),
      quantity: integer('quantity')
        .notNull()
        .default(sql`0`),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
    },
    (table) => [
      check(
        'minibar_warehouse_stock_cost_non_negative',
        sql`((avg_cost_mnt IS NULL) OR (avg_cost_mnt >= 0))`,
      ),
      foreignKey({
        name: 'minibar_warehouse_stock_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check('minibar_warehouse_stock_non_negative', sql`(quantity >= 0)`),
      foreignKey({
        name: 'minibar_warehouse_stock_product_fkey',
        columns: [table.hotelId, table.productId],
        foreignColumns: [minibarProduct.hotelId, minibarProduct.productId],
      }).onDelete('restrict'),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * What one room physically holds of one product. Written only by the ledger
 * trigger (`INV-DEC-002`, doc 22 §2).
 */
export const roomMinibarStock = platform
  .table(
    'room_minibar_stock',
    {
      hotelId: uuid('hotel_id').notNull(),
      productId: uuid('product_id').notNull(),
      quantity: integer('quantity')
        .notNull()
        .default(sql`0`),
      roomId: uuid('room_id').notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
    },
    (table) => [
      foreignKey({
        name: 'room_minibar_stock_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check('room_minibar_stock_non_negative', sql`(quantity >= 0)`),
      primaryKey({ name: 'room_minibar_stock_pkey', columns: [table.roomId, table.productId] }),
      foreignKey({
        name: 'room_minibar_stock_product_fkey',
        columns: [table.hotelId, table.productId],
        foreignColumns: [minibarProduct.hotelId, minibarProduct.productId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'room_minibar_stock_room_fkey',
        columns: [table.hotelId, table.roomId],
        foreignColumns: [room.hotelId, room.roomId],
      }).onDelete('restrict'),
      index('room_minibar_stock_product_idx').on(table.hotelId, table.productId),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The immutable stock ledger (`INV-DEC-003`, doc 22 §4). Every balance is derived
 * from it by trigger; nothing edits or deletes a row.
 */
export const inventoryMovement = platform
  .table(
    'inventory_movement',
    {
      actorAccountId: uuid('actor_account_id'),
      configurationChangeId: uuid('configuration_change_id'),
      hotelId: uuid('hotel_id').notNull(),
      location: text('location').notNull(),
      movementId: uuid('movement_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      movementType: text('movement_type').notNull(),
      occurredAt: timestamp('occurred_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      originalMovementId: uuid('original_movement_id'),
      productId: uuid('product_id').notNull(),
      quantity: integer('quantity').notNull(),
      reason: text('reason'),
      roomId: uuid('room_id'),
      stayId: uuid('stay_id'),
      taskId: uuid('task_id'),
      unitCostMnt: bigint('unit_cost_mnt', { mode: 'bigint' }),
    },
    (table) => [
      check(
        'inventory_movement_correction_has_reason',
        sql`((movement_type <> ALL (ARRAY['WASTE'::text, 'ADJUST_PLUS'::text, 'ADJUST_MINUS'::text])) OR (reason IS NOT NULL))`,
      ),
      check(
        'inventory_movement_cost_non_negative',
        sql`((unit_cost_mnt IS NULL) OR (unit_cost_mnt >= 0))`,
      ),
      foreignKey({
        name: 'inventory_movement_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'inventory_movement_location_known',
        sql`(location = ANY (ARRAY['WAREHOUSE'::text, 'ROOM'::text, 'TRANSFER'::text]))`,
      ),
      check(
        'inventory_movement_location_shape',
        sql`(((movement_type = ANY (ARRAY['TRANSFER_TO_ROOM'::text, 'RETURN_TO_WAREHOUSE'::text])) AND (location = 'TRANSFER'::text) AND (room_id IS NOT NULL)) OR ((movement_type = ANY (ARRAY['OPENING'::text, 'PURCHASE'::text])) AND (location = 'WAREHOUSE'::text) AND (room_id IS NULL)) OR ((movement_type = 'GUEST_CONSUMPTION'::text) AND (location = 'ROOM'::text) AND (room_id IS NOT NULL)) OR ((movement_type = ANY (ARRAY['WASTE'::text, 'ADJUST_PLUS'::text, 'ADJUST_MINUS'::text])) AND (((location = 'WAREHOUSE'::text) AND (room_id IS NULL)) OR ((location = 'ROOM'::text) AND (room_id IS NOT NULL)))))`,
      ),
      foreignKey({
        name: 'inventory_movement_original_fkey',
        columns: [table.originalMovementId],
        foreignColumns: [table.movementId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'inventory_movement_product_fkey',
        columns: [table.hotelId, table.productId],
        foreignColumns: [minibarProduct.hotelId, minibarProduct.productId],
      }).onDelete('restrict'),
      check('inventory_movement_quantity_positive', sql`(quantity > 0)`),
      check(
        'inventory_movement_reason_bounded',
        sql`((reason IS NULL) OR ((length(reason) >= 1) AND (length(reason) <= 300)))`,
      ),
      check(
        'inventory_movement_receipt_has_cost',
        sql`((movement_type <> ALL (ARRAY['OPENING'::text, 'PURCHASE'::text, 'ADJUST_PLUS'::text])) OR (unit_cost_mnt IS NOT NULL))`,
      ),
      foreignKey({
        name: 'inventory_movement_room_fkey',
        columns: [table.hotelId, table.roomId],
        foreignColumns: [room.hotelId, room.roomId],
      }).onDelete('restrict'),
      check(
        'inventory_movement_type_known',
        sql`(movement_type = ANY (ARRAY['OPENING'::text, 'PURCHASE'::text, 'TRANSFER_TO_ROOM'::text, 'RETURN_TO_WAREHOUSE'::text, 'GUEST_CONSUMPTION'::text, 'WASTE'::text, 'ADJUST_PLUS'::text, 'ADJUST_MINUS'::text]))`,
      ),
      index('inventory_movement_change_idx').on(table.hotelId, table.configurationChangeId),
      index('inventory_movement_product_idx').on(table.hotelId, table.productId, table.occurredAt),
      index('inventory_movement_room_idx').on(table.hotelId, table.roomId, table.occurredAt),
      index('inventory_movement_stay_idx').on(table.hotelId, table.stayId),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * One version of a template: `DRAFT → PUBLISHED → ARCHIVED`, at most one Default
 * per template (`RML-DEC-015`…`017`, doc 26 §24).
 */
export const minibarTemplateVersion = platform
  .table(
    'minibar_template_version',
    {
      archivedAt: timestamp('archived_at', { withTimezone: true }),
      clonedFromVersionId: uuid('cloned_from_version_id'),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      hotelId: uuid('hotel_id').notNull(),
      isDefault: boolean('is_default')
        .notNull()
        .default(sql`false`),
      publishedAt: timestamp('published_at', { withTimezone: true }),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'DRAFT'::text`),
      templateId: uuid('template_id').notNull(),
      versionId: uuid('version_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      versionNo: integer('version_no').notNull(),
    },
    (table) => [
      check(
        'minibar_template_version_archived_has_time',
        sql`((state = 'ARCHIVED'::text) = (archived_at IS NOT NULL))`,
      ),
      unique('minibar_template_version_binding_uq').on(
        table.hotelId,
        table.templateId,
        table.versionId,
      ),
      foreignKey({
        name: 'minibar_template_version_clone_fkey',
        columns: [table.clonedFromVersionId],
        foreignColumns: [table.versionId],
      }).onDelete('restrict'),
      check(
        'minibar_template_version_default_is_published',
        sql`((NOT is_default) OR (state = 'PUBLISHED'::text))`,
      ),
      foreignKey({
        name: 'minibar_template_version_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      unique('minibar_template_version_hotel_scope_uq').on(table.hotelId, table.versionId),
      check('minibar_template_version_number_positive', sql`(version_no >= 1)`),
      unique('minibar_template_version_number_uq').on(table.templateId, table.versionNo),
      check(
        'minibar_template_version_published_has_time',
        sql`((state = 'DRAFT'::text) = (published_at IS NULL))`,
      ),
      check('minibar_template_version_revision_non_negative', sql`(revision >= 0)`),
      check(
        'minibar_template_version_state_known',
        sql`(state = ANY (ARRAY['DRAFT'::text, 'PUBLISHED'::text, 'ARCHIVED'::text]))`,
      ),
      foreignKey({
        name: 'minibar_template_version_template_fkey',
        columns: [table.hotelId, table.templateId],
        foreignColumns: [minibarTemplate.hotelId, minibarTemplate.templateId],
      }).onDelete('restrict'),
      uniqueIndex('minibar_template_version_default_uq')
        .on(table.hotelId, table.templateId)
        .where(sql`is_default IS TRUE`),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The product list and target quantity of one version, writable only while the
 * version is a draft (`RML-DEC-016`).
 */
export const minibarTemplateVersionItem = platform
  .table(
    'minibar_template_version_item',
    {
      hotelId: uuid('hotel_id').notNull(),
      itemId: uuid('item_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      productId: uuid('product_id').notNull(),
      targetQuantity: integer('target_quantity').notNull(),
      versionId: uuid('version_id').notNull(),
    },
    (table) => [
      foreignKey({
        name: 'minibar_template_version_item_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'minibar_template_version_item_product_fkey',
        columns: [table.hotelId, table.productId],
        foreignColumns: [minibarProduct.hotelId, minibarProduct.productId],
      }).onDelete('restrict'),
      unique('minibar_template_version_item_product_uq').on(table.versionId, table.productId),
      check('minibar_template_version_item_target_positive', sql`(target_quantity >= 1)`),
      foreignKey({
        name: 'minibar_template_version_item_version_fkey',
        columns: [table.hotelId, table.versionId],
        foreignColumns: [minibarTemplateVersion.hotelId, minibarTemplateVersion.versionId],
      }).onDelete('restrict'),
      index('minibar_template_version_item_product_idx').on(table.hotelId, table.productId),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The Manager's audited exception for the next stay of a short minibar
 * (`INV-DEC-006`, doc 22 §8).
 */
export const minibarShortageOverride = platform
  .table(
    'minibar_shortage_override',
    {
      consumedAt: timestamp('consumed_at', { withTimezone: true }),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      createdBy: uuid('created_by'),
      hotelId: uuid('hotel_id').notNull(),
      overrideId: uuid('override_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      reason: text('reason').notNull(),
      roomId: uuid('room_id').notNull(),
      snapshot: jsonb('snapshot').notNull(),
    },
    (table) => [
      foreignKey({
        name: 'minibar_shortage_override_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      unique('minibar_shortage_override_hotel_scope_uq').on(table.hotelId, table.overrideId),
      check(
        'minibar_shortage_override_reason_bounded',
        sql`((length(reason) >= 1) AND (length(reason) <= 300))`,
      ),
      foreignKey({
        name: 'minibar_shortage_override_room_fkey',
        columns: [table.hotelId, table.roomId],
        foreignColumns: [room.hotelId, room.roomId],
      }).onDelete('restrict'),
      check(
        'minibar_shortage_override_snapshot_has_no_denied_key',
        sql`(NOT platform.contains_denied_key(snapshot))`,
      ),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The one current minibar configuration of a room (`RML-DEC-007`, `INV-DEC-007`,
 * doc 26 §14).
 */
export const roomMinibarConfiguration = platform
  .table(
    'room_minibar_configuration',
    {
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      currentVersionId: uuid('current_version_id'),
      hotelId: uuid('hotel_id').notNull(),
      minibarStatus: text('minibar_status')
        .notNull()
        .default(sql`'NOT_APPLICABLE'::text`),
      mode: text('mode')
        .notNull()
        .default(sql`'OFF'::text`),
      overrideId: uuid('override_id'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      roomId: uuid('room_id').primaryKey().notNull(),
      templateId: uuid('template_id'),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
    },
    (table) => [
      foreignKey({
        name: 'room_minibar_configuration_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'room_minibar_configuration_mode_known',
        sql`(mode = ANY (ARRAY['ON'::text, 'OFF'::text]))`,
      ),
      check(
        'room_minibar_configuration_mode_shape',
        sql`(((mode = 'ON'::text) AND (template_id IS NOT NULL) AND (current_version_id IS NOT NULL) AND (minibar_status <> 'NOT_APPLICABLE'::text)) OR ((mode = 'OFF'::text) AND (template_id IS NULL) AND (current_version_id IS NULL) AND (minibar_status = 'NOT_APPLICABLE'::text) AND (override_id IS NULL)))`,
      ),
      foreignKey({
        name: 'room_minibar_configuration_override_fkey',
        columns: [table.hotelId, table.overrideId],
        foreignColumns: [minibarShortageOverride.hotelId, minibarShortageOverride.overrideId],
      }).onDelete('restrict'),
      check('room_minibar_configuration_revision_non_negative', sql`(revision >= 0)`),
      foreignKey({
        name: 'room_minibar_configuration_room_fkey',
        columns: [table.hotelId, table.roomId],
        foreignColumns: [room.hotelId, room.roomId],
      }).onDelete('restrict'),
      check(
        'room_minibar_configuration_status_known',
        sql`(minibar_status = ANY (ARRAY['FULL'::text, 'SHORT'::text, 'NOT_APPLICABLE'::text, 'UNKNOWN'::text]))`,
      ),
      foreignKey({
        name: 'room_minibar_configuration_template_fkey',
        columns: [table.hotelId, table.templateId],
        foreignColumns: [minibarTemplate.hotelId, minibarTemplate.templateId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'room_minibar_configuration_version_fkey',
        columns: [table.hotelId, table.templateId, table.currentVersionId],
        foreignColumns: [
          minibarTemplateVersion.hotelId,
          minibarTemplateVersion.templateId,
          minibarTemplateVersion.versionId,
        ],
      }).onDelete('restrict'),
      index('room_minibar_configuration_version_idx').on(table.hotelId, table.currentVersionId),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The at-most-one pending change of a room, pinned to an exact target
 * (`RML-DEC-007`…`014`, `RML-DEC-022`…`028`).
 */
export const roomConfigurationChange = platform
  .table(
    'room_configuration_change',
    {
      batchId: uuid('batch_id'),
      blockerDetail: jsonb('blocker_detail')
        .notNull()
        .default(sql`'{}'::jsonb`),
      changeId: uuid('change_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      hotelId: uuid('hotel_id').notNull(),
      kind: text('kind').notNull(),
      movementStarted: boolean('movement_started')
        .notNull()
        .default(sql`false`),
      reason: text('reason'),
      requestedAt: timestamp('requested_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      requestedBy: uuid('requested_by'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      roomId: uuid('room_id').notNull(),
      state: text('state').notNull(),
      targetTemplateId: uuid('target_template_id'),
      targetVersionId: uuid('target_version_id'),
      terminalAt: timestamp('terminal_at', { withTimezone: true }),
    },
    (table) => [
      check(
        'room_configuration_change_detail_has_no_denied_key',
        sql`(NOT platform.contains_denied_key(blocker_detail))`,
      ),
      foreignKey({
        name: 'room_configuration_change_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      unique('room_configuration_change_hotel_scope_uq').on(table.hotelId, table.changeId),
      check(
        'room_configuration_change_kind_known',
        sql`(kind = ANY (ARRAY['ON_TO_OFF'::text, 'OFF_TO_ON'::text, 'TEMPLATE_SWITCH'::text, 'VERSION_ROLLOUT'::text]))`,
      ),
      check(
        'room_configuration_change_reason_bounded',
        sql`((reason IS NULL) OR ((length(reason) >= 1) AND (length(reason) <= 300)))`,
      ),
      check('room_configuration_change_revision_non_negative', sql`(revision >= 0)`),
      foreignKey({
        name: 'room_configuration_change_room_fkey',
        columns: [table.hotelId, table.roomId],
        foreignColumns: [room.hotelId, room.roomId],
      }).onDelete('restrict'),
      check(
        'room_configuration_change_state_known',
        sql`(state = ANY (ARRAY['SCHEDULED_AFTER_STAY'::text, 'READY_FOR_RECONCILIATION'::text, 'IN_PROGRESS'::text, 'BLOCKED_STOCK'::text, 'BLOCKED_VARIANCE'::text, 'APPLIED'::text, 'CANCELLED'::text, 'ROLLBACK_REQUIRED'::text, 'ROLLED_BACK'::text]))`,
      ),
      foreignKey({
        name: 'room_configuration_change_target_fkey',
        columns: [table.hotelId, table.targetTemplateId, table.targetVersionId],
        foreignColumns: [
          minibarTemplateVersion.hotelId,
          minibarTemplateVersion.templateId,
          minibarTemplateVersion.versionId,
        ],
      }).onDelete('restrict'),
      check(
        'room_configuration_change_target_shape',
        sql`(((kind = 'ON_TO_OFF'::text) AND (target_template_id IS NULL) AND (target_version_id IS NULL)) OR ((kind <> 'ON_TO_OFF'::text) AND (target_template_id IS NOT NULL) AND (target_version_id IS NOT NULL)))`,
      ),
      check(
        'room_configuration_change_terminal_has_time',
        sql`((state = ANY (ARRAY['APPLIED'::text, 'CANCELLED'::text, 'ROLLED_BACK'::text])) = (terminal_at IS NOT NULL))`,
      ),
      index('room_configuration_change_batch_idx').on(table.hotelId, table.batchId),
      uniqueIndex('room_configuration_change_one_pending_uq')
        .on(table.hotelId, table.roomId)
        .where(sql`state <> ALL (ARRAY['APPLIED'::text, 'CANCELLED'::text, 'ROLLED_BACK'::text])`),
      index('room_configuration_change_target_idx').on(table.hotelId, table.targetVersionId),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The server-bounded Cleaner task of one configuration change (`RML-DEC-013`,
 * doc 04 §5.3).
 */
export const minibarReconciliationTask = platform
  .table(
    'minibar_reconciliation_task',
    {
      assignedAccountId: uuid('assigned_account_id'),
      bounds: jsonb('bounds').notNull(),
      changeId: uuid('change_id').notNull(),
      claimedAt: timestamp('claimed_at', { withTimezone: true }),
      completedAt: timestamp('completed_at', { withTimezone: true }),
      counted: jsonb('counted'),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      hotelId: uuid('hotel_id').notNull(),
      kind: text('kind').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      roomId: uuid('room_id').notNull(),
      state: text('state')
        .notNull()
        .default(sql`'OPEN'::text`),
      taskId: uuid('task_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
    },
    (table) => [
      check(
        'minibar_reconciliation_task_bounds_has_no_denied_key',
        sql`(NOT platform.contains_denied_key(bounds))`,
      ),
      foreignKey({
        name: 'minibar_reconciliation_task_change_fkey',
        columns: [table.hotelId, table.changeId],
        foreignColumns: [roomConfigurationChange.hotelId, roomConfigurationChange.changeId],
      }).onDelete('restrict'),
      check(
        'minibar_reconciliation_task_claim_shape',
        sql`(((state = 'OPEN'::text) AND (assigned_account_id IS NULL)) OR ((state = ANY (ARRAY['CLAIMED'::text, 'COMPLETED'::text])) AND (assigned_account_id IS NOT NULL)) OR (state = 'CANCELLED'::text))`,
      ),
      check(
        'minibar_reconciliation_task_counted_has_no_denied_key',
        sql`((counted IS NULL) OR (NOT platform.contains_denied_key(counted)))`,
      ),
      foreignKey({
        name: 'minibar_reconciliation_task_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'minibar_reconciliation_task_kind_known',
        sql`(kind = ANY (ARRAY['RECONCILE'::text, 'ROLLBACK'::text]))`,
      ),
      check('minibar_reconciliation_task_revision_non_negative', sql`(revision >= 0)`),
      foreignKey({
        name: 'minibar_reconciliation_task_room_fkey',
        columns: [table.hotelId, table.roomId],
        foreignColumns: [room.hotelId, room.roomId],
      }).onDelete('restrict'),
      check(
        'minibar_reconciliation_task_state_known',
        sql`(state = ANY (ARRAY['OPEN'::text, 'CLAIMED'::text, 'COMPLETED'::text, 'CANCELLED'::text]))`,
      ),
      index('minibar_reconciliation_task_assignee_idx').on(
        table.hotelId,
        table.assignedAccountId,
        table.state,
      ),
      uniqueIndex('minibar_reconciliation_task_one_open_uq')
        .on(table.changeId)
        .where(sql`state = ANY (ARRAY['OPEN'::text, 'CLAIMED'::text])`),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * A multi-room Rollout parent and its exact target; its state is derived from
 * the children on read (`RML-DEC-025`…`028`, doc 26 §36).
 */
export const rolloutBatch = platform
  .table(
    'rollout_batch',
    {
      batchId: uuid('batch_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      createdBy: uuid('created_by'),
      hotelId: uuid('hotel_id').notNull(),
      retryOfBatchId: uuid('retry_of_batch_id'),
      targetVersionId: uuid('target_version_id').notNull(),
      templateId: uuid('template_id').notNull(),
    },
    (table) => [
      foreignKey({
        name: 'rollout_batch_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      unique('rollout_batch_hotel_scope_uq').on(table.hotelId, table.batchId),
      foreignKey({
        name: 'rollout_batch_retry_fkey',
        columns: [table.retryOfBatchId],
        foreignColumns: [table.batchId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'rollout_batch_target_fkey',
        columns: [table.hotelId, table.templateId, table.targetVersionId],
        foreignColumns: [
          minibarTemplateVersion.hotelId,
          minibarTemplateVersion.templateId,
          minibarTemplateVersion.versionId,
        ],
      }).onDelete('restrict'),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * One selected room of a batch and its accepted or skipped result (`RML-DEC-026`).
 */
export const rolloutBatchRoom = platform
  .table(
    'rollout_batch_room',
    {
      batchId: uuid('batch_id').notNull(),
      changeId: uuid('change_id'),
      hotelId: uuid('hotel_id').notNull(),
      reasonCode: text('reason_code'),
      result: text('result').notNull(),
      roomId: uuid('room_id').notNull(),
    },
    (table) => [
      foreignKey({
        name: 'rollout_batch_room_batch_fkey',
        columns: [table.hotelId, table.batchId],
        foreignColumns: [rolloutBatch.hotelId, rolloutBatch.batchId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'rollout_batch_room_change_fkey',
        columns: [table.hotelId, table.changeId],
        foreignColumns: [roomConfigurationChange.hotelId, roomConfigurationChange.changeId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'rollout_batch_room_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      primaryKey({ name: 'rollout_batch_room_pkey', columns: [table.batchId, table.roomId] }),
      check(
        'rollout_batch_room_result_known',
        sql`(result = ANY (ARRAY['ACCEPTED'::text, 'SKIPPED'::text]))`,
      ),
      check(
        'rollout_batch_room_result_shape',
        sql`((result = 'ACCEPTED'::text) = (change_id IS NOT NULL))`,
      ),
      foreignKey({
        name: 'rollout_batch_room_room_fkey',
        columns: [table.hotelId, table.roomId],
        foreignColumns: [room.hotelId, room.roomId],
      }).onDelete('restrict'),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The append-only history of version, configuration, task and batch transitions
 * (doc 22 §11, doc 26 §21).
 */
export const minibarEvent = platform
  .table(
    'minibar_event',
    {
      actorAccountId: uuid('actor_account_id'),
      entityId: uuid('entity_id').notNull(),
      entityType: text('entity_type').notNull(),
      eventId: uuid('event_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      eventType: text('event_type').notNull(),
      fromState: text('from_state'),
      hotelId: uuid('hotel_id').notNull(),
      occurredAt: timestamp('occurred_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      payload: jsonb('payload')
        .notNull()
        .default(sql`'{}'::jsonb`),
      reason: text('reason'),
      toState: text('to_state'),
    },
    (table) => [
      check(
        'minibar_event_entity_type_known',
        sql`(entity_type = ANY (ARRAY['PRODUCT'::text, 'TEMPLATE_VERSION'::text, 'ROOM_CONFIGURATION'::text, 'CONFIGURATION_CHANGE'::text, 'RECONCILIATION_TASK'::text, 'ROLLOUT_BATCH'::text, 'SHORTAGE_OVERRIDE'::text]))`,
      ),
      foreignKey({
        name: 'minibar_event_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'minibar_event_payload_has_no_denied_key',
        sql`(NOT platform.contains_denied_key(payload))`,
      ),
      check(
        'minibar_event_reason_bounded',
        sql`((reason IS NULL) OR ((length(reason) >= 1) AND (length(reason) <= 300)))`,
      ),
      check(
        'minibar_event_type_bounded',
        sql`((length(event_type) >= 1) AND (length(event_type) <= 60))`,
      ),
      index('minibar_event_entity_idx').on(
        table.hotelId,
        table.entityType,
        table.entityId,
        table.occurredAt,
      ),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

// ---------------------------------------------------------------------
// Phase 08 — availability, guest identity, reception, and stay.
// ---------------------------------------------------------------------

/**
 * The operational Reception shift a check-in is confirmed in (doc 05 §19.1).
 * Minimal here; Phase 11 adds the cash count, handover and review.
 */
export const receptionShift = platform
  .table(
    'reception_shift',
    {
      closedAt: timestamp('closed_at', { withTimezone: true }),
      closedByAccountId: uuid('closed_by_account_id'),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      hotelId: uuid('hotel_id').notNull(),
      openedAt: timestamp('opened_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      openedByAccountId: uuid('opened_by_account_id').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      shiftId: uuid('shift_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      state: text('state')
        .notNull()
        .default(sql`'OPEN'::text`),
    },
    (table) => [
      check(
        'reception_shift_closed_after_opened',
        sql`((closed_at IS NULL) OR (closed_at >= opened_at))`,
      ),
      check(
        'reception_shift_closed_shape',
        sql`((state = 'CLOSED'::text) = ((closed_at IS NOT NULL) AND (closed_by_account_id IS NOT NULL)))`,
      ),
      foreignKey({
        name: 'reception_shift_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      unique('reception_shift_hotel_scope_uq').on(table.hotelId, table.shiftId),
      check(
        'reception_shift_state_known',
        sql`(state = ANY (ARRAY['OPEN'::text, 'CLOSED'::text]))`,
      ),
      uniqueIndex('reception_shift_one_open_uq')
        .on(table.hotelId)
        .where(sql`state = 'OPEN'::text`),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The current cleaning axis of a room (doc 06 §4, `STAY-DEC-008`). No row means
 * the room was never marked clean.
 */
export const roomCleaningState = platform
  .table(
    'room_cleaning_state',
    {
      changedAt: timestamp('changed_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      changedByAccountId: uuid('changed_by_account_id'),
      hotelId: uuid('hotel_id').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      roomId: uuid('room_id').primaryKey().notNull(),
      state: text('state').notNull(),
    },
    (table) => [
      foreignKey({
        name: 'room_cleaning_state_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'room_cleaning_state_known',
        sql`(state = ANY (ARRAY['CLEAN'::text, 'NEEDS_CLEANING'::text, 'CLEANING'::text]))`,
      ),
      foreignKey({
        name: 'room_cleaning_state_room_fkey',
        columns: [table.hotelId, table.roomId],
        foreignColumns: [room.hotelId, room.roomId],
      }).onDelete('restrict'),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The append-only cleaning history a backdated check-in proves readiness from
 * (doc 05 §19.2).
 */
export const roomCleaningEvent = platform
  .table(
    'room_cleaning_event',
    {
      actorAccountId: uuid('actor_account_id'),
      eventId: uuid('event_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      fromState: text('from_state'),
      hotelId: uuid('hotel_id').notNull(),
      occurredAt: timestamp('occurred_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      roomId: uuid('room_id').notNull(),
      stayId: uuid('stay_id'),
      toState: text('to_state').notNull(),
    },
    (table) => [
      check(
        'room_cleaning_event_from_state_known',
        sql`((from_state IS NULL) OR (from_state = ANY (ARRAY['CLEAN'::text, 'NEEDS_CLEANING'::text, 'CLEANING'::text])))`,
      ),
      foreignKey({
        name: 'room_cleaning_event_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'room_cleaning_event_room_fkey',
        columns: [table.hotelId, table.roomId],
        foreignColumns: [room.hotelId, room.roomId],
      }).onDelete('restrict'),
      check(
        'room_cleaning_event_to_state_known',
        sql`(to_state = ANY (ARRAY['CLEAN'::text, 'NEEDS_CLEANING'::text, 'CLEANING'::text]))`,
      ),
      index('room_cleaning_event_room_idx').on(table.hotelId, table.roomId, table.occurredAt),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * A stay: immutable times and snapshots, forward-only state, one live stay per
 * room (`STAY-DEC-008`, `-009`, `-011`, `-012`, `-014`).
 */
export const stay = platform
  .table(
    'stay',
    {
      actualCheckInAt: timestamp('actual_check_in_at', { withTimezone: true }).notNull(),
      actualCheckoutAt: timestamp('actual_checkout_at', { withTimezone: true }),
      backdateMinutes: integer('backdate_minutes')
        .notNull()
        .default(sql`0`),
      backdateNote: text('backdate_note'),
      backdateReasonCode: text('backdate_reason_code'),
      bookingRef: uuid('booking_ref'),
      categoryId: uuid('category_id').notNull(),
      checkInRecordedAt: timestamp('check_in_recorded_at', { withTimezone: true }).notNull(),
      checkedInByAccountId: uuid('checked_in_by_account_id').notNull(),
      checkoutRecordedByAccountId: uuid('checkout_recorded_by_account_id'),
      cleaningBufferMinutes: integer('cleaning_buffer_minutes').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      depositRequired: boolean('deposit_required').notNull(),
      durationMinutes: integer('duration_minutes'),
      fixedCheckoutMinute: integer('fixed_checkout_minute'),
      halfHourUnits: integer('half_hour_units'),
      hotelId: uuid('hotel_id').notNull(),
      minibarApplicable: boolean('minibar_applicable')
        .notNull()
        .default(sql`false`),
      nightCount: integer('night_count'),
      plannedCheckoutAt: timestamp('planned_checkout_at', { withTimezone: true }).notNull(),
      pricingConfigVersion: integer('pricing_config_version').notNull(),
      rateSnapshotId: uuid('rate_snapshot_id').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      roomChargeMnt: bigint('room_charge_mnt', { mode: 'bigint' }).notNull(),
      roomId: uuid('room_id').notNull(),
      shiftId: uuid('shift_id').notNull(),
      source: text('source').notNull(),
      state: text('state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
      stayId: uuid('stay_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      stayType: text('stay_type').notNull(),
      unitRateMnt: bigint('unit_rate_mnt', { mode: 'bigint' }).notNull(),
    },
    (table) => [
      check('stay_actual_not_after_recorded', sql`(actual_check_in_at <= check_in_recorded_at)`),
      check(
        'stay_backdate_note_bounded',
        sql`((backdate_note IS NULL) OR ((length(backdate_note) >= 1) AND (length(backdate_note) <= 500)))`,
      ),
      check('stay_backdate_range', sql`((backdate_minutes >= 0) AND (backdate_minutes <= 120))`),
      check(
        'stay_backdate_reason',
        sql`((backdate_minutes > 0) = (backdate_reason_code IS NOT NULL))`,
      ),
      check(
        'stay_backdate_reason_bounded',
        sql`((backdate_reason_code IS NULL) OR ((length(backdate_reason_code) >= 1) AND (length(backdate_reason_code) <= 60)))`,
      ),
      check(
        'stay_buffer_range',
        sql`((cleaning_buffer_minutes >= 0) AND (cleaning_buffer_minutes <= 1440))`,
      ),
      foreignKey({
        name: 'stay_category_fkey',
        columns: [table.hotelId, table.categoryId],
        foreignColumns: [roomCategory.hotelId, roomCategory.categoryId],
      }).onDelete('restrict'),
      check('stay_charge_non_negative', sql`(room_charge_mnt >= 0)`),
      check(
        'stay_checkout_after_check_in',
        sql`((actual_checkout_at IS NULL) OR (actual_checkout_at >= actual_check_in_at))`,
      ),
      check(
        'stay_checkout_recorded_shape',
        sql`((actual_checkout_at IS NULL) = (checkout_recorded_by_account_id IS NULL))`,
      ),
      check(
        'stay_completed_shape',
        sql`((state = 'COMPLETED'::text) = (actual_checkout_at IS NOT NULL))`,
      ),
      check('stay_deposit_by_source', sql`(deposit_required = (source = 'WALK_IN'::text))`),
      foreignKey({
        name: 'stay_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      unique('stay_hotel_scope_uq').on(table.hotelId, table.stayId),
      check(
        'stay_hourly_shape',
        sql`((stay_type <> 'HOURLY'::text) OR ((half_hour_units >= 1) AND (duration_minutes = (half_hour_units * 30)) AND (night_count IS NULL) AND (fixed_checkout_minute IS NULL)))`,
      ),
      check(
        'stay_nightly_shape',
        sql`((stay_type <> 'NIGHTLY'::text) OR ((night_count >= 1) AND ((fixed_checkout_minute >= 0) AND (fixed_checkout_minute <= 1439)) AND (half_hour_units IS NULL) AND (duration_minutes IS NULL)))`,
      ),
      check('stay_planned_after_actual', sql`(planned_checkout_at > actual_check_in_at)`),
      check('stay_rate_non_negative', sql`(unit_rate_mnt >= 0)`),
      foreignKey({
        name: 'stay_rate_snapshot_fkey',
        columns: [table.rateSnapshotId],
        foreignColumns: [stayRateSnapshot.snapshotId],
      }).onDelete('restrict'),
      unique('stay_rate_snapshot_uq').on(table.rateSnapshotId),
      foreignKey({
        name: 'stay_room_fkey',
        columns: [table.hotelId, table.roomId],
        foreignColumns: [room.hotelId, room.roomId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'stay_shift_fkey',
        columns: [table.hotelId, table.shiftId],
        foreignColumns: [receptionShift.hotelId, receptionShift.shiftId],
      }).onDelete('restrict'),
      check('stay_source_known', sql`(source = ANY (ARRAY['WALK_IN'::text, 'ONLINE'::text]))`),
      check('stay_source_shape', sql`((source = 'ONLINE'::text) = (booking_ref IS NOT NULL))`),
      check(
        'stay_state_known',
        sql`(state = ANY (ARRAY['ACTIVE'::text, 'CHECKOUT_IN_PROGRESS'::text, 'COMPLETED'::text]))`,
      ),
      check('stay_type_known', sql`(stay_type = ANY (ARRAY['HOURLY'::text, 'NIGHTLY'::text]))`),
      check('stay_version_positive', sql`(pricing_config_version >= 1)`),
      index('stay_booking_ref_idx')
        .on(table.hotelId, table.bookingRef)
        .where(sql`booking_ref IS NOT NULL`),
      uniqueIndex('stay_one_live_per_room_uq')
        .on(table.hotelId, table.roomId)
        .where(sql`state <> 'COMPLETED'::text`),
      index('stay_room_timeline_idx').on(table.hotelId, table.roomId, table.plannedCheckoutAt),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The primary guest of a stay, in append-only revisions, with the encrypted
 * identifier and its keyed lookup token (`RC-DEC-033`, `RC-DEC-044`).
 */
export const stayGuest = platform
  .table(
    'stay_guest',
    {
      ageAtCheckIn: integer('age_at_check_in'),
      assurance: text('assurance').notNull(),
      correctionReason: text('correction_reason'),
      dateOfBirth: date('date_of_birth').notNull(),
      documentAuthority: text('document_authority'),
      documentCountry: text('document_country'),
      documentExpiresOn: date('document_expires_on'),
      documentType: text('document_type'),
      familyName: text('family_name').notNull(),
      givenName: text('given_name').notNull(),
      guardianName: text('guardian_name'),
      guardianPhone: text('guardian_phone'),
      guardianRelationship: text('guardian_relationship'),
      guestRecordId: uuid('guest_record_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      hotelId: uuid('hotel_id').notNull(),
      identifierCiphertext: bytea('identifier_ciphertext'),
      identifierKeyVersion: text('identifier_key_version'),
      identifierWrappedDek: bytea('identifier_wrapped_dek'),
      identityType: text('identity_type').notNull(),
      isCurrent: boolean('is_current')
        .notNull()
        .default(sql`true`),
      lookupKeyVersion: text('lookup_key_version'),
      lookupNamespace: text('lookup_namespace'),
      lookupToken: text('lookup_token'),
      nationality: text('nationality').notNull(),
      noDocumentNote: text('no_document_note'),
      noDocumentReason: text('no_document_reason'),
      policeMatchEligibility: text('police_match_eligibility').notNull(),
      provenance: text('provenance').notNull(),
      recordedAt: timestamp('recorded_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      recordedByAccountId: uuid('recorded_by_account_id'),
      revisionNo: integer('revision_no')
        .notNull()
        .default(sql`1`),
      stayId: uuid('stay_id').notNull(),
    },
    (table) => [
      check(
        'stay_guest_age_range',
        sql`((age_at_check_in IS NULL) OR ((age_at_check_in >= 0) AND (age_at_check_in <= 130)))`,
      ),
      check(
        'stay_guest_assurance_known',
        sql`(assurance = ANY (ARRAY['DOCUMENT'::text, 'LOW_ASSURANCE'::text]))`,
      ),
      check(
        'stay_guest_correction_reason_bounded',
        sql`((correction_reason IS NULL) OR ((length(correction_reason) >= 1) AND (length(correction_reason) <= 300)))`,
      ),
      check(
        'stay_guest_correction_reason_shape',
        sql`((revision_no = 1) = (correction_reason IS NULL))`,
      ),
      check(
        'stay_guest_document_authority_bounded',
        sql`((document_authority IS NULL) OR ((length(document_authority) >= 1) AND (length(document_authority) <= 120)))`,
      ),
      check(
        'stay_guest_document_country_shape',
        sql`((document_country IS NULL) OR (document_country ~ '^[A-Z]{2}$'::text))`,
      ),
      check(
        'stay_guest_document_type_bounded',
        sql`((document_type IS NULL) OR ((length(document_type) >= 1) AND (length(document_type) <= 60)))`,
      ),
      check(
        'stay_guest_eligibility_by_type',
        sql`((police_match_eligibility <> 'ELIGIBLE_EXACT_RD'::text) OR (identity_type = 'MN_REG_NO'::text))`,
      ),
      check(
        'stay_guest_eligibility_known',
        sql`(police_match_eligibility = ANY (ARRAY['ELIGIBLE_EXACT_RD'::text, 'NOT_ELIGIBLE_EXACT_RD'::text]))`,
      ),
      check(
        'stay_guest_guardian_bounded',
        sql`(((guardian_name IS NULL) OR ((length(guardian_name) >= 1) AND (length(guardian_name) <= 120))) AND ((guardian_phone IS NULL) OR ((length(guardian_phone) >= 4) AND (length(guardian_phone) <= 30))) AND ((guardian_relationship IS NULL) OR ((length(guardian_relationship) >= 1) AND (length(guardian_relationship) <= 60))))`,
      ),
      check(
        'stay_guest_guardian_when_minor',
        sql`((age_at_check_in IS NULL) OR (age_at_check_in >= 18) OR ((guardian_name IS NOT NULL) AND (guardian_phone IS NOT NULL) AND (guardian_relationship IS NOT NULL)))`,
      ),
      foreignKey({
        name: 'stay_guest_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'stay_guest_identifier_shape',
        sql`(((identifier_ciphertext IS NULL) = (identifier_wrapped_dek IS NULL)) AND ((identifier_ciphertext IS NULL) = (identifier_key_version IS NULL)) AND ((identifier_ciphertext IS NULL) = (lookup_token IS NULL)) AND ((lookup_token IS NULL) = (lookup_key_version IS NULL)) AND ((lookup_token IS NULL) = (lookup_namespace IS NULL)))`,
      ),
      check(
        'stay_guest_identity_type_known',
        sql`(identity_type = ANY (ARRAY['MN_REG_NO'::text, 'FOREIGN_PASSPORT'::text, 'OTHER_GOV_ID'::text, 'NO_DOCUMENT'::text]))`,
      ),
      check(
        'stay_guest_names_bounded',
        sql`(((length(family_name) >= 1) AND (length(family_name) <= 120)) AND ((length(given_name) >= 1) AND (length(given_name) <= 120)))`,
      ),
      check('stay_guest_nationality_shape', sql`(nationality ~ '^[A-Z]{2}$'::text)`),
      check(
        'stay_guest_no_document_note_bounded',
        sql`((no_document_note IS NULL) OR ((length(no_document_note) >= 1) AND (length(no_document_note) <= 500)))`,
      ),
      check(
        'stay_guest_no_document_reason_bounded',
        sql`((no_document_reason IS NULL) OR ((length(no_document_reason) >= 1) AND (length(no_document_reason) <= 300)))`,
      ),
      check(
        'stay_guest_no_document_shape',
        sql`((identity_type <> 'NO_DOCUMENT'::text) OR ((identifier_ciphertext IS NULL) AND (no_document_reason IS NOT NULL) AND (assurance = 'LOW_ASSURANCE'::text)))`,
      ),
      check(
        'stay_guest_other_id_shape',
        sql`((identity_type <> 'OTHER_GOV_ID'::text) OR ((identifier_ciphertext IS NOT NULL) AND (document_type IS NOT NULL) AND (document_country IS NOT NULL) AND (document_authority IS NOT NULL) AND (assurance = 'DOCUMENT'::text)))`,
      ),
      check(
        'stay_guest_passport_shape',
        sql`((identity_type <> 'FOREIGN_PASSPORT'::text) OR ((identifier_ciphertext IS NOT NULL) AND (document_country IS NOT NULL) AND (document_expires_on IS NOT NULL) AND (assurance = 'DOCUMENT'::text)))`,
      ),
      check(
        'stay_guest_provenance_known',
        sql`(provenance = ANY (ARRAY['XYP_VERIFIED'::text, 'MANUAL'::text]))`,
      ),
      check(
        'stay_guest_reg_no_shape',
        sql`((identity_type <> 'MN_REG_NO'::text) OR ((identifier_ciphertext IS NOT NULL) AND (document_country = 'MN'::text) AND (assurance = 'DOCUMENT'::text)))`,
      ),
      check('stay_guest_revision_positive', sql`(revision_no >= 1)`),
      unique('stay_guest_revision_uq').on(table.stayId, table.revisionNo),
      foreignKey({
        name: 'stay_guest_stay_fkey',
        columns: [table.hotelId, table.stayId],
        foreignColumns: [stay.hotelId, stay.stayId],
      }).onDelete('restrict'),
      check(
        'stay_guest_xyp_only_for_reg_no',
        sql`((provenance <> 'XYP_VERIFIED'::text) OR (identity_type = 'MN_REG_NO'::text))`,
      ),
      uniqueIndex('stay_guest_current_uq')
        .on(table.stayId)
        .where(sql`is_current IS TRUE`),
      index('stay_guest_lookup_idx')
        .on(table.hotelId, table.lookupToken)
        .where(sql`lookup_token IS NOT NULL`),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The exact template version a check-in pinned for its price book (`PRICE-DEC-001`).
 */
export const stayMinibarSnapshot = platform
  .table(
    'stay_minibar_snapshot',
    {
      hotelId: uuid('hotel_id').notNull(),
      roomId: uuid('room_id').notNull(),
      snapshotAt: timestamp('snapshot_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      stayId: uuid('stay_id').primaryKey().notNull(),
      templateId: uuid('template_id').notNull(),
      versionId: uuid('version_id').notNull(),
    },
    (table) => [
      foreignKey({
        name: 'stay_minibar_snapshot_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'stay_minibar_snapshot_room_fkey',
        columns: [table.hotelId, table.roomId],
        foreignColumns: [room.hotelId, room.roomId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'stay_minibar_snapshot_stay_fkey',
        columns: [table.hotelId, table.stayId],
        foreignColumns: [stay.hotelId, stay.stayId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'stay_minibar_snapshot_version_fkey',
        columns: [table.hotelId, table.templateId, table.versionId],
        foreignColumns: [
          minibarTemplateVersion.hotelId,
          minibarTemplateVersion.templateId,
          minibarTemplateVersion.versionId,
        ],
      }).onDelete('restrict'),
      index('stay_minibar_snapshot_version_idx').on(table.hotelId, table.versionId),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The selling prices a stay is charged, captured at check-in (`PRICE-DEC-001`).
 */
export const stayMinibarPrice = platform
  .table(
    'stay_minibar_price',
    {
      hotelId: uuid('hotel_id').notNull(),
      openingQuantity: integer('opening_quantity').notNull(),
      productCategory: text('product_category'),
      productId: uuid('product_id').notNull(),
      productName: text('product_name').notNull(),
      productUnit: text('product_unit'),
      sellingPriceMnt: bigint('selling_price_mnt', { mode: 'bigint' }).notNull(),
      stayId: uuid('stay_id').notNull(),
      targetQuantity: integer('target_quantity').notNull(),
    },
    (table) => [
      foreignKey({
        name: 'stay_minibar_price_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'stay_minibar_price_name_bounded',
        sql`((length(product_name) >= 1) AND (length(product_name) <= 120))`,
      ),
      check('stay_minibar_price_non_negative', sql`(selling_price_mnt >= 0)`),
      check('stay_minibar_price_opening_non_negative', sql`(opening_quantity >= 0)`),
      primaryKey({ name: 'stay_minibar_price_pkey', columns: [table.stayId, table.productId] }),
      foreignKey({
        name: 'stay_minibar_price_product_fkey',
        columns: [table.hotelId, table.productId],
        foreignColumns: [minibarProduct.hotelId, minibarProduct.productId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'stay_minibar_price_snapshot_fkey',
        columns: [table.stayId],
        foreignColumns: [stayMinibarSnapshot.stayId],
      }).onDelete('restrict'),
      check('stay_minibar_price_target_positive', sql`(target_quantity >= 1)`),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The active-stay actual-time correction: request, fixed bound, decision and the
 * `self_approved` audit flag (`STAY-DEC-010`).
 */
export const stayTimeCorrection = platform
  .table(
    'stay_time_correction',
    {
      correctedActualCheckInAt: timestamp('corrected_actual_check_in_at', {
        withTimezone: true,
      }).notNull(),
      correctionId: uuid('correction_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      decidedAt: timestamp('decided_at', { withTimezone: true }),
      decidedByAccountId: uuid('decided_by_account_id'),
      decisionReason: text('decision_reason'),
      earliestAllowedAt: timestamp('earliest_allowed_at', { withTimezone: true }).notNull(),
      hotelId: uuid('hotel_id').notNull(),
      latestAllowedAt: timestamp('latest_allowed_at', { withTimezone: true }).notNull(),
      previousEffectiveAt: timestamp('previous_effective_at', { withTimezone: true }).notNull(),
      reason: text('reason').notNull(),
      requestedAt: timestamp('requested_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      requestedByAccountId: uuid('requested_by_account_id').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      selfApproved: boolean('self_approved')
        .notNull()
        .default(sql`false`),
      state: text('state')
        .notNull()
        .default(sql`'PENDING'::text`),
      stayId: uuid('stay_id').notNull(),
    },
    (table) => [
      check(
        'stay_time_correction_bound_shape',
        sql`((earliest_allowed_at <= corrected_actual_check_in_at) AND (corrected_actual_check_in_at <= latest_allowed_at))`,
      ),
      check(
        'stay_time_correction_decision_reason_bounded',
        sql`((decision_reason IS NULL) OR ((length(decision_reason) >= 1) AND (length(decision_reason) <= 300)))`,
      ),
      check(
        'stay_time_correction_decision_shape',
        sql`(((state = 'PENDING'::text) = (decided_at IS NULL)) AND ((decided_at IS NULL) = (decided_by_account_id IS NULL)))`,
      ),
      foreignKey({
        name: 'stay_time_correction_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'stay_time_correction_reason_bounded',
        sql`((length(reason) >= 1) AND (length(reason) <= 300))`,
      ),
      check(
        'stay_time_correction_self_approved_shape',
        sql`((self_approved IS FALSE) OR ((decided_by_account_id IS NOT NULL) AND (decided_by_account_id = requested_by_account_id)))`,
      ),
      check(
        'stay_time_correction_state_known',
        sql`(state = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text]))`,
      ),
      foreignKey({
        name: 'stay_time_correction_stay_fkey',
        columns: [table.hotelId, table.stayId],
        foreignColumns: [stay.hotelId, stay.stayId],
      }).onDelete('restrict'),
      uniqueIndex('stay_time_correction_one_pending_uq')
        .on(table.stayId)
        .where(sql`state = 'PENDING'::text`),
      index('stay_time_correction_stay_idx').on(table.hotelId, table.stayId, table.decidedAt),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The overdue conflict of a confirmed booking and its one terminal remedy
 * (`STAY-DEC-013`).
 */
export const bookingFulfillmentConflict = platform
  .table(
    'booking_fulfillment_conflict',
    {
      assignedRoomId: uuid('assigned_room_id'),
      bookingRef: uuid('booking_ref').notNull(),
      categoryId: uuid('category_id').notNull(),
      cleaningBufferMinutes: integer('cleaning_buffer_minutes').notNull(),
      conflictId: uuid('conflict_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      detectedAt: timestamp('detected_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      hotelId: uuid('hotel_id').notNull(),
      overdueStayId: uuid('overdue_stay_id').notNull(),
      plannedCheckinAt: timestamp('planned_checkin_at', { withTimezone: true }).notNull(),
      plannedCheckoutAt: timestamp('planned_checkout_at', { withTimezone: true }).notNull(),
      reason: text('reason'),
      resolvedAt: timestamp('resolved_at', { withTimezone: true }),
      resolvedByAccountId: uuid('resolved_by_account_id'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      roomId: uuid('room_id').notNull(),
      selfApproved: boolean('self_approved')
        .notNull()
        .default(sql`false`),
      state: text('state')
        .notNull()
        .default(sql`'OPEN'::text`),
    },
    (table) => [
      foreignKey({
        name: 'booking_fulfillment_conflict_assigned_room_fkey',
        columns: [table.hotelId, table.assignedRoomId],
        foreignColumns: [room.hotelId, room.roomId],
      }).onDelete('restrict'),
      check(
        'booking_fulfillment_conflict_assignment_shape',
        sql`((state = ANY (ARRAY['RESOLVED_REASSIGNED'::text, 'RESOLVED_HIGHER_CATEGORY'::text])) = (assigned_room_id IS NOT NULL))`,
      ),
      check(
        'booking_fulfillment_conflict_buffer_range',
        sql`((cleaning_buffer_minutes >= 0) AND (cleaning_buffer_minutes <= 1440))`,
      ),
      check(
        'booking_fulfillment_conflict_interval',
        sql`(planned_checkout_at > planned_checkin_at)`,
      ),
      check(
        'booking_fulfillment_conflict_cancel_has_reason',
        sql`((state <> 'CANCELLED_HOTEL'::text) OR (reason IS NOT NULL))`,
      ),
      foreignKey({
        name: 'booking_fulfillment_conflict_category_fkey',
        columns: [table.hotelId, table.categoryId],
        foreignColumns: [roomCategory.hotelId, roomCategory.categoryId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'booking_fulfillment_conflict_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'booking_fulfillment_conflict_reason_bounded',
        sql`((reason IS NULL) OR ((length(reason) >= 1) AND (length(reason) <= 300)))`,
      ),
      check(
        'booking_fulfillment_conflict_resolution_shape',
        sql`((state = 'OPEN'::text) = (resolved_at IS NULL))`,
      ),
      foreignKey({
        name: 'booking_fulfillment_conflict_room_fkey',
        columns: [table.hotelId, table.roomId],
        foreignColumns: [room.hotelId, room.roomId],
      }).onDelete('restrict'),
      check(
        'booking_fulfillment_conflict_state_known',
        sql`(state = ANY (ARRAY['OPEN'::text, 'RESOLVED_READY'::text, 'RESOLVED_REASSIGNED'::text, 'RESOLVED_HIGHER_CATEGORY'::text, 'CANCELLED_HOTEL'::text]))`,
      ),
      foreignKey({
        name: 'booking_fulfillment_conflict_stay_fkey',
        columns: [table.hotelId, table.overdueStayId],
        foreignColumns: [stay.hotelId, stay.stayId],
      }).onDelete('restrict'),
      uniqueIndex('booking_fulfillment_conflict_one_open_uq')
        .on(table.hotelId, table.bookingRef)
        .where(sql`state = 'OPEN'::text`),
      index('booking_fulfillment_conflict_room_idx').on(table.hotelId, table.roomId, table.state),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The append-only stay history (doc 05 §19.3, §20.3).
 */
export const stayEvent = platform
  .table(
    'stay_event',
    {
      actorAccountId: uuid('actor_account_id'),
      eventId: uuid('event_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      eventType: text('event_type').notNull(),
      fromState: text('from_state'),
      hotelId: uuid('hotel_id').notNull(),
      occurredAt: timestamp('occurred_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      payload: jsonb('payload')
        .notNull()
        .default(sql`'{}'::jsonb`),
      reason: text('reason'),
      stayId: uuid('stay_id').notNull(),
      toState: text('to_state'),
    },
    (table) => [
      foreignKey({
        name: 'stay_event_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'stay_event_payload_has_no_denied_key',
        sql`(NOT platform.contains_denied_key(payload))`,
      ),
      check(
        'stay_event_reason_bounded',
        sql`((reason IS NULL) OR ((length(reason) >= 1) AND (length(reason) <= 500)))`,
      ),
      foreignKey({
        name: 'stay_event_stay_fkey',
        columns: [table.hotelId, table.stayId],
        foreignColumns: [stay.hotelId, stay.stayId],
      }).onDelete('restrict'),
      check(
        'stay_event_type_bounded',
        sql`((length(event_type) >= 1) AND (length(event_type) <= 60))`,
      ),
      index('stay_event_stay_idx').on(table.hotelId, table.stayId, table.occurredAt),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/** The kernel tables this declaration covers, for the drift check. */
export const DECLARED_TABLES = [
  idempotencyKey,
  outboxEvent,
  outboxDelivery,
  inboxConsumption,
  providerEvent,
  jobRun,
  exportArtifact,
  projectionCheckpoint,
  externalGate,
  internalGate,
  featureFlag,
  operationalAlert,
  platformEvent,
  securityEvent,
  // Phase 04.
  hotel,
  userAccount,
  accountCredential,
  serverSession,
  staffMembership,
  sessionScopeGrant,
  membershipRoleGrant,
  staffInvitation,
  invitationRequestedRole,
  passwordResetRequest,
  passwordResetIntake,
  accountPermissionGrant,
  workHandoffItem,
  workHandoffEvent,
  workHandoffDiscovery,
  // Phase 05.
  subscriptionOwner,
  onboardingApplication,
  onboardingPhoneVerification,
  onboardingOwnerProof,
  onboardingPaymentAttempt,
  onboardingEvent,
  hotelProfile,
  hotelOwnerLink,
  hotelSubscription,
  subscriptionBillingIntent,
  subscriptionPayment,
  subscriptionEvent,
  ebarimtIssuance,
  cashLocation,
  hotelAdminActivation,
  activationDelivery,
  // Phase 06.
  hotelStayConfiguration,
  roomCategory,
  room,
  minibarProduct,
  minibarTemplate,
  catalogEvent,
  stayRateSnapshot,
  // Phase 07.
  minibarWarehouseStock,
  roomMinibarStock,
  inventoryMovement,
  minibarTemplateVersion,
  minibarTemplateVersionItem,
  minibarShortageOverride,
  roomMinibarConfiguration,
  roomConfigurationChange,
  minibarReconciliationTask,
  rolloutBatch,
  rolloutBatchRoom,
  minibarEvent,
  // Phase 08.
  receptionShift,
  roomCleaningState,
  roomCleaningEvent,
  stay,
  stayGuest,
  stayMinibarSnapshot,
  stayMinibarPrice,
  stayTimeCorrection,
  bookingFulfillmentConflict,
  stayEvent,
] as const;
