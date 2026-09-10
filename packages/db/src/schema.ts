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
 * `time without time zone`, which is what a restaurant's ordering window is:
 * a wall-clock reading in the hotel's own timezone, not an instant.
 *
 * Drizzle's built-in `time()` reports its type as `time`, and the comparator
 * reads `time without time zone` back from the catalogue — the same name in two
 * spellings is a difference it cannot be asked to ignore, so the column states
 * the catalogue's spelling itself.
 */
const wallTime = customType<{ data: string }>({
  dataType: () => 'time without time zone',
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
/**
 * Phase 18. Empty since the kernel and declared here now that it holds rows:
 * the wanted people, their cases, and the matches those two produce. Nothing in
 * it carries a `hotel_id`, which is why its isolation is the realm rather than
 * the tenant.
 */
export const policeSchema = pgSchema('police');

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
      pgPolicy('police_matcher_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(event_type = 'stay.checked_in'::text)`,
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
      pgPolicy('police_matcher_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(consumer = 'police.matcher'::text)`,
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
      pgPolicy('public_listing_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(EXISTS ( SELECT 1
   FROM platform.hotel_profile p
  WHERE ((p.hotel_id = hotel.hotel_id) AND (p.listing_state = 'PUBLISHED'::text))))`,
      }),
      pgPolicy('police_hotel_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`true`,
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
    emailNormalized: text('email_normalized'),
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
      'user_account_email_required_outside_guest',
      sql`((email_normalized IS NOT NULL) OR (realm = 'guest'::text))`,
    ),
    check(
      'user_account_realm_known',
      sql`(realm = ANY (ARRAY['hotel'::text, 'guest'::text, 'operation'::text, 'police'::text]))`,
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
    pgPolicy('police_account_read', {
      for: 'select',
      to: ['prsystem_maintenance_fn'],
      using: sql`(realm = 'police'::text)`,
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
      sql`(realm = ANY (ARRAY['hotel'::text, 'guest'::text, 'operation'::text, 'police'::text]))`,
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
      pgPolicy('operation_suspension_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`true`,
      }),
      pgPolicy('operation_suspension_write', {
        for: 'update',
        to: ['prsystem_maintenance_fn'],
        using: sql`true`,
        withCheck: sql`true`,
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
      pgPolicy('operation_suspension_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`true`,
      }),
      pgPolicy('operation_suspension_write', {
        for: 'update',
        to: ['prsystem_maintenance_fn'],
        using: sql`true`,
        withCheck: sql`true`,
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
      sql`(initiated_by = ANY (ARRAY['self'::text, 'hotel_admin'::text, 'operation'::text]))`,
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
      sql`(initiated_by = ANY (ARRAY['self'::text, 'hotel_admin'::text, 'operation'::text]))`,
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
    WHEN 'POLICE_ADMIN'::text THEN (permission = ANY (ARRAY['FALSE_MATCH_APPROVE'::text, 'FOUND_CORRECTION_APPROVE'::text, 'WANTED_CASE_CREATE'::text, 'WANTED_CASE_EXPORT'::text, 'WANTED_CASE_STATE_MANAGE'::text, 'WANTED_EXPORT_FULL_IDENTIFIER'::text, 'WANTED_IDENTITY_APPROVE'::text]))
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
      reconciliationReference: text('reconciliation_reference'),
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
        sql`(num_nonnulls(reconciliation_outcome, reconciled_by_account_id, reconciled_at, reconciliation_reason, reconciliation_reference) = ANY (ARRAY[0, 5]))`,
      ),
      check(
        'onboarding_payment_attempt_reconciliation_evidence_bounded',
        sql`(((reconciliation_reference IS NULL) OR ((length(reconciliation_reference) >= 3) AND (length(reconciliation_reference) <= 120))) AND ((reconciliation_reason IS NULL) OR ((length(reconciliation_reason) >= 10) AND (length(reconciliation_reason) <= 1000))))`,
      ),
      check(
        'onboarding_payment_attempt_reconciliation_outcome_known',
        sql`((reconciliation_outcome IS NULL) OR (reconciliation_outcome = ANY (ARRAY['PROVIDER_STATUS_CORRECTED_NOT_PAID'::text, 'DUPLICATE_OR_SYSTEM_PAYMENT_EXTERNAL_REVERSAL'::text, 'CHARGEBACK_LINKED'::text, 'FINANCE_EXCEPTION_CLOSED'::text])))`,
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
      pgPolicy('public_listing_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(listing_state = 'PUBLISHED'::text)`,
      }),
      pgPolicy('police_hotel_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`true`,
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
      pgPolicy('operation_dashboard_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`true`,
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
      pgPolicy('operation_review', {
        using: sql`(platform.current_realm() = 'operation'::text)`,
        withCheck: sql`(platform.current_realm() = 'operation'::text)`,
      }),
      pgPolicy('operation_dashboard_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`true`,
      }),
      pgPolicy('public_listing_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(EXISTS ( SELECT 1
   FROM platform.hotel_profile p
  WHERE ((p.hotel_id = hotel_subscription.hotel_id) AND (p.listing_state = 'PUBLISHED'::text))))`,
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
      reconciliationReference: text('reconciliation_reference'),
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
        sql`(num_nonnulls(reconciliation_outcome, reconciled_by_account_id, reconciled_at, reconciliation_reason, reconciliation_reference) = ANY (ARRAY[0, 5]))`,
      ),
      check(
        'subscription_billing_intent_reconciliation_evidence_bounded',
        sql`(((reconciliation_reference IS NULL) OR ((length(reconciliation_reference) >= 3) AND (length(reconciliation_reference) <= 120))) AND ((reconciliation_reason IS NULL) OR ((length(reconciliation_reason) >= 10) AND (length(reconciliation_reason) <= 1000))))`,
      ),
      check(
        'subscription_billing_intent_reconciliation_outcome_known',
        sql`((reconciliation_outcome IS NULL) OR (reconciliation_outcome = ANY (ARRAY['PROVIDER_STATUS_CORRECTED_NOT_PAID'::text, 'DUPLICATE_OR_SYSTEM_PAYMENT_EXTERNAL_REVERSAL'::text, 'CHARGEBACK_LINKED'::text, 'FINANCE_EXCEPTION_CLOSED'::text])))`,
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

/**
 * A hotel's physical cash locations: the drawers a Reception works from and the
 * optional safe (doc 24 §2). Provisioned with the hotel; Phase 11 adds the
 * float a drawer is expected to hold.
 */
export const cashLocation = platform
  .table(
    'cash_location',
    {
      cashLocationId: uuid('cash_location_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      code: text('code').notNull(),
      configuredFloatMnt: bigint('configured_float_mnt', { mode: 'bigint' }),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      createdByAccountId: uuid('created_by_account_id'),
      hotelId: uuid('hotel_id').notNull(),
      isDefaultDrawer: boolean('is_default_drawer')
        .notNull()
        .default(sql`false`),
      kind: text('kind').notNull(),
      name: text('name').notNull(),
      physicalLocation: text('physical_location'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
    },
    (table) => [
      unique('cash_location_code_uq').on(table.hotelId, table.code),
      check(
        'cash_location_default_is_a_drawer',
        sql`((NOT is_default_drawer) OR (kind = 'DRAWER'::text))`,
      ),
      check(
        'cash_location_default_is_active',
        sql`((NOT is_default_drawer) OR (state = 'ACTIVE'::text))`,
      ),
      check(
        'cash_location_float_shape',
        sql`((configured_float_mnt IS NULL) OR ((kind = 'DRAWER'::text) AND (configured_float_mnt >= 0)))`,
      ),
      foreignKey({
        name: 'cash_location_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check('cash_location_kind_known', sql`(kind = ANY (ARRAY['DRAWER'::text, 'SAFE'::text]))`),
      check('cash_location_name_bounded', sql`((length(name) >= 1) AND (length(name) <= 100))`),
      unique('cash_location_name_uq').on(table.hotelId, table.name),
      check(
        'cash_location_physical_bounded',
        sql`((physical_location IS NULL) OR ((length(physical_location) >= 1) AND (length(physical_location) <= 200)))`,
      ),
      check('cash_location_revision_non_negative', sql`(revision >= 0)`),
      unique('cash_location_scope_uq').on(table.hotelId, table.cashLocationId),
      check(
        'cash_location_state_known',
        sql`(state = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text]))`,
      ),
      uniqueIndex('cash_location_default_drawer_uq')
        .on(table.hotelId)
        .where(sql`is_default_drawer IS TRUE`),
      uniqueIndex('cash_location_one_safe_uq')
        .on(table.hotelId)
        .where(sql`kind = 'SAFE'::text`),
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
      pgPolicy('operation_dashboard_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`true`,
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
      pgPolicy('public_listing_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(EXISTS ( SELECT 1
   FROM platform.hotel_profile p
  WHERE ((p.hotel_id = room_category.hotel_id) AND (p.listing_state = 'PUBLISHED'::text))))`,
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
      pgPolicy('public_listing_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(EXISTS ( SELECT 1
   FROM platform.hotel_profile p
  WHERE ((p.hotel_id = room.hotel_id) AND (p.listing_state = 'PUBLISHED'::text))))`,
      }),
      pgPolicy('police_room_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`true`,
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
      pgPolicy('public_availability_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(EXISTS ( SELECT 1
   FROM platform.hotel_profile p
  WHERE ((p.hotel_id = room_configuration_change.hotel_id) AND (p.listing_state = 'PUBLISHED'::text))))`,
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
 * The Reception shift: the bound a check-in needs (Phase 08) and the unit of
 * cash accountability over one drawer (Phase 11). Its operational state and
 * its financial review are separate axes (`SHIFT-DEC-001`).
 */
