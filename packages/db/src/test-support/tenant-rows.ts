/**
 * Complete, structurally valid rows for every TENANT_RLS table.
 *
 * Shared deliberately. An RLS test that inserts a partial row and accepts
 * "null value violates not-null constraint" as proof of tenant isolation has
 * tested the NOT NULL constraint, not the policy — and the only durable way to
 * stop that recurring is for every suite to build its rows from one place that
 * is known to produce rows the database would otherwise accept.
 */
export type Runtime = 'api' | 'worker' | 'police';
export type Verb = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

export interface TenantRowSpec {
  readonly name: string;
  /** A complete valid row for `hotelId`, made unique by `n`. */
  insert(hotelId: string, n: number): { sql: string; values: unknown[] };
  /**
   * Set when no runtime holds INSERT. The probe still runs the statement: the
   * refusal is then the grant rather than the policy, and both are 42501, so
   * one probe covers every table instead of a table-shaped special case.
   */
  readonly insertableByRuntime?: false;
  /**
   * Set when the row cannot be seeded at all, because something else creates
   * it. A delivery row is written only by the SECURITY DEFINER trigger on
   * `outbox_event`.
   */
  readonly seedByAdmin?: false;
  /**
   * The column an UPDATE probe touches. Defaults to `hotel_id`; a table whose
   * UPDATE grant is column-scoped must name a column inside that scope.
   */
  readonly updateColumn?: string;
  /**
   * A SET clause that is a **legal** transition for this table.
   *
   * `column = column` is a no-op update, and a table with a transition guard
   * refuses it — correctly, because a guard that allowed a self-assignment
   * would allow a revision that never moved. The ACL matrix is proving the
   * UPDATE privilege, so the fixture supplies a transition the guard accepts.
   */
  readonly updateSet?: string;
  /**
   * How many distinct rows a fixture can produce per tenant.
   *
   * Two by default: an UPDATE cell that affects one row proves less than one
   * that affects the exact number visible. The tenant root is the exception —
   * its primary key *is* the tenant, so a second row for the same tenant is not
   * a fixture limitation but an impossibility.
   */
  readonly rowsPerTenant?: number;
  /** The grants each runtime holds on this table, exactly as the migration sets them. */
  readonly grants: Readonly<Record<Runtime, readonly Verb[]>>;
}

