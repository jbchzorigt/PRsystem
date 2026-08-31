import {
  bigint,
  boolean,
  check,
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
      sql`(state = ANY (ARRAY['ACTIVE'::text, 'SUSPENDED'::text, 'DISABLED'::text]))`,
    ),
    unique('user_account_principal_uq').on(table.accountId, table.realm, table.realmRole),
    unique('user_account_realm_email_uq').on(table.realm, table.emailNormalized),
    unique('user_account_realm_identity_uq').on(table.accountId, table.realm),
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
        sql`((NOT is_primary_admin) OR (state = 'ACTIVE'::text))`,
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
] as const;