export const receptionShift = platform
  .table(
    'reception_shift',
    {
      closeReason: text('close_reason'),
      closedAt: timestamp('closed_at', { withTimezone: true }),
      closedByAccountId: uuid('closed_by_account_id'),
      countedCashMnt: bigint('counted_cash_mnt', { mode: 'bigint' }),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      expectedCashMnt: bigint('expected_cash_mnt', { mode: 'bigint' }),
      handedToAccountId: uuid('handed_to_account_id'),
      hotelId: uuid('hotel_id').notNull(),
      incomingCountedMnt: bigint('incoming_counted_mnt', { mode: 'bigint' }),
      locationId: uuid('location_id'),
      openedAt: timestamp('opened_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      openedByAccountId: uuid('opened_by_account_id').notNull(),
      openingBalanceMnt: bigint('opening_balance_mnt', { mode: 'bigint' }),
      reviewReason: text('review_reason'),
      reviewState: text('review_state')
        .notNull()
        .default(sql`'NOT_REQUIRED'::text`),
      reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
      reviewedByAccountId: uuid('reviewed_by_account_id'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      selfReviewed: boolean('self_reviewed')
        .notNull()
        .default(sql`false`),
      shiftId: uuid('shift_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      state: text('state')
        .notNull()
        .default(sql`'OPEN'::text`),
      varianceMnt: bigint('variance_mnt', { mode: 'bigint' }),
    },
    (table) => [
      check(
        'reception_shift_closed_after_opened',
        sql`((closed_at IS NULL) OR (closed_at >= opened_at))`,
      ),
      check(
        'reception_shift_closed_shape',
        sql`((state = ANY (ARRAY['SELF_CLOSED'::text, 'CLOSED'::text])) = ((closed_at IS NOT NULL) AND (closed_by_account_id IS NOT NULL)))`,
      ),
      check(
        'reception_shift_counted_non_negative',
        sql`(((counted_cash_mnt IS NULL) OR (counted_cash_mnt >= 0)) AND ((incoming_counted_mnt IS NULL) OR (incoming_counted_mnt >= 0)))`,
      ),
      foreignKey({
        name: 'reception_shift_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      unique('reception_shift_hotel_scope_uq').on(table.hotelId, table.shiftId),
      foreignKey({
        name: 'reception_shift_location_fkey',
        columns: [table.hotelId, table.locationId],
        foreignColumns: [cashLocation.hotelId, cashLocation.cashLocationId],
      }).onDelete('restrict'),
      check(
        'reception_shift_opening_non_negative',
        sql`((opening_balance_mnt IS NULL) OR (opening_balance_mnt >= 0))`,
      ),
      check(
        'reception_shift_reason_bounded',
        sql`(((review_reason IS NULL) OR ((length(review_reason) >= 1) AND (length(review_reason) <= 300))) AND ((close_reason IS NULL) OR ((length(close_reason) >= 1) AND (length(close_reason) <= 300))))`,
      ),
      check(
        'reception_shift_review_shape',
        sql`((reviewed_at IS NULL) = (reviewed_by_account_id IS NULL))`,
      ),
      check(
        'reception_shift_review_state_known',
        sql`(review_state = ANY (ARRAY['NOT_REQUIRED'::text, 'PENDING_MANAGER'::text, 'PENDING_HOTEL_ADMIN'::text, 'DISPUTED'::text, 'RESOLVED'::text]))`,
      ),
      check(
        'reception_shift_state_known',
        sql`(state = ANY (ARRAY['OPEN'::text, 'CLOSING'::text, 'HANDED_OVER'::text, 'RECOUNT_REQUIRED'::text, 'CASH_ACCEPTED'::text, 'SELF_CLOSED'::text, 'CLOSED'::text]))`,
      ),
      check(
        'reception_shift_variance_shape',
        sql`(((counted_cash_mnt IS NULL) AND (expected_cash_mnt IS NULL) AND (variance_mnt IS NULL)) OR ((counted_cash_mnt IS NOT NULL) AND (expected_cash_mnt IS NOT NULL) AND (variance_mnt = (counted_cash_mnt - expected_cash_mnt))))`,
      ),
      uniqueIndex('reception_shift_one_active_per_account_uq')
        .on(table.hotelId, table.openedByAccountId)
        .where(sql`state <> ALL (ARRAY['SELF_CLOSED'::text, 'CLOSED'::text])`),
      uniqueIndex('reception_shift_one_active_per_drawer_uq')
        .on(table.hotelId, table.locationId)
        .where(sql`state <> ALL (ARRAY['SELF_CLOSED'::text, 'CLOSED'::text])`),
      index('reception_shift_review_idx').on(table.hotelId, table.reviewState, table.openedAt),
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
      bookingRef: text('booking_ref'),
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
      fulfilledBookingId: uuid('fulfilled_booking_id'),
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
      check(
        'stay_booking_ref_shape',
        sql`((booking_ref IS NULL) OR (booking_ref ~ '^[A-Z0-9]{8,12}$'::text))`,
      ),
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
      foreignKey({
        name: 'stay_booking_fkey',
        columns: [table.hotelId, table.fulfilledBookingId],
        foreignColumns: [booking.hotelId, booking.bookingId],
      }).onDelete('restrict'),
      uniqueIndex('stay_fulfilled_booking_uq')
        .on(table.fulfilledBookingId)
        .where(sql`fulfilled_booking_id IS NOT NULL`),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
      pgPolicy('public_availability_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(EXISTS ( SELECT 1
   FROM platform.hotel_profile p
  WHERE ((p.hotel_id = stay.hotel_id) AND (p.listing_state = 'PUBLISHED'::text))))`,
      }),
      pgPolicy('police_stay_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`true`,
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
      pgPolicy('police_guest_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(is_current IS TRUE)`,
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
      pgPolicy('police_correction_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(state = 'APPROVED'::text)`,
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
      bookingRef: text('booking_ref').notNull(),
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
        'booking_fulfillment_conflict_booking_ref_shape',
        sql`(booking_ref ~ '^[A-Z0-9]{8,12}$'::text)`,
      ),
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

// ---------------------------------------------------------------------
// Phase 09 — Cleaner and checkout coordination.
// ---------------------------------------------------------------------

/**
 * The Cleaner's unit of cleaning work over a room whose checkout is done
 * (doc 04 §3, §8). The cleaning axis itself stays on `room_cleaning_state`.
 */
export const cleaningTask = platform
  .table(
    'cleaning_task',
    {
      claimedAt: timestamp('claimed_at', { withTimezone: true }),
      claimedByAccountId: uuid('claimed_by_account_id'),
      completedAt: timestamp('completed_at', { withTimezone: true }),
      hotelId: uuid('hotel_id').notNull(),
      kind: text('kind')
        .notNull()
        .default(sql`'CHECKOUT_CLEANING'::text`),
      openedAt: timestamp('opened_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      reason: text('reason'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      roomId: uuid('room_id').notNull(),
      state: text('state')
        .notNull()
        .default(sql`'PENDING'::text`),
      stayId: uuid('stay_id'),
      taskId: uuid('task_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
    },
    (table) => [
      check(
        'cleaning_task_cancel_shape',
        sql`((state <> 'CANCELLED'::text) OR (reason IS NOT NULL))`,
      ),
      check(
        'cleaning_task_claim_shape',
        sql`(((state = 'PENDING'::text) = (claimed_by_account_id IS NULL)) AND ((claimed_by_account_id IS NULL) = (claimed_at IS NULL)))`,
      ),
      check(
        'cleaning_task_completion_shape',
        sql`((state = 'COMPLETED'::text) = (completed_at IS NOT NULL))`,
      ),
      foreignKey({
        name: 'cleaning_task_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check('cleaning_task_kind_known', sql`(kind = 'CHECKOUT_CLEANING'::text)`),
      check(
        'cleaning_task_reason_bounded',
        sql`((reason IS NULL) OR ((length(reason) >= 1) AND (length(reason) <= 300)))`,
      ),
      check('cleaning_task_revision_non_negative', sql`(revision >= 0)`),
      foreignKey({
        name: 'cleaning_task_room_fkey',
        columns: [table.hotelId, table.roomId],
        foreignColumns: [room.hotelId, room.roomId],
      }).onDelete('restrict'),
      check(
        'cleaning_task_state_known',
        sql`(state = ANY (ARRAY['PENDING'::text, 'IN_PROGRESS'::text, 'COMPLETED'::text, 'CANCELLED'::text]))`,
      ),
      foreignKey({
        name: 'cleaning_task_stay_fkey',
        columns: [table.hotelId, table.stayId],
        foreignColumns: [stay.hotelId, stay.stayId],
      }).onDelete('restrict'),
      uniqueIndex('cleaning_task_one_open_uq')
        .on(table.hotelId, table.roomId)
        .where(sql`state = ANY (ARRAY['PENDING'::text, 'IN_PROGRESS'::text])`),
      index('cleaning_task_room_idx').on(table.hotelId, table.roomId, table.state),
      index('cleaning_task_stay_idx').on(table.hotelId, table.stayId),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The minibar usage report a minibar-enabled checkout cannot close without
 * (`CHK-DEC-001`). It points at the version that is current; the versions are
 * the history.
 */
export const minibarUsageReport = platform
  .table(
    'minibar_usage_report',
    {
      claimedAt: timestamp('claimed_at', { withTimezone: true }),
      claimedByAccountId: uuid('claimed_by_account_id'),
      hotelId: uuid('hotel_id').notNull(),
      openedAt: timestamp('opened_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      reason: text('reason'),
      reportId: uuid('report_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      roomId: uuid('room_id').notNull(),
      settledAt: timestamp('settled_at', { withTimezone: true }),
      state: text('state')
        .notNull()
        .default(sql`'PENDING'::text`),
      stayId: uuid('stay_id').notNull(),
    },
    (table) => [
      check(
        'minibar_usage_report_cancel_shape',
        sql`((state <> 'CANCELLED'::text) OR (reason IS NOT NULL))`,
      ),
      check(
        'minibar_usage_report_claim_shape',
        sql`((claimed_by_account_id IS NULL) = (claimed_at IS NULL))`,
      ),
      foreignKey({
        name: 'minibar_usage_report_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'minibar_usage_report_reason_bounded',
        sql`((reason IS NULL) OR ((length(reason) >= 1) AND (length(reason) <= 300)))`,
      ),
      check('minibar_usage_report_revision_non_negative', sql`(revision >= 0)`),
      foreignKey({
        name: 'minibar_usage_report_room_fkey',
        columns: [table.hotelId, table.roomId],
        foreignColumns: [room.hotelId, room.roomId],
      }).onDelete('restrict'),
      check(
        'minibar_usage_report_settled_shape',
        sql`((state = 'SETTLED'::text) = (settled_at IS NOT NULL))`,
      ),
      check(
        'minibar_usage_report_state_known',
        sql`(state = ANY (ARRAY['PENDING'::text, 'IN_INSPECTION'::text, 'SUBMITTED'::text, 'RETURNED'::text, 'LOCKED'::text, 'SETTLED'::text, 'CANCELLED'::text]))`,
      ),
      foreignKey({
        name: 'minibar_usage_report_stay_fkey',
        columns: [table.hotelId, table.stayId],
        foreignColumns: [stay.hotelId, stay.stayId],
      }).onDelete('restrict'),
      uniqueIndex('minibar_usage_report_one_live_uq')
        .on(table.hotelId, table.stayId)
        .where(sql`state <> ALL (ARRAY['SETTLED'::text, 'CANCELLED'::text])`),
      index('minibar_usage_report_room_idx').on(table.hotelId, table.roomId, table.state),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * One immutable version of a usage report - the Cleaner's normal one or a
 * Manager's exception one, with the reason it was needed (`CHK-DEC-002`,
 * `-003`).
 */
export const minibarUsageReportVersion = platform
  .table(
    'minibar_usage_report_version',
    {
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      cutoffAt: timestamp('cutoff_at', { withTimezone: true }).notNull(),
      hotelId: uuid('hotel_id').notNull(),
      kind: text('kind').notNull(),
      noUsage: boolean('no_usage')
        .notNull()
        .default(sql`false`),
      reason: text('reason'),
      reportId: uuid('report_id').notNull(),
      submittedByAccountId: uuid('submitted_by_account_id').notNull(),
      submittedRole: text('submitted_role').notNull(),
      totalMnt: bigint('total_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      versionId: uuid('version_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      versionNo: integer('version_no').notNull(),
    },
    (table) => [
      check(
        'minibar_usage_report_version_exception_shape',
        sql`((kind <> 'EXCEPTION'::text) OR ((submitted_role = ANY (ARRAY['MANAGER'::text, 'MANAGER_PLUS'::text])) AND (reason IS NOT NULL)))`,
      ),
      foreignKey({
        name: 'minibar_usage_report_version_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'minibar_usage_report_version_kind_known',
        sql`(kind = ANY (ARRAY['NORMAL'::text, 'EXCEPTION'::text]))`,
      ),
      check('minibar_usage_report_version_no_positive', sql`(version_no >= 1)`),
      unique('minibar_usage_report_version_no_uq').on(table.reportId, table.versionNo),
      check(
        'minibar_usage_report_version_no_usage_shape',
        sql`((NOT no_usage) OR (total_mnt = 0))`,
      ),
      check(
        'minibar_usage_report_version_normal_shape',
        sql`((kind <> 'NORMAL'::text) OR (submitted_role = 'CLEANER'::text))`,
      ),
      check(
        'minibar_usage_report_version_reason_bounded',
        sql`((reason IS NULL) OR ((length(reason) >= 1) AND (length(reason) <= 300)))`,
      ),
      foreignKey({
        name: 'minibar_usage_report_version_report_fkey',
        columns: [table.reportId],
        foreignColumns: [minibarUsageReport.reportId],
      }).onDelete('restrict'),
      check(
        'minibar_usage_report_version_role_known',
        sql`(submitted_role = ANY (ARRAY['CLEANER'::text, 'MANAGER'::text, 'MANAGER_PLUS'::text]))`,
      ),
      check('minibar_usage_report_version_total_non_negative', sql`(total_mnt >= 0)`),
      index('minibar_usage_report_version_report_idx').on(
        table.hotelId,
        table.reportId,
        table.versionNo,
      ),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * A priced line of a version: the documented billable-quantity formula and the
 * stay's own snapshot price, both held by the database (doc 22 §8,
 * `PRICE-DEC-005`, `-006`, `-007`).
 */
export const minibarUsageReportLine = platform
  .table(
    'minibar_usage_report_line',
    {
      billableQuantity: integer('billable_quantity').notNull(),
      countedQuantity: integer('counted_quantity').notNull(),
      hotelId: uuid('hotel_id').notNull(),
      lineId: uuid('line_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      lineTotalMnt: bigint('line_total_mnt', { mode: 'bigint' }).notNull(),
      nonGuestOutQuantity: integer('non_guest_out_quantity')
        .notNull()
        .default(sql`0`),
      openingQuantity: integer('opening_quantity').notNull(),
      productId: uuid('product_id').notNull(),
      productName: text('product_name').notNull(),
      refillQuantity: integer('refill_quantity')
        .notNull()
        .default(sql`0`),
      stayId: uuid('stay_id').notNull(),
      unitPriceMnt: bigint('unit_price_mnt', { mode: 'bigint' }).notNull(),
      versionId: uuid('version_id').notNull(),
    },
    (table) => [
      check(
        'minibar_usage_report_line_billable_formula',
        sql`(billable_quantity = GREATEST(0, (((opening_quantity + refill_quantity) - non_guest_out_quantity) - counted_quantity)))`,
      ),
      foreignKey({
        name: 'minibar_usage_report_line_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'minibar_usage_report_line_name_bounded',
        sql`((length(product_name) >= 1) AND (length(product_name) <= 120))`,
      ),
      foreignKey({
        name: 'minibar_usage_report_line_price_book_fkey',
        columns: [table.stayId, table.productId],
        foreignColumns: [stayMinibarPrice.stayId, stayMinibarPrice.productId],
      }).onDelete('restrict'),
      check('minibar_usage_report_line_price_non_negative', sql`(unit_price_mnt >= 0)`),
      unique('minibar_usage_report_line_product_uq').on(table.versionId, table.productId),
      check(
        'minibar_usage_report_line_quantities_non_negative',
        sql`((opening_quantity >= 0) AND (refill_quantity >= 0) AND (non_guest_out_quantity >= 0) AND (counted_quantity >= 0) AND (billable_quantity >= 0))`,
      ),
      check(
        'minibar_usage_report_line_total_formula',
        sql`(line_total_mnt = (unit_price_mnt * billable_quantity))`,
      ),
      foreignKey({
        name: 'minibar_usage_report_line_version_fkey',
        columns: [table.versionId],
        foreignColumns: [minibarUsageReportVersion.versionId],
      }).onDelete('restrict'),
      index('minibar_usage_report_line_version_idx').on(table.hotelId, table.versionId),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The refill and non-guest movements a version counted, so its arithmetic can
 * be read back from the ledger (doc 22 §8).
 */
export const minibarUsageReportMovement = platform
  .table(
    'minibar_usage_report_movement',
    {
      hotelId: uuid('hotel_id').notNull(),
      movementId: uuid('movement_id').notNull(),
      role: text('role').notNull(),
      versionId: uuid('version_id').notNull(),
    },
    (table) => [
      foreignKey({
        name: 'minibar_usage_report_movement_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'minibar_usage_report_movement_movement_fkey',
        columns: [table.movementId],
        foreignColumns: [inventoryMovement.movementId],
      }).onDelete('restrict'),
      primaryKey({
        name: 'minibar_usage_report_movement_pkey',
        columns: [table.versionId, table.movementId],
      }),
      check(
        'minibar_usage_report_movement_role_known',
        sql`(role = ANY (ARRAY['REFILL'::text, 'NON_GUEST_OUT'::text]))`,
      ),
      foreignKey({
        name: 'minibar_usage_report_movement_version_fkey',
        columns: [table.versionId],
        foreignColumns: [minibarUsageReportVersion.versionId],
      }).onDelete('restrict'),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * A guest's disputed line: Reception notes it, a Manager upholds or waives it,
 * and the settlement waits for that decision (`CHK-DEC-006`).
 */
export const minibarReportDispute = platform
  .table(
    'minibar_report_dispute',
    {
      disputeId: uuid('dispute_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      disputedQuantity: integer('disputed_quantity').notNull(),
      hotelId: uuid('hotel_id').notNull(),
      note: text('note').notNull(),
      notedAt: timestamp('noted_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      notedByAccountId: uuid('noted_by_account_id').notNull(),
      productId: uuid('product_id').notNull(),
      reportId: uuid('report_id').notNull(),
      resolutionReason: text('resolution_reason'),
      resolvedAt: timestamp('resolved_at', { withTimezone: true }),
      resolvedByAccountId: uuid('resolved_by_account_id'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'OPEN'::text`),
      versionId: uuid('version_id').notNull(),
      waivedAmountMnt: bigint('waived_amount_mnt', { mode: 'bigint' }),
    },
    (table) => [
      foreignKey({
        name: 'minibar_report_dispute_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'minibar_report_dispute_note_bounded',
        sql`((length(note) >= 1) AND (length(note) <= 300))`,
      ),
      foreignKey({
        name: 'minibar_report_dispute_product_fkey',
        columns: [table.hotelId, table.productId],
        foreignColumns: [minibarProduct.hotelId, minibarProduct.productId],
      }).onDelete('restrict'),
      check('minibar_report_dispute_quantity_positive', sql`(disputed_quantity > 0)`),
      check(
        'minibar_report_dispute_reason_bounded',
        sql`((resolution_reason IS NULL) OR ((length(resolution_reason) >= 1) AND (length(resolution_reason) <= 300)))`,
      ),
      foreignKey({
        name: 'minibar_report_dispute_report_fkey',
        columns: [table.reportId],
        foreignColumns: [minibarUsageReport.reportId],
      }).onDelete('restrict'),
      check(
        'minibar_report_dispute_resolution_shape',
        sql`(((state = 'OPEN'::text) = (resolved_at IS NULL)) AND ((resolved_at IS NULL) = (resolved_by_account_id IS NULL)) AND ((resolved_at IS NULL) = (resolution_reason IS NULL)))`,
      ),
      check('minibar_report_dispute_revision_non_negative', sql`(revision >= 0)`),
      check(
        'minibar_report_dispute_state_known',
        sql`(state = ANY (ARRAY['OPEN'::text, 'UPHELD'::text, 'WAIVED'::text]))`,
      ),
      foreignKey({
        name: 'minibar_report_dispute_version_fkey',
        columns: [table.versionId],
        foreignColumns: [minibarUsageReportVersion.versionId],
      }).onDelete('restrict'),
      check(
        'minibar_report_dispute_waiver_non_negative',
        sql`((waived_amount_mnt IS NULL) OR (waived_amount_mnt >= 0))`,
      ),
      check(
        'minibar_report_dispute_waiver_shape',
        sql`((state = 'WAIVED'::text) = (waived_amount_mnt IS NOT NULL))`,
      ),
      index('minibar_report_dispute_report_idx').on(table.hotelId, table.reportId, table.state),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The lock a payment attempt puts on the exact version it charges. One version
 * backs one successful charge, and a pending or unknown provider status keeps
 * the hold (`CHK-DEC-004`).
 */
export const minibarPaymentLock = platform
  .table(
    'minibar_payment_lock',
    {
      amountMnt: bigint('amount_mnt', { mode: 'bigint' }).notNull(),
      attemptRef: text('attempt_ref').notNull(),
      hotelId: uuid('hotel_id').notNull(),
      lockId: uuid('lock_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      lockedAt: timestamp('locked_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      lockedByAccountId: uuid('locked_by_account_id').notNull(),
      providerStatus: text('provider_status'),
      reportId: uuid('report_id').notNull(),
      resolvedAt: timestamp('resolved_at', { withTimezone: true }),
      resolvedByAccountId: uuid('resolved_by_account_id'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'HELD'::text`),
      versionId: uuid('version_id').notNull(),
    },
    (table) => [
      check('minibar_payment_lock_amount_non_negative', sql`(amount_mnt >= 0)`),
      check(
        'minibar_payment_lock_attempt_bounded',
        sql`((length(attempt_ref) >= 1) AND (length(attempt_ref) <= 120))`,
      ),
      unique('minibar_payment_lock_attempt_uq').on(table.hotelId, table.attemptRef),
      foreignKey({
        name: 'minibar_payment_lock_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'minibar_payment_lock_provider_status_known',
        sql`((provider_status IS NULL) OR (provider_status = ANY (ARRAY['PENDING'::text, 'UNKNOWN'::text, 'FAILED_NO_FUNDS'::text, 'SUCCEEDED'::text])))`,
      ),
      check(
        'minibar_payment_lock_release_shape',
        sql`((state <> 'RELEASED'::text) OR (provider_status = 'FAILED_NO_FUNDS'::text))`,
      ),
      foreignKey({
        name: 'minibar_payment_lock_report_fkey',
        columns: [table.reportId],
        foreignColumns: [minibarUsageReport.reportId],
      }).onDelete('restrict'),
      check(
        'minibar_payment_lock_resolution_shape',
        sql`(((state = 'HELD'::text) = (resolved_at IS NULL)) AND ((resolved_at IS NULL) = (resolved_by_account_id IS NULL)))`,
      ),
      check('minibar_payment_lock_revision_non_negative', sql`(revision >= 0)`),
      check(
        'minibar_payment_lock_settle_shape',
        sql`((state <> 'SETTLED'::text) OR (provider_status = 'SUCCEEDED'::text))`,
      ),
      check(
        'minibar_payment_lock_state_known',
        sql`(state = ANY (ARRAY['HELD'::text, 'RELEASED'::text, 'SETTLED'::text]))`,
      ),
      foreignKey({
        name: 'minibar_payment_lock_version_fkey',
        columns: [table.versionId],
        foreignColumns: [minibarUsageReportVersion.versionId],
      }).onDelete('restrict'),
      uniqueIndex('minibar_payment_lock_one_held_uq')
        .on(table.reportId)
        .where(sql`state = 'HELD'::text`),
      uniqueIndex('minibar_payment_lock_one_settled_uq')
        .on(table.versionId)
        .where(sql`state = 'SETTLED'::text`),
      index('minibar_payment_lock_report_idx').on(table.hotelId, table.reportId, table.state),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The only way to correct a settled charge: an append-only reversal, receivable
 * or waiver priced from the original snapshot (`CHK-DEC-005`, `PRICE-DEC-004`).
 */
export const minibarReportAdjustment = platform
  .table(
    'minibar_report_adjustment',
    {
      actorAccountId: uuid('actor_account_id').notNull(),
      adjustmentId: uuid('adjustment_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      amountMnt: bigint('amount_mnt', { mode: 'bigint' }).notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      hotelId: uuid('hotel_id').notNull(),
      kind: text('kind').notNull(),
      lockId: uuid('lock_id').notNull(),
      originalVersionId: uuid('original_version_id').notNull(),
      productId: uuid('product_id'),
      quantity: integer('quantity'),
      reason: text('reason').notNull(),
      reportId: uuid('report_id').notNull(),
      unitPriceMnt: bigint('unit_price_mnt', { mode: 'bigint' }),
    },
    (table) => [
      check('minibar_report_adjustment_amount_positive', sql`(amount_mnt > 0)`),
      foreignKey({
        name: 'minibar_report_adjustment_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'minibar_report_adjustment_kind_known',
        sql`(kind = ANY (ARRAY['OVERCHARGE_REVERSAL'::text, 'UNDERCHARGE_RECEIVABLE'::text, 'DISPUTE_WAIVER'::text]))`,
      ),
      check(
        'minibar_report_adjustment_line_shape',
        sql`(((product_id IS NULL) = (quantity IS NULL)) AND ((product_id IS NULL) = (unit_price_mnt IS NULL)))`,
      ),
      check(
        'minibar_report_adjustment_line_total',
        sql`((product_id IS NULL) OR (amount_mnt = (unit_price_mnt * quantity)))`,
      ),
      foreignKey({
        name: 'minibar_report_adjustment_lock_fkey',
        columns: [table.lockId],
        foreignColumns: [minibarPaymentLock.lockId],
      }).onDelete('restrict'),
      check(
        'minibar_report_adjustment_quantity_positive',
        sql`((quantity IS NULL) OR (quantity > 0))`,
      ),
      check(
        'minibar_report_adjustment_reason_bounded',
        sql`((length(reason) >= 1) AND (length(reason) <= 300))`,
      ),
      foreignKey({
        name: 'minibar_report_adjustment_report_fkey',
        columns: [table.reportId],
        foreignColumns: [minibarUsageReport.reportId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'minibar_report_adjustment_version_fkey',
        columns: [table.originalVersionId],
        foreignColumns: [minibarUsageReportVersion.versionId],
      }).onDelete('restrict'),
      index('minibar_report_adjustment_report_idx').on(
        table.hotelId,
        table.reportId,
        table.createdAt,
      ),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The active-stay refill: a request that is not a movement, and the Cleaner's
 * confirmation that is (doc 04 §5.1, `PRICE-DEC-005`).
 */
export const minibarRefillTask = platform
  .table(
    'minibar_refill_task',
    {
      claimedAt: timestamp('claimed_at', { withTimezone: true }),
      cleanerAccountId: uuid('cleaner_account_id'),
      completedAt: timestamp('completed_at', { withTimezone: true }),
      confirmedQuantity: integer('confirmed_quantity'),
      hotelId: uuid('hotel_id').notNull(),
      movementId: uuid('movement_id'),
      productId: uuid('product_id').notNull(),
      reason: text('reason'),
      requestedAt: timestamp('requested_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      requestedByAccountId: uuid('requested_by_account_id').notNull(),
      requestedQuantity: integer('requested_quantity').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      roomId: uuid('room_id').notNull(),
      state: text('state')
        .notNull()
        .default(sql`'PENDING'::text`),
      stayId: uuid('stay_id').notNull(),
      taskId: uuid('task_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
    },
    (table) => [
      check(
        'minibar_refill_task_claim_shape',
        sql`((cleaner_account_id IS NULL) = (claimed_at IS NULL))`,
      ),
      check(
        'minibar_refill_task_completion_shape',
        sql`((state = 'COMPLETED'::text) = ((confirmed_quantity IS NOT NULL) AND (movement_id IS NOT NULL) AND (completed_at IS NOT NULL)))`,
      ),
      check(
        'minibar_refill_task_confirmed_bounded',
        sql`((confirmed_quantity IS NULL) OR ((confirmed_quantity > 0) AND (confirmed_quantity <= requested_quantity)))`,
      ),
      foreignKey({
        name: 'minibar_refill_task_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'minibar_refill_task_movement_fkey',
        columns: [table.movementId],
        foreignColumns: [inventoryMovement.movementId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'minibar_refill_task_price_book_fkey',
        columns: [table.stayId, table.productId],
        foreignColumns: [stayMinibarPrice.stayId, stayMinibarPrice.productId],
      }).onDelete('restrict'),
      check(
        'minibar_refill_task_reason_bounded',
        sql`((reason IS NULL) OR ((length(reason) >= 1) AND (length(reason) <= 300)))`,
      ),
      check('minibar_refill_task_requested_positive', sql`(requested_quantity > 0)`),
      check('minibar_refill_task_revision_non_negative', sql`(revision >= 0)`),
      foreignKey({
        name: 'minibar_refill_task_room_fkey',
        columns: [table.hotelId, table.roomId],
        foreignColumns: [room.hotelId, room.roomId],
      }).onDelete('restrict'),
      check(
        'minibar_refill_task_state_known',
        sql`(state = ANY (ARRAY['PENDING'::text, 'IN_PROGRESS'::text, 'COMPLETED'::text, 'CANCELLED'::text, 'IMPOSSIBLE'::text]))`,
      ),
      foreignKey({
        name: 'minibar_refill_task_stay_fkey',
        columns: [table.hotelId, table.stayId],
        foreignColumns: [stay.hotelId, stay.stayId],
      }).onDelete('restrict'),
      check(
        'minibar_refill_task_terminal_reason',
        sql`((state <> ALL (ARRAY['CANCELLED'::text, 'IMPOSSIBLE'::text])) OR (reason IS NOT NULL))`,
      ),
      uniqueIndex('minibar_refill_task_one_open_uq')
        .on(table.hotelId, table.roomId, table.productId)
        .where(sql`state = ANY (ARRAY['PENDING'::text, 'IN_PROGRESS'::text])`),
      index('minibar_refill_task_product_idx').on(table.hotelId, table.productId, table.state),
      index('minibar_refill_task_room_idx').on(table.hotelId, table.roomId, table.state),
      index('minibar_refill_task_stay_idx').on(table.hotelId, table.stayId),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

// ---------------------------------------------------------------------
// Phase 10 — folio, deposit, payment, and correction.
// ---------------------------------------------------------------------

/**
 * The configured deposit: a hotel default and an optional category override,
 * versioned so a confirmed stay's snapshot is never re-resolved (`RC-DEC-002`).
 */
export const depositConfig = platform
  .table(
    'deposit_config',
    {
      amountMnt: bigint('amount_mnt', { mode: 'bigint' }).notNull(),
      categoryId: uuid('category_id'),
      configId: uuid('config_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      configVersion: integer('config_version')
        .notNull()
        .default(sql`1`),
      hotelId: uuid('hotel_id').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      updatedByAccountId: uuid('updated_by_account_id').notNull(),
    },
    (table) => [
      check('deposit_config_amount_range', sql`((amount_mnt >= 50000) AND (amount_mnt <= 100000))`),
      foreignKey({
        name: 'deposit_config_category_fkey',
        columns: [table.hotelId, table.categoryId],
        foreignColumns: [roomCategory.hotelId, roomCategory.categoryId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'deposit_config_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check('deposit_config_revision_non_negative', sql`(revision >= 0)`),
      check('deposit_config_version_positive', sql`(config_version >= 1)`),
      uniqueIndex('deposit_config_category_uq')
        .on(table.hotelId, table.categoryId)
        .where(sql`category_id IS NOT NULL`),
      uniqueIndex('deposit_config_default_uq')
        .on(table.hotelId)
        .where(sql`category_id IS NULL`),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The one consolidated bill of a stay: what was charged, what was paid and what
 * the deposit covered (`RC-DEC-001`).
 */
export const stayFolio = platform
  .table(
    'stay_folio',
    {
      chargedMnt: bigint('charged_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      depositAppliedMnt: bigint('deposit_applied_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      folioId: uuid('folio_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      hotelId: uuid('hotel_id').notNull(),
      openedAt: timestamp('opened_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      paidMnt: bigint('paid_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      reason: text('reason'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      roomId: uuid('room_id').notNull(),
      settledAt: timestamp('settled_at', { withTimezone: true }),
      state: text('state')
        .notNull()
        .default(sql`'OPEN'::text`),
      stayId: uuid('stay_id').notNull(),
    },
    (table) => [
      check(
        'stay_folio_amounts_non_negative',
        sql`((charged_mnt >= 0) AND (paid_mnt >= 0) AND (deposit_applied_mnt >= 0))`,
      ),
      foreignKey({
        name: 'stay_folio_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check('stay_folio_not_overpaid', sql`((paid_mnt + deposit_applied_mnt) <= charged_mnt)`),
      check(
        'stay_folio_reason_bounded',
        sql`((reason IS NULL) OR ((length(reason) >= 1) AND (length(reason) <= 300)))`,
      ),
      check('stay_folio_revision_non_negative', sql`(revision >= 0)`),
      foreignKey({
        name: 'stay_folio_room_fkey',
        columns: [table.hotelId, table.roomId],
        foreignColumns: [room.hotelId, room.roomId],
      }).onDelete('restrict'),
      check(
        'stay_folio_settled_balanced',
        sql`((state <> 'SETTLED'::text) OR ((paid_mnt + deposit_applied_mnt) = charged_mnt))`,
      ),
      check(
        'stay_folio_settled_shape',
        sql`((state = 'SETTLED'::text) = (settled_at IS NOT NULL))`,
      ),
      check(
        'stay_folio_state_known',
        sql`(state = ANY (ARRAY['OPEN'::text, 'SETTLED'::text, 'VOID'::text]))`,
      ),
      foreignKey({
        name: 'stay_folio_stay_fkey',
        columns: [table.hotelId, table.stayId],
        foreignColumns: [stay.hotelId, stay.stayId],
      }).onDelete('restrict'),
      unique('stay_folio_stay_uq').on(table.stayId),
      check('stay_folio_void_shape', sql`((state <> 'VOID'::text) OR (reason IS NOT NULL))`),
      index('stay_folio_room_idx').on(table.hotelId, table.roomId, table.state),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * A charge on the folio, append-only and idempotent on what produced it, so a
 * repeated posting bills nothing twice (doc 02 §3.3).
 */
export const folioLine = platform
  .table(
    'folio_line',
    {
      actorAccountId: uuid('actor_account_id'),
      amountMnt: bigint('amount_mnt', { mode: 'bigint' }).notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      description: text('description').notNull(),
      folioId: uuid('folio_id').notNull(),
      hotelId: uuid('hotel_id').notNull(),
      kind: text('kind').notNull(),
      lineId: uuid('line_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      sourceRef: uuid('source_ref').notNull(),
      sourceType: text('source_type').notNull(),
    },
    (table) => [
      check('folio_line_amount_positive', sql`(amount_mnt > 0)`),
      check(
        'folio_line_description_bounded',
        sql`((length(description) >= 1) AND (length(description) <= 200))`,
      ),
      foreignKey({
        name: 'folio_line_folio_fkey',
        columns: [table.folioId],
        foreignColumns: [stayFolio.folioId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'folio_line_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'folio_line_kind_known',
        sql`(kind = ANY (ARRAY['ROOM'::text, 'MINIBAR'::text, 'OTHER'::text]))`,
      ),
      unique('folio_line_source_uq').on(table.folioId, table.sourceType, table.sourceRef),
      index('folio_line_folio_idx').on(table.hotelId, table.folioId, table.createdAt),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The versioned deposit balance of a stay. Its invariant -
 * received - reversed - allocated - reserved - refunded >= 0 - is a CHECK,
 * and the requirement it was confirmed under is written once (`DEP-DEC-007`,
 * `-008`).
 */
export const depositAggregate = platform
  .table(
    'deposit_aggregate',
    {
      allocatedMnt: bigint('allocated_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      categoryId: uuid('category_id'),
      configScope: text('config_scope').notNull(),
      configVersion: integer('config_version'),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      frozen: boolean('frozen')
        .notNull()
        .default(sql`false`),
      hotelId: uuid('hotel_id').notNull(),
      receivedMnt: bigint('received_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      refundReservedMnt: bigint('refund_reserved_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      refundedMnt: bigint('refunded_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      required: boolean('required').notNull(),
      requiredAmountMnt: bigint('required_amount_mnt', { mode: 'bigint' }),
      reversedMnt: bigint('reversed_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      source: text('source').notNull(),
      stayId: uuid('stay_id').primaryKey().notNull(),
    },
    (table) => [
      check(
        'deposit_aggregate_amount_shape',
        sql`((required = (required_amount_mnt IS NOT NULL)) AND ((required_amount_mnt IS NULL) OR ((required_amount_mnt >= 50000) AND (required_amount_mnt <= 100000))))`,
      ),
      check(
        'deposit_aggregate_amounts_non_negative',
        sql`((received_mnt >= 0) AND (reversed_mnt >= 0) AND (allocated_mnt >= 0) AND (refund_reserved_mnt >= 0) AND (refunded_mnt >= 0))`,
      ),
      check(
        'deposit_aggregate_available_non_negative',
        sql`(((((received_mnt - reversed_mnt) - allocated_mnt) - refund_reserved_mnt) - refunded_mnt) >= 0)`,
      ),
      check(
        'deposit_aggregate_config_shape',
        sql`(((config_scope = 'NONE'::text) = (config_version IS NULL)) AND ((config_scope = 'CATEGORY'::text) = (category_id IS NOT NULL)))`,
      ),
      foreignKey({
        name: 'deposit_aggregate_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check('deposit_aggregate_required_shape', sql`(required = (source = 'WALK_IN'::text))`),
      check('deposit_aggregate_revision_non_negative', sql`(revision >= 0)`),
      check(
        'deposit_aggregate_scope_known',
        sql`(config_scope = ANY (ARRAY['HOTEL'::text, 'CATEGORY'::text, 'NONE'::text]))`,
      ),
      check(
        'deposit_aggregate_source_known',
        sql`(source = ANY (ARRAY['WALK_IN'::text, 'ONLINE'::text]))`,
      ),
      foreignKey({
        name: 'deposit_aggregate_stay_fkey',
        columns: [table.hotelId, table.stayId],
        foreignColumns: [stay.hotelId, stay.stayId],
      }).onDelete('restrict'),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The immutable money ledger: receipts, refunds, reversals and corrected
 * records, one row per movement and one row per provider reference
 * (`DEP-DEC-005`, `-006`, `-007`).
 */
export const paymentTransaction = platform
  .table(
    'payment_transaction',
    {
      actorAccountId: uuid('actor_account_id').notNull(),
      amountMnt: bigint('amount_mnt', { mode: 'bigint' }).notNull(),
      approvalCode: text('approval_code'),
      channel: text('channel').notNull(),
      direction: text('direction').notNull(),
      effectiveAt: timestamp('effective_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      folioId: uuid('folio_id'),
      hotelId: uuid('hotel_id').notNull(),
      kind: text('kind').notNull(),
      occurredAt: timestamp('occurred_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      originalTransactionId: uuid('original_transaction_id'),
      providerReference: text('provider_reference'),
      reason: text('reason'),
      refundRequestId: uuid('refund_request_id'),
      shiftId: uuid('shift_id'),
      stayId: uuid('stay_id').notNull(),
      terminalId: text('terminal_id'),
      transactionId: uuid('transaction_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
    },
    (table) => [
      check('payment_transaction_amount_positive', sql`(amount_mnt > 0)`),
      check(
        'payment_transaction_cash_shape',
        sql`((channel <> 'CASH'::text) OR (shift_id IS NOT NULL))`,
      ),
      check(
        'payment_transaction_channel_known',
        sql`(channel = ANY (ARRAY['CASH'::text, 'QPAY'::text, 'CARD_GATEWAY'::text, 'MANUAL_POS'::text]))`,
      ),
      check(
        'payment_transaction_direction_known',
        sql`(direction = ANY (ARRAY['IN'::text, 'OUT'::text]))`,
      ),
      check(
        'payment_transaction_direction_shape',
        sql`((direction = 'IN'::text) = (kind = ANY (ARRAY['DEPOSIT_RECEIPT'::text, 'FOLIO_PAYMENT'::text, 'CORRECTED_PAYMENT'::text])))`,
      ),
      foreignKey({
        name: 'payment_transaction_folio_fkey',
        columns: [table.folioId],
        foreignColumns: [stayFolio.folioId],
      }).onDelete('restrict'),
      check(
        'payment_transaction_gateway_shape',
        sql`((channel <> ALL (ARRAY['QPAY'::text, 'CARD_GATEWAY'::text])) OR (kind = ANY (ARRAY['DEPOSIT_REVERSAL'::text, 'FOLIO_PAYMENT_REVERSAL'::text])) OR (provider_reference IS NOT NULL))`,
      ),
      foreignKey({
        name: 'payment_transaction_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'payment_transaction_kind_known',
        sql`(kind = ANY (ARRAY['DEPOSIT_RECEIPT'::text, 'DEPOSIT_REFUND'::text, 'DEPOSIT_REVERSAL'::text, 'FOLIO_PAYMENT'::text, 'FOLIO_PAYMENT_REVERSAL'::text, 'CORRECTED_PAYMENT'::text, 'LATE_REFUND_COVERED'::text]))`,
      ),
      foreignKey({
        name: 'payment_transaction_original_fkey',
        columns: [table.originalTransactionId],
        foreignColumns: [table.transactionId],
      }).onDelete('restrict'),
      check(
        'payment_transaction_pos_shape',
        sql`((channel <> 'MANUAL_POS'::text) OR (kind = ANY (ARRAY['DEPOSIT_REVERSAL'::text, 'FOLIO_PAYMENT_REVERSAL'::text])) OR ((provider_reference IS NOT NULL) AND (approval_code IS NOT NULL)))`,
      ),
      check(
        'payment_transaction_reason_bounded',
        sql`((reason IS NULL) OR ((length(reason) >= 1) AND (length(reason) <= 300)))`,
      ),
      check(
        'payment_transaction_reference_bounded',
        sql`(((provider_reference IS NULL) OR ((length(provider_reference) >= 1) AND (length(provider_reference) <= 120))) AND ((approval_code IS NULL) OR ((length(approval_code) >= 1) AND (length(approval_code) <= 60))) AND ((terminal_id IS NULL) OR ((length(terminal_id) >= 1) AND (length(terminal_id) <= 60))))`,
      ),
      check(
        'payment_transaction_refund_shape',
        sql`((kind <> ALL (ARRAY['DEPOSIT_REFUND'::text, 'LATE_REFUND_COVERED'::text])) OR (refund_request_id IS NOT NULL))`,
      ),
      check(
        'payment_transaction_reversal_shape',
        sql`((kind <> ALL (ARRAY['DEPOSIT_REVERSAL'::text, 'FOLIO_PAYMENT_REVERSAL'::text, 'CORRECTED_PAYMENT'::text])) OR (original_transaction_id IS NOT NULL))`,
      ),
      foreignKey({
        name: 'payment_transaction_shift_fkey',
        columns: [table.hotelId, table.shiftId],
        foreignColumns: [receptionShift.hotelId, receptionShift.shiftId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'payment_transaction_stay_fkey',
        columns: [table.hotelId, table.stayId],
        foreignColumns: [stay.hotelId, stay.stayId],
      }).onDelete('restrict'),
      index('payment_transaction_folio_idx').on(table.hotelId, table.folioId),
      uniqueIndex('payment_transaction_provider_reference_uq')
        .on(table.hotelId, table.channel, table.providerReference)
        .where(sql`provider_reference IS NOT NULL`),
      index('payment_transaction_stay_idx').on(table.hotelId, table.stayId, table.occurredAt),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * What the deposit paid for, line by line - audited without a reason, an
 * evidence photograph or a second approval (`DEP-DEC-002`).
 */
export const depositAllocation = platform
  .table(
    'deposit_allocation',
    {
      actorAccountId: uuid('actor_account_id').notNull(),
      allocationId: uuid('allocation_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      amountMnt: bigint('amount_mnt', { mode: 'bigint' }).notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      folioLineId: uuid('folio_line_id').notNull(),
      hotelId: uuid('hotel_id').notNull(),
      stayId: uuid('stay_id').notNull(),
    },
    (table) => [
      check('deposit_allocation_amount_positive', sql`(amount_mnt > 0)`),
      foreignKey({
        name: 'deposit_allocation_deposit_fkey',
        columns: [table.stayId],
        foreignColumns: [depositAggregate.stayId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'deposit_allocation_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'deposit_allocation_line_fkey',
        columns: [table.folioLineId],
        foreignColumns: [folioLine.lineId],
      }).onDelete('restrict'),
      unique('deposit_allocation_line_uq').on(table.folioLineId),
      index('deposit_allocation_stay_idx').on(table.hotelId, table.stayId, table.createdAt),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * A refund and its reservation: pending, failed, succeeded, released, and the
 * reconciliation a late success forces (`DEP-DEC-003`, `-004`, `-009`).
 */
export const refundRequest = platform
  .table(
    'refund_request',
    {
      alternateChannel: boolean('alternate_channel')
        .notNull()
        .default(sql`false`),
      amountMnt: bigint('amount_mnt', { mode: 'bigint' }).notNull(),
      approvalState: text('approval_state')
        .notNull()
        .default(sql`'NOT_REQUIRED'::text`),
      channel: text('channel').notNull(),
      decidedAt: timestamp('decided_at', { withTimezone: true }),
      decidedByAccountId: uuid('decided_by_account_id'),
      failureReason: text('failure_reason'),
      hotelId: uuid('hotel_id').notNull(),
      originalTransactionId: uuid('original_transaction_id').notNull(),
      providerReference: text('provider_reference'),
      reason: text('reason'),
      releaseReason: text('release_reason'),
      releasedAt: timestamp('released_at', { withTimezone: true }),
      releasedByAccountId: uuid('released_by_account_id'),
      requestId: uuid('request_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      requestedAt: timestamp('requested_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      requestedByAccountId: uuid('requested_by_account_id').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      settledAt: timestamp('settled_at', { withTimezone: true }),
      state: text('state')
        .notNull()
        .default(sql`'PENDING'::text`),
      stayId: uuid('stay_id').notNull(),
    },
    (table) => [
      check(
        'refund_request_alternate_reason',
        sql`((NOT alternate_channel) OR (reason IS NOT NULL))`,
      ),
      check(
        'refund_request_alternate_shape',
        sql`(alternate_channel = (approval_state <> 'NOT_REQUIRED'::text))`,
      ),
      check('refund_request_amount_positive', sql`(amount_mnt > 0)`),
      check(
        'refund_request_approval_known',
        sql`(approval_state = ANY (ARRAY['NOT_REQUIRED'::text, 'PENDING'::text, 'APPROVED'::text, 'REJECTED'::text]))`,
      ),
      check(
        'refund_request_channel_known',
        sql`(channel = ANY (ARRAY['CASH'::text, 'QPAY'::text, 'CARD_GATEWAY'::text, 'MANUAL_POS'::text]))`,
      ),
      check(
        'refund_request_decision_shape',
        sql`(((decided_at IS NULL) = (decided_by_account_id IS NULL)) AND ((approval_state = ANY (ARRAY['NOT_REQUIRED'::text, 'PENDING'::text])) = (decided_at IS NULL)))`,
      ),
      foreignKey({
        name: 'refund_request_deposit_fkey',
        columns: [table.stayId],
        foreignColumns: [depositAggregate.stayId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'refund_request_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'refund_request_original_fkey',
        columns: [table.originalTransactionId],
        foreignColumns: [paymentTransaction.transactionId],
      }).onDelete('restrict'),
      check(
        'refund_request_reason_bounded',
        sql`(((reason IS NULL) OR ((length(reason) >= 1) AND (length(reason) <= 300))) AND ((release_reason IS NULL) OR ((length(release_reason) >= 1) AND (length(release_reason) <= 300))) AND ((failure_reason IS NULL) OR ((length(failure_reason) >= 1) AND (length(failure_reason) <= 300))))`,
      ),
      check(
        'refund_request_release_shape',
        sql`((((state = 'RELEASED'::text) OR (state = 'RECONCILING'::text) OR (state = 'RECONCILED'::text)) = (released_at IS NOT NULL)) AND ((released_at IS NULL) = (released_by_account_id IS NULL)) AND ((released_at IS NULL) = (release_reason IS NULL)))`,
      ),
      check('refund_request_revision_non_negative', sql`(revision >= 0)`),
      check(
        'refund_request_settled_shape',
        sql`((state = 'SUCCEEDED'::text) = (settled_at IS NOT NULL))`,
      ),
      check(
        'refund_request_state_known',
        sql`(state = ANY (ARRAY['PENDING'::text, 'FAILED'::text, 'SUCCEEDED'::text, 'RELEASED'::text, 'RECONCILING'::text, 'RECONCILED'::text]))`,
      ),
      uniqueIndex('refund_request_one_live_uq')
        .on(table.originalTransactionId)
        .where(sql`state = ANY (ARRAY['PENDING'::text, 'FAILED'::text, 'RECONCILING'::text])`),
      index('refund_request_stay_idx').on(table.hotelId, table.stayId, table.state),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The request that turns a wrong movement into a reversal plus a corrected
 * record, one non-terminal per original transaction (`DEP-DEC-006`).
 */
export const financialCorrection = platform
  .table(
    'financial_correction',
    {
      correctedAmountMnt: bigint('corrected_amount_mnt', { mode: 'bigint' }),
      correctedChannel: text('corrected_channel'),
      correctedReference: text('corrected_reference'),
      correctedTransactionId: uuid('corrected_transaction_id'),
      correctionId: uuid('correction_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      decidedAt: timestamp('decided_at', { withTimezone: true }),
      decidedByAccountId: uuid('decided_by_account_id'),
      decisionReason: text('decision_reason'),
      hotelId: uuid('hotel_id').notNull(),
      originalTransactionId: uuid('original_transaction_id').notNull(),
      reason: text('reason').notNull(),
      requestedAt: timestamp('requested_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      requestedByAccountId: uuid('requested_by_account_id').notNull(),
      reversalTransactionId: uuid('reversal_transaction_id'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'PENDING'::text`),
      stayId: uuid('stay_id').notNull(),
    },
    (table) => [
      check(
        'financial_correction_amount_positive',
        sql`((corrected_amount_mnt IS NULL) OR (corrected_amount_mnt > 0))`,
      ),
      check(
        'financial_correction_channel_known',
        sql`((corrected_channel IS NULL) OR (corrected_channel = ANY (ARRAY['CASH'::text, 'QPAY'::text, 'CARD_GATEWAY'::text, 'MANUAL_POS'::text])))`,
      ),
      foreignKey({
        name: 'financial_correction_corrected_fkey',
        columns: [table.correctedTransactionId],
        foreignColumns: [paymentTransaction.transactionId],
      }).onDelete('restrict'),
      check(
        'financial_correction_decision_shape',
        sql`(((state = 'PENDING'::text) = (decided_at IS NULL)) AND ((decided_at IS NULL) = (decided_by_account_id IS NULL)))`,
      ),
      check(
        'financial_correction_execution_shape',
        sql`((state = 'EXECUTED'::text) = (reversal_transaction_id IS NOT NULL))`,
      ),
      foreignKey({
        name: 'financial_correction_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'financial_correction_original_fkey',
        columns: [table.originalTransactionId],
        foreignColumns: [paymentTransaction.transactionId],
      }).onDelete('restrict'),
      check(
        'financial_correction_reason_bounded',
        sql`(((length(reason) >= 1) AND (length(reason) <= 300)) AND ((decision_reason IS NULL) OR ((length(decision_reason) >= 1) AND (length(decision_reason) <= 300))))`,
      ),
      foreignKey({
        name: 'financial_correction_reversal_fkey',
        columns: [table.reversalTransactionId],
        foreignColumns: [paymentTransaction.transactionId],
      }).onDelete('restrict'),
      check('financial_correction_revision_non_negative', sql`(revision >= 0)`),
      check(
        'financial_correction_state_known',
        sql`(state = ANY (ARRAY['PENDING'::text, 'REJECTED'::text, 'EXECUTED'::text]))`,
      ),
      foreignKey({
        name: 'financial_correction_stay_fkey',
        columns: [table.hotelId, table.stayId],
        foreignColumns: [stay.hotelId, stay.stayId],
      }).onDelete('restrict'),
      uniqueIndex('financial_correction_one_open_uq')
        .on(table.originalTransactionId)
        .where(sql`state = 'PENDING'::text`),
      index('financial_correction_stay_idx').on(table.hotelId, table.stayId, table.state),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The late-success case a released refund opens: one per request, claimed and
 * resolved by Platform Operation, terminal in one of two outcomes
 * (`DEP-DEC-010`).
 */
export const depositReconciliationCase = platform
  .table(
    'deposit_reconciliation_case',
    {
      caseId: uuid('case_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      claimedAt: timestamp('claimed_at', { withTimezone: true }),
      claimedByAccountId: uuid('claimed_by_account_id'),
      coveredAmountMnt: bigint('covered_amount_mnt', { mode: 'bigint' }),
      hotelId: uuid('hotel_id').notNull(),
      openedAt: timestamp('opened_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      outcome: text('outcome'),
      providerAmountMnt: bigint('provider_amount_mnt', { mode: 'bigint' }),
      providerReference: text('provider_reference'),
      refundRequestId: uuid('refund_request_id').notNull(),
      resolutionNote: text('resolution_note'),
      resolvedAt: timestamp('resolved_at', { withTimezone: true }),
      resolvedByAccountId: uuid('resolved_by_account_id'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      shortfallAmountMnt: bigint('shortfall_amount_mnt', { mode: 'bigint' }),
      state: text('state')
        .notNull()
        .default(sql`'OPEN'::text`),
      stayId: uuid('stay_id').notNull(),
    },
    (table) => [
      check(
        'deposit_reconciliation_case_amounts_non_negative',
        sql`(((covered_amount_mnt IS NULL) OR (covered_amount_mnt >= 0)) AND ((shortfall_amount_mnt IS NULL) OR (shortfall_amount_mnt >= 0)) AND ((provider_amount_mnt IS NULL) OR (provider_amount_mnt > 0)))`,
      ),
      check(
        'deposit_reconciliation_case_claim_shape',
        sql`(((claimed_at IS NULL) = (claimed_by_account_id IS NULL)) AND ((state = 'OPEN'::text) = (claimed_at IS NULL)))`,
      ),
      foreignKey({
        name: 'deposit_reconciliation_case_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'deposit_reconciliation_case_note_bounded',
        sql`((resolution_note IS NULL) OR ((length(resolution_note) >= 1) AND (length(resolution_note) <= 300)))`,
      ),
      check(
        'deposit_reconciliation_case_outcome_known',
        sql`((outcome IS NULL) OR (outcome = ANY (ARRAY['PROVIDER_STATUS_CORRECTED_NOT_SUCCESS'::text, 'PROVIDER_SUCCESS_POSTED'::text])))`,
      ),
      check(
        'deposit_reconciliation_case_posting_shape',
        sql`((outcome IS DISTINCT FROM 'PROVIDER_SUCCESS_POSTED'::text) = ((covered_amount_mnt IS NULL) AND (shortfall_amount_mnt IS NULL)))`,
      ),
      foreignKey({
        name: 'deposit_reconciliation_case_request_fkey',
        columns: [table.refundRequestId],
        foreignColumns: [refundRequest.requestId],
      }).onDelete('restrict'),
      unique('deposit_reconciliation_case_request_uq').on(table.refundRequestId),
      check(
        'deposit_reconciliation_case_resolution_shape',
        sql`(((state = 'RESOLVED'::text) = (resolved_at IS NOT NULL)) AND ((resolved_at IS NULL) = (resolved_by_account_id IS NULL)) AND ((resolved_at IS NULL) = (outcome IS NULL)))`,
      ),
      check('deposit_reconciliation_case_revision_non_negative', sql`(revision >= 0)`),
      check(
        'deposit_reconciliation_case_state_known',
        sql`(state = ANY (ARRAY['OPEN'::text, 'RECONCILING'::text, 'RESOLVED'::text]))`,
      ),
      index('deposit_reconciliation_case_state_idx').on(table.hotelId, table.state, table.openedAt),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * What the deposit could not cover, recorded as the hotel's own loss rather
 * than as a negative balance (`DEP-DEC-010`).
 */
export const hotelFinanceEvent = platform
  .table(
    'hotel_finance_event',
    {
      amountMnt: bigint('amount_mnt', { mode: 'bigint' }).notNull(),
      caseId: uuid('case_id'),
      eventId: uuid('event_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      hotelId: uuid('hotel_id').notNull(),
      kind: text('kind').notNull(),
      note: text('note'),
      occurredAt: timestamp('occurred_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      reference: text('reference'),
      stayId: uuid('stay_id'),
    },
    (table) => [
      check('hotel_finance_event_amount_positive', sql`(amount_mnt > 0)`),
      foreignKey({
        name: 'hotel_finance_event_case_fkey',
        columns: [table.caseId],
        foreignColumns: [depositReconciliationCase.caseId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'hotel_finance_event_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'hotel_finance_event_kind_known',
        sql`(kind = ANY (ARRAY['LATE_REFUND_SHORTFALL'::text]))`,
      ),
      check(
        'hotel_finance_event_note_bounded',
        sql`(((note IS NULL) OR ((length(note) >= 1) AND (length(note) <= 300))) AND ((reference IS NULL) OR ((length(reference) >= 1) AND (length(reference) <= 120))))`,
      ),
      foreignKey({
        name: 'hotel_finance_event_stay_fkey',
        columns: [table.hotelId, table.stayId],
        foreignColumns: [stay.hotelId, stay.stayId],
      }).onDelete('restrict'),
      index('hotel_finance_event_hotel_idx').on(table.hotelId, table.kind, table.occurredAt),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

// ---------------------------------------------------------------------
// Phase 11 — shift, cash drawer, expense, and hotel finance.
// ---------------------------------------------------------------------

/**
 * The typed immutable cash ledger. Every drawer movement names the shift it
 * belongs to; a mistake is a reversal plus a corrected movement
 * (`CASH-DEC-004`).
 */
export const cashMovement = platform
  .table(
    'cash_movement',
    {
      actorAccountId: uuid('actor_account_id').notNull(),
      amountMnt: bigint('amount_mnt', { mode: 'bigint' }).notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      direction: text('direction').notNull(),
      effectiveAt: timestamp('effective_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      expenseId: uuid('expense_id'),
      hotelId: uuid('hotel_id').notNull(),
      locationId: uuid('location_id').notNull(),
      movementId: uuid('movement_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      movementType: text('movement_type').notNull(),
      originalMovementId: uuid('original_movement_id'),
      paymentTransactionId: uuid('payment_transaction_id'),
      reason: text('reason'),
      reference: text('reference'),
      requestId: uuid('request_id'),
      shiftId: uuid('shift_id'),
      transferId: uuid('transfer_id'),
    },
    (table) => [
      check('cash_movement_amount_positive', sql`(amount_mnt > 0)`),
      check(
        'cash_movement_correction_shape',
        sql`((movement_type <> ALL (ARRAY['CASH_CORRECTION_IN'::text, 'CASH_CORRECTION_OUT'::text])) OR ((reason IS NOT NULL) AND (original_movement_id IS NOT NULL)))`,
      ),
      check(
        'cash_movement_direction_known',
        sql`(direction = ANY (ARRAY['IN'::text, 'OUT'::text]))`,
      ),
      check(
        'cash_movement_direction_shape',
        sql`((direction = 'IN'::text) = (movement_type = ANY (ARRAY['INITIAL_FLOAT'::text, 'SERVICE_CASH_PAYMENT'::text, 'DEPOSIT_CASH_RECEIPT'::text, 'CASH_TOP_UP'::text, 'DRAWER_TRANSFER_IN'::text, 'SAFE_TRANSFER_IN'::text, 'CASH_CORRECTION_IN'::text])))`,
      ),
      foreignKey({
        name: 'cash_movement_expense_fkey',
        columns: [table.expenseId],
        foreignColumns: [expense.expenseId],
      }).onDelete('restrict'),
      check(
        'cash_movement_expense_shape',
        sql`((movement_type = 'PAID_CASH_EXPENSE'::text) = (expense_id IS NOT NULL))`,
      ),
      foreignKey({
        name: 'cash_movement_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'cash_movement_location_fkey',
        columns: [table.hotelId, table.locationId],
        foreignColumns: [cashLocation.hotelId, cashLocation.cashLocationId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'cash_movement_original_fkey',
        columns: [table.originalMovementId],
        foreignColumns: [table.movementId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'cash_movement_payment_fkey',
        columns: [table.paymentTransactionId],
        foreignColumns: [paymentTransaction.transactionId],
      }).onDelete('restrict'),
      check(
        'cash_movement_reason_bounded',
        sql`(((reason IS NULL) OR ((length(reason) >= 1) AND (length(reason) <= 300))) AND ((reference IS NULL) OR ((length(reference) >= 1) AND (length(reference) <= 120))))`,
      ),
      foreignKey({
        name: 'cash_movement_request_fkey',
        columns: [table.requestId],
        foreignColumns: [cashRequest.requestId],
      }).onDelete('restrict'),
      check(
        'cash_movement_request_shape',
        sql`((movement_type <> ALL (ARRAY['BANK_DEPOSIT_OUT'::text, 'OWNER_OTHER_WITHDRAWAL'::text])) OR (request_id IS NOT NULL))`,
      ),
      foreignKey({
        name: 'cash_movement_shift_fkey',
        columns: [table.hotelId, table.shiftId],
        foreignColumns: [receptionShift.hotelId, receptionShift.shiftId],
      }).onDelete('restrict'),
      check(
        'cash_movement_top_up_shape',
        sql`((movement_type <> 'CASH_TOP_UP'::text) OR (reason IS NOT NULL))`,
      ),
      foreignKey({
        name: 'cash_movement_transfer_fkey',
        columns: [table.transferId],
        foreignColumns: [cashTransfer.transferId],
      }).onDelete('restrict'),
      check(
        'cash_movement_transfer_shape',
        sql`((movement_type <> ALL (ARRAY['DRAWER_TRANSFER_IN'::text, 'DRAWER_TRANSFER_OUT'::text, 'SAFE_TRANSFER_IN'::text, 'SAFE_TRANSFER_OUT'::text])) OR (transfer_id IS NOT NULL))`,
      ),
      check(
        'cash_movement_type_known',
        sql`(movement_type = ANY (ARRAY['INITIAL_FLOAT'::text, 'SERVICE_CASH_PAYMENT'::text, 'DEPOSIT_CASH_RECEIPT'::text, 'SERVICE_CASH_REFUND'::text, 'DEPOSIT_CASH_REFUND'::text, 'PAID_CASH_EXPENSE'::text, 'CASH_TOP_UP'::text, 'DRAWER_TRANSFER_IN'::text, 'DRAWER_TRANSFER_OUT'::text, 'SAFE_TRANSFER_IN'::text, 'SAFE_TRANSFER_OUT'::text, 'BANK_DEPOSIT_OUT'::text, 'OWNER_OTHER_WITHDRAWAL'::text, 'CASH_CORRECTION_IN'::text, 'CASH_CORRECTION_OUT'::text]))`,
      ),
      index('cash_movement_location_idx').on(table.hotelId, table.locationId, table.effectiveAt),
      uniqueIndex('cash_movement_one_initial_float_uq')
        .on(table.locationId)
        .where(sql`movement_type = 'INITIAL_FLOAT'::text`),
      index('cash_movement_shift_idx').on(table.hotelId, table.shiftId, table.effectiveAt),
      index('cash_movement_transfer_idx').on(table.hotelId, table.transferId),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * A transfer between two locations, its drawers and shifts pinned when it is
 * raised and completed only by the recipient's own count (`CASH-DEC-006`).
 */
export const cashTransfer = platform
  .table(
    'cash_transfer',
    {
      amountMnt: bigint('amount_mnt', { mode: 'bigint' }).notNull(),
      cancelReason: text('cancel_reason'),
      cancelRecountMnt: bigint('cancel_recount_mnt', { mode: 'bigint' }),
      cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
      cancelledByAccountId: uuid('cancelled_by_account_id'),
      confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
      confirmedByAccountId: uuid('confirmed_by_account_id'),
      confirmedCountedMnt: bigint('confirmed_counted_mnt', { mode: 'bigint' }),
      destinationLocationId: uuid('destination_location_id').notNull(),
      destinationShiftId: uuid('destination_shift_id'),
      hotelId: uuid('hotel_id').notNull(),
      initiatedAt: timestamp('initiated_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      initiatedByAccountId: uuid('initiated_by_account_id').notNull(),
      kind: text('kind').notNull(),
      reason: text('reason'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      sourceLocationId: uuid('source_location_id').notNull(),
      sourceShiftId: uuid('source_shift_id'),
      state: text('state')
        .notNull()
        .default(sql`'PENDING'::text`),
      transferId: uuid('transfer_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
    },
    (table) => [
      check('cash_transfer_amount_positive', sql`(amount_mnt > 0)`),
      check(
        'cash_transfer_cancellation_shape',
        sql`((state = 'CANCELLED'::text) = ((cancelled_at IS NOT NULL) AND (cancelled_by_account_id IS NOT NULL) AND (cancel_reason IS NOT NULL)))`,
      ),
      check(
        'cash_transfer_confirmation_shape',
        sql`((state = 'COMPLETED'::text) = ((confirmed_at IS NOT NULL) AND (confirmed_by_account_id IS NOT NULL)))`,
      ),
      check(
        'cash_transfer_counted_non_negative',
        sql`(((confirmed_counted_mnt IS NULL) OR (confirmed_counted_mnt >= 0)) AND ((cancel_recount_mnt IS NULL) OR (cancel_recount_mnt >= 0)))`,
      ),
      foreignKey({
        name: 'cash_transfer_destination_fkey',
        columns: [table.hotelId, table.destinationLocationId],
        foreignColumns: [cashLocation.hotelId, cashLocation.cashLocationId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'cash_transfer_destination_shift_fkey',
        columns: [table.hotelId, table.destinationShiftId],
        foreignColumns: [receptionShift.hotelId, receptionShift.shiftId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'cash_transfer_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'cash_transfer_kind_known',
        sql`(kind = ANY (ARRAY['DRAWER_TO_DRAWER'::text, 'DRAWER_SAFE'::text]))`,
      ),
      check('cash_transfer_locations_differ', sql`(source_location_id <> destination_location_id)`),
      check(
        'cash_transfer_reason_bounded',
        sql`(((reason IS NULL) OR ((length(reason) >= 1) AND (length(reason) <= 300))) AND ((cancel_reason IS NULL) OR ((length(cancel_reason) >= 1) AND (length(cancel_reason) <= 300))))`,
      ),
      check('cash_transfer_revision_non_negative', sql`(revision >= 0)`),
      check(
        'cash_transfer_shift_shape',
        sql`((kind <> 'DRAWER_TO_DRAWER'::text) OR ((source_shift_id IS NOT NULL) AND (destination_shift_id IS NOT NULL)))`,
      ),
      foreignKey({
        name: 'cash_transfer_source_fkey',
        columns: [table.hotelId, table.sourceLocationId],
        foreignColumns: [cashLocation.hotelId, cashLocation.cashLocationId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'cash_transfer_source_shift_fkey',
        columns: [table.hotelId, table.sourceShiftId],
        foreignColumns: [receptionShift.hotelId, receptionShift.shiftId],
      }).onDelete('restrict'),
      check(
        'cash_transfer_state_known',
        sql`(state = ANY (ARRAY['PENDING'::text, 'COMPLETED'::text, 'CANCELLED'::text]))`,
      ),
      index('cash_transfer_destination_idx').on(
        table.hotelId,
        table.destinationShiftId,
        table.state,
      ),
      index('cash_transfer_source_idx').on(table.hotelId, table.sourceShiftId, table.state),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * A bank deposit or an owner withdrawal: money leaving the hotel's cash that is
 * not an expense, and needs a Hotel Admin's approval (`CASH-DEC-007`).
 */
export const cashRequest = platform
  .table(
    'cash_request',
    {
      amountMnt: bigint('amount_mnt', { mode: 'bigint' }).notNull(),
      decidedAt: timestamp('decided_at', { withTimezone: true }),
      decidedByAccountId: uuid('decided_by_account_id'),
      decisionReason: text('decision_reason'),
      hotelId: uuid('hotel_id').notNull(),
      kind: text('kind').notNull(),
      locationId: uuid('location_id').notNull(),
      movementId: uuid('movement_id'),
      reason: text('reason').notNull(),
      recipient: text('recipient'),
      reference: text('reference'),
      requestId: uuid('request_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
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
      shiftId: uuid('shift_id'),
      state: text('state')
        .notNull()
        .default(sql`'PENDING'::text`),
    },
    (table) => [
      check('cash_request_amount_positive', sql`(amount_mnt > 0)`),
      check(
        'cash_request_bank_shape',
        sql`((kind <> 'BANK_DEPOSIT'::text) OR (reference IS NOT NULL))`,
      ),
      check(
        'cash_request_decision_shape',
        sql`(((state = 'PENDING'::text) = (decided_at IS NULL)) AND ((decided_at IS NULL) = (decided_by_account_id IS NULL)))`,
      ),
      foreignKey({
        name: 'cash_request_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'cash_request_kind_known',
        sql`(kind = ANY (ARRAY['BANK_DEPOSIT'::text, 'OWNER_WITHDRAWAL'::text]))`,
      ),
      foreignKey({
        name: 'cash_request_location_fkey',
        columns: [table.hotelId, table.locationId],
        foreignColumns: [cashLocation.hotelId, cashLocation.cashLocationId],
      }).onDelete('restrict'),
      check(
        'cash_request_movement_shape',
        sql`((movement_id IS NULL) OR (state = 'APPROVED'::text))`,
      ),
      check('cash_request_revision_non_negative', sql`(revision >= 0)`),
      foreignKey({
        name: 'cash_request_shift_fkey',
        columns: [table.hotelId, table.shiftId],
        foreignColumns: [receptionShift.hotelId, receptionShift.shiftId],
      }).onDelete('restrict'),
      check(
        'cash_request_state_known',
        sql`(state = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text]))`,
      ),
      check(
        'cash_request_text_bounded',
        sql`(((length(reason) >= 1) AND (length(reason) <= 300)) AND ((reference IS NULL) OR ((length(reference) >= 1) AND (length(reference) <= 120))) AND ((recipient IS NULL) OR ((length(recipient) >= 1) AND (length(recipient) <= 200))) AND ((decision_reason IS NULL) OR ((length(decision_reason) >= 1) AND (length(decision_reason) <= 300))))`,
      ),
      check(
        'cash_request_withdrawal_shape',
        sql`((kind <> 'OWNER_WITHDRAWAL'::text) OR (recipient IS NOT NULL))`,
      ),
      index('cash_request_state_idx').on(table.hotelId, table.state, table.requestedAt),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The expense lifecycle. An approval moves no money; only a cash execution
 * writes a drawer movement (`FIN-DEC-005`, `CASH-DEC-005`).
 */
/**
 * Phase 17, declared here rather than with the rest of its phase.
 *
 * `expense` carries a foreign key to it, and a Drizzle table's key targets are
 * evaluated when the table is created — so the referenced table has to exist
 * first. The phase comment above the Phase 17 block explains what it is for.
 */
export const expenseCategory = platform
  .table(
    'expense_category',
    {
      categoryId: uuid('category_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      createdByAccountId: uuid('created_by_account_id').notNull(),
      deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
      hotelId: uuid('hotel_id').notNull(),
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
      foreignKey({
        name: 'expense_category_created_by_fkey',
        columns: [table.createdByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      check(
        'expense_category_deactivated_shape',
        sql`((state = 'INACTIVE'::text) = (deactivated_at IS NOT NULL))`,
      ),
      foreignKey({
        name: 'expense_category_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      unique('expense_category_identity_uq').on(table.hotelId, table.categoryId),
      check(
        'expense_category_kind_known',
        sql`(kind = ANY (ARRAY['INVENTORY_PURCHASE'::text, 'OPERATING'::text]))`,
      ),
      check('expense_category_name_bounded', sql`((length(name) >= 1) AND (length(name) <= 80))`),
      unique('expense_category_name_uq').on(table.hotelId, table.name),
      check('expense_category_revision_non_negative', sql`(revision >= 0)`),
      check(
        'expense_category_state_known',
        sql`(state = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text]))`,
      ),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const expense = platform
  .table(
    'expense',
    {
      amountMnt: bigint('amount_mnt', { mode: 'bigint' }).notNull(),
      category: text('category').notNull(),
      categoryId: uuid('category_id'),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      createdByAccountId: uuid('created_by_account_id').notNull(),
      decidedAt: timestamp('decided_at', { withTimezone: true }),
      decidedByAccountId: uuid('decided_by_account_id'),
      decisionReason: text('decision_reason'),
      description: text('description').notNull(),
      expenseId: uuid('expense_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      hotelId: uuid('hotel_id').notNull(),
      locationId: uuid('location_id'),
      method: text('method').notNull(),
      movementId: uuid('movement_id'),
      paidAt: timestamp('paid_at', { withTimezone: true }),
      paidByAccountId: uuid('paid_by_account_id'),
      providerReference: text('provider_reference'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      selfApproved: boolean('self_approved')
        .notNull()
        .default(sql`false`),
      shiftId: uuid('shift_id'),
      expenseType: text('expense_type').notNull(),
      state: text('state')
        .notNull()
        .default(sql`'DRAFT'::text`),
      stockMovementId: uuid('stock_movement_id'),
      submittedAt: timestamp('submitted_at', { withTimezone: true }),
      supplier: text('supplier'),
    },
    (table) => [
      check('expense_amount_positive', sql`(amount_mnt > 0)`),
      foreignKey({
        name: 'expense_category_fkey',
        columns: [table.hotelId, table.categoryId],
        foreignColumns: [expenseCategory.hotelId, expenseCategory.categoryId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'expense_stock_movement_fkey',
        columns: [table.stockMovementId],
        foreignColumns: [inventoryMovement.movementId],
      }).onDelete('restrict'),
      check(
        'expense_stock_movement_kind',
        sql`((stock_movement_id IS NULL) OR (expense_type = 'INVENTORY_PURCHASE'::text))`,
      ),
      check(
        'expense_supplier_bounded',
        sql`((supplier IS NULL) OR ((length(supplier) >= 1) AND (length(supplier) <= 200)))`,
      ),
      check(
        'expense_type_known',
        sql`(expense_type = ANY (ARRAY['INVENTORY_PURCHASE'::text, 'OPERATING'::text]))`,
      ),
      uniqueIndex('expense_stock_movement_uq')
        .on(table.stockMovementId)
        .where(sql`stock_movement_id IS NOT NULL`),
      check(
        'expense_cash_payment_shape',
        sql`((state <> 'PAID'::text) OR (method <> 'CASH'::text) OR ((movement_id IS NOT NULL) AND (shift_id IS NOT NULL) AND (location_id IS NOT NULL)))`,
      ),
      check(
        'expense_decision_shape',
        sql`(((state = ANY (ARRAY['APPROVED'::text, 'PAID'::text, 'REJECTED'::text])) = (decided_at IS NOT NULL)) AND ((decided_at IS NULL) = (decided_by_account_id IS NULL)))`,
      ),
      foreignKey({
        name: 'expense_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'expense_location_fkey',
        columns: [table.hotelId, table.locationId],
        foreignColumns: [cashLocation.hotelId, cashLocation.cashLocationId],
      }).onDelete('restrict'),
      check(
        'expense_method_known',
        sql`(method = ANY (ARRAY['CASH'::text, 'CARD_POS'::text, 'BANK_QPAY'::text]))`,
      ),
      check(
        'expense_non_cash_payment_shape',
        sql`((method = 'CASH'::text) OR ((movement_id IS NULL) AND (shift_id IS NULL)))`,
      ),
      check(
        'expense_non_cash_reference_shape',
        sql`((state <> 'PAID'::text) OR (method = 'CASH'::text) OR (provider_reference IS NOT NULL))`,
      ),
      check(
        'expense_paid_shape',
        sql`((state = 'PAID'::text) = ((paid_at IS NOT NULL) AND (paid_by_account_id IS NOT NULL)))`,
      ),
      check('expense_revision_non_negative', sql`(revision >= 0)`),
      foreignKey({
        name: 'expense_shift_fkey',
        columns: [table.hotelId, table.shiftId],
        foreignColumns: [receptionShift.hotelId, receptionShift.shiftId],
      }).onDelete('restrict'),
      check(
        'expense_state_known',
        sql`(state = ANY (ARRAY['DRAFT'::text, 'SUBMITTED'::text, 'APPROVED'::text, 'PAID'::text, 'REJECTED'::text]))`,
      ),
      check('expense_submitted_shape', sql`((state = 'DRAFT'::text) = (submitted_at IS NULL))`),
      check(
        'expense_text_bounded',
        sql`(((length(category) >= 1) AND (length(category) <= 80)) AND ((length(description) >= 1) AND (length(description) <= 300)) AND ((decision_reason IS NULL) OR ((length(decision_reason) >= 1) AND (length(decision_reason) <= 300))) AND ((provider_reference IS NULL) OR ((length(provider_reference) >= 1) AND (length(provider_reference) <= 120))))`,
      ),
      index('expense_state_idx').on(table.hotelId, table.state, table.createdAt),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

// ---------------------------------------------------------------------
// Phase 12 — public discovery and Guest authentication.
// ---------------------------------------------------------------------

/**
 * The Guest's own account: one verified phone number, held as a keyed lookup
 * token beside the encrypted number itself, and never in the clear
 * (`BK-DEC-002`, doc 09 §6.2). Its identity is written once.
 */
export const guestAccount = platform.table(
  'guest_account',
  {
    accountId: uuid('account_id').primaryKey().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    displayName: text('display_name'),
    phoneCiphertext: bytea('phone_ciphertext'),
    phoneKeyVersion: text('phone_key_version'),
    phoneToken: text('phone_token'),
    phoneTokenKeyVersion: text('phone_token_key_version'),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
    phoneWrappedDek: bytea('phone_wrapped_dek'),
    realm: text('realm')
      .notNull()
      .default(sql`'guest'::text`),
    registeredVia: text('registered_via').notNull(),
    revision: integer('revision')
      .notNull()
      .default(sql`0`),
    state: text('state')
      .notNull()
      .default(sql`'ACTIVE'::text`),
  },
  (table) => [
    foreignKey({
      name: 'guest_account_account_fkey',
      columns: [table.accountId, table.realm],
      foreignColumns: [userAccount.accountId, userAccount.realm],
    }).onDelete('restrict'),
    check(
      'guest_account_display_name_bounded',
      sql`((display_name IS NULL) OR ((length(display_name) >= 1) AND (length(display_name) <= 120)))`,
    ),
    check(
      'guest_account_phone_all_or_nothing',
      sql`(num_nulls(phone_token, phone_token_key_version, phone_ciphertext, phone_wrapped_dek, phone_key_version, phone_verified_at) = ANY (ARRAY[0, 6]))`,
    ),
    check(
      'guest_account_phone_registration_has_phone',
      sql`((registered_via <> 'PHONE_OTP'::text) OR (phone_token IS NOT NULL))`,
    ),
    check('guest_account_realm_is_guest', sql`(realm = 'guest'::text)`),
    check(
      'guest_account_registered_via_known',
      sql`(registered_via = ANY (ARRAY['PHONE_OTP'::text, 'PROVIDER'::text]))`,
    ),
    check('guest_account_revision_non_negative', sql`(revision >= 0)`),
    check(
      'guest_account_state_known',
      sql`(state = ANY (ARRAY['ACTIVE'::text, 'SUSPENDED'::text, 'CLOSED'::text]))`,
    ),
    check(
      'guest_account_token_shape',
      sql`((phone_token IS NULL) OR (phone_token ~ '^[0-9a-f]{64}$'::text))`,
    ),
    uniqueIndex('guest_account_phone_token_uq')
      .on(table.phoneToken)
      .where(sql`phone_token IS NOT NULL`),
  ],
);

/**
 * The one-time code that proves a number. Stored as a keyed HMAC, time-limited
 * and attempt-limited; one live code per number and purpose, so a resend
 * supersedes rather than stacks (doc 09 §6.2).
 */
export const guestPhoneVerification = platform.table(
  'guest_phone_verification',
  {
    accountId: uuid('account_id'),
    attempts: integer('attempts')
      .notNull()
      .default(sql`0`),
    codeHash: text('code_hash').notNull(),
    codeKeyVersion: text('code_key_version').notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    maxAttempts: integer('max_attempts')
      .notNull()
      .default(sql`5`),
    phoneToken: text('phone_token').notNull(),
    purpose: text('purpose').notNull(),
    requestIpHash: text('request_ip_hash'),
    revision: integer('revision')
      .notNull()
      .default(sql`0`),
    sentAt: timestamp('sent_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    state: text('state')
      .notNull()
      .default(sql`'PENDING'::text`),
    verificationId: uuid('verification_id')
      .primaryKey()
      .notNull()
      .default(sql`gen_random_uuid()`),
  },
  (table) => [
    foreignKey({
      name: 'guest_phone_verification_account_fkey',
      columns: [table.accountId],
      foreignColumns: [userAccount.accountId],
    }).onDelete('restrict'),
    check(
      'guest_phone_verification_attempts_bounded',
      sql`((attempts >= 0) AND ((max_attempts >= 1) AND (max_attempts <= 10)) AND (attempts <= max_attempts))`,
    ),
    check('guest_phone_verification_code_shape', sql`(code_hash ~ '^[0-9a-f]{64}$'::text)`),
    check(
      'guest_phone_verification_consumed_shape',
      sql`((state = 'CONSUMED'::text) = (consumed_at IS NOT NULL))`,
    ),
    check('guest_phone_verification_expiry_after_send', sql`(expires_at > sent_at)`),
    check(
      'guest_phone_verification_ip_shape',
      sql`((request_ip_hash IS NULL) OR (request_ip_hash ~ '^[0-9a-f]{64}$'::text))`,
    ),
    check(
      'guest_phone_verification_purpose_known',
      sql`(purpose = ANY (ARRAY['REGISTER'::text, 'SIGN_IN'::text, 'PASSWORD_RESET'::text, 'ACCOUNT_LINK'::text]))`,
    ),
    check('guest_phone_verification_revision_non_negative', sql`(revision >= 0)`),
    check(
      'guest_phone_verification_state_known',
      sql`(state = ANY (ARRAY['PENDING'::text, 'CONSUMED'::text, 'EXPIRED'::text, 'LOCKED'::text]))`,
    ),
    check('guest_phone_verification_token_shape', sql`(phone_token ~ '^[0-9a-f]{64}$'::text)`),
    uniqueIndex('guest_phone_verification_one_pending_uq')
      .on(table.phoneToken, table.purpose)
      .where(sql`state = 'PENDING'::text`),
    index('guest_phone_verification_rate_idx').on(
      table.phoneToken,
      table.sentAt.desc().nullsFirst(),
    ),
  ],
);

/**
 * An external identity bound to a Guest account. What e-Mongolia returns is a
 * provider subject, tokenized under its own scope; the link is append-only and
 * one subject reaches one account (doc 09 §6.1).
 */
export const guestIdentityLink = platform.table(
  'guest_identity_link',
  {
    accountId: uuid('account_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    linkId: uuid('link_id')
      .primaryKey()
      .notNull()
      .default(sql`gen_random_uuid()`),
    linkedAt: timestamp('linked_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    linkedVia: text('linked_via').notNull(),
    provider: text('provider').notNull(),
    realm: text('realm')
      .notNull()
      .default(sql`'guest'::text`),
    revision: integer('revision')
      .notNull()
      .default(sql`0`),
    subjectKeyVersion: text('subject_key_version').notNull(),
    subjectToken: text('subject_token').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'guest_identity_link_account_fkey',
      columns: [table.accountId, table.realm],
      foreignColumns: [userAccount.accountId, userAccount.realm],
    }).onDelete('restrict'),
    check('guest_identity_link_provider_known', sql`(provider = 'EMONGOLIA'::text)`),
    check('guest_identity_link_realm_is_guest', sql`(realm = 'guest'::text)`),
    check('guest_identity_link_revision_non_negative', sql`(revision >= 0)`),
    check('guest_identity_link_subject_shape', sql`(subject_token ~ '^[0-9a-f]{64}$'::text)`),
    check(
      'guest_identity_link_via_known',
      sql`(linked_via = ANY (ARRAY['PROVIDER_REGISTRATION'::text, 'DUAL_CHANNEL_LINK'::text]))`,
    ),
    uniqueIndex('guest_identity_link_account_uq').on(table.provider, table.accountId),
    uniqueIndex('guest_identity_link_subject_uq').on(table.provider, table.subjectToken),
  ],
);

/**
 * The dual-channel confirmation doc 09 §6.3 requires before an e-Mongolia
 * identity joins an existing phone account. `CONFIRMED` is unreachable without
 * both channels, the verification it used and the link it produced.
 */
export const guestAccountLinkRequest = platform.table(
  'guest_account_link_request',
  {
    accountId: uuid('account_id').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    linkId: uuid('link_id'),
    phoneChannelVerifiedAt: timestamp('phone_channel_verified_at', { withTimezone: true }),
    provider: text('provider').notNull(),
    providerChannelVerifiedAt: timestamp('provider_channel_verified_at', { withTimezone: true }),
    realm: text('realm')
      .notNull()
      .default(sql`'guest'::text`),
    reason: text('reason'),
    requestId: uuid('request_id')
      .primaryKey()
      .notNull()
      .default(sql`gen_random_uuid()`),
    requestedAt: timestamp('requested_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    revision: integer('revision')
      .notNull()
      .default(sql`0`),
    state: text('state')
      .notNull()
      .default(sql`'PENDING'::text`),
    subjectKeyVersion: text('subject_key_version').notNull(),
    subjectToken: text('subject_token').notNull(),
    verificationId: uuid('verification_id'),
  },
  (table) => [
    foreignKey({
      name: 'guest_account_link_request_account_fkey',
      columns: [table.accountId, table.realm],
      foreignColumns: [userAccount.accountId, userAccount.realm],
    }).onDelete('restrict'),
    check(
      'guest_account_link_request_decided_shape',
      sql`((state = 'PENDING'::text) = (decided_at IS NULL))`,
    ),
    check(
      'guest_account_link_request_dual_channel',
      sql`((state <> 'CONFIRMED'::text) OR ((provider_channel_verified_at IS NOT NULL) AND (phone_channel_verified_at IS NOT NULL) AND (verification_id IS NOT NULL) AND (link_id IS NOT NULL)))`,
    ),
    foreignKey({
      name: 'guest_account_link_request_link_fkey',
      columns: [table.linkId],
      foreignColumns: [guestIdentityLink.linkId],
    }).onDelete('restrict'),
    check('guest_account_link_request_provider_known', sql`(provider = 'EMONGOLIA'::text)`),
    check('guest_account_link_request_realm_is_guest', sql`(realm = 'guest'::text)`),
    check(
      'guest_account_link_request_reason_bounded',
      sql`((reason IS NULL) OR ((length(reason) >= 1) AND (length(reason) <= 300)))`,
    ),
    check('guest_account_link_request_revision_non_negative', sql`(revision >= 0)`),
    check(
      'guest_account_link_request_state_known',
      sql`(state = ANY (ARRAY['PENDING'::text, 'CONFIRMED'::text, 'REJECTED'::text, 'EXPIRED'::text]))`,
    ),
    check(
      'guest_account_link_request_subject_shape',
      sql`(subject_token ~ '^[0-9a-f]{64}$'::text)`,
    ),
    foreignKey({
      name: 'guest_account_link_request_verification_fkey',
      columns: [table.verificationId],
      foreignColumns: [guestPhoneVerification.verificationId],
    }).onDelete('restrict'),
    index('guest_account_link_request_account_idx').on(table.accountId, table.state),
    uniqueIndex('guest_account_link_request_one_pending_uq')
      .on(table.provider, table.subjectToken)
      .where(sql`state = 'PENDING'::text`),
  ],
);

/**
 * The photographs a listing cannot be shown without (doc 09 §3.2, §3.3, §5).
 * The bytes live in private object storage; the row holds the key. One cover
 * per hotel, and a category photograph names its category.
 */
export const hotelPhoto = platform
  .table(
    'hotel_photo',
    {
      byteSize: integer('byte_size').notNull(),
      categoryId: uuid('category_id'),
      contentType: text('content_type').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      createdByAccountId: uuid('created_by_account_id').notNull(),
      hotelId: uuid('hotel_id').notNull(),
      isCover: boolean('is_cover')
        .notNull()
        .default(sql`false`),
      objectKey: text('object_key').notNull(),
      photoId: uuid('photo_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      sortOrder: integer('sort_order')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
      subjectType: text('subject_type').notNull(),
    },
    (table) => [
      foreignKey({
        name: 'hotel_photo_category_fkey',
        columns: [table.hotelId, table.categoryId],
        foreignColumns: [roomCategory.hotelId, roomCategory.categoryId],
      }).onDelete('restrict'),
      check(
        'hotel_photo_content_type_known',
        sql`(content_type = ANY (ARRAY['image/jpeg'::text, 'image/png'::text, 'image/webp'::text]))`,
      ),
      check('hotel_photo_cover_is_active', sql`((NOT is_cover) OR (state = 'ACTIVE'::text))`),
      check('hotel_photo_cover_is_hotel', sql`((NOT is_cover) OR (subject_type = 'HOTEL'::text))`),
      foreignKey({
        name: 'hotel_photo_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      unique('hotel_photo_identity_uq').on(table.hotelId, table.photoId),
      check(
        'hotel_photo_key_bounded',
        sql`((length(object_key) >= 1) AND (length(object_key) <= 400))`,
      ),
      check('hotel_photo_revision_non_negative', sql`(revision >= 0)`),
      check('hotel_photo_size_bounded', sql`((byte_size >= 1) AND (byte_size <= 10485760))`),
      check('hotel_photo_sort_non_negative', sql`(sort_order >= 0)`),
      check('hotel_photo_state_known', sql`(state = ANY (ARRAY['ACTIVE'::text, 'REMOVED'::text]))`),
      check(
        'hotel_photo_subject_known',
        sql`(subject_type = ANY (ARRAY['HOTEL'::text, 'ROOM_CATEGORY'::text]))`,
      ),
      check(
        'hotel_photo_subject_shape',
        sql`((subject_type = 'ROOM_CATEGORY'::text) = (category_id IS NOT NULL))`,
      ),
      uniqueIndex('hotel_photo_object_key_uq').on(table.objectKey),
      uniqueIndex('hotel_photo_one_cover_uq')
        .on(table.hotelId)
        .where(sql`is_cover IS TRUE`),
      index('hotel_photo_subject_idx').on(
        table.hotelId,
        table.subjectType,
        table.categoryId,
        table.sortOrder,
      ),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
      pgPolicy('public_listing_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(EXISTS ( SELECT 1
   FROM platform.hotel_profile p
  WHERE ((p.hotel_id = hotel_photo.hotel_id) AND (p.listing_state = 'PUBLISHED'::text))))`,
      }),
    ],
  )
  .enableRLS();

// ---------------------------------------------------------------------
// Phase 13 — online booking and inventory hold.
// ---------------------------------------------------------------------

/**
 * One online booking: one category unit, one primary staying guest, whole nights
 * only (`BK-DEC-012`). Its identity, window and booker are written once — a change
 * is a cancellation and a new booking — and its price is a snapshot, never
 * re-resolved (doc 09 §10).
 */
export const booking = platform
  .table(
    'booking',
    {
      bookerAccountId: uuid('booker_account_id').notNull(),
      bookingId: uuid('booking_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      bookingRef: text('booking_ref').notNull(),
      cancellationPolicyVersion: integer('cancellation_policy_version'),
      categoryId: uuid('category_id').notNull(),
      checkInDate: date('check_in_date').notNull(),
      checkOutDate: date('check_out_date').notNull(),
      confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      freeCancellationUntil: timestamp('free_cancellation_until', { withTimezone: true }),
      fulfilledStayId: uuid('fulfilled_stay_id'),
      holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }).notNull(),
      holdState: text('hold_state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
      hotelId: uuid('hotel_id').notNull(),
      nightCount: integer('night_count').notNull(),
      paymentState: text('payment_state')
        .notNull()
        .default(sql`'PENDING'::text`),
      pricingConfigVersion: integer('pricing_config_version'),
      rateSnapshotId: uuid('rate_snapshot_id'),
      refundState: text('refund_state')
        .notNull()
        .default(sql`'NONE'::text`),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'HOLDING'::text`),
      stayingGuestName: text('staying_guest_name').notNull(),
      stayingGuestPhoneToken: text('staying_guest_phone_token'),
      terminalAt: timestamp('terminal_at', { withTimezone: true }),
      terminalReason: text('terminal_reason'),
      totalAmountMnt: bigint('total_amount_mnt', { mode: 'bigint' }),
      unitRateMnt: bigint('unit_rate_mnt', { mode: 'bigint' }),
    },
    (table) => [
      check(
        'booking_amounts_non_negative',
        sql`(((unit_rate_mnt IS NULL) OR (unit_rate_mnt >= 0)) AND ((total_amount_mnt IS NULL) OR (total_amount_mnt >= 0)))`,
      ),
      foreignKey({
        name: 'booking_booker_fkey',
        columns: [table.bookerAccountId],
        foreignColumns: [guestAccount.accountId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'booking_category_fkey',
        columns: [table.hotelId, table.categoryId],
        foreignColumns: [roomCategory.hotelId, roomCategory.categoryId],
      }).onDelete('restrict'),
      check(
        'booking_confirmed_has_policy',
        sql`((state <> ALL (ARRAY['CONFIRMED'::text, 'CHECKED_IN'::text, 'COMPLETED'::text])) OR ((cancellation_policy_version IS NOT NULL) AND (free_cancellation_until IS NOT NULL)))`,
      ),
      check(
        'booking_confirmed_has_snapshot',
        sql`((state <> ALL (ARRAY['CONFIRMED'::text, 'CHECKED_IN'::text, 'COMPLETED'::text])) OR ((rate_snapshot_id IS NOT NULL) AND (unit_rate_mnt IS NOT NULL) AND (total_amount_mnt IS NOT NULL) AND (pricing_config_version IS NOT NULL)))`,
      ),
      check(
        'booking_confirmed_has_time',
        sql`((state <> ALL (ARRAY['CONFIRMED'::text, 'CHECKED_IN'::text, 'COMPLETED'::text])) OR (confirmed_at IS NOT NULL))`,
      ),
      check(
        'booking_fulfilled_shape',
        sql`((fulfilled_stay_id IS NOT NULL) = (state = ANY (ARRAY['CHECKED_IN'::text, 'COMPLETED'::text])))`,
      ),
      check(
        'booking_guest_name_bounded',
        sql`((length(staying_guest_name) >= 1) AND (length(staying_guest_name) <= 200))`,
      ),
      check(
        'booking_guest_phone_shape',
        sql`((staying_guest_phone_token IS NULL) OR (staying_guest_phone_token ~ '^[0-9a-f]{64}$'::text))`,
      ),
      check(
        'booking_hold_state_known',
        sql`(hold_state = ANY (ARRAY['ACTIVE'::text, 'CONSUMED'::text, 'EXPIRED'::text, 'CANCELLED'::text]))`,
      ),
      check(
        'booking_hotel_cancellation_refunds',
        sql`((state <> 'CANCELLED_HOTEL'::text) OR (payment_state <> 'PAID'::text) OR (refund_state <> 'NONE'::text))`,
      ),
      foreignKey({
        name: 'booking_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      unique('booking_identity_uq').on(table.hotelId, table.bookingId),
      check(
        'booking_nightly_window',
        sql`((check_out_date > check_in_date) AND (night_count = (check_out_date - check_in_date)) AND ((night_count >= 1) AND (night_count <= 90)))`,
      ),
      check(
        'booking_payment_state_known',
        sql`(payment_state = ANY (ARRAY['PENDING'::text, 'PAID'::text, 'FAILED'::text, 'EXPIRED'::text]))`,
      ),
      check(
        'booking_policy_version_positive',
        sql`((cancellation_policy_version IS NULL) OR (cancellation_policy_version > 0))`,
      ),
      check('booking_ref_shape', sql`(booking_ref ~ '^[A-Z0-9]{8,12}$'::text)`),
      check(
        'booking_refund_needs_payment',
        sql`((refund_state = 'NONE'::text) OR (payment_state = 'PAID'::text))`,
      ),
      check(
        'booking_refund_state_known',
        sql`(refund_state = ANY (ARRAY['NONE'::text, 'REQUIRED'::text, 'PENDING'::text, 'PARTIALLY_REFUNDED'::text, 'REFUNDED'::text, 'FAILED'::text]))`,
      ),
      check('booking_revision_non_negative', sql`(revision >= 0)`),
      check(
        'booking_state_known',
        sql`(state = ANY (ARRAY['HOLDING'::text, 'CONFIRMED'::text, 'CHECKED_IN'::text, 'COMPLETED'::text, 'EXPIRED'::text, 'CANCELLED_GUEST'::text, 'CANCELLED_HOTEL'::text, 'NO_SHOW'::text]))`,
      ),
      check(
        'booking_terminal_shape',
        sql`((state = ANY (ARRAY['EXPIRED'::text, 'CANCELLED_GUEST'::text, 'CANCELLED_HOTEL'::text, 'NO_SHOW'::text, 'COMPLETED'::text])) = (terminal_at IS NOT NULL))`,
      ),
      index('booking_booker_idx').on(table.bookerAccountId, table.createdAt.desc().nullsFirst()),
      index('booking_category_window_idx').on(
        table.hotelId,
        table.categoryId,
        table.checkInDate,
        table.checkOutDate,
      ),
      index('booking_expiry_idx')
        .on(table.holdExpiresAt)
        .where(sql`hold_state = 'ACTIVE'::text`),
      index('booking_hotel_state_idx').on(table.hotelId, table.state, table.checkInDate),
      uniqueIndex('booking_ref_uq').on(table.bookingRef),
      pgPolicy('public_availability_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(EXISTS ( SELECT 1\n   FROM platform.hotel_profile p\n  WHERE ((p.hotel_id = booking.hotel_id) AND (p.listing_state = 'PUBLISHED'::text))))`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
      pgPolicy('own_booking_read', {
        for: 'select',
        using: sql`((platform.current_hotel_id() = '00000000-0000-0000-0000-000000000000'::uuid) AND (booker_account_id = platform.current_account_id()))`,
      }),
    ],
  )
  .enableRLS();

/**
 * The nights a booking took. The occupancy arithmetic is exact because a
 * booking is the specific nights it holds, not a range that probably overlaps.
 */
export const bookingNight = platform
  .table(
    'booking_night',
    {
      bookingId: uuid('booking_id').notNull(),
      categoryId: uuid('category_id').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      hotelId: uuid('hotel_id').notNull(),
      night: date('night').notNull(),
    },
    (table) => [
      foreignKey({
        name: 'booking_night_booking_fkey',
        columns: [table.hotelId, table.bookingId],
        foreignColumns: [booking.hotelId, booking.bookingId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'booking_night_category_fkey',
        columns: [table.hotelId, table.categoryId],
        foreignColumns: [roomCategory.hotelId, roomCategory.categoryId],
      }).onDelete('restrict'),
      primaryKey({ name: 'booking_night_pkey', columns: [table.bookingId, table.night] }),
      index('booking_night_category_idx').on(table.hotelId, table.categoryId, table.night),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
      pgPolicy('public_availability_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(EXISTS ( SELECT 1\n   FROM platform.hotel_profile p\n  WHERE ((p.hotel_id = booking_night.hotel_id) AND (p.listing_state = 'PUBLISHED'::text))))`,
      }),
    ],
  )
  .enableRLS();

/**
 * The capacity of a category on one night and the units taken
 * (`BK-DEC-013`). `CHECK (units_held <= units_capacity)` is the whole
 * anti-overbooking rule, held by the database rather than by a query that
 * counted and then acted.
 */
export const categoryNightInventory = platform
  .table(
    'category_night_inventory',
    {
      categoryId: uuid('category_id').notNull(),
      hotelId: uuid('hotel_id').notNull(),
      night: date('night').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      unitsCapacity: integer('units_capacity').notNull(),
      unitsHeld: integer('units_held')
        .notNull()
        .default(sql`0`),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
    },
    (table) => [
      check('category_night_inventory_capacity_non_negative', sql`(units_capacity >= 0)`),
      foreignKey({
        name: 'category_night_inventory_category_fkey',
        columns: [table.hotelId, table.categoryId],
        foreignColumns: [roomCategory.hotelId, roomCategory.categoryId],
      }).onDelete('restrict'),
      primaryKey({
        name: 'category_night_inventory_pkey',
        columns: [table.hotelId, table.categoryId, table.night],
      }),
      check('category_night_inventory_revision_non_negative', sql`(revision >= 0)`),
      check(
        'category_night_inventory_within_capacity',
        sql`((units_held >= 0) AND (units_held <= units_capacity))`,
      ),
      pgPolicy('public_availability_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(EXISTS ( SELECT 1\n   FROM platform.hotel_profile p\n  WHERE ((p.hotel_id = category_night_inventory.hotel_id) AND (p.listing_state = 'PUBLISHED'::text))))`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * One attempt to pay for a booking. Exactly one is `ACTIVE` at a time, held by
 * a partial unique index; a provider switch supersedes rather than replaces,
 * and no session outlives the hold that authorized it (doc 09 §8).
 */
export const bookingPaymentAttempt = platform
  .table(
    'booking_payment_attempt',
    {
      amountMnt: bigint('amount_mnt', { mode: 'bigint' }).notNull(),
      attemptId: uuid('attempt_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      bookingId: uuid('booking_id').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      hotelId: uuid('hotel_id').notNull(),
      provider: text('provider').notNull(),
      providerInvoiceId: text('provider_invoice_id'),
      providerPaymentId: text('provider_payment_id'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      settledAt: timestamp('settled_at', { withTimezone: true }),
      settledReason: text('settled_reason'),
      state: text('state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
    },
    (table) => [
      check('booking_payment_attempt_amount_positive', sql`(amount_mnt > 0)`),
      foreignKey({
        name: 'booking_payment_attempt_booking_fkey',
        columns: [table.hotelId, table.bookingId],
        foreignColumns: [booking.hotelId, booking.bookingId],
      }).onDelete('restrict'),
      check(
        'booking_payment_attempt_provider_known',
        sql`(provider = ANY (ARRAY['QPAY'::text, 'KHAAN'::text]))`,
      ),
      check(
        'booking_payment_attempt_payment_shape',
        sql`((provider_payment_id IS NULL) OR ((length(provider_payment_id) >= 1) AND (length(provider_payment_id) <= 200)))`,
      ),
      check('booking_payment_attempt_revision_non_negative', sql`(revision >= 0)`),
      check(
        'booking_payment_attempt_settled_shape',
        sql`((state = 'ACTIVE'::text) = (settled_at IS NULL))`,
      ),
      check(
        'booking_payment_attempt_state_known',
        sql`(state = ANY (ARRAY['ACTIVE'::text, 'SUPERSEDED'::text, 'PAID'::text, 'FAILED'::text, 'EXPIRED'::text]))`,
      ),
      index('booking_payment_attempt_booking_idx').on(
        table.bookingId,
        table.createdAt.desc().nullsFirst(),
      ),
      uniqueIndex('booking_payment_attempt_invoice_uq')
        .on(table.provider, table.providerInvoiceId)
        .where(sql`provider_invoice_id IS NOT NULL`),
      uniqueIndex('booking_payment_attempt_one_active_uq')
        .on(table.bookingId)
        .where(sql`state = 'ACTIVE'::text`),
      uniqueIndex('booking_payment_attempt_payment_uq')
        .on(table.provider, table.providerPaymentId)
        .where(sql`provider_payment_id IS NOT NULL`),
      pgPolicy('callback_dispatch_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(provider_invoice_id IS NOT NULL)`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The booking's append-only history: an expiry and a guest cancellation are
 * different facts, and neither is recoverable from the row's state alone.
 */
export const bookingEvent = platform
  .table(
    'booking_event',
    {
      actorRef: text('actor_ref').notNull(),
      bookingId: uuid('booking_id').notNull(),
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
      reason: text('reason'),
      toState: text('to_state'),
    },
    (table) => [
      check(
        'booking_event_actor_bounded',
        sql`((length(actor_ref) >= 1) AND (length(actor_ref) <= 120))`,
      ),
      foreignKey({
        name: 'booking_event_booking_fkey',
        columns: [table.hotelId, table.bookingId],
        foreignColumns: [booking.hotelId, booking.bookingId],
      }).onDelete('restrict'),
      check(
        'booking_event_reason_bounded',
        sql`((reason IS NULL) OR ((length(reason) >= 1) AND (length(reason) <= 300)))`,
      ),
      check(
        'booking_event_type_bounded',
        sql`((length(event_type) >= 1) AND (length(event_type) <= 80))`,
      ),
      index('booking_event_booking_idx').on(table.bookingId, table.occurredAt),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The explicit, negotiated commission rate a hotel sells online under
 * (`PAY-DEC-001`, `BK-DEC-008`). `commission_rate_bps` has no default because
 * the decision refuses one: a hotel with no active contract takes no online
 * payment at all.
 */
export const hotelCommissionContract = platform
  .table(
    'hotel_commission_contract',
    {
      cancellationPolicyVersion: integer('cancellation_policy_version').notNull(),
      commissionRateBps: integer('commission_rate_bps').notNull(),
      contractId: uuid('contract_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      contractVersion: integer('contract_version').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
      effectiveTo: timestamp('effective_to', { withTimezone: true }),
      hotelId: uuid('hotel_id').notNull(),
      partyType: text('party_type').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
    },
    (table) => [
      foreignKey({
        name: 'hotel_commission_contract_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      unique('hotel_commission_contract_identity_uq').on(table.hotelId, table.contractId),
      check(
        'hotel_commission_contract_party_known',
        sql`(party_type = ANY (ARRAY['INDIVIDUAL'::text, 'ORGANISATION'::text, 'NEGOTIATED'::text]))`,
      ),
      check(
        'hotel_commission_contract_rate_bounded',
        sql`((commission_rate_bps >= 0) AND (commission_rate_bps <= 10000))`,
      ),
      check('hotel_commission_contract_revision_non_negative', sql`(revision >= 0)`),
      check(
        'hotel_commission_contract_state_known',
        sql`(state = ANY (ARRAY['ACTIVE'::text, 'SUPERSEDED'::text, 'TERMINATED'::text]))`,
      ),
      check(
        'hotel_commission_contract_version_positive',
        sql`((contract_version > 0) AND (cancellation_policy_version > 0))`,
      ),
      unique('hotel_commission_contract_version_uq').on(table.hotelId, table.contractVersion),
      check(
        'hotel_commission_contract_window',
        sql`((effective_to IS NULL) OR (effective_to > effective_from))`,
      ),
      uniqueIndex('hotel_commission_contract_active_uq')
        .on(table.hotelId)
        .where(sql`state = 'ACTIVE'::text`),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * What one booking earns the hotel, with the contract snapshot it was settled
 * under. `retained = gross - refunded`, `commission = ROUND_HALF_UP(retained x
 * rate)` and `payable = retained - commission` are CHECKs on the row
 * (`PAY-DEC-008`); the provider fee is here and is a term of none of them
 * (`BK-DEC-011`).
 */
export const bookingPayable = platform
  .table(
    'booking_payable',
    {
      bookingId: uuid('booking_id').notNull(),
      commissionMnt: bigint('commission_mnt', { mode: 'bigint' }).notNull(),
      commissionRateBps: integer('commission_rate_bps').notNull(),
      contractId: uuid('contract_id').notNull(),
      contractVersion: integer('contract_version').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      eligibleAt: timestamp('eligible_at', { withTimezone: true }),
      eligibleLocalDate: date('eligible_local_date'),
      grossPaidMnt: bigint('gross_paid_mnt', { mode: 'bigint' }).notNull(),
      holdReason: text('hold_reason'),
      hotelId: uuid('hotel_id').notNull(),
      hotelPayableMnt: bigint('hotel_payable_mnt', { mode: 'bigint' }).notNull(),
      paidOutMnt: bigint('paid_out_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      payableId: uuid('payable_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      payoutState: text('payout_state')
        .notNull()
        .default(sql`'NOT_ELIGIBLE'::text`),
      providerFeeMnt: bigint('provider_fee_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      refundedMnt: bigint('refunded_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      retainedMnt: bigint('retained_mnt', { mode: 'bigint' }).notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
    },
    (table) => [
      check(
        'booking_payable_adjustment_when_overpaid',
        sql`((payout_state <> 'ADJUSTMENT_DUE'::text) OR (hotel_payable_mnt < paid_out_mnt))`,
      ),
      check(
        'booking_payable_amounts_non_negative',
        sql`((gross_paid_mnt >= 0) AND (refunded_mnt >= 0) AND (provider_fee_mnt >= 0) AND (paid_out_mnt >= 0))`,
      ),
      foreignKey({
        name: 'booking_payable_booking_fkey',
        columns: [table.hotelId, table.bookingId],
        foreignColumns: [booking.hotelId, booking.bookingId],
      }).onDelete('restrict'),
      unique('booking_payable_booking_uq').on(table.bookingId),
      check(
        'booking_payable_commission_rounded',
        sql`(commission_mnt = (((retained_mnt * commission_rate_bps) + 5000) / 10000))`,
      ),
      foreignKey({
        name: 'booking_payable_contract_fkey',
        columns: [table.hotelId, table.contractId],
        foreignColumns: [hotelCommissionContract.hotelId, hotelCommissionContract.contractId],
      }).onDelete('restrict'),
      check(
        'booking_payable_eligible_shape',
        sql`((eligible_at IS NULL) = (eligible_local_date IS NULL))`,
      ),
      check(
        'booking_payable_eligible_when_due',
        sql`((payout_state <> 'ELIGIBLE'::text) OR ((eligible_at IS NOT NULL) AND (hotel_payable_mnt > paid_out_mnt)))`,
      ),
      check(
        'booking_payable_hold_reason_bounded',
        sql`((hold_reason IS NULL) OR ((length(hold_reason) >= 1) AND (length(hold_reason) <= 200)))`,
      ),
      check(
        'booking_payable_hotel_share',
        sql`(hotel_payable_mnt = (retained_mnt - commission_mnt))`,
      ),
      unique('booking_payable_identity_uq').on(table.hotelId, table.payableId),
      check(
        'booking_payable_rate_bounded',
        sql`((commission_rate_bps >= 0) AND (commission_rate_bps <= 10000))`,
      ),
      check('booking_payable_refund_within_capture', sql`(refunded_mnt <= gross_paid_mnt)`),
      check('booking_payable_retained_base', sql`(retained_mnt = (gross_paid_mnt - refunded_mnt))`),
      check('booking_payable_revision_non_negative', sql`(revision >= 0)`),
      check(
        'booking_payable_state_known',
        sql`(payout_state = ANY (ARRAY['NOT_ELIGIBLE'::text, 'ELIGIBLE'::text, 'HELD'::text, 'BATCHED'::text, 'PAID'::text, 'FAILED'::text, 'ADJUSTMENT_DUE'::text]))`,
      ),
      index('booking_payable_due_idx')
        .on(table.payoutState, table.eligibleLocalDate)
        .where(sql`payout_state = ANY (ARRAY['ELIGIBLE'::text, 'ADJUSTMENT_DUE'::text])`),
      pgPolicy('payout_dispatch_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(payout_state = ANY (ARRAY['ELIGIBLE'::text, 'ADJUSTMENT_DUE'::text]))`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The append-only money ledger of doc 11 §9. `source_ref` is unique per event
 * type, so a duplicated callback, a retried job or a replayed batch posts once.
 */
export const bookingLedgerEvent = platform
  .table(
    'booking_ledger_event',
    {
      amountMnt: bigint('amount_mnt', { mode: 'bigint' }).notNull(),
      bankReference: text('bank_reference'),
      bookingId: uuid('booking_id').notNull(),
      currency: text('currency')
        .notNull()
        .default(sql`'MNT'::text`),
      eventType: text('event_type').notNull(),
      hotelId: uuid('hotel_id').notNull(),
      ledgerEventId: uuid('ledger_event_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      occurredAt: timestamp('occurred_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      payableId: uuid('payable_id'),
      provider: text('provider'),
      providerPaymentId: text('provider_payment_id'),
      providerRefundId: text('provider_refund_id'),
      recordedAt: timestamp('recorded_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      sourceRef: text('source_ref').notNull(),
    },
    (table) => [
      foreignKey({
        name: 'booking_ledger_event_booking_fkey',
        columns: [table.hotelId, table.bookingId],
        foreignColumns: [booking.hotelId, booking.bookingId],
      }).onDelete('restrict'),
      check('booking_ledger_event_currency_known', sql`(currency = 'MNT'::text)`),
      foreignKey({
        name: 'booking_ledger_event_payable_fkey',
        columns: [table.hotelId, table.payableId],
        foreignColumns: [bookingPayable.hotelId, bookingPayable.payableId],
      }).onDelete('restrict'),
      check(
        'booking_ledger_event_provider_known',
        sql`((provider IS NULL) OR (provider = ANY (ARRAY['QPAY'::text, 'KHAAN'::text])))`,
      ),
      check(
        'booking_ledger_event_reference_bounded',
        sql`((bank_reference IS NULL) OR ((length(bank_reference) >= 1) AND (length(bank_reference) <= 120)))`,
      ),
      check(
        'booking_ledger_event_source_bounded',
        sql`((length(source_ref) >= 1) AND (length(source_ref) <= 200))`,
      ),
      check(
        'booking_ledger_event_type_known',
        sql`(event_type = ANY (ARRAY['PAYMENT'::text, 'COMMISSION'::text, 'HOTEL_PAYABLE'::text, 'PROVIDER_FEE'::text, 'REFUND'::text, 'ADJUSTMENT'::text, 'PAYOUT'::text]))`,
      ),
      index('booking_ledger_event_booking_idx').on(table.bookingId, table.occurredAt),
      uniqueIndex('booking_ledger_event_cause_uq').on(table.eventType, table.sourceRef),
      index('booking_ledger_event_payable_idx').on(table.payableId, table.eventType),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The refund axis, which only a verified provider result moves (`PAY-DEC-007`).
 * A refund naming a payable reduces the commission base; a refund of a late or
 * duplicate capture names none and reduces nothing.
 */
export const bookingRefund = platform
  .table(
    'booking_refund',
    {
      amountMnt: bigint('amount_mnt', { mode: 'bigint' }).notNull(),
      bookingId: uuid('booking_id').notNull(),
      failureCode: text('failure_code'),
      hotelId: uuid('hotel_id').notNull(),
      payableId: uuid('payable_id'),
      provider: text('provider').notNull(),
      providerPaymentId: text('provider_payment_id'),
      providerRefundId: text('provider_refund_id'),
      reason: text('reason').notNull(),
      refundId: uuid('refund_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      requestedAt: timestamp('requested_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      settledAt: timestamp('settled_at', { withTimezone: true }),
      sourceRef: text('source_ref').notNull(),
      state: text('state')
        .notNull()
        .default(sql`'REQUIRED'::text`),
    },
    (table) => [
      check('booking_refund_amount_positive', sql`(amount_mnt > 0)`),
      foreignKey({
        name: 'booking_refund_booking_fkey',
        columns: [table.hotelId, table.bookingId],
        foreignColumns: [booking.hotelId, booking.bookingId],
      }).onDelete('restrict'),
      unique('booking_refund_cause_uq').on(table.bookingId, table.sourceRef),
      check(
        'booking_refund_completed_has_reference',
        sql`((state <> 'REFUNDED'::text) OR (provider_refund_id IS NOT NULL))`,
      ),
      check(
        'booking_refund_failure_shape',
        sql`((failure_code IS NULL) OR ((length(failure_code) >= 1) AND (length(failure_code) <= 80)))`,
      ),
      foreignKey({
        name: 'booking_refund_payable_fkey',
        columns: [table.hotelId, table.payableId],
        foreignColumns: [bookingPayable.hotelId, bookingPayable.payableId],
      }).onDelete('restrict'),
      check(
        'booking_refund_provider_known',
        sql`(provider = ANY (ARRAY['QPAY'::text, 'KHAAN'::text]))`,
      ),
      check(
        'booking_refund_reason_known',
        sql`(reason = ANY (ARRAY['GUEST_CANCELLATION'::text, 'LATE_CANCELLATION_BALANCE'::text, 'NO_SHOW_BALANCE'::text, 'HOTEL_CANCELLATION'::text, 'LATE_PAYMENT_AFTER_HOLD'::text, 'DUPLICATE_CAPTURE'::text]))`,
      ),
      check('booking_refund_revision_non_negative', sql`(revision >= 0)`),
      check(
        'booking_refund_settled_shape',
        sql`((state = ANY (ARRAY['REFUNDED'::text, 'FAILED'::text])) = (settled_at IS NOT NULL))`,
      ),
      check(
        'booking_refund_source_bounded',
        sql`((length(source_ref) >= 1) AND (length(source_ref) <= 200))`,
      ),
      check(
        'booking_refund_state_known',
        sql`(state = ANY (ARRAY['REQUIRED'::text, 'PENDING'::text, 'REFUNDED'::text, 'FAILED'::text]))`,
      ),
      index('booking_refund_open_idx')
        .on(table.state, table.requestedAt)
        .where(sql`state = ANY (ARRAY['REQUIRED'::text, 'PENDING'::text])`),
      uniqueIndex('booking_refund_provider_refund_uq')
        .on(table.providerRefundId)
        .where(sql`provider_refund_id IS NOT NULL`),
      pgPolicy('refund_dispatch_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(state = ANY (ARRAY['REQUIRED'::text, 'PENDING'::text]))`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * One `D+1 12:00 Asia/Ulaanbaatar` payout attempt (`PAY-DEC-009`). A retry is a
 * new `attempt_no`, never an overwrite, and the totals CHECK is what makes
 * "the batch reconciles" a property of the row.
 */
export const payoutBatch = platform
  .table(
    'payout_batch',
    {
      adjustmentMnt: bigint('adjustment_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      attemptNo: integer('attempt_no')
        .notNull()
        .default(sql`1`),
      bankReference: text('bank_reference'),
      batchId: uuid('batch_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      batchLocalDate: date('batch_local_date').notNull(),
      commissionMnt: bigint('commission_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      failureCode: text('failure_code'),
      grossPaidMnt: bigint('gross_paid_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      hotelId: uuid('hotel_id').notNull(),
      hotelPayableMnt: bigint('hotel_payable_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      refundedMnt: bigint('refunded_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      retainedMnt: bigint('retained_mnt', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
      settledAt: timestamp('settled_at', { withTimezone: true }),
      state: text('state')
        .notNull()
        .default(sql`'OPEN'::text`),
    },
    (table) => [
      check('payout_batch_adjustment_never_adds', sql`(adjustment_mnt <= 0)`),
      check(
        'payout_batch_amounts_non_negative',
        sql`((gross_paid_mnt >= 0) AND (refunded_mnt >= 0) AND (retained_mnt >= 0) AND (commission_mnt >= 0))`,
      ),
      check('payout_batch_attempt_positive', sql`(attempt_no > 0)`),
      unique('payout_batch_attempt_uq').on(table.hotelId, table.batchLocalDate, table.attemptNo),
      check(
        'payout_batch_failure_bounded',
        sql`((failure_code IS NULL) OR ((length(failure_code) >= 1) AND (length(failure_code) <= 80)))`,
      ),
      foreignKey({
        name: 'payout_batch_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      unique('payout_batch_identity_uq').on(table.hotelId, table.batchId),
      check(
        'payout_batch_paid_has_reference',
        sql`((state <> 'PAID'::text) OR (bank_reference IS NOT NULL))`,
      ),
      check(
        'payout_batch_reconciles',
        sql`(hotel_payable_mnt = ((retained_mnt - commission_mnt) + adjustment_mnt))`,
      ),
      check(
        'payout_batch_reference_bounded',
        sql`((bank_reference IS NULL) OR ((length(bank_reference) >= 1) AND (length(bank_reference) <= 120)))`,
      ),
      check('payout_batch_retained_base', sql`(retained_mnt = (gross_paid_mnt - refunded_mnt))`),
      check('payout_batch_revision_non_negative', sql`(revision >= 0)`),
      check(
        'payout_batch_settled_shape',
        sql`((state = ANY (ARRAY['PAID'::text, 'FAILED'::text])) = (settled_at IS NOT NULL))`,
      ),
      check(
        'payout_batch_state_known',
        sql`(state = ANY (ARRAY['OPEN'::text, 'SUBMITTED'::text, 'PAID'::text, 'FAILED'::text]))`,
      ),
      index('payout_batch_open_idx').on(table.hotelId, table.state, table.scheduledAt),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The lines of a batch. The partial unique index on settled `PAYABLE` lines is
 * doc 11 §8's "one booking payable enters exactly one successful payout".
 */
export const payoutBatchItem = platform
  .table(
    'payout_batch_item',
    {
      amountMnt: bigint('amount_mnt', { mode: 'bigint' }).notNull(),
      batchId: uuid('batch_id').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      hotelId: uuid('hotel_id').notNull(),
      itemId: uuid('item_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      kind: text('kind').notNull(),
      payableId: uuid('payable_id').notNull(),
      settled: boolean('settled')
        .notNull()
        .default(sql`false`),
    },
    (table) => [
      check(
        'payout_batch_item_adjustment_negative',
        sql`((kind <> 'ADJUSTMENT'::text) OR (amount_mnt < 0))`,
      ),
      foreignKey({
        name: 'payout_batch_item_batch_fkey',
        columns: [table.hotelId, table.batchId],
        foreignColumns: [payoutBatch.hotelId, payoutBatch.batchId],
      }).onDelete('restrict'),
      check(
        'payout_batch_item_kind_known',
        sql`(kind = ANY (ARRAY['PAYABLE'::text, 'ADJUSTMENT'::text]))`,
      ),
      foreignKey({
        name: 'payout_batch_item_payable_fkey',
        columns: [table.hotelId, table.payableId],
        foreignColumns: [bookingPayable.hotelId, bookingPayable.payableId],
      }).onDelete('restrict'),
      check(
        'payout_batch_item_payable_positive',
        sql`((kind <> 'PAYABLE'::text) OR (amount_mnt > 0))`,
      ),
      unique('payout_batch_item_uq').on(table.batchId, table.payableId, table.kind),
      index('payout_batch_item_batch_idx').on(table.batchId),
      uniqueIndex('payout_batch_item_settled_payable_uq')
        .on(table.payableId)
        .where(sql`settled AND (kind = 'PAYABLE'::text)`),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * doc 08 §3: the restaurant a Manager Plus registered on a 30,000₮ package.
 * Activation lives on the link, not here, so one restaurant can later be linked
 * to more than one hotel on separate terms (doc 08 §4).
 */
export const restaurant = platform
  .table(
    'restaurant',
    {
      addressLine: text('address_line').notNull(),
      contactPhone: text('contact_phone').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      cuisineKind: text('cuisine_kind').notNull(),
      description: text('description'),
      displayName: text('display_name').notNull(),
      hotelId: uuid('hotel_id').notNull(),
      latitudeMicro: integer('latitude_micro').notNull(),
      longitudeMicro: integer('longitude_micro').notNull(),
      restaurantId: uuid('restaurant_id')
        .primaryKey()
        .notNull()
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
    (table) => [
      check(
        'restaurant_address_bounded',
        sql`((length(address_line) >= 1) AND (length(address_line) <= 300))`,
      ),
      check(
        'restaurant_description_bounded',
        sql`((description IS NULL) OR ((length(description) >= 1) AND (length(description) <= 2000)))`,
      ),
      foreignKey({
        name: 'restaurant_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      unique('restaurant_identity_uq').on(table.hotelId, table.restaurantId),
      check(
        'restaurant_kind_bounded',
        sql`((length(cuisine_kind) >= 1) AND (length(cuisine_kind) <= 80))`,
      ),
      check(
        'restaurant_name_bounded',
        sql`((length(display_name) >= 1) AND (length(display_name) <= 200))`,
      ),
      check('restaurant_phone_shape', sql`(contact_phone ~ '^\\+976[0-9]{8}$'::text)`),
      check(
        'restaurant_position_bounded',
        sql`(((latitude_micro >= '-90000000'::integer) AND (latitude_micro <= 90000000)) AND ((longitude_micro >= '-180000000'::integer) AND (longitude_micro <= 180000000)))`,
      ),
      check('restaurant_revision_non_negative', sql`(revision >= 0)`),
      check(
        'restaurant_state_known',
        sql`(state = ANY (ARRAY['ACTIVE'::text, 'SUSPENDED'::text]))`,
      ),
      check('restaurant_timezone_known', sql`(timezone = 'Asia/Ulaanbaatar'::text)`),
      index('restaurant_hotel_idx').on(table.hotelId, table.state),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * doc 08 §4: whether this hotel may order from this restaurant. The
 * `RC-DEC-031` SLA pause is a separate column from the manual state, so lifting
 * the pause cannot switch a link back on that Manager Plus had switched off.
 */
export const hotelRestaurantLink = platform
  .table(
    'hotel_restaurant_link',
    {
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      hotelId: uuid('hotel_id').notNull(),
      linkId: uuid('link_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      linkState: text('link_state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
      restaurantId: uuid('restaurant_id').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      slaPaused: boolean('sla_paused')
        .notNull()
        .default(sql`false`),
      slaPausedAt: timestamp('sla_paused_at', { withTimezone: true }),
      slaPausedReason: text('sla_paused_reason'),
    },
    (table) => [
      foreignKey({
        name: 'hotel_restaurant_link_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      unique('hotel_restaurant_link_identity_uq').on(table.hotelId, table.linkId),
      check(
        'hotel_restaurant_link_pause_reason_bounded',
        sql`((sla_paused_reason IS NULL) OR ((length(sla_paused_reason) >= 1) AND (length(sla_paused_reason) <= 200)))`,
      ),
      check('hotel_restaurant_link_pause_shape', sql`(sla_paused = (sla_paused_at IS NOT NULL))`),
      foreignKey({
        name: 'hotel_restaurant_link_restaurant_fkey',
        columns: [table.hotelId, table.restaurantId],
        foreignColumns: [restaurant.hotelId, restaurant.restaurantId],
      }).onDelete('restrict'),
      check('hotel_restaurant_link_revision_non_negative', sql`(revision >= 0)`),
      check(
        'hotel_restaurant_link_state_known',
        sql`(link_state = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text]))`,
      ),
      unique('hotel_restaurant_link_uq').on(table.hotelId, table.restaurantId),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * doc 08 §5: one ordering window per weekday. An overnight window is the case
 * where `closes_at <= opens_at`, which is why the domain reasons in local
 * wall-clock terms rather than by comparing two instants.
 */
export const restaurantSchedule = platform
  .table(
    'restaurant_schedule',
    {
      closed: boolean('closed')
        .notNull()
        .default(sql`false`),
      closesAt: wallTime('closes_at'),
      hotelId: uuid('hotel_id').notNull(),
      opensAt: wallTime('opens_at'),
      restaurantId: uuid('restaurant_id').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      scheduleId: uuid('schedule_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      weekday: integer('weekday').notNull(),
    },
    (table) => [
      foreignKey({
        name: 'restaurant_schedule_restaurant_fkey',
        columns: [table.hotelId, table.restaurantId],
        foreignColumns: [restaurant.hotelId, restaurant.restaurantId],
      }).onDelete('restrict'),
      check('restaurant_schedule_revision_non_negative', sql`(revision >= 0)`),
      unique('restaurant_schedule_uq').on(table.restaurantId, table.weekday),
      check('restaurant_schedule_weekday_known', sql`((weekday >= 0) AND (weekday <= 6))`),
      check(
        'restaurant_schedule_window_shape',
        sql`((closed = (opens_at IS NULL)) AND (closed = (closes_at IS NULL)))`,
      ),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/** doc 08 §5: a holiday or a temporary closure, outranking the weekly row. */
export const restaurantScheduleOverride = platform
  .table(
    'restaurant_schedule_override',
    {
      closed: boolean('closed')
        .notNull()
        .default(sql`true`),
      closesAt: wallTime('closes_at'),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      hotelId: uuid('hotel_id').notNull(),
      localDate: date('local_date').notNull(),
      opensAt: wallTime('opens_at'),
      overrideId: uuid('override_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      reason: text('reason'),
      restaurantId: uuid('restaurant_id').notNull(),
    },
    (table) => [
      check(
        'restaurant_schedule_override_reason_bounded',
        sql`((reason IS NULL) OR ((length(reason) >= 1) AND (length(reason) <= 200)))`,
      ),
      foreignKey({
        name: 'restaurant_schedule_override_restaurant_fkey',
        columns: [table.hotelId, table.restaurantId],
        foreignColumns: [restaurant.hotelId, restaurant.restaurantId],
      }).onDelete('restrict'),
      unique('restaurant_schedule_override_uq').on(table.restaurantId, table.localDate),
      check(
        'restaurant_schedule_override_window_shape',
        sql`((closed = (opens_at IS NULL)) AND (closed = (closes_at IS NULL)))`,
      ),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/** doc 08 §6: the menu's own sections. */
export const restaurantMenuCategory = platform
  .table(
    'restaurant_menu_category',
    {
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      hotelId: uuid('hotel_id').notNull(),
      menuCategoryId: uuid('menu_category_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      name: text('name').notNull(),
      restaurantId: uuid('restaurant_id').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      sortOrder: integer('sort_order')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
    },
    (table) => [
      unique('restaurant_menu_category_identity_uq').on(table.restaurantId, table.menuCategoryId),
      check(
        'restaurant_menu_category_name_bounded',
        sql`((length(name) >= 1) AND (length(name) <= 120))`,
      ),
      unique('restaurant_menu_category_name_uq').on(table.restaurantId, table.name),
      foreignKey({
        name: 'restaurant_menu_category_restaurant_fkey',
        columns: [table.hotelId, table.restaurantId],
        foreignColumns: [restaurant.hotelId, restaurant.restaurantId],
      }).onDelete('restrict'),
      check('restaurant_menu_category_revision_non_negative', sql`(revision >= 0)`),
      check(
        'restaurant_menu_category_state_known',
        sql`(state = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text]))`,
      ),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * doc 08 §6: the price is the server's. A basket total is recomputed from these
 * rows and never taken from the guest's device.
 */
export const restaurantMenuItem = platform
  .table(
    'restaurant_menu_item',
    {
      available: boolean('available')
        .notNull()
        .default(sql`true`),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      description: text('description'),
      hotelId: uuid('hotel_id').notNull(),
      imageObjectKey: text('image_object_key'),
      itemId: uuid('item_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      menuCategoryId: uuid('menu_category_id').notNull(),
      name: text('name').notNull(),
      priceMnt: bigint('price_mnt', { mode: 'bigint' }).notNull(),
      restaurantId: uuid('restaurant_id').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
    },
    (table) => [
      foreignKey({
        name: 'restaurant_menu_item_category_fkey',
        columns: [table.restaurantId, table.menuCategoryId],
        foreignColumns: [
          restaurantMenuCategory.restaurantId,
          restaurantMenuCategory.menuCategoryId,
        ],
      }).onDelete('restrict'),
      check(
        'restaurant_menu_item_description_bounded',
        sql`((description IS NULL) OR ((length(description) >= 1) AND (length(description) <= 1000)))`,
      ),
      unique('restaurant_menu_item_identity_uq').on(table.restaurantId, table.itemId),
      check(
        'restaurant_menu_item_image_bounded',
        sql`((image_object_key IS NULL) OR ((length(image_object_key) >= 1) AND (length(image_object_key) <= 300)))`,
      ),
      check(
        'restaurant_menu_item_name_bounded',
        sql`((length(name) >= 1) AND (length(name) <= 200))`,
      ),
      check('restaurant_menu_item_price_positive', sql`(price_mnt > 0)`),
      foreignKey({
        name: 'restaurant_menu_item_restaurant_fkey',
        columns: [table.hotelId, table.restaurantId],
        foreignColumns: [restaurant.hotelId, restaurant.restaurantId],
      }).onDelete('restrict'),
      check('restaurant_menu_item_revision_non_negative', sql`(revision >= 0)`),
      check(
        'restaurant_menu_item_state_known',
        sql`(state = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text]))`,
      ),
      index('restaurant_menu_item_menu_idx').on(
        table.restaurantId,
        table.menuCategoryId,
        table.state,
      ),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * `RC-DEC-026`: the permanent QR in the room. It carries no room number and no
 * stay id, and the token is stored as a keyed hash — a leaked database gives
 * nobody a working QR.
 */
export const roomAccessToken = platform
  .table(
    'room_access_token',
    {
      hotelId: uuid('hotel_id').notNull(),
      issuedAt: timestamp('issued_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      roomAccessId: uuid('room_access_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      roomId: uuid('room_id').notNull(),
      rotatedAt: timestamp('rotated_at', { withTimezone: true }),
      state: text('state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
      tokenHash: text('token_hash').notNull(),
      tokenVersion: integer('token_version')
        .notNull()
        .default(sql`1`),
    },
    (table) => [
      check('room_access_token_hash_shape', sql`(token_hash ~ '^[0-9a-f]{64}$'::text)`),
      check('room_access_token_revision_non_negative', sql`(revision >= 0)`),
      foreignKey({
        name: 'room_access_token_room_fkey',
        columns: [table.hotelId, table.roomId],
        foreignColumns: [room.hotelId, room.roomId],
      }).onDelete('restrict'),
      check(
        'room_access_token_rotated_shape',
        sql`((state = 'ROTATED'::text) = (rotated_at IS NOT NULL))`,
      ),
      check(
        'room_access_token_state_known',
        sql`(state = ANY (ARRAY['ACTIVE'::text, 'ROTATED'::text]))`,
      ),
      check('room_access_token_version_positive', sql`(token_version > 0)`),
      uniqueIndex('room_access_token_hash_uq').on(table.tokenHash),
      uniqueIndex('room_access_token_room_uq')
        .on(table.roomId)
        .where(sql`state = 'ACTIVE'::text`),
      pgPolicy('qr_resolution_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(state = 'ACTIVE'::text)`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * `RC-DEC-027`, counted by the database: active sessions plus valid unused codes
 * may not exceed five, and `CHECK (active + pending <= 5)` on this row is what
 * refuses the sixth rather than a count taken in another statement.
 */
export const stayGuestAccess = platform
  .table(
    'stay_guest_access',
    {
      activeSessions: integer('active_sessions')
        .notNull()
        .default(sql`0`),
      closedAt: timestamp('closed_at', { withTimezone: true }),
      hotelId: uuid('hotel_id').notNull(),
      pendingCodes: integer('pending_codes')
        .notNull()
        .default(sql`0`),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      roomId: uuid('room_id').notNull(),
      stayId: uuid('stay_id').primaryKey().notNull(),
    },
    (table) => [
      check(
        'stay_guest_access_counts_non_negative',
        sql`((active_sessions >= 0) AND (pending_codes >= 0))`,
      ),
      unique('stay_guest_access_identity_uq').on(table.hotelId, table.stayId),
      check('stay_guest_access_revision_non_negative', sql`(revision >= 0)`),
      foreignKey({
        name: 'stay_guest_access_stay_fkey',
        columns: [table.hotelId, table.stayId],
        foreignColumns: [stay.hotelId, stay.stayId],
      }).onDelete('restrict'),
      check('stay_guest_access_within_limit', sql`((active_sessions + pending_codes) <= 5)`),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * doc 08 §7: the one-time code Reception hands the guest, stored as a keyed hash
 * and never in plaintext — not here, not in a log, not in an audit payload.
 */
export const guestAccessCode = platform
  .table(
    'guest_access_code',
    {
      attempts: integer('attempts')
        .notNull()
        .default(sql`0`),
      codeHash: text('code_hash').notNull(),
      codeId: uuid('code_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      hotelId: uuid('hotel_id').notNull(),
      issuedAt: timestamp('issued_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      issuedByAccountId: uuid('issued_by_account_id').notNull(),
      keyVersion: text('key_version').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      roomId: uuid('room_id').notNull(),
      settledAt: timestamp('settled_at', { withTimezone: true }),
      state: text('state')
        .notNull()
        .default(sql`'PENDING'::text`),
      stayId: uuid('stay_id').notNull(),
    },
    (table) => [
      check('guest_access_code_attempts_bounded', sql`((attempts >= 0) AND (attempts <= 10))`),
      check('guest_access_code_hash_shape', sql`(code_hash ~ '^[0-9a-f]{64}$'::text)`),
      check(
        'guest_access_code_key_version_bounded',
        sql`((length(key_version) >= 1) AND (length(key_version) <= 40))`,
      ),
      check('guest_access_code_revision_non_negative', sql`(revision >= 0)`),
      foreignKey({
        name: 'guest_access_code_room_fkey',
        columns: [table.hotelId, table.roomId],
        foreignColumns: [room.hotelId, room.roomId],
      }).onDelete('restrict'),
      check(
        'guest_access_code_settled_shape',
        sql`((state = 'PENDING'::text) = (settled_at IS NULL))`,
      ),
      check(
        'guest_access_code_state_known',
        sql`(state = ANY (ARRAY['PENDING'::text, 'USED'::text, 'REVOKED'::text, 'EXPIRED'::text]))`,
      ),
      foreignKey({
        name: 'guest_access_code_stay_fkey',
        columns: [table.hotelId, table.stayId],
        foreignColumns: [stay.hotelId, stay.stayId],
      }).onDelete('restrict'),
      check('guest_access_code_window', sql`(expires_at > issued_at)`),
      index('guest_access_code_stay_idx').on(table.stayId, table.state),
      pgPolicy('guest_stay_confinement', {
        as: 'restrictive',
        using: sql`((platform.current_guest_stay_id() IS NULL) OR (stay_id = platform.current_guest_stay_id()))`,
        withCheck: sql`((platform.current_guest_stay_id() IS NULL) OR (stay_id = platform.current_guest_stay_id()))`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * The session a confirmed code creates, bound to one hotel, one room and one
 * stay. doc 08 §7 refuses the guest any choice of room, and this row is why
 * there is none to make.
 */
export const guestSession = platform
  .table(
    'guest_session',
    {
      codeId: uuid('code_id').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      guestSessionId: uuid('guest_session_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      hotelId: uuid('hotel_id').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      revokedAt: timestamp('revoked_at', { withTimezone: true }),
      revokedReason: text('revoked_reason'),
      roomId: uuid('room_id').notNull(),
      state: text('state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
      stayId: uuid('stay_id').notNull(),
      tokenHash: text('token_hash').notNull(),
    },
    (table) => [
      foreignKey({
        name: 'guest_session_code_fkey',
        columns: [table.codeId],
        foreignColumns: [guestAccessCode.codeId],
      }).onDelete('restrict'),
      unique('guest_session_code_uq').on(table.codeId),
      unique('guest_session_identity_uq').on(table.hotelId, table.guestSessionId),
      check(
        'guest_session_reason_bounded',
        sql`((revoked_reason IS NULL) OR ((length(revoked_reason) >= 1) AND (length(revoked_reason) <= 120)))`,
      ),
      check('guest_session_revision_non_negative', sql`(revision >= 0)`),
      check('guest_session_revoked_shape', sql`((state = 'ACTIVE'::text) = (revoked_at IS NULL))`),
      check(
        'guest_session_state_known',
        sql`(state = ANY (ARRAY['ACTIVE'::text, 'REVOKED'::text, 'EXPIRED'::text]))`,
      ),
      foreignKey({
        name: 'guest_session_stay_fkey',
        columns: [table.hotelId, table.stayId],
        foreignColumns: [stay.hotelId, stay.stayId],
      }).onDelete('restrict'),
      check('guest_session_token_shape', sql`(token_hash ~ '^[0-9a-f]{64}$'::text)`),
      check('guest_session_window', sql`(expires_at > created_at)`),
      index('guest_session_stay_idx').on(table.stayId, table.state),
      uniqueIndex('guest_session_token_uq').on(table.tokenHash),
      pgPolicy('session_resolution_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(state = 'ACTIVE'::text)`,
      }),
      pgPolicy('guest_stay_confinement', {
        as: 'restrictive',
        using: sql`((platform.current_guest_stay_id() IS NULL) OR (stay_id = platform.current_guest_stay_id()))`,
        withCheck: sql`((platform.current_guest_stay_id() IS NULL) OR (stay_id = platform.current_guest_stay_id()))`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * doc 08 §10 / `REST-DEC-001`: seven axes, seven columns, seven CHECKs. A late
 * capture on a cancelled order moves `payment_state` and leaves the other six
 * exactly where they were.
 */
export const restaurantOrder = platform
  .table(
    'restaurant_order',
    {
      acceptedAt: timestamp('accepted_at', { withTimezone: true }),
      checkoutNotifiedAt: timestamp('checkout_notified_at', { withTimezone: true }),
      contactPhoneSnapshot: text('contact_phone_snapshot').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      etaMinutes: integer('eta_minutes'),
      fulfillmentState: text('fulfillment_state')
        .notNull()
        .default(sql`'NOT_STARTED'::text`),
      guestNote: text('guest_note'),
      guestSessionId: uuid('guest_session_id').notNull(),
      handoffMode: text('handoff_mode')
        .notNull()
        .default(sql`'ROOM'::text`),
      hotelId: uuid('hotel_id').notNull(),
      orderId: uuid('order_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      orderNo: text('order_no').notNull(),
      orderState: text('order_state')
        .notNull()
        .default(sql`'PENDING_PAYMENT'::text`),
      orderingClosesAt: timestamp('ordering_closes_at', { withTimezone: true }).notNull(),
      paymentConfirmedAt: timestamp('payment_confirmed_at', { withTimezone: true }),
      paymentState: text('payment_state')
        .notNull()
        .default(sql`'PENDING'::text`),
      promisedReadyAt: timestamp('promised_ready_at', { withTimezone: true }),
      refundPolicy: text('refund_policy')
        .notNull()
        .default(sql`'NONE'::text`),
      refundReason: text('refund_reason'),
      refundRequestState: text('refund_request_state')
        .notNull()
        .default(sql`'NONE'::text`),
      refundRequestedAt: timestamp('refund_requested_at', { withTimezone: true }),
      refundState: text('refund_state')
        .notNull()
        .default(sql`'NONE'::text`),
      rejectReason: text('reject_reason'),
      restaurantId: uuid('restaurant_id').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      roomId: uuid('room_id').notNull(),
      stayId: uuid('stay_id').notNull(),
      totalAmountMnt: bigint('total_amount_mnt', { mode: 'bigint' }).notNull(),
    },
    (table) => [
      check(
        'restaurant_order_accept_shape',
        sql`(((accepted_at IS NULL) = (eta_minutes IS NULL)) AND ((accepted_at IS NULL) = (promised_ready_at IS NULL)))`,
      ),
      check(
        'restaurant_order_cancelled_shape',
        sql`((fulfillment_state = 'CANCELLED'::text) = (order_state = 'CANCELLED'::text))`,
      ),
      check(
        'restaurant_order_completed_shape',
        sql`((fulfillment_state = ANY (ARRAY['DELIVERED_TO_ROOM'::text, 'HANDED_TO_RECEPTION'::text, 'PICKED_UP_BY_GUEST'::text])) = (order_state = 'COMPLETED'::text))`,
      ),
      check(
        'restaurant_order_confirmed_shape',
        sql`((order_state <> 'CONFIRMED'::text) OR ((payment_state = 'PAID'::text) AND (fulfillment_state = ANY (ARRAY['AWAITING_ACCEPTANCE'::text, 'ACCEPTED'::text, 'PREPARING'::text, 'READY'::text, 'OUT_FOR_DELIVERY'::text]))))`,
      ),
      check(
        'restaurant_order_eta_known',
        sql`((eta_minutes IS NULL) OR (eta_minutes = ANY (ARRAY[15, 30, 45, 60])))`,
      ),
      check(
        'restaurant_order_fulfillment_state_known',
        sql`(fulfillment_state = ANY (ARRAY['NOT_STARTED'::text, 'AWAITING_ACCEPTANCE'::text, 'ACCEPTED'::text, 'PREPARING'::text, 'READY'::text, 'OUT_FOR_DELIVERY'::text, 'DELIVERED_TO_ROOM'::text, 'HANDED_TO_RECEPTION'::text, 'PICKED_UP_BY_GUEST'::text, 'CANCELLED'::text]))`,
      ),
      check(
        'restaurant_order_handoff_known',
        sql`(handoff_mode = ANY (ARRAY['ROOM'::text, 'RECEPTION'::text, 'GUEST_PICKUP'::text, 'REFUND_REQUEST'::text]))`,
      ),
      check(
        'restaurant_order_handoff_matches',
        sql`(((fulfillment_state <> 'HANDED_TO_RECEPTION'::text) OR (handoff_mode = 'RECEPTION'::text)) AND ((fulfillment_state <> 'PICKED_UP_BY_GUEST'::text) OR (handoff_mode = 'GUEST_PICKUP'::text)) AND ((fulfillment_state <> 'DELIVERED_TO_ROOM'::text) OR (handoff_mode = 'ROOM'::text)))`,
      ),
      unique('restaurant_order_identity_uq').on(table.hotelId, table.orderId),
      check(
        'restaurant_order_mandatory_is_approved',
        sql`((refund_policy <> 'MANDATORY'::text) OR (refund_request_state = ANY (ARRAY['APPROVED'::text, 'RESOLVED'::text])))`,
      ),
      check('restaurant_order_no_shape', sql`(order_no ~ '^[A-Z0-9]{8,12}$'::text)`),
      unique('restaurant_order_no_uq').on(table.orderNo),
      check(
        'restaurant_order_note_bounded',
        sql`((guest_note IS NULL) OR ((length(guest_note) >= 1) AND (length(guest_note) <= 500)))`,
      ),
      check(
        'restaurant_order_order_state_known',
        sql`(order_state = ANY (ARRAY['PENDING_PAYMENT'::text, 'CONFIRMED'::text, 'CANCELLED'::text, 'COMPLETED'::text]))`,
      ),
      check(
        'restaurant_order_payment_state_known',
        sql`(payment_state = ANY (ARRAY['PENDING'::text, 'PAID'::text, 'FAILED'::text, 'EXPIRED'::text]))`,
      ),
      check(
        'restaurant_order_payment_time_shape',
        sql`((payment_state = 'PAID'::text) = (payment_confirmed_at IS NOT NULL))`,
      ),
      check(
        'restaurant_order_pending_payment_shape',
        sql`((order_state <> 'PENDING_PAYMENT'::text) OR (payment_state = ANY (ARRAY['PENDING'::text, 'FAILED'::text])))`,
      ),
      check(
        'restaurant_order_pending_shape',
        sql`((payment_state <> 'PENDING'::text) OR ((order_state = 'PENDING_PAYMENT'::text) AND (fulfillment_state = 'NOT_STARTED'::text)))`,
      ),
      check(
        'restaurant_order_phone_shape',
        sql`(contact_phone_snapshot ~ '^\\+976[0-9]{8}$'::text)`,
      ),
      check(
        'restaurant_order_promise_derived',
        sql`((promised_ready_at IS NULL) OR (promised_ready_at = (accepted_at + ((eta_minutes)::double precision * '00:01:00'::interval))))`,
      ),
      check(
        'restaurant_order_refund_axes_agree',
        sql`((refund_policy = 'NONE'::text) = (refund_request_state = 'NONE'::text))`,
      ),
      check(
        'restaurant_order_refund_needs_approval',
        sql`((refund_state = 'NONE'::text) OR (refund_request_state = ANY (ARRAY['APPROVED'::text, 'RESOLVED'::text])))`,
      ),
      check(
        'restaurant_order_refund_needs_payment',
        sql`((refund_policy = 'NONE'::text) OR (payment_state = 'PAID'::text))`,
      ),
      check(
        'restaurant_order_refund_policy_known',
        sql`(refund_policy = ANY (ARRAY['NONE'::text, 'MANDATORY'::text, 'DISCRETIONARY'::text]))`,
      ),
      check(
        'restaurant_order_refund_reason_known',
        sql`((refund_reason IS NULL) OR (refund_reason = ANY (ARRAY['PRE_ACCEPT_SLA'::text, 'RESTAURANT_CANCELLED'::text, 'PAID_AFTER_INVOICE_EXPIRY'::text, 'RESTAURANT_INACTIVE_AT_PAYMENT'::text, 'RESTAURANT_OR_ITEM_INACTIVE_AT_PAYMENT'::text, 'GUEST_REQUEST'::text, 'CHECKOUT_REFUND_REQUEST'::text, 'ETA_OVERDUE'::text])))`,
      ),
      check(
        'restaurant_order_refund_reason_shape',
        sql`((refund_policy = 'NONE'::text) = (refund_reason IS NULL))`,
      ),
      check(
        'restaurant_order_refund_request_known',
        sql`(refund_request_state = ANY (ARRAY['NONE'::text, 'OPEN'::text, 'APPROVED'::text, 'REJECTED'::text, 'RESOLVED'::text]))`,
      ),
      check(
        'restaurant_order_refund_state_known',
        sql`(refund_state = ANY (ARRAY['NONE'::text, 'PENDING'::text, 'REFUNDED'::text, 'FAILED'::text]))`,
      ),
      check(
        'restaurant_order_reject_reason_known',
        sql`((reject_reason IS NULL) OR (reject_reason = ANY (ARRAY['PREPARATION_STARTED'::text, 'FOOD_READY'::text, 'OUT_FOR_DELIVERY'::text, 'HANDED_OVER'::text])))`,
      ),
      check(
        'restaurant_order_reject_reason_shape',
        sql`((refund_request_state = 'REJECTED'::text) = (reject_reason IS NOT NULL))`,
      ),
      check(
        'restaurant_order_request_time_shape',
        sql`((refund_request_state = 'NONE'::text) = (refund_requested_at IS NULL))`,
      ),
      check(
        'restaurant_order_resolved_is_refunded',
        sql`((refund_state = 'REFUNDED'::text) = (refund_request_state = 'RESOLVED'::text))`,
      ),
      foreignKey({
        name: 'restaurant_order_restaurant_fkey',
        columns: [table.hotelId, table.restaurantId],
        foreignColumns: [restaurant.hotelId, restaurant.restaurantId],
      }).onDelete('restrict'),
      check('restaurant_order_revision_non_negative', sql`(revision >= 0)`),
      foreignKey({
        name: 'restaurant_order_session_fkey',
        columns: [table.hotelId, table.guestSessionId],
        foreignColumns: [guestSession.hotelId, guestSession.guestSessionId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'restaurant_order_stay_fkey',
        columns: [table.hotelId, table.stayId],
        foreignColumns: [stay.hotelId, stay.stayId],
      }).onDelete('restrict'),
      unique('restaurant_order_stay_uq').on(table.orderId, table.stayId),
      check('restaurant_order_total_positive', sql`(total_amount_mnt > 0)`),
      index('restaurant_order_open_refund_idx')
        .on(table.hotelId, table.restaurantId, table.refundRequestedAt)
        .where(sql`refund_request_state = ANY (ARRAY['OPEN'::text, 'APPROVED'::text])`),
      index('restaurant_order_queue_idx').on(
        table.restaurantId,
        table.fulfillmentState,
        table.paymentConfirmedAt,
      ),
      index('restaurant_order_session_idx').on(
        table.guestSessionId,
        table.createdAt.desc().nullsFirst(),
      ),
      index('restaurant_order_stay_idx').on(table.stayId, table.createdAt.desc().nullsFirst()),
      pgPolicy('guest_stay_confinement', {
        as: 'restrictive',
        using: sql`((platform.current_guest_stay_id() IS NULL) OR (stay_id = platform.current_guest_stay_id()))`,
        withCheck: sql`((platform.current_guest_stay_id() IS NULL) OR (stay_id = platform.current_guest_stay_id()))`,
      }),
      pgPolicy('refund_sla_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(refund_request_state = ANY (ARRAY['OPEN'::text, 'APPROVED'::text]))`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/** doc 08 §11: name, unit price and quantity as they were when the order was placed. */
export const restaurantOrderItem = platform
  .table(
    'restaurant_order_item',
    {
      hotelId: uuid('hotel_id').notNull(),
      itemId: uuid('item_id').notNull(),
      lineTotalMnt: bigint('line_total_mnt', { mode: 'bigint' }).notNull(),
      nameSnapshot: text('name_snapshot').notNull(),
      orderId: uuid('order_id').notNull(),
      orderItemId: uuid('order_item_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      quantity: integer('quantity').notNull(),
      stayId: uuid('stay_id').notNull(),
      unitPriceMnt: bigint('unit_price_mnt', { mode: 'bigint' }).notNull(),
    },
    (table) => [
      check(
        'restaurant_order_item_line_total',
        sql`(line_total_mnt = (unit_price_mnt * quantity))`,
      ),
      check(
        'restaurant_order_item_name_bounded',
        sql`((length(name_snapshot) >= 1) AND (length(name_snapshot) <= 200))`,
      ),
      foreignKey({
        name: 'restaurant_order_item_order_fkey',
        columns: [table.hotelId, table.orderId],
        foreignColumns: [restaurantOrder.hotelId, restaurantOrder.orderId],
      }).onDelete('restrict'),
      check('restaurant_order_item_price_positive', sql`(unit_price_mnt > 0)`),
      check('restaurant_order_item_quantity_bounded', sql`((quantity >= 1) AND (quantity <= 50))`),
      foreignKey({
        name: 'restaurant_order_item_stay_fkey',
        columns: [table.orderId, table.stayId],
        foreignColumns: [restaurantOrder.orderId, restaurantOrder.stayId],
      }).onDelete('restrict'),
      unique('restaurant_order_item_uq').on(table.orderId, table.itemId),
      pgPolicy('guest_stay_confinement', {
        as: 'restrictive',
        using: sql`((platform.current_guest_stay_id() IS NULL) OR (stay_id = platform.current_guest_stay_id()))`,
        withCheck: sql`((platform.current_guest_stay_id() IS NULL) OR (stay_id = platform.current_guest_stay_id()))`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/** The order's append-only history, per axis. */
export const restaurantOrderEvent = platform
  .table(
    'restaurant_order_event',
    {
      actorRef: text('actor_ref').notNull(),
      axis: text('axis').notNull(),
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
      orderId: uuid('order_id').notNull(),
      reason: text('reason'),
      stayId: uuid('stay_id').notNull(),
      toState: text('to_state'),
    },
    (table) => [
      check(
        'restaurant_order_event_actor_bounded',
        sql`((length(actor_ref) >= 1) AND (length(actor_ref) <= 120))`,
      ),
      check(
        'restaurant_order_event_axis_known',
        sql`(axis = ANY (ARRAY['order'::text, 'fulfillment'::text, 'payment'::text, 'refund_policy'::text, 'refund_request'::text, 'refund'::text, 'handoff'::text]))`,
      ),
      foreignKey({
        name: 'restaurant_order_event_order_fkey',
        columns: [table.hotelId, table.orderId],
        foreignColumns: [restaurantOrder.hotelId, restaurantOrder.orderId],
      }).onDelete('restrict'),
      check(
        'restaurant_order_event_reason_bounded',
        sql`((reason IS NULL) OR ((length(reason) >= 1) AND (length(reason) <= 300)))`,
      ),
      foreignKey({
        name: 'restaurant_order_event_stay_fkey',
        columns: [table.orderId, table.stayId],
        foreignColumns: [restaurantOrder.orderId, restaurantOrder.stayId],
      }).onDelete('restrict'),
      check(
        'restaurant_order_event_type_bounded',
        sql`((length(event_type) >= 1) AND (length(event_type) <= 80))`,
      ),
      index('restaurant_order_event_order_idx').on(table.orderId, table.occurredAt),
      pgPolicy('guest_stay_confinement', {
        as: 'restrictive',
        using: sql`((platform.current_guest_stay_id() IS NULL) OR (stay_id = platform.current_guest_stay_id()))`,
        withCheck: sql`((platform.current_guest_stay_id() IS NULL) OR (stay_id = platform.current_guest_stay_id()))`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * doc 08 §11: one invoice per attempt on the restaurant's own merchant, whose
 * expiry `RC-DEC-023` will not let outlive the day's ordering close — the close
 * is snapshotted here so that is a property of the row.
 */
export const restaurantPaymentAttempt = platform
  .table(
    'restaurant_payment_attempt',
    {
      amountMnt: bigint('amount_mnt', { mode: 'bigint' }).notNull(),
      attemptId: uuid('attempt_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      hotelId: uuid('hotel_id').notNull(),
      orderId: uuid('order_id').notNull(),
      orderingClosesAt: timestamp('ordering_closes_at', { withTimezone: true }).notNull(),
      provider: text('provider')
        .notNull()
        .default(sql`'QPAY'::text`),
      providerInvoiceId: text('provider_invoice_id'),
      providerPaymentId: text('provider_payment_id'),
      restaurantId: uuid('restaurant_id').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      settledAt: timestamp('settled_at', { withTimezone: true }),
      settledReason: text('settled_reason'),
      state: text('state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
    },
    (table) => [
      check('restaurant_payment_attempt_amount_positive', sql`(amount_mnt > 0)`),
      foreignKey({
        name: 'restaurant_payment_attempt_order_fkey',
        columns: [table.hotelId, table.orderId],
        foreignColumns: [restaurantOrder.hotelId, restaurantOrder.orderId],
      }).onDelete('restrict'),
      check('restaurant_payment_attempt_provider_known', sql`(provider = 'QPAY'::text)`),
      check(
        'restaurant_payment_attempt_reason_bounded',
        sql`((settled_reason IS NULL) OR ((length(settled_reason) >= 1) AND (length(settled_reason) <= 200)))`,
      ),
      check('restaurant_payment_attempt_revision_non_negative', sql`(revision >= 0)`),
      check(
        'restaurant_payment_attempt_settled_shape',
        sql`((state = 'ACTIVE'::text) = (settled_at IS NULL))`,
      ),
      check(
        'restaurant_payment_attempt_state_known',
        sql`(state = ANY (ARRAY['ACTIVE'::text, 'PAID'::text, 'FAILED'::text, 'EXPIRED'::text]))`,
      ),
      check('restaurant_payment_attempt_within_close', sql`(expires_at <= ordering_closes_at)`),
      uniqueIndex('restaurant_payment_attempt_invoice_uq')
        .on(table.provider, table.providerInvoiceId)
        .where(sql`provider_invoice_id IS NOT NULL`),
      uniqueIndex('restaurant_payment_attempt_one_active_uq')
        .on(table.orderId)
        .where(sql`state = 'ACTIVE'::text`),
      uniqueIndex('restaurant_payment_attempt_payment_uq')
        .on(table.provider, table.providerPaymentId)
        .where(sql`provider_payment_id IS NOT NULL`),
      pgPolicy('callback_dispatch_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(provider_invoice_id IS NOT NULL)`,
      }),
      pgPolicy('invoice_sweep_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(state = 'ACTIVE'::text)`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * `RC-DEC-024`: the refund the restaurant executes on its own merchant. The
 * platform records it and moves no money; there is no payable and no batch.
 */
export const restaurantRefund = platform
  .table(
    'restaurant_refund',
    {
      amountMnt: bigint('amount_mnt', { mode: 'bigint' }).notNull(),
      failureCode: text('failure_code'),
      hotelId: uuid('hotel_id').notNull(),
      initiatedByAccountId: uuid('initiated_by_account_id').notNull(),
      orderId: uuid('order_id').notNull(),
      provider: text('provider')
        .notNull()
        .default(sql`'QPAY'::text`),
      providerPaymentId: text('provider_payment_id').notNull(),
      providerRefundId: text('provider_refund_id'),
      refundId: uuid('refund_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      requestedAt: timestamp('requested_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      restaurantId: uuid('restaurant_id').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      settledAt: timestamp('settled_at', { withTimezone: true }),
      state: text('state')
        .notNull()
        .default(sql`'PENDING'::text`),
    },
    (table) => [
      check('restaurant_refund_amount_positive', sql`(amount_mnt > 0)`),
      check(
        'restaurant_refund_completed_has_reference',
        sql`((state <> 'REFUNDED'::text) OR (provider_refund_id IS NOT NULL))`,
      ),
      check(
        'restaurant_refund_failure_bounded',
        sql`((failure_code IS NULL) OR ((length(failure_code) >= 1) AND (length(failure_code) <= 80)))`,
      ),
      foreignKey({
        name: 'restaurant_refund_order_fkey',
        columns: [table.hotelId, table.orderId],
        foreignColumns: [restaurantOrder.hotelId, restaurantOrder.orderId],
      }).onDelete('restrict'),
      check('restaurant_refund_provider_known', sql`(provider = 'QPAY'::text)`),
      check('restaurant_refund_revision_non_negative', sql`(revision >= 0)`),
      check(
        'restaurant_refund_settled_shape',
        sql`((state = 'PENDING'::text) = (settled_at IS NULL))`,
      ),
      check(
        'restaurant_refund_state_known',
        sql`(state = ANY (ARRAY['PENDING'::text, 'REFUNDED'::text, 'FAILED'::text]))`,
      ),
      uniqueIndex('restaurant_refund_one_open_uq')
        .on(table.orderId)
        .where(sql`state = 'PENDING'::text`),
      uniqueIndex('restaurant_refund_provider_uq')
        .on(table.providerRefundId)
        .where(sql`provider_refund_id IS NOT NULL`),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/** The kernel tables this declaration covers, for the drift check. */
/**
 * Phase 16 — verified reviews, reports, moderation and the official reply.
 *
 * doc 10. A review is earned by a `COMPLETED` booking the account itself made,
 * so `booking_id` is UNIQUE and a soft-deleted review keeps its booking
 * forever. Nothing here is ever deleted: the owner soft-deletes and the
 * moderator hides, and both keep the row, the owner and the audit. The
 * aggregate's average is a CHECK on the count and the sum, so a client never
 * computes it and it cannot drift from what it summarises.
 */
export const hotelReview = platform
  .table(
    'hotel_review',
    {
      accountId: uuid('account_id').notNull(),
      bookingId: uuid('booking_id').notNull(),
      comment: text('comment').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      deletedAt: timestamp('deleted_at', { withTimezone: true }),
      displayNameSnapshot: text('display_name_snapshot').notNull(),
      edited: boolean('edited')
        .notNull()
        .default(sql`false`),
      hiddenAt: timestamp('hidden_at', { withTimezone: true }),
      hiddenByAccountId: uuid('hidden_by_account_id'),
      hotelId: uuid('hotel_id').notNull(),
      rating: integer('rating').notNull(),
      reviewDeadlineAt: timestamp('review_deadline_at', { withTimezone: true }).notNull(),
      reviewId: uuid('review_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      status: text('status')
        .notNull()
        .default(sql`'PUBLISHED'::text`),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
    },
    (table) => [
      foreignKey({
        name: 'hotel_review_account_fkey',
        columns: [table.accountId],
        foreignColumns: [guestAccount.accountId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'hotel_review_booking_fkey',
        columns: [table.hotelId, table.bookingId],
        foreignColumns: [booking.hotelId, booking.bookingId],
      }).onDelete('restrict'),
      unique('hotel_review_booking_uq').on(table.bookingId),
      check(
        'hotel_review_comment_bounded',
        sql`((length(comment) >= 10) AND (length(comment) <= 1000))`,
      ),
      check('hotel_review_comment_trimmed', sql`(comment = btrim(comment))`),
      check(
        'hotel_review_deleted_when_deleted',
        sql`((status = 'DELETED'::text) = (deleted_at IS NOT NULL))`,
      ),
      check(
        'hotel_review_display_name_bounded',
        sql`((length(display_name_snapshot) >= 1) AND (length(display_name_snapshot) <= 120))`,
      ),
      foreignKey({
        name: 'hotel_review_hidden_by_fkey',
        columns: [table.hiddenByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      check(
        'hotel_review_hidden_shape',
        sql`((hidden_at IS NULL) = (hidden_by_account_id IS NULL))`,
      ),
      check(
        'hotel_review_hidden_when_hidden',
        sql`((status <> 'HIDDEN'::text) OR (hidden_at IS NOT NULL))`,
      ),
      foreignKey({
        name: 'hotel_review_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      unique('hotel_review_identity_uq').on(table.hotelId, table.reviewId),
      check('hotel_review_rating_range', sql`((rating >= 1) AND (rating <= 5))`),
      check('hotel_review_revision_non_negative', sql`(revision >= 0)`),
      check(
        'hotel_review_status_known',
        sql`(status = ANY (ARRAY['PUBLISHED'::text, 'HIDDEN'::text, 'DELETED'::text]))`,
      ),
      index('hotel_review_account_idx').on(table.accountId, table.createdAt.desc().nullsFirst()),
      index('hotel_review_hotel_idx').on(
        table.hotelId,
        table.status,
        table.createdAt.desc().nullsFirst(),
      ),
      pgPolicy('own_review_read', {
        for: 'select',
        using: sql`((platform.current_hotel_id() = '00000000-0000-0000-0000-000000000000'::uuid) AND (account_id = platform.current_account_id()))`,
      }),
      pgPolicy('moderation_resolution_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(status = ANY (ARRAY['PUBLISHED'::text, 'HIDDEN'::text]))`,
      }),
      pgPolicy('public_review_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`((status = 'PUBLISHED'::text) AND (EXISTS ( SELECT 1
   FROM platform.hotel_profile p
  WHERE ((p.hotel_id = hotel_review.hotel_id) AND (p.listing_state = 'PUBLISHED'::text)))))`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const hotelReviewEdit = platform
  .table(
    'hotel_review_edit',
    {
      accountId: uuid('account_id').notNull(),
      editId: uuid('edit_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      editedAt: timestamp('edited_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      fromComment: text('from_comment').notNull(),
      fromRating: integer('from_rating').notNull(),
      hotelId: uuid('hotel_id').notNull(),
      reviewId: uuid('review_id').notNull(),
      toComment: text('to_comment').notNull(),
      toRating: integer('to_rating').notNull(),
    },
    (table) => [
      check(
        'hotel_review_edit_comment_bounded',
        sql`(((length(from_comment) >= 10) AND (length(from_comment) <= 1000)) AND ((length(to_comment) >= 10) AND (length(to_comment) <= 1000)))`,
      ),
      check(
        'hotel_review_edit_rating_range',
        sql`(((from_rating >= 1) AND (from_rating <= 5)) AND ((to_rating >= 1) AND (to_rating <= 5)))`,
      ),
      foreignKey({
        name: 'hotel_review_edit_review_fkey',
        columns: [table.hotelId, table.reviewId],
        foreignColumns: [hotelReview.hotelId, hotelReview.reviewId],
      }).onDelete('restrict'),
      index('hotel_review_edit_review_idx').on(table.reviewId, table.editedAt),
      pgPolicy('own_review_edit_read', {
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

export const hotelReviewAggregate = platform
  .table(
    'hotel_review_aggregate',
    {
      averageRatingCenti: integer('average_rating_centi')
        .notNull()
        .default(sql`0`),
      hotelId: uuid('hotel_id').primaryKey().notNull(),
      publishedCount: integer('published_count')
        .notNull()
        .default(sql`0`),
      ratingSum: bigint('rating_sum', { mode: 'bigint' })
        .notNull()
        .default(sql`0`),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
    },
    (table) => [
      check(
        'hotel_review_aggregate_average_derived',
        sql`(average_rating_centi = ((((rating_sum * 200) + published_count) / (GREATEST(published_count, 1) * 2)))::integer)`,
      ),
      check(
        'hotel_review_aggregate_counts_non_negative',
        sql`((published_count >= 0) AND (rating_sum >= 0))`,
      ),
      foreignKey({
        name: 'hotel_review_aggregate_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check('hotel_review_aggregate_revision_non_negative', sql`(revision >= 0)`),
      check(
        'hotel_review_aggregate_sum_in_range',
        sql`((rating_sum >= published_count) AND (rating_sum <= (published_count * 5)))`,
      ),
      pgPolicy('public_aggregate_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(EXISTS ( SELECT 1
   FROM platform.hotel_profile p
  WHERE ((p.hotel_id = hotel_review_aggregate.hotel_id) AND (p.listing_state = 'PUBLISHED'::text))))`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const reviewReport = platform
  .table(
    'review_report',
    {
      accountId: uuid('account_id').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      hotelId: uuid('hotel_id').notNull(),
      note: text('note'),
      reason: text('reason').notNull(),
      reportId: uuid('report_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      resolution: text('resolution'),
      resolutionNote: text('resolution_note'),
      resolvedAt: timestamp('resolved_at', { withTimezone: true }),
      resolvedByAccountId: uuid('resolved_by_account_id'),
      reviewId: uuid('review_id').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'OPEN'::text`),
    },
    (table) => [
      foreignKey({
        name: 'review_report_account_fkey',
        columns: [table.accountId],
        foreignColumns: [guestAccount.accountId],
      }).onDelete('restrict'),
      unique('review_report_identity_uq').on(table.hotelId, table.reportId),
      check(
        'review_report_note_bounded',
        sql`((note IS NULL) OR ((note = btrim(note)) AND ((length(note) >= 10) AND (length(note) <= 500))))`,
      ),
      check('review_report_note_shape', sql`((reason = 'OTHER'::text) = (note IS NOT NULL))`),
      check(
        'review_report_reason_known',
        sql`(reason = ANY (ARRAY['PERSONAL_DATA'::text, 'ABUSE_ILLEGAL'::text, 'SPAM_FRAUD'::text, 'OTHER'::text]))`,
      ),
      check(
        'review_report_resolution_known',
        sql`((resolution IS NULL) OR (resolution = ANY (ARRAY['UPHELD'::text, 'DISMISSED'::text])))`,
      ),
      check(
        'review_report_resolution_note_bounded',
        sql`((resolution_note IS NULL) OR ((resolution_note = btrim(resolution_note)) AND ((length(resolution_note) >= 10) AND (length(resolution_note) <= 500))))`,
      ),
      foreignKey({
        name: 'review_report_resolved_by_fkey',
        columns: [table.resolvedByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      check(
        'review_report_resolved_shape',
        sql`((state = 'RESOLVED'::text) = ((resolved_at IS NOT NULL) AND (resolved_by_account_id IS NOT NULL) AND (resolution IS NOT NULL) AND (resolution_note IS NOT NULL)))`,
      ),
      foreignKey({
        name: 'review_report_review_fkey',
        columns: [table.hotelId, table.reviewId],
        foreignColumns: [hotelReview.hotelId, hotelReview.reviewId],
      }).onDelete('restrict'),
      check('review_report_revision_non_negative', sql`(revision >= 0)`),
      check(
        'review_report_state_known',
        sql`(state = ANY (ARRAY['OPEN'::text, 'RESOLVED'::text]))`,
      ),
      uniqueIndex('review_report_one_open_uq')
        .on(table.accountId, table.reviewId)
        .where(sql`state = 'OPEN'::text`),
      index('review_report_queue_idx').on(table.state, table.createdAt),
      pgPolicy('queue_resolution_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(state = 'OPEN'::text)`,
      }),
      pgPolicy('own_report_read', {
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

export const reviewModerationEvent = platform
  .table(
    'review_moderation_event',
    {
      action: text('action').notNull(),
      actorAccountId: uuid('actor_account_id').notNull(),
      eventId: uuid('event_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      fromStatus: text('from_status'),
      hotelId: uuid('hotel_id').notNull(),
      note: text('note').notNull(),
      occurredAt: timestamp('occurred_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      permission: text('permission').notNull(),
      reason: text('reason').notNull(),
      reportId: uuid('report_id'),
      reviewId: uuid('review_id').notNull(),
      toStatus: text('to_status'),
    },
    (table) => [
      check(
        'review_moderation_event_action_known',
        sql`(action = ANY (ARRAY['HIDE'::text, 'RESTORE'::text, 'REPORT_RESOLVE'::text]))`,
      ),
      foreignKey({
        name: 'review_moderation_event_actor_fkey',
        columns: [table.actorAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      check(
        'review_moderation_event_note_bounded',
        sql`((note = btrim(note)) AND ((length(note) >= 10) AND (length(note) <= 500)))`,
      ),
      check(
        'review_moderation_event_permission_known',
        sql`(permission = 'REVIEW_MODERATE'::text)`,
      ),
      check(
        'review_moderation_event_reason_known',
        sql`(reason = ANY (ARRAY['PERSONAL_DATA'::text, 'ABUSE_ILLEGAL'::text, 'SPAM_FRAUD'::text, 'OTHER'::text, 'RESTORED'::text, 'DISMISSED'::text, 'UPHELD'::text]))`,
      ),
      foreignKey({
        name: 'review_moderation_event_report_fkey',
        columns: [table.hotelId, table.reportId],
        foreignColumns: [reviewReport.hotelId, reviewReport.reportId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'review_moderation_event_review_fkey',
        columns: [table.hotelId, table.reviewId],
        foreignColumns: [hotelReview.hotelId, hotelReview.reviewId],
      }).onDelete('restrict'),
      check(
        'review_moderation_event_status_known',
        sql`(((from_status IS NULL) OR (from_status = ANY (ARRAY['PUBLISHED'::text, 'HIDDEN'::text, 'DELETED'::text]))) AND ((to_status IS NULL) OR (to_status = ANY (ARRAY['PUBLISHED'::text, 'HIDDEN'::text, 'DELETED'::text]))))`,
      ),
      index('review_moderation_event_review_idx').on(table.reviewId, table.occurredAt),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const hotelReviewReply = platform
  .table(
    'hotel_review_reply',
    {
      body: text('body').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      createdByAccountId: uuid('created_by_account_id').notNull(),
      deletedAt: timestamp('deleted_at', { withTimezone: true }),
      edited: boolean('edited')
        .notNull()
        .default(sql`false`),
      hotelId: uuid('hotel_id').notNull(),
      replyId: uuid('reply_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      reviewId: uuid('review_id').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      updatedByAccountId: uuid('updated_by_account_id'),
    },
    (table) => [
      check(
        'hotel_review_reply_body_bounded',
        sql`((length(body) >= 10) AND (length(body) <= 1000))`,
      ),
      check('hotel_review_reply_body_trimmed', sql`(body = btrim(body))`),
      foreignKey({
        name: 'hotel_review_reply_created_by_fkey',
        columns: [table.createdByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      check(
        'hotel_review_reply_deleted_shape',
        sql`((state = 'DELETED'::text) = (deleted_at IS NOT NULL))`,
      ),
      unique('hotel_review_reply_identity_uq').on(table.hotelId, table.replyId),
      foreignKey({
        name: 'hotel_review_reply_review_fkey',
        columns: [table.hotelId, table.reviewId],
        foreignColumns: [hotelReview.hotelId, hotelReview.reviewId],
      }).onDelete('restrict'),
      unique('hotel_review_reply_review_uq').on(table.reviewId),
      check('hotel_review_reply_revision_non_negative', sql`(revision >= 0)`),
      check(
        'hotel_review_reply_state_known',
        sql`(state = ANY (ARRAY['ACTIVE'::text, 'DELETED'::text]))`,
      ),
      foreignKey({
        name: 'hotel_review_reply_updated_by_fkey',
        columns: [table.updatedByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      pgPolicy('public_reply_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`((state = 'ACTIVE'::text) AND (EXISTS ( SELECT 1
   FROM platform.hotel_profile p
  WHERE ((p.hotel_id = hotel_review_reply.hotel_id) AND (p.listing_state = 'PUBLISHED'::text)))))`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const hotelReviewReplyEvent = platform
  .table(
    'hotel_review_reply_event',
    {
      action: text('action').notNull(),
      actorAccountId: uuid('actor_account_id').notNull(),
      eventId: uuid('event_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      fromBody: text('from_body'),
      fromState: text('from_state'),
      hotelId: uuid('hotel_id').notNull(),
      occurredAt: timestamp('occurred_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      replyId: uuid('reply_id').notNull(),
      reviewId: uuid('review_id').notNull(),
      toBody: text('to_body'),
      toState: text('to_state'),
    },
    (table) => [
      check(
        'hotel_review_reply_event_action_known',
        sql`(action = ANY (ARRAY['CREATE'::text, 'EDIT'::text, 'DELETE'::text, 'RESTORE'::text]))`,
      ),
      foreignKey({
        name: 'hotel_review_reply_event_actor_fkey',
        columns: [table.actorAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'hotel_review_reply_event_reply_fkey',
        columns: [table.hotelId, table.replyId],
        foreignColumns: [hotelReviewReply.hotelId, hotelReviewReply.replyId],
      }).onDelete('restrict'),
      index('hotel_review_reply_event_reply_idx').on(table.replyId, table.occurredAt),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

/**
 * Phase 17 — the guest registry's exports, retention, and expense kinds.
 *
 * doc 12 and doc 23. Almost no facts: the registry and the dashboard are reads
 * over rows earlier phases wrote. What is here is the machinery around them —
 * an export job carrying an immutable filter snapshot and a ten-thousand-row
 * CHECK, a file whose one hour is a derived column no download grant can
 * touch, a retention snapshot written once at checkout, the legal hold that
 * suspends it, and the expense kind that keeps an inventory purchase from
 * being deducted twice.
 */
export const retentionPolicy = platform
  .table(
    'retention_policy',
    {
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
      hotelId: uuid('hotel_id').notNull(),
      legalBasis: text('legal_basis').notNull(),
      owner: text('owner').notNull(),
      policyId: uuid('policy_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      retentionDays: integer('retention_days').notNull(),
      retroactive: boolean('retroactive')
        .notNull()
        .default(sql`false`),
      version: integer('version').notNull(),
    },
    (table) => [
      check(
        'retention_policy_basis_bounded',
        sql`((length(legal_basis) >= 1) AND (length(legal_basis) <= 500))`,
      ),
      check(
        'retention_policy_days_bounded',
        sql`((retention_days >= 1) AND (retention_days <= 3650))`,
      ),
      foreignKey({
        name: 'retention_policy_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      check(
        'retention_policy_owner_bounded',
        sql`((length(owner) >= 1) AND (length(owner) <= 200))`,
      ),
      check('retention_policy_version_positive', sql`(version >= 1)`),
      unique('retention_policy_version_uq').on(table.hotelId, table.version),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const stayRetention = platform
  .table(
    'stay_retention',
    {
      anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),
      anonymizedReason: text('anonymized_reason'),
      checkoutAt: timestamp('checkout_at', { withTimezone: true }).notNull(),
      hotelId: uuid('hotel_id').notNull(),
      retentionDays: integer('retention_days').notNull(),
      retentionExpiresAt: timestamp('retention_expires_at', { withTimezone: true }).notNull(),
      retentionPolicyVersion: integer('retention_policy_version').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      stayId: uuid('stay_id').primaryKey().notNull(),
    },
    (table) => [
      check(
        'stay_retention_anonymized_shape',
        sql`((anonymized_at IS NULL) = (anonymized_reason IS NULL))`,
      ),
      check(
        'stay_retention_days_bounded',
        sql`((retention_days >= 1) AND (retention_days <= 3650))`,
      ),
      check(
        'stay_retention_expiry_derived',
        sql`(retention_expires_at = (checkout_at + make_interval(days => retention_days)))`,
      ),
      unique('stay_retention_identity_uq').on(table.hotelId, table.stayId),
      foreignKey({
        name: 'stay_retention_policy_fkey',
        columns: [table.hotelId, table.retentionPolicyVersion],
        foreignColumns: [retentionPolicy.hotelId, retentionPolicy.version],
      }).onDelete('restrict'),
      check('stay_retention_revision_non_negative', sql`(revision >= 0)`),
      foreignKey({
        name: 'stay_retention_stay_fkey',
        columns: [table.hotelId, table.stayId],
        foreignColumns: [stay.hotelId, stay.stayId],
      }).onDelete('restrict'),
      index('stay_retention_due_idx')
        .on(table.retentionExpiresAt)
        .where(sql`anonymized_at IS NULL`),
      pgPolicy('retention_sweep_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(anonymized_at IS NULL)`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const retentionLegalHold = platform
  .table(
    'retention_legal_hold',
    {
      authorityReference: text('authority_reference').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      endsAt: timestamp('ends_at', { withTimezone: true }),
      holdId: uuid('hold_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      hotelId: uuid('hotel_id').notNull(),
      imposedByAccountId: uuid('imposed_by_account_id').notNull(),
      reason: text('reason').notNull(),
      releasedAt: timestamp('released_at', { withTimezone: true }),
      releasedByAccountId: uuid('released_by_account_id'),
      releasedReason: text('released_reason'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      startsAt: timestamp('starts_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      stayId: uuid('stay_id'),
    },
    (table) => [
      check(
        'retention_legal_hold_authority_bounded',
        sql`((length(authority_reference) >= 1) AND (length(authority_reference) <= 200))`,
      ),
      foreignKey({
        name: 'retention_legal_hold_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'retention_legal_hold_imposed_by_fkey',
        columns: [table.imposedByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      check(
        'retention_legal_hold_reason_bounded',
        sql`((length(reason) >= 10) AND (length(reason) <= 500))`,
      ),
      foreignKey({
        name: 'retention_legal_hold_released_by_fkey',
        columns: [table.releasedByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      check(
        'retention_legal_hold_released_shape',
        sql`(num_nulls(released_at, released_by_account_id, released_reason) = ANY (ARRAY[0, 3]))`,
      ),
      check('retention_legal_hold_revision_non_negative', sql`(revision >= 0)`),
      foreignKey({
        name: 'retention_legal_hold_stay_fkey',
        columns: [table.hotelId, table.stayId],
        foreignColumns: [stay.hotelId, stay.stayId],
      }).onDelete('restrict'),
      check('retention_legal_hold_window', sql`((ends_at IS NULL) OR (ends_at > starts_at))`),
      index('retention_legal_hold_live_idx')
        .on(table.hotelId, table.stayId)
        .where(sql`released_at IS NULL`),
      pgPolicy('retention_hold_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(released_at IS NULL)`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const reportExportJob = platform
  .table(
    'report_export_job',
    {
      contentHash: text('content_hash'),
      expiredAt: timestamp('expired_at', { withTimezone: true }),
      expiresAt: timestamp('expires_at', { withTimezone: true }),
      failedAt: timestamp('failed_at', { withTimezone: true }),
      failureReason: text('failure_reason'),
      filters: jsonb('filters').notNull(),
      hotelId: uuid('hotel_id').notNull(),
      jobId: uuid('job_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      kind: text('kind').notNull(),
      policyVersion: integer('policy_version').notNull(),
      readyAt: timestamp('ready_at', { withTimezone: true }),
      requestedAt: timestamp('requested_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      requestedByAccountId: uuid('requested_by_account_id').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      rowCount: integer('row_count'),
      startedAt: timestamp('started_at', { withTimezone: true }),
      state: text('state')
        .notNull()
        .default(sql`'QUEUED'::text`),
      storageKey: text('storage_key'),
      timezone: text('timezone').notNull(),
    },
    (table) => [
      check(
        'report_export_job_completed_shape',
        sql`((state = ANY (ARRAY['COMPLETED'::text, 'EXPIRED'::text])) = ((ready_at IS NOT NULL) AND (row_count IS NOT NULL) AND (content_hash IS NOT NULL)))`,
      ),
      check(
        'report_export_job_expired_shape',
        sql`((state = 'EXPIRED'::text) = (expired_at IS NOT NULL))`,
      ),
      check(
        'report_export_job_failed_shape',
        sql`((state = 'FAILED'::text) = ((failed_at IS NOT NULL) AND (failure_reason IS NOT NULL)))`,
      ),
      check(
        'report_export_job_failure_bounded',
        sql`((failure_reason IS NULL) OR ((length(failure_reason) >= 1) AND (length(failure_reason) <= 500)))`,
      ),
      check(
        'report_export_job_hash_shape',
        sql`((content_hash IS NULL) OR (content_hash ~ '^[0-9a-f]{64}$'::text))`,
      ),
      foreignKey({
        name: 'report_export_job_hotel_fkey',
        columns: [table.hotelId],
        foreignColumns: [hotel.hotelId],
      }).onDelete('restrict'),
      unique('report_export_job_identity_uq').on(table.hotelId, table.jobId),
      check(
        'report_export_job_kind_known',
        sql`(kind = ANY (ARRAY['GUEST_REGISTRY'::text, 'ROOM_SALES'::text, 'MINIBAR_SALES'::text, 'EXPENSE'::text, 'PAYMENT_BREAKDOWN'::text]))`,
      ),
      check('report_export_job_policy_version_positive', sql`(policy_version >= 1)`),
      foreignKey({
        name: 'report_export_job_requested_by_fkey',
        columns: [table.requestedByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      check('report_export_job_revision_non_negative', sql`(revision >= 0)`),
      check('report_export_job_row_cap', sql`((row_count IS NULL) OR (row_count <= 10000))`),
      check('report_export_job_rows_non_negative', sql`((row_count IS NULL) OR (row_count >= 0))`),
      check(
        'report_export_job_state_known',
        sql`(state = ANY (ARRAY['QUEUED'::text, 'RUNNING'::text, 'COMPLETED'::text, 'FAILED'::text, 'EXPIRED'::text]))`,
      ),
      check(
        'report_export_job_storage_key_shape',
        sql`((storage_key IS NULL) OR (storage_key ~ '^exports/[0-9a-f-]{36}/[0-9a-f]{32}\\.xlsx$'::text))`,
      ),
      check(
        'report_export_job_storage_shape',
        sql`((state = 'COMPLETED'::text) = (storage_key IS NOT NULL))`,
      ),
      check(
        'report_export_job_timezone_bounded',
        sql`((length(timezone) >= 1) AND (length(timezone) <= 64))`,
      ),
      check(
        'report_export_job_ttl_derived',
        sql`(((ready_at IS NULL) AND (expires_at IS NULL)) OR (expires_at = (ready_at + '01:00:00'::interval)))`,
      ),
      index('report_export_job_due_idx')
        .on(table.expiresAt)
        .where(sql`state = 'COMPLETED'::text`),
      index('report_export_job_hotel_idx').on(table.hotelId, table.requestedAt.desc().nullsFirst()),
      pgPolicy('export_sweep_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(state = ANY (ARRAY['QUEUED'::text, 'COMPLETED'::text]))`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const reportExportGrant = platform
  .table(
    'report_export_grant',
    {
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      grantId: uuid('grant_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      hotelId: uuid('hotel_id').notNull(),
      issuedAt: timestamp('issued_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      issuedByAccountId: uuid('issued_by_account_id').notNull(),
      jobId: uuid('job_id').notNull(),
    },
    (table) => [
      foreignKey({
        name: 'report_export_grant_issued_by_fkey',
        columns: [table.issuedByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'report_export_grant_job_fkey',
        columns: [table.hotelId, table.jobId],
        foreignColumns: [reportExportJob.hotelId, reportExportJob.jobId],
      }).onDelete('restrict'),
      check(
        'report_export_grant_ttl_derived',
        sql`(expires_at = (issued_at + '00:05:00'::interval))`,
      ),
      index('report_export_grant_job_idx').on(table.jobId, table.issuedAt.desc().nullsFirst()),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

// =====================================================================
// Phase 18 — Police monitoring (migration 0019)
// =====================================================================

export const wantedPerson = policeSchema
  .table(
    'wanted_person',
    {
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      createdByAccountId: uuid('created_by_account_id').notNull(),
      identityKeyVersion: text('identity_key_version').notNull(),
      identityNamespace: text('identity_namespace').notNull(),
      identityToken: text('identity_token').notNull(),
      matchKeyVersion: text('match_key_version').notNull(),
      matchNamespace: text('match_namespace').notNull(),
      matchToken: text('match_token').notNull(),
      personId: uuid('person_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
    },
    (table) => [
      unique('wanted_person_identity_uq').on(table.identityNamespace, table.identityToken),
      check(
        'wanted_person_namespace_known',
        sql`((identity_namespace = 'registration_number:MN'::text) AND (match_namespace = 'registration_number:MN'::text))`,
      ),
      check('wanted_person_revision_non_negative', sql`(revision >= 0)`),
      check(
        'wanted_person_token_shape',
        sql`((identity_token ~ '^[0-9a-f]{64}$'::text) AND (match_token ~ '^[0-9a-f]{64}$'::text))`,
      ),
      index('wanted_person_match_idx').on(
        table.matchNamespace,
        table.matchToken,
        table.matchKeyVersion,
      ),
      pgPolicy('police_matcher_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(EXISTS ( SELECT 1
   FROM police.wanted_case c
  WHERE ((c.person_id = wanted_person.person_id) AND (c.state = 'ACTIVE'::text))))`,
      }),
      pgPolicy('police_realm_only', {
        to: ['prsystem_police'],
        using: sql`(platform.current_realm() = 'police'::text)`,
        withCheck: sql`(platform.current_realm() = 'police'::text)`,
      }),
    ],
  )
  .enableRLS();

export const wantedIdentityRevision = policeSchema
  .table(
    'wanted_identity_revision',
    {
      approvalState: text('approval_state').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      createdByAccountId: uuid('created_by_account_id').notNull(),
      dateOfBirth: date('date_of_birth').notNull(),
      decidedAt: timestamp('decided_at', { withTimezone: true }),
      decidedByAccountId: uuid('decided_by_account_id'),
      decisionReason: text('decision_reason'),
      familyName: text('family_name').notNull(),
      givenName: text('given_name').notNull(),
      homeAddress: text('home_address'),
      homeDistrict: text('home_district'),
      identifierCiphertext: bytea('identifier_ciphertext').notNull(),
      identifierKeyVersion: text('identifier_key_version').notNull(),
      identifierWrappedDek: bytea('identifier_wrapped_dek').notNull(),
      isCurrent: boolean('is_current')
        .notNull()
        .default(sql`false`),
      parentName: text('parent_name').notNull(),
      personId: uuid('person_id').notNull(),
      provenance: text('provenance').notNull(),
      revisionId: uuid('revision_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      revisionNo: integer('revision_no').notNull(),
    },
    (table) => [
      check(
        'wanted_identity_address_bounded',
        sql`((home_address IS NULL) OR ((length(home_address) >= 1) AND (length(home_address) <= 300)))`,
      ),
      check(
        'wanted_identity_approval_known',
        sql`(approval_state = ANY (ARRAY['PENDING_APPROVAL'::text, 'APPROVED'::text, 'REJECTED'::text]))`,
      ),
      check(
        'wanted_identity_current_is_approved',
        sql`((NOT is_current) OR (approval_state = 'APPROVED'::text))`,
      ),
      check(
        'wanted_identity_district_bounded',
        sql`((home_district IS NULL) OR ((length(home_district) >= 1) AND (length(home_district) <= 100)))`,
      ),
      check(
        'wanted_identity_manual_shape',
        sql`((provenance <> 'MANUAL'::text) OR ((approval_state = 'PENDING_APPROVAL'::text) AND (decided_by_account_id IS NULL) AND (decided_at IS NULL)) OR ((approval_state <> 'PENDING_APPROVAL'::text) AND (decided_by_account_id IS NOT NULL) AND (decided_at IS NOT NULL)))`,
      ),
      check(
        'wanted_identity_names_bounded',
        sql`(((length(family_name) >= 1) AND (length(family_name) <= 100)) AND ((length(parent_name) >= 1) AND (length(parent_name) <= 100)) AND ((length(given_name) >= 1) AND (length(given_name) <= 100)))`,
      ),
      check(
        'wanted_identity_provenance_known',
        sql`(provenance = ANY (ARRAY['XYP_VERIFIED'::text, 'MANUAL'::text]))`,
      ),
      check(
        'wanted_identity_reason_bounded',
        sql`((decision_reason IS NULL) OR ((length(decision_reason) >= 5) AND (length(decision_reason) <= 500)))`,
      ),
      check('wanted_identity_revision_no_positive', sql`(revision_no >= 1)`),
      unique('wanted_identity_revision_no_uq').on(table.personId, table.revisionNo),
      foreignKey({
        name: 'wanted_identity_revision_person_fkey',
        columns: [table.personId],
        foreignColumns: [wantedPerson.personId],
      }).onDelete('restrict'),
      check(
        'wanted_identity_two_person',
        sql`((decided_by_account_id IS NULL) OR (decided_by_account_id <> created_by_account_id))`,
      ),
      check(
        'wanted_identity_verified_shape',
        sql`((provenance <> 'XYP_VERIFIED'::text) OR ((approval_state = 'APPROVED'::text) AND (decided_by_account_id IS NULL)))`,
      ),
      uniqueIndex('wanted_identity_current_uq')
        .on(table.personId)
        .where(sql`is_current IS TRUE`),
      uniqueIndex('wanted_identity_pending_uq')
        .on(table.personId)
        .where(sql`approval_state = 'PENDING_APPROVAL'::text`),
      pgPolicy('police_matcher_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`((is_current IS TRUE) AND (approval_state = 'APPROVED'::text))`,
      }),
      pgPolicy('police_realm_only', {
        to: ['prsystem_police'],
        using: sql`(platform.current_realm() = 'police'::text)`,
        withCheck: sql`(platform.current_realm() = 'police'::text)`,
      }),
    ],
  )
  .enableRLS();

export const wantedCase = policeSchema
  .table(
    'wanted_case',
    {
      activatedAt: timestamp('activated_at', { withTimezone: true }),
      caseId: uuid('case_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      createdByAccountId: uuid('created_by_account_id').notNull(),
      crimeCategory: text('crime_category').notNull(),
      owningUnitRef: text('owning_unit_ref').notNull(),
      personId: uuid('person_id').notNull(),
      reasonText: text('reason_text').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'DRAFT'::text`),
      terminalAt: timestamp('terminal_at', { withTimezone: true }),
    },
    (table) => [
      check(
        'wanted_case_activation_shape',
        sql`((state = ANY (ARRAY['DRAFT'::text, 'PENDING_APPROVAL'::text])) = (activated_at IS NULL))`,
      ),
      check(
        'wanted_case_category_bounded',
        sql`((length(crime_category) >= 1) AND (length(crime_category) <= 120))`,
      ),
      unique('wanted_case_identity_uq').on(table.personId, table.caseId),
      foreignKey({
        name: 'wanted_case_person_fkey',
        columns: [table.personId],
        foreignColumns: [wantedPerson.personId],
      }).onDelete('restrict'),
      check(
        'wanted_case_reason_bounded',
        sql`((length(reason_text) >= 10) AND (length(reason_text) <= 2000))`,
      ),
      check('wanted_case_revision_non_negative', sql`(revision >= 0)`),
      check(
        'wanted_case_state_known',
        sql`(state = ANY (ARRAY['DRAFT'::text, 'PENDING_APPROVAL'::text, 'ACTIVE'::text, 'SUSPENDED'::text, 'CLOSED'::text, 'CANCELLED'::text]))`,
      ),
      check(
        'wanted_case_terminal_shape',
        sql`((state = ANY (ARRAY['CLOSED'::text, 'CANCELLED'::text])) = (terminal_at IS NOT NULL))`,
      ),
      check(
        'wanted_case_unit_bounded',
        sql`((length(owning_unit_ref) >= 1) AND (length(owning_unit_ref) <= 100))`,
      ),
      index('wanted_case_active_idx')
        .on(table.personId)
        .where(sql`state = 'ACTIVE'::text`),
      index('wanted_case_state_idx').on(table.state, table.createdAt.desc().nullsFirst()),
      pgPolicy('police_matcher_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(state = 'ACTIVE'::text)`,
      }),
      pgPolicy('police_realm_only', {
        to: ['prsystem_police'],
        using: sql`(platform.current_realm() = 'police'::text)`,
        withCheck: sql`(platform.current_realm() = 'police'::text)`,
      }),
    ],
  )
  .enableRLS();

export const wantedCaseEvent = policeSchema
  .table(
    'wanted_case_event',
    {
      actorAccountId: uuid('actor_account_id').notNull(),
      caseId: uuid('case_id').notNull(),
      eventId: uuid('event_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      fromState: text('from_state').notNull(),
      occurredAt: timestamp('occurred_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      reason: text('reason').notNull(),
      toState: text('to_state').notNull(),
    },
    (table) => [
      foreignKey({
        name: 'wanted_case_event_case_fkey',
        columns: [table.caseId],
        foreignColumns: [wantedCase.caseId],
      }).onDelete('restrict'),
      check(
        'wanted_case_event_reason_bounded',
        sql`((length(reason) >= 5) AND (length(reason) <= 500))`,
      ),
      check('wanted_case_event_states_differ', sql`(from_state <> to_state)`),
      index('wanted_case_event_case_idx').on(table.caseId, table.occurredAt),
      pgPolicy('police_realm_only', {
        to: ['prsystem_police'],
        using: sql`(platform.current_realm() = 'police'::text)`,
        withCheck: sql`(platform.current_realm() = 'police'::text)`,
      }),
    ],
  )
  .enableRLS();

export const policeMatch = policeSchema
  .table(
    'police_match',
    {
      actualCheckInAt: timestamp('actual_check_in_at', { withTimezone: true }).notNull(),
      checkInRecordedAt: timestamp('check_in_recorded_at', { withTimezone: true }).notNull(),
      detectedAt: timestamp('detected_at', { withTimezone: true }).notNull(),
      falseMatchReviewPending: boolean('false_match_review_pending')
        .notNull()
        .default(sql`false`),
      firstAcknowledgedAt: timestamp('first_acknowledged_at', { withTimezone: true }),
      firstAcknowledgedByAccountId: uuid('first_acknowledged_by_account_id'),
      hotelAddressLine: text('hotel_address_line').notNull(),
      hotelDistrict: text('hotel_district').notNull(),
      hotelId: uuid('hotel_id').notNull(),
      hotelName: text('hotel_name').notNull(),
      latitudeMicro: integer('latitude_micro'),
      longitudeMicro: integer('longitude_micro'),
      matchId: uuid('match_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      matchMethod: text('match_method')
        .notNull()
        .default(sql`'EXACT_REGISTRATION_NUMBER'::text`),
      originatingUnitRef: text('originating_unit_ref').notNull(),
      outcome: text('outcome')
        .notNull()
        .default(sql`'NONE'::text`),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      roomNumber: text('room_number').notNull(),
      stayId: uuid('stay_id').notNull(),
      wantedPersonId: uuid('wanted_person_id').notNull(),
      workflowState: text('workflow_state')
        .notNull()
        .default(sql`'NEW'::text`),
    },
    (table) => [
      check(
        'police_match_acknowledgement_shape',
        sql`((first_acknowledged_by_account_id IS NULL) = (first_acknowledged_at IS NULL))`,
      ),
      check('police_match_method_known', sql`(match_method = 'EXACT_REGISTRATION_NUMBER'::text)`),
      check(
        'police_match_new_is_unacknowledged',
        sql`((workflow_state <> 'NEW'::text) OR (first_acknowledged_by_account_id IS NULL))`,
      ),
      check(
        'police_match_outcome_known',
        sql`(outcome = ANY (ARRAY['NONE'::text, 'FOUND'::text, 'FALSE_MATCH'::text, 'LOCATION_STALE'::text]))`,
      ),
      check(
        'police_match_outcome_resolved',
        sql`((outcome = 'NONE'::text) OR (workflow_state = 'RESOLVED'::text))`,
      ),
      foreignKey({
        name: 'police_match_person_fkey',
        columns: [table.wantedPersonId],
        foreignColumns: [wantedPerson.personId],
      }).onDelete('restrict'),
      check(
        'police_match_position_bounded',
        sql`(((latitude_micro IS NULL) = (longitude_micro IS NULL)) AND ((latitude_micro IS NULL) OR (((latitude_micro >= '-90000000'::integer) AND (latitude_micro <= 90000000)) AND ((longitude_micro >= '-180000000'::integer) AND (longitude_micro <= 180000000)))))`,
      ),
      check('police_match_revision_non_negative', sql`(revision >= 0)`),
      check(
        'police_match_room_bounded',
        sql`((length(room_number) >= 1) AND (length(room_number) <= 20))`,
      ),
      unique('police_match_stay_person_uq').on(table.stayId, table.wantedPersonId),
      check(
        'police_match_workflow_known',
        sql`(workflow_state = ANY (ARRAY['NEW'::text, 'ACKNOWLEDGED'::text, 'UNDER_REVIEW'::text, 'RESOLVED'::text]))`,
      ),
      index('police_match_district_idx').on(
        table.hotelDistrict,
        table.detectedAt.desc().nullsFirst(),
      ),
      index('police_match_open_idx')
        .on(table.workflowState, table.detectedAt.desc().nullsFirst())
        .where(sql`workflow_state <> 'RESOLVED'::text`),
      index('police_match_person_idx').on(
        table.wantedPersonId,
        table.detectedAt.desc().nullsFirst(),
      ),
      pgPolicy('police_matcher_write', {
        for: 'insert',
        to: ['prsystem_maintenance_fn'],
        withCheck: sql`(workflow_state = 'NEW'::text)`,
      }),
      pgPolicy('police_realm_only', {
        to: ['prsystem_police'],
        using: sql`(platform.current_realm() = 'police'::text)`,
        withCheck: sql`(platform.current_realm() = 'police'::text)`,
      }),
      pgPolicy('police_matcher_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(workflow_state <> 'RESOLVED'::text)`,
      }),
    ],
  )
  .enableRLS();

export const matchCaseLink = policeSchema
  .table(
    'match_case_link',
    {
      caseId: uuid('case_id').notNull(),
      linkId: uuid('link_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      linkedAt: timestamp('linked_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      matchId: uuid('match_id').notNull(),
    },
    (table) => [
      foreignKey({
        name: 'match_case_link_case_fkey',
        columns: [table.caseId],
        foreignColumns: [wantedCase.caseId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'match_case_link_match_fkey',
        columns: [table.matchId],
        foreignColumns: [policeMatch.matchId],
      }).onDelete('restrict'),
      unique('match_case_link_uq').on(table.matchId, table.caseId),
      pgPolicy('police_matcher_write', {
        for: 'insert',
        to: ['prsystem_maintenance_fn'],
        withCheck: sql`true`,
      }),
      pgPolicy('police_realm_only', {
        to: ['prsystem_police'],
        using: sql`(platform.current_realm() = 'police'::text)`,
        withCheck: sql`(platform.current_realm() = 'police'::text)`,
      }),
    ],
  )
  .enableRLS();

export const matchEvent = policeSchema
  .table(
    'match_event',
    {
      actorAccountId: uuid('actor_account_id'),
      eventId: uuid('event_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      eventType: text('event_type').notNull(),
      matchId: uuid('match_id').notNull(),
      occurredAt: timestamp('occurred_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      payload: jsonb('payload')
        .notNull()
        .default(sql`'{}'::jsonb`),
    },
    (table) => [
      foreignKey({
        name: 'match_event_match_fkey',
        columns: [table.matchId],
        foreignColumns: [policeMatch.matchId],
      }).onDelete('restrict'),
      check('match_event_payload_sanitised', sql`(NOT platform.contains_denied_key(payload))`),
      check(
        'match_event_type_known',
        sql`(event_type = ANY (ARRAY['DETECTED'::text, 'CASE_LINKED'::text, 'ALERT_CREATED'::text, 'ACKNOWLEDGED'::text, 'ROOM_UPDATED'::text, 'FOUND_CONFIRMED'::text, 'FOUND_CORRECTION_REQUESTED'::text, 'FOUND_CORRECTION_APPROVED'::text, 'FOUND_CORRECTION_REJECTED'::text, 'FALSE_MATCH_REQUESTED'::text, 'FALSE_MATCH_APPROVED'::text, 'FALSE_MATCH_REJECTED'::text, 'LOCATION_STALE'::text, 'ACTUAL_TIME_CORRECTED'::text]))`,
      ),
      index('match_event_match_idx').on(table.matchId, table.occurredAt),
      pgPolicy('police_matcher_write', {
        for: 'insert',
        to: ['prsystem_maintenance_fn'],
        withCheck: sql`(actor_account_id IS NULL)`,
      }),
      pgPolicy('police_realm_only', {
        to: ['prsystem_police'],
        using: sql`(platform.current_realm() = 'police'::text)`,
        withCheck: sql`(platform.current_realm() = 'police'::text)`,
      }),
    ],
  )
  .enableRLS();

export const districtAlertGroup = policeSchema
  .table(
    'district_alert_group',
    {
      approvedAt: timestamp('approved_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      approvedByAccountId: uuid('approved_by_account_id').notNull(),
      district: text('district').primaryKey().notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
      unitRef: text('unit_ref').notNull(),
    },
    () => [
      check(
        'district_alert_group_bounded',
        sql`(((length(district) >= 1) AND (length(district) <= 100)) AND ((length(unit_ref) >= 1) AND (length(unit_ref) <= 100)))`,
      ),
      check('district_alert_group_revision_non_negative', sql`(revision >= 0)`),
      check(
        'district_alert_group_state_known',
        sql`(state = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text]))`,
      ),
      pgPolicy('police_matcher_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(state = 'ACTIVE'::text)`,
      }),
      pgPolicy('police_realm_only', {
        to: ['prsystem_police'],
        using: sql`(platform.current_realm() = 'police'::text)`,
        withCheck: sql`(platform.current_realm() = 'police'::text)`,
      }),
    ],
  )
  .enableRLS();

export const matchAlert = policeSchema
  .table(
    'match_alert',
    {
      alertId: uuid('alert_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
      escalatedAt: timestamp('escalated_at', { withTimezone: true }),
      escalationStage: integer('escalation_stage')
        .notNull()
        .default(sql`0`),
      matchId: uuid('match_id').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      routedDistrict: text('routed_district').notNull(),
      routingError: boolean('routing_error')
        .notNull()
        .default(sql`false`),
    },
    (table) => [
      foreignKey({
        name: 'match_alert_match_fkey',
        columns: [table.matchId],
        foreignColumns: [policeMatch.matchId],
      }).onDelete('restrict'),
      unique('match_alert_match_uq').on(table.matchId),
      check('match_alert_revision_non_negative', sql`(revision >= 0)`),
      check(
        'match_alert_stage_shape',
        sql`((escalation_stage >= 0) AND ((escalation_stage = 0) = (escalated_at IS NULL)))`,
      ),
      pgPolicy('police_matcher_write', {
        for: 'insert',
        to: ['prsystem_maintenance_fn'],
        withCheck: sql`(escalation_stage = 0)`,
      }),
      pgPolicy('police_realm_only', {
        to: ['prsystem_police'],
        using: sql`(platform.current_realm() = 'police'::text)`,
        withCheck: sql`(platform.current_realm() = 'police'::text)`,
      }),
      pgPolicy('police_matcher_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(escalation_stage = 0)`,
      }),
    ],
  )
  .enableRLS();

export const alertDelivery = policeSchema
  .table(
    'alert_delivery',
    {
      alertId: uuid('alert_id').notNull(),
      channel: text('channel').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      deliveredAt: timestamp('delivered_at', { withTimezone: true }),
      deliveryId: uuid('delivery_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      failureReason: text('failure_reason'),
      maskedIdentifier: text('masked_identifier'),
      openedAt: timestamp('opened_at', { withTimezone: true }),
      providerMessageId: text('provider_message_id'),
      recipientAccountId: uuid('recipient_account_id').notNull(),
      recipientKind: text('recipient_kind').notNull(),
    },
    (table) => [
      foreignKey({
        name: 'alert_delivery_alert_fkey',
        columns: [table.alertId],
        foreignColumns: [matchAlert.alertId],
      }).onDelete('restrict'),
      check(
        'alert_delivery_channel_known',
        sql`(channel = ANY (ARRAY['IN_APP'::text, 'SMS'::text]))`,
      ),
      check(
        'alert_delivery_failure_bounded',
        sql`((failure_reason IS NULL) OR ((length(failure_reason) >= 1) AND (length(failure_reason) <= 200)))`,
      ),
      check(
        'alert_delivery_kind_known',
        sql`(recipient_kind = ANY (ARRAY['DISTRICT_OFFICER'::text, 'POLICE_ADMIN'::text, 'DUTY_SUPERVISOR'::text]))`,
      ),
      check(
        'alert_delivery_mask_shape',
        sql`((masked_identifier IS NULL) OR (masked_identifier ~ '^\\*{4,}[0-9]{0,4}$'::text))`,
      ),
      unique('alert_delivery_uq').on(table.alertId, table.recipientAccountId, table.channel),
      index('alert_delivery_alert_idx').on(table.alertId),
      index('alert_delivery_recipient_idx').on(
        table.recipientAccountId,
        table.createdAt.desc().nullsFirst(),
      ),
      pgPolicy('police_matcher_write', {
        for: 'insert',
        to: ['prsystem_maintenance_fn'],
        withCheck: sql`((delivered_at IS NULL) AND (opened_at IS NULL) AND (provider_message_id IS NULL))`,
      }),
      pgPolicy('police_realm_only', {
        to: ['prsystem_police'],
        using: sql`(platform.current_realm() = 'police'::text)`,
        withCheck: sql`(platform.current_realm() = 'police'::text)`,
      }),
    ],
  )
  .enableRLS();

export const escalationPolicy = policeSchema
  .table(
    'escalation_policy',
    {
      approvedByAccountId: uuid('approved_by_account_id').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
      legalBasis: text('legal_basis').notNull(),
      minutes: integer('minutes').notNull(),
      policyId: uuid('policy_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      version: integer('version').notNull(),
    },
    (table) => [
      check(
        'escalation_policy_basis_bounded',
        sql`((length(legal_basis) >= 5) AND (length(legal_basis) <= 500))`,
      ),
      check('escalation_policy_minutes_bounded', sql`((minutes >= 1) AND (minutes <= 1440))`),
      check('escalation_policy_version_positive', sql`(version >= 1)`),
      unique('escalation_policy_version_uq').on(table.version),
      pgPolicy('police_realm_only', {
        to: ['prsystem_police'],
        using: sql`(platform.current_realm() = 'police'::text)`,
        withCheck: sql`(platform.current_realm() = 'police'::text)`,
      }),
    ],
  )
  .enableRLS();

export const checkinRetentionPolicy = policeSchema
  .table(
    'checkin_retention_policy',
    {
      approvedByAccountId: uuid('approved_by_account_id').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
      legalBasis: text('legal_basis').notNull(),
      policyId: uuid('policy_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      retentionDays: integer('retention_days').notNull(),
      version: integer('version').notNull(),
    },
    (table) => [
      check(
        'checkin_retention_policy_basis_bounded',
        sql`((length(legal_basis) >= 5) AND (length(legal_basis) <= 500))`,
      ),
      check(
        'checkin_retention_policy_days_bounded',
        sql`((retention_days >= 1) AND (retention_days <= 3650))`,
      ),
      check('checkin_retention_policy_version_positive', sql`(version >= 1)`),
      unique('checkin_retention_policy_version_uq').on(table.version),
      pgPolicy('police_realm_only', {
        to: ['prsystem_police'],
        using: sql`(platform.current_realm() = 'police'::text)`,
        withCheck: sql`(platform.current_realm() = 'police'::text)`,
      }),
    ],
  )
  .enableRLS();

export const foundConfirmation = policeSchema
  .table(
    'found_confirmation',
    {
      confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull(),
      correctedAt: timestamp('corrected_at', { withTimezone: true }),
      foundByAccountId: uuid('found_by_account_id').notNull(),
      foundByUnitRef: text('found_by_unit_ref').notNull(),
      foundId: uuid('found_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      locationKind: text('location_kind').notNull(),
      locationNote: text('location_note'),
      matchId: uuid('match_id').notNull(),
      note: text('note'),
      state: text('state')
        .notNull()
        .default(sql`'ACTIVE'::text`),
      taskReference: text('task_reference'),
    },
    (table) => [
      check(
        'found_confirmation_corrected_shape',
        sql`((state = 'CORRECTED'::text) = (corrected_at IS NOT NULL))`,
      ),
      check(
        'found_confirmation_kind_known',
        sql`(location_kind = ANY (ARRAY['AT_MATCH_HOTEL'::text, 'OTHER_LOCATION'::text]))`,
      ),
      check(
        'found_confirmation_location_shape',
        sql`((location_kind = 'OTHER_LOCATION'::text) = ((location_note IS NOT NULL) AND ((length(location_note) >= 3) AND (length(location_note) <= 300))))`,
      ),
      foreignKey({
        name: 'found_confirmation_match_fkey',
        columns: [table.matchId],
        foreignColumns: [policeMatch.matchId],
      }).onDelete('restrict'),
      check(
        'found_confirmation_note_bounded',
        sql`((note IS NULL) OR ((length(note) >= 1) AND (length(note) <= 500)))`,
      ),
      check(
        'found_confirmation_state_known',
        sql`(state = ANY (ARRAY['ACTIVE'::text, 'CORRECTED'::text]))`,
      ),
      check(
        'found_confirmation_task_bounded',
        sql`((task_reference IS NULL) OR ((length(task_reference) >= 1) AND (length(task_reference) <= 100)))`,
      ),
      uniqueIndex('found_confirmation_active_uq')
        .on(table.matchId)
        .where(sql`state = 'ACTIVE'::text`),
      pgPolicy('police_realm_only', {
        to: ['prsystem_police'],
        using: sql`(platform.current_realm() = 'police'::text)`,
        withCheck: sql`(platform.current_realm() = 'police'::text)`,
      }),
    ],
  )
  .enableRLS();

export const foundCorrectionRequest = policeSchema
  .table(
    'found_correction_request',
    {
      decidedAt: timestamp('decided_at', { withTimezone: true }),
      decidedByAccountId: uuid('decided_by_account_id'),
      decisionNote: text('decision_note'),
      foundId: uuid('found_id').notNull(),
      matchId: uuid('match_id').notNull(),
      reason: text('reason').notNull(),
      requestId: uuid('request_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      requestedAt: timestamp('requested_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      requestedByAccountId: uuid('requested_by_account_id').notNull(),
      state: text('state')
        .notNull()
        .default(sql`'PENDING'::text`),
    },
    (table) => [
      check(
        'found_correction_decision_shape',
        sql`((state = 'PENDING'::text) = ((decided_by_account_id IS NULL) AND (decided_at IS NULL)))`,
      ),
      foreignKey({
        name: 'found_correction_found_fkey',
        columns: [table.foundId],
        foreignColumns: [foundConfirmation.foundId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'found_correction_match_fkey',
        columns: [table.matchId],
        foreignColumns: [policeMatch.matchId],
      }).onDelete('restrict'),
      check(
        'found_correction_note_bounded',
        sql`((decision_note IS NULL) OR ((length(decision_note) >= 5) AND (length(decision_note) <= 500)))`,
      ),
      check(
        'found_correction_reason_bounded',
        sql`((length(reason) >= 10) AND (length(reason) <= 500))`,
      ),
      check(
        'found_correction_state_known',
        sql`(state = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text]))`,
      ),
      check(
        'found_correction_two_person',
        sql`((decided_by_account_id IS NULL) OR (decided_by_account_id <> requested_by_account_id))`,
      ),
      uniqueIndex('found_correction_pending_uq')
        .on(table.matchId)
        .where(sql`state = 'PENDING'::text`),
      pgPolicy('police_realm_only', {
        to: ['prsystem_police'],
        using: sql`(platform.current_realm() = 'police'::text)`,
        withCheck: sql`(platform.current_realm() = 'police'::text)`,
      }),
    ],
  )
  .enableRLS();

export const falseMatchRequest = policeSchema
  .table(
    'false_match_request',
    {
      decidedAt: timestamp('decided_at', { withTimezone: true }),
      decidedByAccountId: uuid('decided_by_account_id'),
      decisionNote: text('decision_note'),
      matchId: uuid('match_id').notNull(),
      reasonCode: text('reason_code').notNull(),
      reasonNote: text('reason_note').notNull(),
      requestId: uuid('request_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      requestedAt: timestamp('requested_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      requestedByAccountId: uuid('requested_by_account_id').notNull(),
      state: text('state')
        .notNull()
        .default(sql`'PENDING'::text`),
    },
    (table) => [
      check(
        'false_match_decision_note_bounded',
        sql`((decision_note IS NULL) OR ((length(decision_note) >= 5) AND (length(decision_note) <= 500)))`,
      ),
      check(
        'false_match_decision_shape',
        sql`((state = 'PENDING'::text) = ((decided_by_account_id IS NULL) AND (decided_at IS NULL)))`,
      ),
      foreignKey({
        name: 'false_match_match_fkey',
        columns: [table.matchId],
        foreignColumns: [policeMatch.matchId],
      }).onDelete('restrict'),
      check(
        'false_match_note_bounded',
        sql`((length(reason_note) >= 10) AND (length(reason_note) <= 500))`,
      ),
      check(
        'false_match_reason_known',
        sql`(reason_code = ANY (ARRAY['WRONG_NUMBER_ENTERED'::text, 'IDENTIFIER_USED_BY_ANOTHER'::text, 'IDENTITY_DISPROVED'::text, 'OTHER_VERIFIED_REASON'::text]))`,
      ),
      check(
        'false_match_state_known',
        sql`(state = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text]))`,
      ),
      check(
        'false_match_two_person',
        sql`((decided_by_account_id IS NULL) OR (decided_by_account_id <> requested_by_account_id))`,
      ),
      uniqueIndex('false_match_pending_uq')
        .on(table.matchId)
        .where(sql`state = 'PENDING'::text`),
      pgPolicy('police_realm_only', {
        to: ['prsystem_police'],
        using: sql`(platform.current_realm() = 'police'::text)`,
        withCheck: sql`(platform.current_realm() = 'police'::text)`,
      }),
    ],
  )
  .enableRLS();

export const bootstrapCode = policeSchema
  .table(
    'bootstrap_code',
    {
      accountId: uuid('account_id').notNull(),
      attempts: integer('attempts')
        .notNull()
        .default(sql`0`),
      codeHash: bytea('code_hash').notNull(),
      codeId: uuid('code_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      consumedAt: timestamp('consumed_at', { withTimezone: true }),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      hashKeyVersion: text('hash_key_version').notNull(),
      invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
      issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
      lockedUntil: timestamp('locked_until', { withTimezone: true }),
      phoneVersion: integer('phone_version').notNull(),
      purpose: text('purpose').notNull(),
    },
    (table) => [
      check('bootstrap_code_attempts_bounded', sql`((attempts >= 0) AND (attempts <= 3))`),
      check('bootstrap_code_phone_version_positive', sql`(phone_version >= 1)`),
      check(
        'bootstrap_code_purpose_known',
        sql`(purpose = ANY (ARRAY['ACCOUNT_ACTIVATION'::text, 'PASSWORD_RESET'::text]))`,
      ),
      check(
        'bootstrap_code_terminal_shape',
        sql`((consumed_at IS NULL) OR (invalidated_at IS NULL))`,
      ),
      check('bootstrap_code_ttl_derived', sql`(expires_at = (issued_at + '00:05:00'::interval))`),
      index('bootstrap_code_account_idx').on(table.accountId, table.issuedAt.desc().nullsFirst()),
      uniqueIndex('bootstrap_code_live_uq')
        .on(table.accountId, table.purpose)
        .where(sql`(consumed_at IS NULL) AND (invalidated_at IS NULL)`),
      pgPolicy('police_realm_only', {
        to: ['prsystem_police'],
        using: sql`(platform.current_realm() = 'police'::text)`,
        withCheck: sql`(platform.current_realm() = 'police'::text)`,
      }),
    ],
  )
  .enableRLS();

export const wantedExportJob = policeSchema
  .table(
    'wanted_export_job',
    {
      contentHash: text('content_hash'),
      expiresAt: timestamp('expires_at', { withTimezone: true }),
      failureReason: text('failure_reason'),
      filters: jsonb('filters')
        .notNull()
        .default(sql`'{}'::jsonb`),
      fullIdentifier: boolean('full_identifier')
        .notNull()
        .default(sql`false`),
      jobId: uuid('job_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      purpose: text('purpose').notNull(),
      readyAt: timestamp('ready_at', { withTimezone: true }),
      requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
      requestedByAccountId: uuid('requested_by_account_id').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      rowCount: integer('row_count'),
      state: text('state')
        .notNull()
        .default(sql`'QUEUED'::text`),
      storageKey: text('storage_key'),
      taskReference: text('task_reference').notNull(),
    },
    (table) => [
      check('wanted_export_filters_sanitised', sql`(NOT platform.contains_denied_key(filters))`),
      check(
        'wanted_export_purpose_bounded',
        sql`((length(purpose) >= 10) AND (length(purpose) <= 500))`,
      ),
      check(
        'wanted_export_ready_shape',
        sql`((state = 'COMPLETED'::text) = ((ready_at IS NOT NULL) AND (storage_key IS NOT NULL) AND (row_count IS NOT NULL)))`,
      ),
      check('wanted_export_revision_non_negative', sql`(revision >= 0)`),
      check('wanted_export_row_cap', sql`((row_count IS NULL) OR (row_count <= 10000))`),
      check(
        'wanted_export_state_known',
        sql`(state = ANY (ARRAY['QUEUED'::text, 'RUNNING'::text, 'COMPLETED'::text, 'FAILED'::text, 'EXPIRED'::text]))`,
      ),
      check(
        'wanted_export_storage_key_shape',
        sql`((storage_key IS NULL) OR (storage_key ~ '^police-exports/[0-9a-f-]{36}/[0-9a-f]{32}\\.xlsx$'::text))`,
      ),
      check(
        'wanted_export_task_bounded',
        sql`((length(task_reference) >= 1) AND (length(task_reference) <= 100))`,
      ),
      check(
        'wanted_export_ttl_derived',
        sql`(((ready_at IS NULL) AND (expires_at IS NULL)) OR (expires_at = (ready_at + '01:00:00'::interval)))`,
      ),
      index('wanted_export_requester_idx').on(
        table.requestedByAccountId,
        table.requestedAt.desc().nullsFirst(),
      ),
      pgPolicy('police_realm_only', {
        to: ['prsystem_police'],
        using: sql`(platform.current_realm() = 'police'::text)`,
        withCheck: sql`(platform.current_realm() = 'police'::text)`,
      }),
    ],
  )
  .enableRLS();

export const wantedExportGrant = policeSchema
  .table(
    'wanted_export_grant',
    {
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      grantId: uuid('grant_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
      issuedByAccountId: uuid('issued_by_account_id').notNull(),
      jobId: uuid('job_id').notNull(),
    },
    (table) => [
      foreignKey({
        name: 'wanted_export_grant_job_fkey',
        columns: [table.jobId],
        foreignColumns: [wantedExportJob.jobId],
      }).onDelete('restrict'),
      check(
        'wanted_export_grant_ttl_derived',
        sql`(expires_at = (issued_at + '00:05:00'::interval))`,
      ),
      index('wanted_export_grant_job_idx').on(table.jobId, table.issuedAt.desc().nullsFirst()),
      pgPolicy('police_realm_only', {
        to: ['prsystem_police'],
        using: sql`(platform.current_realm() = 'police'::text)`,
        withCheck: sql`(platform.current_realm() = 'police'::text)`,
      }),
    ],
  )
  .enableRLS();

export const exactSearchAttempt = policeSchema
  .table(
    'exact_search_attempt',
    {
      accountId: uuid('account_id').notNull(),
      attemptId: uuid('attempt_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      attemptedAt: timestamp('attempted_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      deviceRef: text('device_ref'),
      found: boolean('found').notNull(),
      searchKind: text('search_kind').notNull(),
    },
    (table) => [
      check(
        'exact_search_device_bounded',
        sql`((device_ref IS NULL) OR ((length(device_ref) >= 1) AND (length(device_ref) <= 128)))`,
      ),
      check(
        'exact_search_kind_known',
        sql`(search_kind = ANY (ARRAY['REGISTRATION_NUMBER'::text, 'MATCH_ID'::text]))`,
      ),
      index('exact_search_account_idx').on(table.accountId, table.attemptedAt.desc().nullsFirst()),
      pgPolicy('police_realm_only', {
        to: ['prsystem_police'],
        using: sql`(platform.current_realm() = 'police'::text)`,
        withCheck: sql`(platform.current_realm() = 'police'::text)`,
      }),
    ],
  )
  .enableRLS();

export const policeContact = policeSchema
  .table(
    'police_contact',
    {
      accountId: uuid('account_id').notNull(),
      approvedByAccountId: uuid('approved_by_account_id').notNull(),
      contactId: uuid('contact_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      isCurrent: boolean('is_current')
        .notNull()
        .default(sql`true`),
      phoneCiphertext: bytea('phone_ciphertext').notNull(),
      phoneKeyVersion: text('phone_key_version').notNull(),
      phoneMasked: text('phone_masked').notNull(),
      phoneVersion: integer('phone_version').notNull(),
      phoneWrappedDek: bytea('phone_wrapped_dek').notNull(),
      verifiedAt: timestamp('verified_at', { withTimezone: true }),
    },
    (table) => [
      check('police_contact_mask_shape', sql`(phone_masked ~ '^\\*{4,}[0-9]{4}$'::text)`),
      check('police_contact_version_positive', sql`(phone_version >= 1)`),
      unique('police_contact_version_uq').on(table.accountId, table.phoneVersion),
      uniqueIndex('police_contact_current_uq')
        .on(table.accountId)
        .where(sql`is_current IS TRUE`),
      pgPolicy('police_realm_only', {
        to: ['prsystem_police'],
        using: sql`(platform.current_realm() = 'police'::text)`,
        withCheck: sql`(platform.current_realm() = 'police'::text)`,
      }),
    ],
  )
  .enableRLS();

// ---------------------------------------------------------------- Phase 19
//
// Platform Operation: the named Operation account and its second factor, the
// offline recovery handoff, the subscription contact and its two challenges,
// the suspension history, and manual-only SMS. The four SMS tables and the
// preview are isolated by realm rather than by tenant — a reminder spans every
// hotel the filter matched, and a recipient message's `hotel_id` says who was
// written to, not whose row it is.

export const operationTotpFactor = platform.table(
  'operation_totp_factor',
  {
    accountId: uuid('account_id').primaryKey().notNull(),
    digits: integer('digits')
      .notNull()
      .default(sql`6`),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastAcceptedStep: bigint('last_accepted_step', { mode: 'bigint' }),
    periodSeconds: integer('period_seconds')
      .notNull()
      .default(sql`30`),
    revision: integer('revision')
      .notNull()
      .default(sql`0`),
    secretCiphertext: bytea('secret_ciphertext').notNull(),
    secretKeyVersion: text('secret_key_version').notNull(),
    secretWrappedDek: bytea('secret_wrapped_dek').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'operation_totp_factor_account_fkey',
      columns: [table.accountId],
      foreignColumns: [userAccount.accountId],
    }).onDelete('restrict'),
    check('operation_totp_factor_digits_known', sql`(digits = 6)`),
    check('operation_totp_factor_period_known', sql`(period_seconds = 30)`),
    check('operation_totp_factor_revision_non_negative', sql`(revision >= 0)`),
    check(
      'operation_totp_factor_step_non_negative',
      sql`((last_accepted_step IS NULL) OR (last_accepted_step >= 0))`,
    ),
  ],
);

export const operationAccountEnrolment = platform.table(
  'operation_account_enrolment',
  {
    accountId: uuid('account_id').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    createdByAccountId: uuid('created_by_account_id').notNull(),
    enrolmentId: uuid('enrolment_id')
      .primaryKey()
      .notNull()
      .default(sql`gen_random_uuid()`),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revision: integer('revision')
      .notNull()
      .default(sql`0`),
    state: text('state')
      .notNull()
      .default(sql`'PENDING'::text`),
    tokenHash: text('token_hash'),
    tokenKeyVersion: text('token_key_version'),
  },
  (table) => [
    foreignKey({
      name: 'operation_account_enrolment_account_fkey',
      columns: [table.accountId],
      foreignColumns: [userAccount.accountId],
    }).onDelete('restrict'),
    check(
      'operation_account_enrolment_completed_has_time',
      sql`((state = 'COMPLETED'::text) = (completed_at IS NOT NULL))`,
    ),
    foreignKey({
      name: 'operation_account_enrolment_creator_fkey',
      columns: [table.createdByAccountId],
      foreignColumns: [userAccount.accountId],
    }).onDelete('restrict'),
    check('operation_account_enrolment_revision_non_negative', sql`(revision >= 0)`),
    check(
      'operation_account_enrolment_state_known',
      sql`(state = ANY (ARRAY['PENDING'::text, 'COMPLETED'::text, 'CANCELLED'::text]))`,
    ),
    check(
      'operation_account_enrolment_token_complete',
      sql`(num_nonnulls(token_hash, token_key_version, expires_at) = ANY (ARRAY[0, 3]))`,
    ),
    check(
      'operation_account_enrolment_token_only_while_pending',
      sql`((token_hash IS NULL) OR (state = 'PENDING'::text))`,
    ),
    check(
      'operation_account_enrolment_token_shape',
      sql`((token_hash IS NULL) OR (token_hash ~ '^[0-9a-f]{64}$'::text))`,
    ),
    unique('operation_account_enrolment_token_uq').on(table.tokenHash),
    uniqueIndex('operation_account_enrolment_pending_uq')
      .on(table.accountId)
      .where(sql`state = 'PENDING'::text`),
  ],
);

export const accountRecoveryRequest = platform.table(
  'account_recovery_request',
  {
    accountId: uuid('account_id').notNull(),
    caseReference: text('case_reference').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedByAccountId: uuid('decided_by_account_id'),
    decisionReason: text('decision_reason'),
    requestId: uuid('request_id')
      .primaryKey()
      .notNull()
      .default(sql`gen_random_uuid()`),
    requestNote: text('request_note').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    requestedByAccountId: uuid('requested_by_account_id').notNull(),
    revision: integer('revision')
      .notNull()
      .default(sql`0`),
    state: text('state')
      .notNull()
      .default(sql`'PENDING'::text`),
  },
  (table) => [
    foreignKey({
      name: 'account_recovery_request_account_fkey',
      columns: [table.accountId],
      foreignColumns: [userAccount.accountId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'account_recovery_request_decider_fkey',
      columns: [table.decidedByAccountId],
      foreignColumns: [userAccount.accountId],
    }).onDelete('restrict'),
    check(
      'account_recovery_request_decision_complete',
      sql`(num_nonnulls(decided_by_account_id, decision_reason, decided_at) =
CASE
    WHEN (state = 'PENDING'::text) THEN 0
    ELSE 3
END)`,
    ),
    check(
      'account_recovery_request_note_bounded',
      sql`((length(request_note) >= 10) AND (length(request_note) <= 1000))`,
    ),
    check(
      'account_recovery_request_reason_bounded',
      sql`((decision_reason IS NULL) OR ((length(decision_reason) >= 10) AND (length(decision_reason) <= 1000)))`,
    ),
    check(
      'account_recovery_request_reference_bounded',
      sql`((length(case_reference) >= 3) AND (length(case_reference) <= 120))`,
    ),
    foreignKey({
      name: 'account_recovery_request_requester_fkey',
      columns: [table.requestedByAccountId],
      foreignColumns: [userAccount.accountId],
    }).onDelete('restrict'),
    check('account_recovery_request_revision_non_negative', sql`(revision >= 0)`),
    check(
      'account_recovery_request_state_known',
      sql`(state = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REFUSED'::text]))`,
    ),
    check(
      'account_recovery_request_two_people',
      sql`((decided_by_account_id IS NULL) OR (decided_by_account_id <> requested_by_account_id))`,
    ),
    uniqueIndex('account_recovery_request_open_uq')
      .on(table.accountId)
      .where(sql`state = 'PENDING'::text`),
  ],
);

export const subscriptionContact = platform
  .table(
    'subscription_contact',
    {
      changeRequestId: uuid('change_request_id'),
      changedByAccountId: uuid('changed_by_account_id'),
      contactId: uuid('contact_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      effectiveFrom: timestamp('effective_from', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      hotelId: uuid('hotel_id').notNull(),
      isCurrent: boolean('is_current')
        .notNull()
        .default(sql`true`),
      phone: text('phone').notNull(),
      source: text('source').notNull(),
      subscriptionId: uuid('subscription_id').notNull(),
      supersededAt: timestamp('superseded_at', { withTimezone: true }),
    },
    (table) => [
      foreignKey({
        name: 'subscription_contact_actor_fkey',
        columns: [table.changedByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      check(
        'subscription_contact_change_shape',
        sql`
CASE source
    WHEN 'CONTACT_CHANGE'::text THEN ((change_request_id IS NOT NULL) AND (changed_by_account_id IS NOT NULL))
    ELSE ((change_request_id IS NULL) AND (changed_by_account_id IS NULL))
END`,
      ),
      check('subscription_contact_current_has_no_end', sql`(is_current = (superseded_at IS NULL))`),
      check('subscription_contact_phone_shape', sql`(phone ~ '^\\+976[0-9]{8}$'::text)`),
      unique('subscription_contact_scope_uq').on(table.hotelId, table.contactId),
      check(
        'subscription_contact_source_known',
        sql`(source = ANY (ARRAY['PROVISIONING'::text, 'CONTACT_CHANGE'::text]))`,
      ),
      foreignKey({
        name: 'subscription_contact_subscription_fkey',
        columns: [table.hotelId, table.subscriptionId],
        foreignColumns: [hotelSubscription.hotelId, hotelSubscription.subscriptionId],
      }).onDelete('restrict'),
      uniqueIndex('subscription_contact_current_uq')
        .on(table.subscriptionId)
        .where(sql`is_current IS TRUE`),
      pgPolicy('operation_dashboard_read', {
        for: 'select',
        to: ['prsystem_maintenance_fn'],
        using: sql`(is_current IS TRUE)`,
      }),
      pgPolicy('provisioning_seed', {
        for: 'insert',
        to: ['prsystem_maintenance_fn'],
        withCheck: sql`(source = 'PROVISIONING'::text)`,
      }),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const subscriptionContactChangeRequest = platform
  .table(
    'subscription_contact_change_request',
    {
      appliedContactId: uuid('applied_contact_id'),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      exceptionApprovedAt: timestamp('exception_approved_at', { withTimezone: true }),
      exceptionApprovedByAccountId: uuid('exception_approved_by_account_id'),
      exceptionReason: text('exception_reason'),
      exceptionReference: text('exception_reference'),
      hotelId: uuid('hotel_id').notNull(),
      newPhone: text('new_phone').notNull(),
      newPhoneVerifiedAt: timestamp('new_phone_verified_at', { withTimezone: true }),
      oldPhone: text('old_phone').notNull(),
      oldPhoneVerifiedAt: timestamp('old_phone_verified_at', { withTimezone: true }),
      requestId: uuid('request_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      requestedByAccountId: uuid('requested_by_account_id').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'AWAITING_OLD_PHONE'::text`),
      subscriptionId: uuid('subscription_id').notNull(),
      terminalAt: timestamp('terminal_at', { withTimezone: true }),
      terminalReason: text('terminal_reason'),
    },
    (table) => [
      foreignKey({
        name: 'subscription_contact_change_applied_fkey',
        columns: [table.hotelId, table.appliedContactId],
        foreignColumns: [subscriptionContact.hotelId, subscriptionContact.contactId],
      }).onDelete('restrict'),
      check(
        'subscription_contact_change_applied_is_verified',
        sql`((state <> 'APPLIED'::text) OR ((new_phone_verified_at IS NOT NULL) AND ((old_phone_verified_at IS NOT NULL) OR (exception_approved_at IS NOT NULL))))`,
      ),
      check(
        'subscription_contact_change_applied_shape',
        sql`((state = 'APPLIED'::text) = (applied_contact_id IS NOT NULL))`,
      ),
      foreignKey({
        name: 'subscription_contact_change_approver_fkey',
        columns: [table.exceptionApprovedByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      check(
        'subscription_contact_change_exception_complete',
        sql`(num_nonnulls(exception_approved_by_account_id, exception_reference, exception_reason, exception_approved_at) = ANY (ARRAY[0, 4]))`,
      ),
      check(
        'subscription_contact_change_exception_reason_bounded',
        sql`((exception_reason IS NULL) OR ((length(exception_reason) >= 10) AND (length(exception_reason) <= 1000)))`,
      ),
      check(
        'subscription_contact_change_exception_reference_bounded',
        sql`((exception_reference IS NULL) OR ((length(exception_reference) >= 3) AND (length(exception_reference) <= 120)))`,
      ),
      check('subscription_contact_change_is_a_change', sql`(old_phone <> new_phone)`),
      check(
        'subscription_contact_change_phone_shape',
        sql`((old_phone ~ '^\\+976[0-9]{8}$'::text) AND (new_phone ~ '^\\+976[0-9]{8}$'::text))`,
      ),
      foreignKey({
        name: 'subscription_contact_change_requester_fkey',
        columns: [table.requestedByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      check('subscription_contact_change_revision_non_negative', sql`(revision >= 0)`),
      unique('subscription_contact_change_scope_uq').on(table.hotelId, table.requestId),
      check(
        'subscription_contact_change_state_known',
        sql`(state = ANY (ARRAY['AWAITING_OLD_PHONE'::text, 'AWAITING_NEW_PHONE'::text, 'APPLIED'::text, 'CANCELLED'::text, 'EXPIRED'::text]))`,
      ),
      foreignKey({
        name: 'subscription_contact_change_subscription_fkey',
        columns: [table.hotelId, table.subscriptionId],
        foreignColumns: [hotelSubscription.hotelId, hotelSubscription.subscriptionId],
      }).onDelete('restrict'),
      check(
        'subscription_contact_change_terminal_has_time',
        sql`((state = ANY (ARRAY['AWAITING_OLD_PHONE'::text, 'AWAITING_NEW_PHONE'::text])) = (terminal_at IS NULL))`,
      ),
      check(
        'subscription_contact_change_waiver_is_not_a_pass',
        sql`((exception_approved_at IS NULL) OR (old_phone_verified_at IS NULL))`,
      ),
      uniqueIndex('subscription_contact_change_open_uq')
        .on(table.subscriptionId)
        .where(sql`state = ANY (ARRAY['AWAITING_OLD_PHONE'::text, 'AWAITING_NEW_PHONE'::text])`),
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

export const subscriptionContactCode = platform
  .table(
    'subscription_contact_code',
    {
      attempts: integer('attempts')
        .notNull()
        .default(sql`0`),
      challenge: text('challenge').notNull(),
      codeHash: text('code_hash').notNull(),
      codeId: uuid('code_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      codeKeyVersion: text('code_key_version').notNull(),
      consumedAt: timestamp('consumed_at', { withTimezone: true }),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      hotelId: uuid('hotel_id').notNull(),
      isCurrent: boolean('is_current')
        .notNull()
        .default(sql`true`),
      issuedAt: timestamp('issued_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      maxAttempts: integer('max_attempts')
        .notNull()
        .default(sql`5`),
      phone: text('phone').notNull(),
      requestId: uuid('request_id').notNull(),
      supersededAt: timestamp('superseded_at', { withTimezone: true }),
    },
    (table) => [
      check(
        'subscription_contact_code_attempts_bounded',
        sql`((attempts >= 0) AND (attempts <= max_attempts))`,
      ),
      check(
        'subscription_contact_code_challenge_known',
        sql`(challenge = ANY (ARRAY['OLD_PHONE'::text, 'NEW_PHONE'::text]))`,
      ),
      check(
        'subscription_contact_code_current_is_live',
        sql`(is_current = ((consumed_at IS NULL) AND (superseded_at IS NULL)))`,
      ),
      check('subscription_contact_code_expiry_after_issue', sql`(expires_at > issued_at)`),
      check('subscription_contact_code_hash_shape', sql`(code_hash ~ '^[0-9a-f]{64}$'::text)`),
      check('subscription_contact_code_max_attempts_known', sql`(max_attempts = 5)`),
      check('subscription_contact_code_phone_shape', sql`(phone ~ '^\\+976[0-9]{8}$'::text)`),
      foreignKey({
        name: 'subscription_contact_code_request_fkey',
        columns: [table.hotelId, table.requestId],
        foreignColumns: [
          subscriptionContactChangeRequest.hotelId,
          subscriptionContactChangeRequest.requestId,
        ],
      }).onDelete('restrict'),
      uniqueIndex('subscription_contact_code_current_uq')
        .on(table.requestId, table.challenge)
        .where(sql`is_current IS TRUE`),
      pgPolicy('tenant_isolation', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ],
  )
  .enableRLS();

export const subscriptionSuspensionEvent = platform
  .table(
    'subscription_suspension_event',
    {
      action: text('action').notNull(),
      actorAccountId: uuid('actor_account_id').notNull(),
      eventId: uuid('event_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      expiresAtSnapshot: timestamp('expires_at_snapshot', { withTimezone: true }).notNull(),
      hotelId: uuid('hotel_id').notNull(),
      note: text('note').notNull(),
      occurredAt: timestamp('occurred_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      reasonCode: text('reason_code').notNull(),
      sessionsRevoked: integer('sessions_revoked')
        .notNull()
        .default(sql`0`),
      startsAtSnapshot: timestamp('starts_at_snapshot', { withTimezone: true }).notNull(),
      subscriptionId: uuid('subscription_id').notNull(),
      suspendedAfter: boolean('suspended_after').notNull(),
      suspendedBefore: boolean('suspended_before').notNull(),
    },
    (table) => [
      check(
        'subscription_suspension_event_action_known',
        sql`(action = ANY (ARRAY['SUSPEND'::text, 'REACTIVATE'::text]))`,
      ),
      check(
        'subscription_suspension_event_action_matches',
        sql`(suspended_after = (action = 'SUSPEND'::text))`,
      ),
      foreignKey({
        name: 'subscription_suspension_event_actor_fkey',
        columns: [table.actorAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      check(
        'subscription_suspension_event_is_a_transition',
        sql`(suspended_before <> suspended_after)`,
      ),
      check(
        'subscription_suspension_event_note_bounded',
        sql`((length(note) >= 10) AND (length(note) <= 1000))`,
      ),
      check(
        'subscription_suspension_event_reason_code_shape',
        sql`(reason_code ~ '^[A-Z][A-Z0-9_]{2,39}$'::text)`,
      ),
      check('subscription_suspension_event_sessions_non_negative', sql`(sessions_revoked >= 0)`),
      foreignKey({
        name: 'subscription_suspension_event_subscription_fkey',
        columns: [table.hotelId, table.subscriptionId],
        foreignColumns: [hotelSubscription.hotelId, hotelSubscription.subscriptionId],
      }).onDelete('restrict'),
      index('subscription_suspension_event_subscription_idx').on(
        table.subscriptionId,
        table.occurredAt.desc().nullsFirst(),
      ),
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

export const smsTariff = platform.table(
  'sms_tariff',
  {
    agreementReference: text('agreement_reference').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    currency: text('currency')
      .notNull()
      .default(sql`'MNT'::text`),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    pricePerSegmentMnt: bigint('price_per_segment_mnt', { mode: 'bigint' }).notNull(),
    provider: text('provider').notNull(),
    tariffId: uuid('tariff_id')
      .primaryKey()
      .notNull()
      .default(sql`gen_random_uuid()`),
  },
  (table) => [
    check('sms_tariff_currency_known', sql`(currency = 'MNT'::text)`),
    check('sms_tariff_price_positive', sql`(price_per_segment_mnt > 0)`),
    check('sms_tariff_provider_known', sql`(provider = 'CALLPRO'::text)`),
    check(
      'sms_tariff_reference_bounded',
      sql`((length(agreement_reference) >= 3) AND (length(agreement_reference) <= 120))`,
    ),
    check(
      'sms_tariff_window_ordered',
      sql`((effective_to IS NULL) OR (effective_to > effective_from))`,
    ),
    uniqueIndex('sms_tariff_live_uq')
      .on(table.provider)
      .where(sql`effective_to IS NULL`),
  ],
);

export const smsPreview = platform
  .table(
    'sms_preview',
    {
      body: text('body').notNull(),
      bodyHash: text('body_hash').notNull(),
      consumedAt: timestamp('consumed_at', { withTimezone: true }),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      createdByAccountId: uuid('created_by_account_id').notNull(),
      estimatedCostMnt: bigint('estimated_cost_mnt', { mode: 'bigint' }),
      excludedCount: integer('excluded_count').notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      filterSnapshot: jsonb('filter_snapshot').notNull(),
      previewId: uuid('preview_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      recipientCount: integer('recipient_count').notNull(),
      recipientHash: text('recipient_hash').notNull(),
      segmentsPerRecipient: integer('segments_per_recipient').notNull(),
      tariffId: uuid('tariff_id'),
      totalSegments: integer('total_segments').notNull(),
    },
    (table) => [
      foreignKey({
        name: 'sms_preview_author_fkey',
        columns: [table.createdByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      check(
        'sms_preview_body_bounded',
        sql`((length(btrim(body)) >= 1) AND (length(btrim(body)) <= 300))`,
      ),
      check('sms_preview_body_is_trimmed', sql`(body = btrim(body))`),
      check(
        'sms_preview_cost_needs_a_tariff',
        sql`(num_nonnulls(estimated_cost_mnt, tariff_id) = ANY (ARRAY[0, 2]))`,
      ),
      check(
        'sms_preview_cost_non_negative',
        sql`((estimated_cost_mnt IS NULL) OR (estimated_cost_mnt >= 0))`,
      ),
      check(
        'sms_preview_counts_non_negative',
        sql`((recipient_count >= 0) AND (excluded_count >= 0) AND (segments_per_recipient >= 0))`,
      ),
      check('sms_preview_expiry_after_creation', sql`(expires_at > created_at)`),
      check(
        'sms_preview_hash_shape',
        sql`((body_hash ~ '^[0-9a-f]{64}$'::text) AND (recipient_hash ~ '^[0-9a-f]{64}$'::text))`,
      ),
      foreignKey({
        name: 'sms_preview_tariff_fkey',
        columns: [table.tariffId],
        foreignColumns: [smsTariff.tariffId],
      }).onDelete('restrict'),
      check(
        'sms_preview_total_is_product',
        sql`(total_segments = (recipient_count * segments_per_recipient))`,
      ),
      pgPolicy('operation_realm_only', {
        using: sql`(platform.current_realm() = 'operation'::text)`,
        withCheck: sql`(platform.current_realm() = 'operation'::text)`,
      }),
    ],
  )
  .enableRLS();

export const smsSendJob = platform
  .table(
    'sms_send_job',
    {
      body: text('body').notNull(),
      confirmedAt: timestamp('confirmed_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      confirmedByAccountId: uuid('confirmed_by_account_id').notNull(),
      dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
      estimatedCostMnt: bigint('estimated_cost_mnt', { mode: 'bigint' }),
      excludedCount: integer('excluded_count').notNull(),
      filterSnapshot: jsonb('filter_snapshot').notNull(),
      jobId: uuid('job_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      lastError: text('last_error'),
      previewId: uuid('preview_id').notNull(),
      providerReference: text('provider_reference'),
      recipientCount: integer('recipient_count').notNull(),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      state: text('state')
        .notNull()
        .default(sql`'CONFIRMED'::text`),
      totalSegments: integer('total_segments').notNull(),
    },
    (table) => [
      foreignKey({
        name: 'sms_send_job_actor_fkey',
        columns: [table.confirmedByAccountId],
        foreignColumns: [userAccount.accountId],
      }).onDelete('restrict'),
      check(
        'sms_send_job_body_bounded',
        sql`((length(btrim(body)) >= 1) AND (length(btrim(body)) <= 300))`,
      ),
      check(
        'sms_send_job_counts_non_negative',
        sql`((recipient_count >= 0) AND (excluded_count >= 0) AND (total_segments >= 0))`,
      ),
      check(
        'sms_send_job_dispatched_has_time',
        sql`((state = 'CONFIRMED'::text) = (dispatched_at IS NULL))`,
      ),
      foreignKey({
        name: 'sms_send_job_preview_fkey',
        columns: [table.previewId],
        foreignColumns: [smsPreview.previewId],
      }).onDelete('restrict'),
      unique('sms_send_job_preview_uq').on(table.previewId),
      check('sms_send_job_revision_non_negative', sql`(revision >= 0)`),
      check(
        'sms_send_job_state_known',
        sql`(state = ANY (ARRAY['CONFIRMED'::text, 'DISPATCHED'::text, 'FAILED'::text]))`,
      ),
      pgPolicy('operation_realm_only', {
        using: sql`(platform.current_realm() = 'operation'::text)`,
        withCheck: sql`(platform.current_realm() = 'operation'::text)`,
      }),
    ],
  )
  .enableRLS();

export const smsRecipientMessage = platform
  .table(
    'sms_recipient_message',
    {
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      failureCode: text('failure_code'),
      hotelId: uuid('hotel_id').notNull(),
      jobId: uuid('job_id').notNull(),
      messageId: uuid('message_id')
        .primaryKey()
        .notNull()
        .default(sql`gen_random_uuid()`),
      phone: text('phone').notNull(),
      providerMessageId: text('provider_message_id'),
      revision: integer('revision')
        .notNull()
        .default(sql`0`),
      segments: integer('segments').notNull(),
      state: text('state')
        .notNull()
        .default(sql`'PENDING'::text`),
      stateChangedAt: timestamp('state_changed_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      subscriptionId: uuid('subscription_id').notNull(),
    },
    (table) => [
      check(
        'sms_recipient_message_failure_shape',
        sql`((failure_code IS NULL) OR (state = 'FAILED'::text))`,
      ),
      foreignKey({
        name: 'sms_recipient_message_job_fkey',
        columns: [table.jobId],
        foreignColumns: [smsSendJob.jobId],
      }).onDelete('restrict'),
      unique('sms_recipient_message_job_phone_uq').on(table.jobId, table.phone),
      check('sms_recipient_message_phone_shape', sql`(phone ~ '^\\+976[0-9]{8}$'::text)`),
      check('sms_recipient_message_revision_non_negative', sql`(revision >= 0)`),
      check('sms_recipient_message_segments_positive', sql`(segments >= 1)`),
      check(
        'sms_recipient_message_sent_has_provider_id',
        sql`((state = ANY (ARRAY['SENT'::text, 'DELIVERED'::text])) <= (provider_message_id IS NOT NULL))`,
      ),
      check(
        'sms_recipient_message_state_known',
        sql`(state = ANY (ARRAY['PENDING'::text, 'SENT'::text, 'DELIVERED'::text, 'FAILED'::text]))`,
      ),
      index('sms_recipient_message_month_idx').on(table.createdAt, table.state),
      uniqueIndex('sms_recipient_message_provider_uq')
        .on(table.providerMessageId)
        .where(sql`provider_message_id IS NOT NULL`),
      pgPolicy('operation_realm_only', {
        using: sql`(platform.current_realm() = 'operation'::text)`,
        withCheck: sql`(platform.current_realm() = 'operation'::text)`,
      }),
    ],
  )
  .enableRLS();

export const smsMessageEvent = platform
  .table(
    'sms_message_event',
    {
      detail: text('detail'),
      eventId: bigint('event_id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
      messageId: uuid('message_id').notNull(),
      occurredAt: timestamp('occurred_at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      providerMessageId: text('provider_message_id'),
      source: text('source').notNull(),
      state: text('state').notNull(),
    },
    (table) => [
      foreignKey({
        name: 'sms_message_event_message_fkey',
        columns: [table.messageId],
        foreignColumns: [smsRecipientMessage.messageId],
      }).onDelete('restrict'),
      check(
        'sms_message_event_source_known',
        sql`(source = ANY (ARRAY['CONFIRMATION'::text, 'PROVIDER_SEND'::text, 'PROVIDER_STATUS_QUERY'::text]))`,
      ),
      check(
        'sms_message_event_state_known',
        sql`(state = ANY (ARRAY['PENDING'::text, 'SENT'::text, 'DELIVERED'::text, 'FAILED'::text]))`,
      ),
      index('sms_message_event_message_idx').on(table.messageId, table.eventId),
      pgPolicy('operation_realm_only', {
        using: sql`(platform.current_realm() = 'operation'::text)`,
        withCheck: sql`(platform.current_realm() = 'operation'::text)`,
      }),
    ],
  )
  .enableRLS();

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
  // Phase 09.
  cleaningTask,
  minibarUsageReport,
  minibarUsageReportVersion,
  minibarUsageReportLine,
  minibarUsageReportMovement,
  minibarReportDispute,
  minibarPaymentLock,
  minibarReportAdjustment,
  minibarRefillTask,
  // Phase 10.
  depositConfig,
  stayFolio,
  folioLine,
  depositAggregate,
  paymentTransaction,
  depositAllocation,
  refundRequest,
  financialCorrection,
  depositReconciliationCase,
  hotelFinanceEvent,
  // Phase 11.
  cashMovement,
  cashTransfer,
  cashRequest,
  expense,
  // Phase 12.
  guestAccount,
  guestPhoneVerification,
  guestIdentityLink,
  guestAccountLinkRequest,
  hotelPhoto,
  // Phase 13.
  booking,
  bookingNight,
  categoryNightInventory,
  bookingPaymentAttempt,
  bookingEvent,
  // Phase 14.
  hotelCommissionContract,
  bookingPayable,
  bookingLedgerEvent,
  bookingRefund,
  payoutBatch,
  payoutBatchItem,
  // Phase 15.
  restaurant,
  hotelRestaurantLink,
  restaurantSchedule,
  restaurantScheduleOverride,
  restaurantMenuCategory,
  restaurantMenuItem,
  roomAccessToken,
  stayGuestAccess,
  guestAccessCode,
  guestSession,
  restaurantOrder,
  restaurantOrderItem,
  restaurantOrderEvent,
  restaurantPaymentAttempt,
  restaurantRefund,
  // Phase 16.
  hotelReview,
  hotelReviewEdit,
  hotelReviewAggregate,
  reviewReport,
  reviewModerationEvent,
  hotelReviewReply,
  hotelReviewReplyEvent,
  // Phase 17.
  expenseCategory,
  retentionPolicy,
  stayRetention,
  retentionLegalHold,
  reportExportJob,
  reportExportGrant,
  // Phase 18.
  wantedPerson,
  wantedIdentityRevision,
  wantedCase,
  wantedCaseEvent,
  policeMatch,
  matchCaseLink,
  matchEvent,
  districtAlertGroup,
  matchAlert,
  alertDelivery,
  escalationPolicy,
  checkinRetentionPolicy,
  foundConfirmation,
  foundCorrectionRequest,
  falseMatchRequest,
  bootstrapCode,
  wantedExportJob,
  wantedExportGrant,
  exactSearchAttempt,
  policeContact,
  // Phase 19.
  operationTotpFactor,
  operationAccountEnrolment,
  accountRecoveryRequest,
  subscriptionContact,
  subscriptionContactChangeRequest,
  subscriptionContactCode,
  subscriptionSuspensionEvent,
  smsTariff,
  smsPreview,
  smsSendJob,
  smsRecipientMessage,
  smsMessageEvent,
] as const;