export const TENANT_ROW_SPECS: readonly TenantRowSpec[] = [
  {
    name: 'platform.idempotency_key',
    grants: {
      api: ['SELECT', 'INSERT', 'UPDATE'],
      worker: ['SELECT', 'INSERT', 'UPDATE'],
      police: [],
    },
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.idempotency_key
              (hotel_id, realm, actor_ref, client_ref, operation, idempotency_key,
               request_hash, expires_at)
            VALUES ($1,'hotel','actor-fixture','client-fixture','fixture.probe',$2,
                    repeat('a', 64), now() + interval '1 day')`,
      values: [hotelId, `idem-fixture-${String(n).padStart(8, '0')}`],
    }),
  },
  {
    name: 'platform.outbox_event',
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT', 'INSERT'], police: [] },
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.outbox_event
              (hotel_id, aggregate_type, aggregate_id, event_type, payload)
            VALUES ($1,'fixture_probe',$2,'fixture.probe.created','{"ok":true}'::jsonb)`,
      values: [hotelId, `fixture-${String(n)}`],
    }),
  },
  {
    name: 'platform.outbox_delivery',
    // The relay is entirely a worker concern: the API holds nothing here. A
    // retained SELECT nobody exercised was reach the design does not need.
    grants: { api: [], worker: ['SELECT', 'UPDATE'], police: [] },
    // A statement that is well formed and refused on the grant. It was
    // previously empty, which forced the probe to carry this table's column
    // names in the test instead of in the fixture.
    insert: (hotelId) => ({
      sql: `INSERT INTO platform.outbox_delivery (event_id, hotel_id) VALUES (1, $1)`,
      values: [hotelId],
    }),
    insertableByRuntime: false,
    seedByAdmin: false,
  },
  {
    name: 'platform.inbox_consumption',
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT', 'INSERT'], police: [] },
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.inbox_consumption (hotel_id, consumer, dedup_key, source)
            VALUES ($1,'fixture.consumer',$2,'outbox')`,
      values: [hotelId, `dedup-fixture-${String(n)}`],
    }),
  },
  {
    name: 'platform.provider_event',
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT', 'INSERT'], police: [] },
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.provider_event
              (hotel_id, provider, provider_event_id, event_kind, payload_hash)
            VALUES ($1,'qpay',$2,'payment.succeeded', repeat('b', 64))`,
      values: [hotelId, `evt-fixture-${String(n)}`],
    }),
  },
  {
    name: 'platform.job_run',
    // D-09: no runtime holds INSERT or UPDATE. Rows come from
    // platform.begin_worker_job (ordinary) or platform.schedule_maintenance_job
    // (privileged, scheduler-only); transitions go through
    // platform.finish_worker_job or the audited maintenance function.
    grants: { api: ['SELECT'], worker: ['SELECT'], police: [] },
    insert: (hotelId, n) => ({
      // Shapes matter here: job_name and job_identity carry bounded CHECK
      // constraints, so the fixture builds values a real caller could.
      sql: `INSERT INTO platform.job_run (hotel_id, job_name, job_identity)
            VALUES ($1, $2, 'identity_fixture')`,
      values: [hotelId, `job_fixture_${String(n)}`],
    }),
    updateColumn: 'state',
  },
  {
    name: 'platform.export_artifact',
    grants: { api: ['SELECT'], worker: ['SELECT', 'INSERT', 'UPDATE'], police: [] },
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.export_artifact
              (hotel_id, export_kind, storage_key, content_hash, as_of)
            VALUES ($1,'fixture',$2, repeat('c', 64), now())`,
      values: [hotelId, `key-fixture-${String(n)}`],
    }),
  },
  // ------------------------------------------------------------- Phase 04
  //
  // Each fixture builds its own parents in one statement. A row that needed a
  // separately seeded account or membership would make the probe depend on the
  // order the specs happen to be listed in, and a reordering would silently
  // turn a policy refusal into a foreign-key refusal.
  {
    name: 'platform.hotel',
    // Phase 05 provisions hotels through paid onboarding. No runtime holds
    // INSERT, so a runtime cannot create a tenant nobody paid for.
    grants: { api: ['SELECT'], worker: [], police: [] },
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.hotel (hotel_id, display_name) VALUES ($1, $2)`,
      values: [hotelId, `Fixture Hotel ${String(n)}`],
    }),
    insertableByRuntime: false,
    rowsPerTenant: 1,
  },
  {
    name: 'platform.staff_membership',
    grants: {
      api: ['SELECT', 'INSERT', 'UPDATE'],
      worker: [],
      police: [],
    },
    insert: (hotelId, n) => ({
      sql: `WITH acct AS (
              INSERT INTO platform.user_account (realm, email_normalized)
              VALUES ('hotel', $2) RETURNING account_id
            )
            INSERT INTO platform.staff_membership
              (hotel_id, account_id, invited_email_normalized, state,
               membership_revision, activated_at)
            SELECT $1, acct.account_id, $2, 'ACTIVE', 1, now() FROM acct`,
      values: [hotelId, `fixture-member-${String(n)}@example.test`],
    }),
    updateColumn: 'state_reason',
    updateSet: 'membership_revision = membership_revision + 1',
  },
  {
    name: 'platform.membership_role_grant',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: [], police: [] },
    insert: (hotelId, n) => ({
      sql: `WITH acct AS (
              INSERT INTO platform.user_account (realm, email_normalized)
              VALUES ('hotel', $2) RETURNING account_id
            ), mem AS (
              INSERT INTO platform.staff_membership
                (hotel_id, account_id, invited_email_normalized, state,
                 membership_revision, activated_at)
              SELECT $1, acct.account_id, $2, 'ACTIVE', 1, now() FROM acct
              RETURNING membership_id
            )
            INSERT INTO platform.membership_role_grant
              (hotel_id, membership_id, role, granted_by_account_id)
            SELECT $1, mem.membership_id, 'RECEPTION', (SELECT account_id FROM acct) FROM mem`,
      values: [hotelId, `fixture-role-${String(n)}@example.test`],
    }),
    updateColumn: 'revoked_reason',
    updateSet: 'revoked_at = now(), revoked_by_account_id = granted_by_account_id',
  },
  {
    name: 'platform.staff_invitation',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: [], police: [] },
    insert: (hotelId, n) => ({
      sql: `WITH acct AS (
              INSERT INTO platform.user_account (realm, email_normalized)
              VALUES ('hotel', $2) RETURNING account_id
            ), mem AS (
              INSERT INTO platform.staff_membership
                (hotel_id, account_id, invited_email_normalized, state,
                 membership_revision, activated_at)
              SELECT $1, acct.account_id, $2, 'ACTIVE', 1, now() FROM acct
              RETURNING membership_id
            )
            INSERT INTO platform.staff_invitation
              (hotel_id, membership_id, token_hash, token_key_version,
               email_normalized, created_by_account_id, expires_at)
            SELECT $1, mem.membership_id, repeat(md5($3), 2), 'fixture-v1', $2,
                   (SELECT account_id FROM acct), now() + interval '7 days'
            FROM mem`,
      values: [hotelId, `fixture-invite-${String(n)}@example.test`, `invite-${String(n)}`],
    }),
    updateColumn: 'terminal_reason',
    updateSet: "state = 'REVOKED', terminal_at = now()",
  },
  {
    name: 'platform.invitation_requested_role',
    grants: { api: ['SELECT', 'INSERT'], worker: [], police: [] },
    insert: (hotelId, n) => ({
      sql: `WITH acct AS (
              INSERT INTO platform.user_account (realm, email_normalized)
              VALUES ('hotel', $2) RETURNING account_id
            ), mem AS (
              INSERT INTO platform.staff_membership
                (hotel_id, account_id, invited_email_normalized, state,
                 membership_revision, activated_at)
              SELECT $1, acct.account_id, $2, 'ACTIVE', 1, now() FROM acct
              RETURNING membership_id
            ), inv AS (
              INSERT INTO platform.staff_invitation
                (hotel_id, membership_id, token_hash, token_key_version,
                 email_normalized, created_by_account_id, expires_at)
              SELECT $1, mem.membership_id, repeat(md5($3), 2), 'fixture-v1', $2,
                     (SELECT account_id FROM acct), now() + interval '7 days'
              FROM mem
              RETURNING invitation_id
            )
            INSERT INTO platform.invitation_requested_role (hotel_id, invitation_id, role)
            SELECT $1, inv.invitation_id, 'RECEPTION' FROM inv`,
      values: [hotelId, `fixture-invrole-${String(n)}@example.test`, `invrole-${String(n)}`],
    }),
  },
  {
    name: 'platform.session_scope_grant',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: [], police: [] },
    insert: (hotelId, n) => ({
      sql: `WITH acct AS (
              INSERT INTO platform.user_account (realm, email_normalized)
              VALUES ('hotel', $2) RETURNING account_id
            ), mem AS (
              INSERT INTO platform.staff_membership
                (hotel_id, account_id, invited_email_normalized, state,
                 membership_revision, activated_at)
              SELECT $1, acct.account_id, $2, 'ACTIVE', 1, now() FROM acct
              RETURNING membership_id
            ), sess AS (
              INSERT INTO platform.server_session
                (account_id, realm, token_hash, token_key_version, account_epoch,
                 idle_expires_at, absolute_expires_at)
              SELECT acct.account_id, 'hotel', repeat(md5($3), 2), 'fixture-v1', 0,
                     now() + interval '30 minutes', now() + interval '8 hours'
              FROM acct
              RETURNING session_id
            )
            INSERT INTO platform.session_scope_grant
              (hotel_id, account_id, session_id, realm, membership_id, membership_revision)
            SELECT $1, (SELECT account_id FROM acct), sess.session_id, 'hotel',
                   (SELECT membership_id FROM mem), 1
            FROM sess`,
      values: [hotelId, `fixture-scope-${String(n)}@example.test`, `scope-${String(n)}`],
    }),
    updateColumn: 'revoked_reason',
    // The one legal update: a revocation. The guard refuses anything else — a
    // rewritten identity, or an update that leaves the row live — so the ACL
    // probe has to make the transition the table actually permits.
    updateSet: `revoked_at = now(), revoked_reason = 'acl-probe'`,
  },
  {
    name: 'platform.work_handoff_discovery',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: [], police: [] },
    insert: (hotelId, n) => ({
      sql: `WITH acct AS (
              INSERT INTO platform.user_account (realm, email_normalized)
              VALUES ('hotel', $2) RETURNING account_id
            ), mem AS (
              INSERT INTO platform.staff_membership
                (hotel_id, account_id, invited_email_normalized, state,
                 membership_revision, activated_at)
              SELECT $1, acct.account_id, $2, 'ACTIVE', 1, now() FROM acct
              RETURNING membership_id
            )
            INSERT INTO platform.work_handoff_discovery
              (hotel_id, membership_id, opened_reason, idempotency_seed)
            SELECT $1, mem.membership_id, 'suspension', $3 FROM mem`,
      values: [
        hotelId,
        `fixture-discovery-${String(n)}@example.test`,
        `fixture-discovery-seed-${String(n)}`,
      ],
    }),
    updateColumn: 'last_error',
    // The only legal update is an attempt advancing: the guard refuses a
    // rewritten identity and refuses a marker that never moved.
    updateSet: `attempts = attempts + 1, last_error = 'acl-probe', updated_at = now()`,
  },
  {
    name: 'platform.work_handoff_item',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: [], police: [] },
    insert: (hotelId, n) => ({
      sql: `WITH acct AS (
              INSERT INTO platform.user_account (realm, email_normalized)
              VALUES ('hotel', $2) RETURNING account_id
            ), mem AS (
              INSERT INTO platform.staff_membership
                (hotel_id, account_id, invited_email_normalized, state,
                 membership_revision, activated_at)
              SELECT $1, acct.account_id, $2, 'ACTIVE', 1, now() FROM acct
              RETURNING membership_id
            )
            INSERT INTO platform.work_handoff_item
              (hotel_id, subject_kind, subject_ref, state, opened_reason,
               previous_actor_membership_id)
            SELECT $1, 'reception_shift', gen_random_uuid(), 'TAKEOVER_REQUIRED',
                   'suspension', mem.membership_id
            FROM mem`,
      values: [hotelId, `fixture-handoff-${String(n)}@example.test`],
    }),
    updateColumn: 'movement_started',
    updateSet: 'assignment_version = assignment_version + 1',
  },
  {
    name: 'platform.work_handoff_event',
    grants: { api: ['SELECT', 'INSERT'], worker: [], police: [] },
    insert: (hotelId, n) => ({
      sql: `WITH acct AS (
              INSERT INTO platform.user_account (realm, email_normalized)
              VALUES ('hotel', $2) RETURNING account_id
            ), mem AS (
              INSERT INTO platform.staff_membership
                (hotel_id, account_id, invited_email_normalized, state,
                 membership_revision, activated_at)
              SELECT $1, acct.account_id, $2, 'ACTIVE', 1, now() FROM acct
              RETURNING membership_id
            ), item AS (
              INSERT INTO platform.work_handoff_item
                (hotel_id, subject_kind, subject_ref, state, opened_reason,
                 previous_actor_membership_id)
              SELECT $1, 'reception_shift', gen_random_uuid(), 'TAKEOVER_REQUIRED',
                     'suspension', mem.membership_id
              FROM mem
              RETURNING item_id
            )
            INSERT INTO platform.work_handoff_event
              (hotel_id, item_id, seq, kind, idempotency_key)
            SELECT $1, item.item_id, 1, 'opened', $3 FROM item`,
      values: [hotelId, `fixture-event-${String(n)}@example.test`, `handoff-fixture-${String(n)}`],
    }),
  },
];

/** Errors that mean "the row was malformed", never "the policy refused it". */
export const STRUCTURAL_SQLSTATES = [
  '23502', // not_null_violation
  '23503', // foreign_key_violation
  '23505', // unique_violation
  '23514', // check_violation
  '42601', // syntax_error
  '42703', // undefined_column
  '42P01', // undefined_table
] as const;
