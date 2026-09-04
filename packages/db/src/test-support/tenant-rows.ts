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
  /**
   * The subset of this tenant's rows the UPDATE and DELETE probes address.
   *
   * Defaults to every visible row, which is what a table nothing references
   * wants. A parent table whose other fixtures deliberately reference some of
   * its rows names the free ones here instead: `DELETE FROM parent` would
   * otherwise be refused by the child's foreign key, and a referential refusal
   * is not evidence about a grant. The count the probe compares against is
   * taken through the same predicate, so the cell still proves the statement
   * reached real rows.
   */
  readonly probeWhere?: string;
  /** The grants each runtime holds on this table, exactly as the migration sets them. */
  readonly grants: Readonly<Record<Runtime, readonly Verb[]>>;
}

/**
 * The reference a fixture uses when its parent row is invisible.
 *
 * A pre-tenant or cross-tenant parent is hidden by the very policy under test,
 * so `INSERT ... SELECT FROM parent` inserts zero rows and raises nothing — and
 * "no error" is indistinguishable from "the policy allowed it". Every such
 * fixture supplies a complete row with this fallback instead, so the statement
 * always reaches the WITH CHECK predicate. Nothing references it: it exists to
 * be refused before the foreign key is ever checked.
 */
const ABSENT_UUID = "'00000000-0000-0000-0000-0000000000ff'::uuid";

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
              (hotel_id, membership_id, opened_reason, expected_state, membership_revision,
               idempotency_seed)
            SELECT $1, mem.membership_id, 'suspension', 'SUSPENDED', 1, $3 FROM mem`,
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
  // ------------------------------------------------------------- Phase 05
  //
  // Every one of these hangs off a pre-tenant application, so each fixture
  // builds the whole graph it needs — owner, application, attempt — rather than
  // relying on a suite having seeded one. `$1` is always the tenant.
  {
    name: 'platform.hotel_profile',
    // Provisioning writes the row; the API may only correct it afterwards.
    grants: { api: ['SELECT', 'UPDATE'], worker: [], police: [] },
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.hotel_profile
              (hotel_id, public_name, public_phone, district, khoroo, address_line,
               latitude_micro, longitude_micro)
            VALUES ($1, $2, '+97611000000', 'Sukhbaatar', '1-r khoroo', 'fixture address',
                    47918000, 106917000)`,
      values: [hotelId, `fixture-profile-${String(n)}`],
    }),
    insertableByRuntime: false,
    rowsPerTenant: 1,
    updateColumn: 'public_phone',
    updateSet: `public_phone = '+97611000001', revision = revision + 1`,
  },
  {
    name: 'platform.hotel_owner_link',
    // The issuance worker names the receipt's buyer by the owner link (R5).
    grants: { api: ['SELECT'], worker: ['SELECT'], police: [] },
    insert: (hotelId, n) => ({
      sql: `WITH owner AS (
              INSERT INTO platform.subscription_owner
                (owner_type, display_name, identity_type, identifier_ciphertext,
                 identifier_wrapped_dek, identifier_key_version, identifier_lookup_token,
                 identifier_lookup_key_version)
              VALUES ('CITIZEN', 'fixture owner', 'registration_number',
                      decode('00', 'hex'), decode('00', 'hex'), 'v1', md5($2) || md5($2), 'v1')
              RETURNING owner_id
            ), app AS (
              INSERT INTO platform.onboarding_application
                (owner_type, applicant_token_hash, applicant_token_key_version,
                 owner_display_name, owner_identifier_ciphertext, owner_identifier_wrapped_dek,
                 owner_identifier_key_version, owner_identifier_lookup_token,
                 owner_identifier_lookup_key_version, contact_phone,
                 subscription_contact_phone, admin_email_normalized, hotel_display_name,
                 hotel_public_phone, district, khoroo, address_line, latitude_micro,
                 longitude_micro, package_code, term_months, monthly_price_mnt,
                 total_amount_mnt, vat_rate_bp, price_book_version, tax_config_version,
                 package_feature_version, owner_id)
              SELECT 'CITIZEN', md5($2 || 'a') || md5($2 || 'b'), 'v1', 'fixture owner',
                     decode('00', 'hex'), decode('00', 'hex'), 'v1', md5($2) || md5($2), 'v1',
                     '+97699000000', '+97699000000', $3, 'fixture hotel', '+97611000000',
                     'Sukhbaatar', '1-r khoroo', 'fixture address', 47918000, 106917000,
                     'P20', 1, 20000, 20000, 1000, 'pb-1', 'tax-1', 'pkg-1', owner.owner_id
              FROM owner
              RETURNING application_id, owner_id
            )
            INSERT INTO platform.hotel_owner_link (hotel_id, owner_id, owner_type, application_id)
            SELECT $1, app.owner_id, 'CITIZEN', app.application_id FROM app`,
      values: [hotelId, `fixture-link-${String(n)}`, `fixture-link-${String(n)}@example.test`],
    }),
    insertableByRuntime: false,
    rowsPerTenant: 1,
  },
  {
    name: 'platform.hotel_subscription',
    grants: { api: ['SELECT', 'UPDATE'], worker: ['SELECT', 'UPDATE'], police: [] },
    insert: (hotelId) => ({
      sql: `INSERT INTO platform.hotel_subscription
              (hotel_id, effective_package, package_floor, term_months, starts_at, expires_at)
            VALUES ($1, 'P20', 'P20', 1, now(), now() + interval '30 days')`,
      values: [hotelId],
    }),
    insertableByRuntime: false,
    rowsPerTenant: 1,
    updateColumn: 'expires_at',
    updateSet: `expires_at = expires_at + interval '1 day',
                billing_revision = billing_revision + 1, revision = revision + 1`,
  },
  {
    name: 'platform.subscription_billing_intent',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: [], police: [] },
    insert: (hotelId, n) => ({
      // `coalesce`, not a bare subquery. Unscoped, the parent is invisible and a
      // `SELECT ... FROM parent` would insert **zero rows and raise nothing** —
      // which the unscoped probe would read as "the policy allowed it". With a
      // literal fallback the row is always structurally complete, so the refusal
      // is the WITH CHECK predicate. The foreign key is an AFTER trigger and is
      // never reached.
      sql: `INSERT INTO platform.subscription_billing_intent
              (hotel_id, subscription_id, kind, provider, merchant_ref, provider_invoice_id,
               amount_mnt, quoted_billing_revision, current_package, target_package,
               term_months, monthly_price_mnt, quoted_expires_at, vat_rate_bp,
               price_book_version, tax_config_version, package_feature_version, expires_at,
               state, terminal_at, terminal_reason)
            VALUES ($1,
                    coalesce((SELECT s.subscription_id FROM platform.hotel_subscription s
                               WHERE s.hotel_id = $1), ${ABSENT_UUID}),
                    'RENEWAL', 'QPAY', 'merch-fixture-' || $2, $2, 20000, 1, 'P20', 'P20', 1, 20000,
                    now() + interval '30 days', 1000, 'pb-1', 'tax-1', 'pkg-1',
                    now() + interval '1 hour', 'CANCELLED', now(), 'fixture')`,
      values: [hotelId, `inv-fixture-${String(n)}`],
    }),
    // Seeded terminal, not pending. `LIFE-DEC-006` allows exactly one live
    // intent per subscription, so a fixture that produced live ones could seed
    // only a single row and the INSERT cell would collide with it — which would
    // report the unique index as a privilege failure. Terminal rows exercise
    // the same grants and the same policy without pretending the rule is
    // looser than it is.
    updateColumn: 'reconciliation_reason',
    updateSet: `state = 'PAID_REQUIRES_RECONCILIATION', revision = revision + 1`,
  },
  {
    name: 'platform.subscription_payment',
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT'], police: [] },
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.subscription_payment
              (hotel_id, subscription_id, purpose, provider, provider_payment_id, merchant_ref,
               gross_amount_mnt, vat_amount_mnt, vat_rate_bp, package_code,
               term_months, monthly_price_mnt, price_book_version, tax_config_version,
               package_feature_version, application_id, confirmed_at)
            VALUES ($1,
                    coalesce((SELECT s.subscription_id FROM platform.hotel_subscription s
                               WHERE s.hotel_id = $1), ${ABSENT_UUID}),
                    'RENEWAL', 'QPAY', $2, 'merch-fixture', 20000, 1818, 1000, 'P20',
                    1, 20000, 'pb-1', 'tax-1', 'pkg-1',
                    coalesce((SELECT l.application_id FROM platform.hotel_owner_link l
                               WHERE l.hotel_id = $1), ${ABSENT_UUID}),
                    now())`,
      values: [hotelId, `pay-fixture-${String(n)}`],
    }),
  },
  {
    name: 'platform.subscription_event',
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT', 'INSERT'], police: [] },
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.subscription_event
              (hotel_id, subscription_id, event_type, billing_revision, actor_ref, detail)
            VALUES ($1,
                    coalesce((SELECT s.subscription_id FROM platform.hotel_subscription s
                               WHERE s.hotel_id = $1), ${ABSENT_UUID}),
                    'RENEWED', 1, $2, '{}'::jsonb)`,
      values: [hotelId, `actor-fixture-${String(n)}`],
    }),
  },
  {
    name: 'platform.ebarimt_issuance',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT', 'UPDATE'], police: [] },
    insert: (hotelId, n) => ({
      sql: `WITH pay AS (
              INSERT INTO platform.subscription_payment
                (hotel_id, subscription_id, purpose, provider, provider_payment_id, merchant_ref,
                 gross_amount_mnt, vat_amount_mnt, vat_rate_bp, package_code,
                 term_months, monthly_price_mnt, price_book_version, tax_config_version,
                 package_feature_version, application_id, confirmed_at)
              VALUES ($1,
                      coalesce((SELECT s.subscription_id FROM platform.hotel_subscription s
                                 WHERE s.hotel_id = $1), ${ABSENT_UUID}),
                      'RENEWAL', 'QPAY', $2, 'merch-fixture', 20000, 1818, 1000, 'P20',
                      1, 20000, 'pb-1', 'tax-1', 'pkg-1',
                      coalesce((SELECT l.application_id FROM platform.hotel_owner_link l
                                 WHERE l.hotel_id = $1), ${ABSENT_UUID}),
                      now())
              RETURNING payment_id
            )
            INSERT INTO platform.ebarimt_issuance (hotel_id, payment_id)
            SELECT $1, pay.payment_id FROM pay`,
      values: [hotelId, `ebarimt-pay-fixture-${String(n)}`],
    }),
    updateColumn: 'last_error',
    updateSet: `attempts = attempts + 1, last_error = 'acl-probe', revision = revision + 1`,
  },
  {
    name: 'platform.cash_location',
    grants: { api: ['SELECT'], worker: [], police: [] },
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.cash_location (hotel_id, kind, name, code)
            VALUES ($1, 'DRAWER', $2, $3)`,
      values: [hotelId, `Fixture drawer ${String(n)}`, `FIX${String(n)}`],
    }),
    insertableByRuntime: false,
  },
  {
    name: 'platform.hotel_admin_activation',
    grants: { api: ['SELECT', 'UPDATE'], worker: ['SELECT', 'UPDATE'], police: [] },
    insert: (hotelId, n) => ({
      sql: `WITH acct AS (
              INSERT INTO platform.user_account (realm, email_normalized)
              VALUES ('hotel', $2) RETURNING account_id
            ), mem AS (
              INSERT INTO platform.staff_membership
                (hotel_id, account_id, invited_email_normalized, state,
                 membership_revision, activated_at)
              SELECT $1, acct.account_id, $2, 'ACTIVE', 1, now() FROM acct
              RETURNING membership_id, account_id
            )
            INSERT INTO platform.hotel_admin_activation
              (hotel_id, membership_id, account_id, application_id, state, email_normalized,
               activated_at)
            SELECT $1, mem.membership_id, mem.account_id, l.application_id, 'ACTIVE', $2, now()
              FROM mem, platform.hotel_owner_link l WHERE l.hotel_id = $1`,
      values: [hotelId, `fixture-activation-${String(n)}@example.test`],
    }),
    insertableByRuntime: false,
    // One application per hotel, and one activation per application.
    rowsPerTenant: 1,
    updateColumn: 'state',
    updateSet: `state = 'SUSPENDED', revision = revision + 1`,
  },
  {
    name: 'platform.activation_delivery',
    // The sealed link is written by the provisioning wrapper, in the same
    // transaction as the tenant. A runtime drains it and never mints one.
    grants: { api: ['SELECT', 'UPDATE'], worker: ['SELECT', 'UPDATE'], police: [] },
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.activation_delivery
              (hotel_id, activation_id, email_normalized, expires_at)
            VALUES ($1,
                    coalesce((SELECT a.activation_id FROM platform.hotel_admin_activation a
                               WHERE a.hotel_id = $1), ${ABSENT_UUID}),
                    $2, now() + interval '1 day')`,
      values: [hotelId, `fixture-delivery-${String(n)}@example.test`],
    }),
    insertableByRuntime: false,
    rowsPerTenant: 1,
    updateColumn: 'last_error',
    updateSet: `attempts = attempts + 1, last_error = 'acl-probe'`,
  },
  // ------------------------------------------------------------- Phase 06
  {
    name: 'platform.hotel_stay_configuration',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT'], police: [] },
    // An upsert, because the tenant *is* the key: the second probe has no free
    // slot to insert into. The statement still needs the INSERT privilege — a
    // runtime without it is refused before the conflict is ever reached — and it
    // is the shape the service itself uses, since a hotel provisioned in Phase
    // 05 has no configuration row until somebody configures one.
    insert: (hotelId) => ({
      sql: `INSERT INTO platform.hotel_stay_configuration (hotel_id) VALUES ($1)
            ON CONFLICT (hotel_id) DO UPDATE
               SET revision = platform.hotel_stay_configuration.revision + 1`,
      values: [hotelId],
    }),
    // One configuration per hotel: the tenant *is* the key.
    rowsPerTenant: 1,
    updateColumn: 'cleaning_buffer_minutes',
    // A configuration change has to advance the version, so the probe advances
    // it: the guard refuses an edit that leaves a snapshot attributable to two
    // different configurations.
    updateSet: `cleaning_buffer_minutes = 30, config_version = config_version + 1,
                revision = revision + 1`,
  },
  {
    name: 'platform.room_category',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], worker: ['SELECT'], police: [] },
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.room_category (hotel_id, name) VALUES ($1, $2)`,
      values: [hotelId, `fixture-category-${String(n)}`],
    }),
    // The room and snapshot fixtures below deliberately reference the lowest
    // category id, so the delete probe addresses the ones nothing references.
    probeWhere: `category_id NOT IN (SELECT category_id FROM platform.room)
                 AND category_id NOT IN (SELECT category_id FROM platform.stay_rate_snapshot)
                 AND category_id NOT IN (SELECT category_id FROM platform.stay)
                 AND category_id NOT IN (SELECT category_id FROM platform.booking_fulfillment_conflict)`,
    updateColumn: 'description',
    updateSet: `description = 'acl-probe', revision = revision + 1`,
  },
  {
    name: 'platform.room',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], worker: ['SELECT'], police: [] },
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.room (hotel_id, room_number, category_id)
            VALUES ($1, $2,
                    coalesce((SELECT category_id FROM platform.room_category
                               WHERE hotel_id = $1 ORDER BY category_id LIMIT 1), ${ABSENT_UUID}))`,
      values: [hotelId, `fixture-room-${String(n)}`],
    }),
    // Phase 07, 08 and 09 fixtures configure, stock, occupy and clean rooms of
    // their own; the DELETE probe addresses the free ones.
    probeWhere: `room_id NOT IN (SELECT room_id FROM platform.room_minibar_configuration)
                 AND room_id NOT IN (SELECT room_id FROM platform.room_minibar_stock)
                 AND room_id NOT IN (SELECT room_id FROM platform.inventory_movement
                                      WHERE room_id IS NOT NULL)
                 AND room_id NOT IN (SELECT room_id FROM platform.room_configuration_change)
                 AND room_id NOT IN (SELECT room_id FROM platform.rollout_batch_room)
                 AND room_id NOT IN (SELECT room_id FROM platform.room_cleaning_state)
                 AND room_id NOT IN (SELECT room_id FROM platform.room_cleaning_event)
                 AND room_id NOT IN (SELECT room_id FROM platform.stay)
                 AND room_id NOT IN (SELECT room_id FROM platform.booking_fulfillment_conflict)
                 AND room_id NOT IN (SELECT room_id FROM platform.minibar_shortage_override)
                 AND room_id NOT IN (SELECT room_id FROM platform.stay_rate_snapshot
                                      WHERE room_id IS NOT NULL)
                 AND room_id NOT IN (SELECT room_id FROM platform.cleaning_task)
                 AND room_id NOT IN (SELECT room_id FROM platform.minibar_usage_report)
                 AND room_id NOT IN (SELECT room_id FROM platform.minibar_refill_task)`,
    updateColumn: 'floor_label',
    updateSet: `floor_label = 'acl-probe', revision = revision + 1`,
  },
  {
    name: 'platform.minibar_product',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], worker: ['SELECT'], police: [] },
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.minibar_product (hotel_id, name, category, unit, selling_price_mnt,
                                                  purchase_cost_mnt)
            VALUES ($1, $2, 'Ус', 'ш', 3000, 1000)`,
      values: [hotelId, `fixture-product-${String(n)}`],
    }),
    // Phase 07, 08 and 09 fixtures hold stock, a ledger, version items, price
    // books, report lines and tasks against products of their own; the DELETE
    // probe addresses the free ones.
    probeWhere: `product_id NOT IN (SELECT product_id FROM platform.stay_minibar_price)
                 AND product_id NOT IN (SELECT product_id FROM platform.minibar_warehouse_stock)
                 AND product_id NOT IN (SELECT product_id FROM platform.room_minibar_stock)
                 AND product_id NOT IN (SELECT product_id FROM platform.inventory_movement)
                 AND product_id NOT IN (SELECT product_id FROM platform.minibar_template_version_item)
                 AND product_id NOT IN (SELECT product_id FROM platform.minibar_report_dispute)
                 AND product_id NOT IN (SELECT product_id FROM platform.minibar_usage_report_line)
                 AND product_id NOT IN (SELECT product_id FROM platform.minibar_refill_task)
                 AND product_id NOT IN (SELECT product_id FROM platform.minibar_report_adjustment
                                         WHERE product_id IS NOT NULL)`,
    updateColumn: 'name',
    updateSet: `name = 'acl-probe', revision = revision + 1`,
  },
  {
    name: 'platform.minibar_template',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], worker: ['SELECT'], police: [] },
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.minibar_template (hotel_id, name) VALUES ($1, $2)`,
      values: [hotelId, `fixture-template-${String(n)}`],
    }),
    probeWhere: `template_id NOT IN (SELECT template_id FROM platform.minibar_template_version)`,
    updateColumn: 'name',
    updateSet: `name = 'acl-probe', revision = revision + 1`,
  },
  {
    name: 'platform.catalog_event',
    // Append-only history: no role holds UPDATE or DELETE, and the trigger
    // refuses them behind the grant.
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `INSERT INTO platform.catalog_event (hotel_id, entity_type, entity_id, event_type)
            VALUES ($1, 'ROOM', gen_random_uuid(), 'CREATED')`,
      values: [hotelId],
    }),
  },
  {
    name: 'platform.stay_rate_snapshot',
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `INSERT INTO platform.stay_rate_snapshot
              (hotel_id, subject_type, subject_ref, stay_type, unit_price_mnt, source_level,
               source_entity_id, pricing_config_version, category_id, cleaning_buffer_minutes)
            VALUES ($1, 'WALK_IN_STAY', gen_random_uuid(), 'HOURLY', 20000, 'HOTEL', $1, 1,
                    coalesce((SELECT category_id FROM platform.room_category
                               WHERE hotel_id = $1 ORDER BY category_id LIMIT 1), ${ABSENT_UUID}),
                    30)`,
      values: [hotelId],
    }),
  },

  // ------------------------------------------------------------- Phase 07
  // Every fixture below binds to the first product, template or room of the
  // tenant, so the Phase 06 parents' DELETE probes skip those through their
  // `probeWhere`. The stock tables are written only by the ledger trigger, so
  // their rows are seeded on the administrative connection and no runtime may
  // insert, update or delete them.
  {
    name: 'platform.minibar_warehouse_stock',
    grants: { api: ['SELECT'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `INSERT INTO platform.minibar_warehouse_stock (product_id, hotel_id, quantity, avg_cost_mnt)
            VALUES (coalesce((SELECT product_id FROM platform.minibar_product
                               WHERE hotel_id = $1
                                 AND product_id NOT IN (SELECT product_id
                                                          FROM platform.minibar_warehouse_stock)
                               ORDER BY product_id LIMIT 1), ${ABSENT_UUID}),
                    $1, 5, 1000)`,
      values: [hotelId],
    }),
    insertableByRuntime: false,
    rowsPerTenant: 1,
    updateColumn: 'quantity',
  },
  {
    name: 'platform.room_minibar_stock',
    grants: { api: ['SELECT'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `INSERT INTO platform.room_minibar_stock (room_id, product_id, hotel_id, quantity)
            VALUES (coalesce((SELECT room_id FROM platform.room
                               WHERE hotel_id = $1 ORDER BY room_number LIMIT 1), ${ABSENT_UUID}),
                    coalesce((SELECT product_id FROM platform.minibar_product
                               WHERE hotel_id = $1
                                 AND product_id NOT IN (SELECT product_id FROM platform.room_minibar_stock)
                               ORDER BY product_id LIMIT 1), ${ABSENT_UUID}),
                    $1, 2)`,
      values: [hotelId],
    }),
    insertableByRuntime: false,
    rowsPerTenant: 1,
    updateColumn: 'quantity',
  },
  {
    name: 'platform.inventory_movement',
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `INSERT INTO platform.inventory_movement
              (hotel_id, product_id, movement_type, location, quantity, unit_cost_mnt)
            VALUES ($1,
                    coalesce((SELECT product_id FROM platform.minibar_product
                               WHERE hotel_id = $1 ORDER BY product_id LIMIT 1), ${ABSENT_UUID}),
                    'PURCHASE', 'WAREHOUSE', 1, 1000)`,
      values: [hotelId],
    }),
    updateColumn: 'reason',
  },
  {
    name: 'platform.minibar_template_version',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], worker: ['SELECT'], police: [] },
    insert: (hotelId, n) => ({
      sql: `INSERT INTO platform.minibar_template_version (hotel_id, template_id, version_no)
            VALUES ($1,
                    coalesce((SELECT template_id FROM platform.minibar_template
                               WHERE hotel_id = $1 ORDER BY template_id LIMIT 1), ${ABSENT_UUID}),
                    $2)`,
      values: [hotelId, n],
    }),
    // Drafts, so their items stay writable; the first version is referenced by
    // the item, configuration, change and batch fixtures.
    probeWhere: `version_id NOT IN (SELECT version_id FROM platform.minibar_template_version_item)
                 AND version_id NOT IN (SELECT version_id FROM platform.stay_minibar_snapshot)
                 AND version_id NOT IN (SELECT current_version_id FROM platform.room_minibar_configuration
                                         WHERE current_version_id IS NOT NULL)
                 AND version_id NOT IN (SELECT target_version_id FROM platform.room_configuration_change
                                         WHERE target_version_id IS NOT NULL)
                 AND version_id NOT IN (SELECT target_version_id FROM platform.rollout_batch)`,
    updateColumn: 'revision',
    updateSet: `revision = revision + 1`,
  },
  {
    name: 'platform.minibar_template_version_item',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `INSERT INTO platform.minibar_template_version_item
              (hotel_id, version_id, product_id, target_quantity)
            VALUES ($1,
                    coalesce((SELECT version_id FROM platform.minibar_template_version
                               WHERE hotel_id = $1 AND state = 'DRAFT'
                               ORDER BY version_no LIMIT 1), ${ABSENT_UUID}),
                    coalesce((SELECT p.product_id FROM platform.minibar_product p
                               WHERE p.hotel_id = $1
                                 AND p.product_id NOT IN (
                                   SELECT i.product_id FROM platform.minibar_template_version_item i
                                    WHERE i.version_id = (SELECT version_id
                                                            FROM platform.minibar_template_version
                                                           WHERE hotel_id = $1 AND state = 'DRAFT'
                                                           ORDER BY version_no LIMIT 1))
                               ORDER BY p.product_id LIMIT 1), ${ABSENT_UUID}),
                    2)`,
      values: [hotelId],
    }),
    // Two products per tenant, one row each; the runtime INSERT probe would
    // need a third product, so one seeded row leaves it one to take.
    rowsPerTenant: 1,
    updateColumn: 'target_quantity',
    updateSet: `target_quantity = target_quantity + 1`,
  },
  {
    name: 'platform.room_minibar_configuration',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `INSERT INTO platform.room_minibar_configuration (room_id, hotel_id)
            VALUES (coalesce((SELECT room_id FROM platform.room
                               WHERE hotel_id = $1
                                 AND room_id NOT IN (SELECT room_id FROM platform.room_minibar_configuration)
                               ORDER BY room_number LIMIT 1), ${ABSENT_UUID}),
                    $1)`,
      values: [hotelId],
    }),
    rowsPerTenant: 1,
    updateColumn: 'updated_at',
    updateSet: `updated_at = now(), revision = revision + 1`,
  },
  {
    name: 'platform.room_configuration_change',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `INSERT INTO platform.room_configuration_change
              (hotel_id, room_id, kind, state, terminal_at)
            VALUES ($1,
                    coalesce((SELECT room_id FROM platform.room
                               WHERE hotel_id = $1 ORDER BY room_number LIMIT 1), ${ABSENT_UUID}),
                    'ON_TO_OFF', 'CANCELLED', now())`,
      values: [hotelId],
    }),
    updateColumn: 'revision',
    updateSet: `revision = revision + 1`,
  },
  {
    name: 'platform.minibar_reconciliation_task',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `INSERT INTO platform.minibar_reconciliation_task
              (hotel_id, change_id, room_id, kind, state, bounds)
            VALUES ($1,
                    coalesce((SELECT change_id FROM platform.room_configuration_change
                               WHERE hotel_id = $1 ORDER BY requested_at LIMIT 1), ${ABSENT_UUID}),
                    coalesce((SELECT room_id FROM platform.room
                               WHERE hotel_id = $1 ORDER BY room_number LIMIT 1), ${ABSENT_UUID}),
                    'RECONCILE', 'CANCELLED', '[]'::jsonb)`,
      values: [hotelId],
    }),
    updateColumn: 'revision',
    updateSet: `revision = revision + 1`,
  },
  {
    name: 'platform.rollout_batch',
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `INSERT INTO platform.rollout_batch (hotel_id, template_id, target_version_id)
            VALUES ($1,
                    coalesce((SELECT template_id FROM platform.minibar_template_version
                               WHERE hotel_id = $1 ORDER BY version_no LIMIT 1), ${ABSENT_UUID}),
                    coalesce((SELECT version_id FROM platform.minibar_template_version
                               WHERE hotel_id = $1 ORDER BY version_no LIMIT 1), ${ABSENT_UUID}))`,
      values: [hotelId],
    }),
    updateColumn: 'created_at',
  },
  {
    name: 'platform.rollout_batch_room',
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `INSERT INTO platform.rollout_batch_room (batch_id, room_id, hotel_id, result, reason_code)
            VALUES (coalesce((SELECT batch_id FROM platform.rollout_batch
                               WHERE hotel_id = $1 ORDER BY created_at LIMIT 1), ${ABSENT_UUID}),
                    coalesce((SELECT room_id FROM platform.room
                               WHERE hotel_id = $1
                                 AND room_id NOT IN (SELECT room_id FROM platform.rollout_batch_room)
                               ORDER BY room_number LIMIT 1), ${ABSENT_UUID}),
                    $1, 'SKIPPED', 'FIXTURE')`,
      values: [hotelId],
    }),
    rowsPerTenant: 1,
    updateColumn: 'reason_code',
  },
  {
    name: 'platform.minibar_shortage_override',
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `INSERT INTO platform.minibar_shortage_override (hotel_id, room_id, snapshot, reason)
            VALUES ($1,
                    coalesce((SELECT room_id FROM platform.room
                               WHERE hotel_id = $1 ORDER BY room_number LIMIT 1), ${ABSENT_UUID}),
                    '{}'::jsonb, 'fixture')`,
      values: [hotelId],
    }),
    updateColumn: 'reason',
  },
  {
    name: 'platform.minibar_event',
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `INSERT INTO platform.minibar_event (hotel_id, entity_type, entity_id, event_type)
            VALUES ($1, 'PRODUCT', gen_random_uuid(), 'FIXTURE')`,
      values: [hotelId],
    }),
    updateColumn: 'reason',
  },
  // ------------------------------------------------------------- Phase 08
  // A stay needs a room no other stay occupies, a rate snapshot of its own and
  // the hotel's open shift, so the fixtures that need one create the room, the
  // snapshot and the stay in the same statement (every runtime that may insert
  // a stay may insert those too). The parents' DELETE probes skip what these
  // fixtures reference through their `probeWhere`.
  {
    name: 'platform.reception_shift',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      // One open shift per hotel: the first row is open, every later one closed.
      sql: `INSERT INTO platform.reception_shift
              (hotel_id, opened_by_account_id, state, closed_by_account_id, closed_at)
            SELECT $1, gen_random_uuid(),
                   CASE WHEN open.n = 0 THEN 'OPEN' ELSE 'CLOSED' END,
                   CASE WHEN open.n = 0 THEN NULL ELSE gen_random_uuid() END,
                   CASE WHEN open.n = 0 THEN NULL ELSE now() END
              FROM (SELECT count(*) AS n FROM platform.reception_shift
                     WHERE hotel_id = $1 AND state = 'OPEN') AS open`,
      values: [hotelId],
    }),
    // The closed row is terminal; the UPDATE probe addresses the open one.
    probeWhere: `state = 'OPEN'`,
    updateColumn: 'revision',
    updateSet: `revision = revision + 1`,
  },
  {
    name: 'platform.room_cleaning_state',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `WITH r AS (
              INSERT INTO platform.room (hotel_id, room_number, category_id)
              VALUES ($1, 'p08-' || substr(gen_random_uuid()::text, 1, 12), coalesce((SELECT category_id FROM platform.room_category
                               WHERE hotel_id = $1 ORDER BY category_id LIMIT 1), ${ABSENT_UUID}))
              RETURNING room_id)
            INSERT INTO platform.room_cleaning_state (room_id, hotel_id, state)
            SELECT r.room_id, $1, 'CLEAN' FROM r`,
      values: [hotelId],
    }),
    updateColumn: 'changed_at',
    updateSet: `changed_at = now(), revision = revision + 1`,
  },
  {
    name: 'platform.room_cleaning_event',
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `INSERT INTO platform.room_cleaning_event (hotel_id, room_id, to_state)
            VALUES ($1,
                    coalesce((SELECT room_id FROM platform.room
                               WHERE hotel_id = $1 ORDER BY room_number LIMIT 1), ${ABSENT_UUID}),
                    'CLEAN')`,
      values: [hotelId],
    }),
    updateColumn: 'to_state',
  },
  {
    name: 'platform.stay',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `WITH r AS (
              INSERT INTO platform.room (hotel_id, room_number, category_id)
              VALUES ($1, 'p08-' || substr(gen_random_uuid()::text, 1, 12), coalesce((SELECT category_id FROM platform.room_category
                               WHERE hotel_id = $1 ORDER BY category_id LIMIT 1), ${ABSENT_UUID}))
              RETURNING room_id, category_id),
            snap AS (
              INSERT INTO platform.stay_rate_snapshot
                (hotel_id, subject_type, subject_ref, stay_type, unit_price_mnt, source_level,
                 source_entity_id, pricing_config_version, category_id, room_id, cleaning_buffer_minutes)
              SELECT $1, 'WALK_IN_STAY', gen_random_uuid(), 'HOURLY', 20000, 'HOTEL', $1, 1,
                     r.category_id, r.room_id, 30
                FROM r
              RETURNING snapshot_id, category_id, room_id),
            s AS (
              INSERT INTO platform.stay
                (hotel_id, room_id, category_id, source, stay_type, actual_check_in_at,
                 check_in_recorded_at, planned_checkout_at, half_hour_units, duration_minutes,
                 cleaning_buffer_minutes, rate_snapshot_id, unit_rate_mnt, room_charge_mnt,
                 pricing_config_version, deposit_required, shift_id, checked_in_by_account_id)
              SELECT $1, snap.room_id, snap.category_id, 'WALK_IN', 'HOURLY', now(), now(),
                     now() + interval '60 minutes', 2, 60, 30, snap.snapshot_id, 20000, 20000, 1,
                     true,
                     coalesce((SELECT shift_id FROM platform.reception_shift
                                WHERE hotel_id = $1 AND state = 'OPEN' LIMIT 1), ${ABSENT_UUID}),
                     gen_random_uuid()
                FROM snap
              RETURNING stay_id, room_id, category_id)
            SELECT stay_id FROM s`,
      values: [hotelId],
    }),
    updateColumn: 'revision',
    updateSet: `revision = revision + 1`,
  },
  {
    name: 'platform.stay_guest',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      // The first revision of a stay is current; a later one is a retired
      // correction, so the current-revision index admits it.
      sql: `INSERT INTO platform.stay_guest
              (hotel_id, stay_id, revision_no, is_current, identity_type, family_name, given_name,
               date_of_birth, nationality, provenance, assurance, no_document_reason,
               age_at_check_in, police_match_eligibility, correction_reason)
            SELECT $1, st.stay_id, prior.n + 1, prior.n = 0, 'NO_DOCUMENT', 'Fixture', 'Guest',
                   DATE '1990-01-01', 'MN', 'MANUAL', 'LOW_ASSURANCE', 'fixture', 30,
                   'NOT_ELIGIBLE_EXACT_RD', CASE WHEN prior.n = 0 THEN NULL ELSE 'fixture' END
              FROM (SELECT coalesce((SELECT stay_id FROM platform.stay
                               WHERE hotel_id = $1 ORDER BY created_at LIMIT 1), ${ABSENT_UUID}) AS stay_id) AS st,
                   LATERAL (SELECT count(*) AS n FROM platform.stay_guest
                             WHERE hotel_id = $1 AND stay_id = st.stay_id) AS prior`,
      values: [hotelId],
    }),
    // Only the current revision admits the one legal update.
    probeWhere: `is_current IS TRUE`,
    updateColumn: 'is_current',
    updateSet: `is_current = false`,
  },
  {
    name: 'platform.stay_minibar_snapshot',
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `WITH r AS (
              INSERT INTO platform.room (hotel_id, room_number, category_id)
              VALUES ($1, 'p08-' || substr(gen_random_uuid()::text, 1, 12), coalesce((SELECT category_id FROM platform.room_category
                               WHERE hotel_id = $1 ORDER BY category_id LIMIT 1), ${ABSENT_UUID}))
              RETURNING room_id, category_id),
            snap AS (
              INSERT INTO platform.stay_rate_snapshot
                (hotel_id, subject_type, subject_ref, stay_type, unit_price_mnt, source_level,
                 source_entity_id, pricing_config_version, category_id, room_id, cleaning_buffer_minutes)
              SELECT $1, 'WALK_IN_STAY', gen_random_uuid(), 'HOURLY', 20000, 'HOTEL', $1, 1,
                     r.category_id, r.room_id, 30
                FROM r
              RETURNING snapshot_id, category_id, room_id),
            s AS (
              INSERT INTO platform.stay
                (hotel_id, room_id, category_id, source, stay_type, actual_check_in_at,
                 check_in_recorded_at, planned_checkout_at, half_hour_units, duration_minutes,
                 cleaning_buffer_minutes, rate_snapshot_id, unit_rate_mnt, room_charge_mnt,
                 pricing_config_version, deposit_required, shift_id, checked_in_by_account_id)
              SELECT $1, snap.room_id, snap.category_id, 'WALK_IN', 'HOURLY', now(), now(),
                     now() + interval '60 minutes', 2, 60, 30, snap.snapshot_id, 20000, 20000, 1,
                     true,
                     coalesce((SELECT shift_id FROM platform.reception_shift
                                WHERE hotel_id = $1 AND state = 'OPEN' LIMIT 1), ${ABSENT_UUID}),
                     gen_random_uuid()
                FROM snap
              RETURNING stay_id, room_id, category_id)
            INSERT INTO platform.stay_minibar_snapshot (stay_id, hotel_id, room_id, template_id, version_id)
            SELECT s.stay_id, $1, s.room_id,
                   coalesce((SELECT template_id FROM platform.minibar_template_version
                              WHERE hotel_id = $1 ORDER BY created_at LIMIT 1), ${ABSENT_UUID}),
                   coalesce((SELECT version_id FROM platform.minibar_template_version
                              WHERE hotel_id = $1 ORDER BY created_at LIMIT 1), ${ABSENT_UUID})
              FROM s`,
      values: [hotelId],
    }),
    updateColumn: 'snapshot_at',
  },
  {
    name: 'platform.stay_minibar_price',
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `WITH p AS (
              INSERT INTO platform.minibar_product (hotel_id, name, category, unit, selling_price_mnt, purchase_cost_mnt)
              VALUES ($1, 'p08-' || substr(gen_random_uuid()::text, 1, 12), 'Ус', 'ш', 3000, 1000)
              RETURNING product_id)
            INSERT INTO platform.stay_minibar_price
              (stay_id, product_id, hotel_id, product_name, selling_price_mnt, target_quantity, opening_quantity)
            SELECT coalesce((SELECT stay_id FROM platform.stay_minibar_snapshot
                              WHERE hotel_id = $1 ORDER BY snapshot_at LIMIT 1), ${ABSENT_UUID}),
                   p.product_id, $1, 'Fixture', 5000, 1, 0
              FROM p`,
      values: [hotelId],
    }),
    updateColumn: 'selling_price_mnt',
  },
  {
    name: 'platform.stay_time_correction',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      // One pending correction per stay: each row gets a stay of its own.
      sql: `WITH r AS (
              INSERT INTO platform.room (hotel_id, room_number, category_id)
              VALUES ($1, 'p08-' || substr(gen_random_uuid()::text, 1, 12), coalesce((SELECT category_id FROM platform.room_category
                               WHERE hotel_id = $1 ORDER BY category_id LIMIT 1), ${ABSENT_UUID}))
              RETURNING room_id, category_id),
            snap AS (
              INSERT INTO platform.stay_rate_snapshot
                (hotel_id, subject_type, subject_ref, stay_type, unit_price_mnt, source_level,
                 source_entity_id, pricing_config_version, category_id, room_id, cleaning_buffer_minutes)
              SELECT $1, 'WALK_IN_STAY', gen_random_uuid(), 'HOURLY', 20000, 'HOTEL', $1, 1,
                     r.category_id, r.room_id, 30
                FROM r
              RETURNING snapshot_id, category_id, room_id),
            s AS (
              INSERT INTO platform.stay
                (hotel_id, room_id, category_id, source, stay_type, actual_check_in_at,
                 check_in_recorded_at, planned_checkout_at, half_hour_units, duration_minutes,
                 cleaning_buffer_minutes, rate_snapshot_id, unit_rate_mnt, room_charge_mnt,
                 pricing_config_version, deposit_required, shift_id, checked_in_by_account_id)
              SELECT $1, snap.room_id, snap.category_id, 'WALK_IN', 'HOURLY', now(), now(),
                     now() + interval '60 minutes', 2, 60, 30, snap.snapshot_id, 20000, 20000, 1,
                     true,
                     coalesce((SELECT shift_id FROM platform.reception_shift
                                WHERE hotel_id = $1 AND state = 'OPEN' LIMIT 1), ${ABSENT_UUID}),
                     gen_random_uuid()
                FROM snap
              RETURNING stay_id, room_id, category_id)
            INSERT INTO platform.stay_time_correction
              (hotel_id, stay_id, previous_effective_at, corrected_actual_check_in_at,
               earliest_allowed_at, latest_allowed_at, reason, requested_by_account_id)
            SELECT $1, s.stay_id, now(), now() - interval '10 minutes',
                   now() - interval '120 minutes', now(), 'fixture', gen_random_uuid()
              FROM s`,
      values: [hotelId],
    }),
    updateColumn: 'state',
    updateSet: `state = 'REJECTED', decided_at = now(), decided_by_account_id = requested_by_account_id,
                revision = revision + 1`,
  },
  {
    name: 'platform.booking_fulfillment_conflict',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `INSERT INTO platform.booking_fulfillment_conflict
              (hotel_id, booking_ref, category_id, room_id, overdue_stay_id, planned_checkin_at,
               planned_checkout_at, cleaning_buffer_minutes)
            SELECT $1, gen_random_uuid(),
                   coalesce(f.category_id, ${ABSENT_UUID}),
                   coalesce(f.room_id, ${ABSENT_UUID}),
                   coalesce(f.stay_id, ${ABSENT_UUID}),
                   now() + interval '2 hours', now() + interval '1 day', 30
              FROM (SELECT 1) AS one
              LEFT JOIN LATERAL (SELECT category_id, room_id, stay_id FROM platform.stay
                                  WHERE hotel_id = $1 ORDER BY created_at LIMIT 1) AS f ON true`,
      values: [hotelId],
    }),
    updateColumn: 'state',
    updateSet: `state = 'RESOLVED_READY', resolved_at = now(), revision = revision + 1`,
  },
  {
    name: 'platform.stay_event',
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `INSERT INTO platform.stay_event (hotel_id, stay_id, event_type)
            VALUES ($1, coalesce((SELECT stay_id FROM platform.stay
                               WHERE hotel_id = $1 ORDER BY created_at LIMIT 1), ${ABSENT_UUID}), 'FIXTURE')`,
      values: [hotelId],
    }),
    updateColumn: 'reason',
  },

  // Phase 09. Every one of these rows hangs off a stay, its price book or a
  // report version, and each of the uniqueness rules — one open cleaning task
  // per room, one live report per stay, one held payment lock per report, one
  // open refill task per room and product — means the fixture creates the whole
  // chain it needs in the same statement rather than sharing another fixture's.
  {
    name: 'platform.cleaning_task',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `WITH r AS (
              INSERT INTO platform.room (hotel_id, room_number, category_id)
              VALUES ($1, 'p09-' || substr(gen_random_uuid()::text, 1, 12),
                      coalesce((SELECT category_id FROM platform.room_category
                                 WHERE hotel_id = $1 ORDER BY category_id LIMIT 1), ${ABSENT_UUID}))
              RETURNING room_id)
            INSERT INTO platform.cleaning_task (hotel_id, room_id)
            SELECT $1, r.room_id FROM r`,
      values: [hotelId],
    }),
    updateColumn: 'revision',
    updateSet: `state = 'IN_PROGRESS', claimed_by_account_id = gen_random_uuid(),
                claimed_at = now(), revision = revision + 1`,
  },

  {
    name: 'platform.minibar_usage_report',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `WITH r AS (
              INSERT INTO platform.room (hotel_id, room_number, category_id)
              VALUES ($1, 'p09-' || substr(gen_random_uuid()::text, 1, 12),
                      coalesce((SELECT category_id FROM platform.room_category
                                 WHERE hotel_id = $1 ORDER BY category_id LIMIT 1), ${ABSENT_UUID}))
              RETURNING room_id, category_id),
            snap AS (
              INSERT INTO platform.stay_rate_snapshot
                (hotel_id, subject_type, subject_ref, stay_type, unit_price_mnt, source_level,
                 source_entity_id, pricing_config_version, category_id, room_id, cleaning_buffer_minutes)
              SELECT $1, 'WALK_IN_STAY', gen_random_uuid(), 'HOURLY', 20000, 'HOTEL', $1, 1,
                     r.category_id, r.room_id, 30
                FROM r
              RETURNING snapshot_id, category_id, room_id),
            s AS (
              INSERT INTO platform.stay
                (hotel_id, room_id, category_id, source, stay_type, actual_check_in_at,
                 check_in_recorded_at, planned_checkout_at, half_hour_units, duration_minutes,
                 cleaning_buffer_minutes, rate_snapshot_id, unit_rate_mnt, room_charge_mnt,
                 pricing_config_version, deposit_required, shift_id, checked_in_by_account_id)
              SELECT $1, snap.room_id, snap.category_id, 'WALK_IN', 'HOURLY', now(), now(),
                     now() + interval '60 minutes', 2, 60, 30, snap.snapshot_id, 20000, 20000, 1,
                     true,
                     coalesce((SELECT shift_id FROM platform.reception_shift
                                WHERE hotel_id = $1 AND state = 'OPEN' LIMIT 1), ${ABSENT_UUID}),
                     gen_random_uuid()
                FROM snap
              RETURNING stay_id, room_id, category_id)
            INSERT INTO platform.minibar_usage_report (hotel_id, stay_id, room_id)
            SELECT $1, s.stay_id, s.room_id FROM s`,
      values: [hotelId],
    }),
    updateColumn: 'revision',
    updateSet: `state = 'IN_INSPECTION', claimed_by_account_id = gen_random_uuid(),
                claimed_at = now(), revision = revision + 1`,
  },

  {
    name: 'platform.minibar_usage_report_version',
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `WITH r AS (
              INSERT INTO platform.room (hotel_id, room_number, category_id)
              VALUES ($1, 'p09-' || substr(gen_random_uuid()::text, 1, 12),
                      coalesce((SELECT category_id FROM platform.room_category
                                 WHERE hotel_id = $1 ORDER BY category_id LIMIT 1), ${ABSENT_UUID}))
              RETURNING room_id, category_id),
            snap AS (
              INSERT INTO platform.stay_rate_snapshot
                (hotel_id, subject_type, subject_ref, stay_type, unit_price_mnt, source_level,
                 source_entity_id, pricing_config_version, category_id, room_id, cleaning_buffer_minutes)
              SELECT $1, 'WALK_IN_STAY', gen_random_uuid(), 'HOURLY', 20000, 'HOTEL', $1, 1,
                     r.category_id, r.room_id, 30
                FROM r
              RETURNING snapshot_id, category_id, room_id),
            s AS (
              INSERT INTO platform.stay
                (hotel_id, room_id, category_id, source, stay_type, actual_check_in_at,
                 check_in_recorded_at, planned_checkout_at, half_hour_units, duration_minutes,
                 cleaning_buffer_minutes, rate_snapshot_id, unit_rate_mnt, room_charge_mnt,
                 pricing_config_version, deposit_required, shift_id, checked_in_by_account_id)
              SELECT $1, snap.room_id, snap.category_id, 'WALK_IN', 'HOURLY', now(), now(),
                     now() + interval '60 minutes', 2, 60, 30, snap.snapshot_id, 20000, 20000, 1,
                     true,
                     coalesce((SELECT shift_id FROM platform.reception_shift
                                WHERE hotel_id = $1 AND state = 'OPEN' LIMIT 1), ${ABSENT_UUID}),
                     gen_random_uuid()
                FROM snap
              RETURNING stay_id, room_id, category_id),
            rep AS (
              INSERT INTO platform.minibar_usage_report (hotel_id, stay_id, room_id, state)
              SELECT $1, s.stay_id, s.room_id, 'IN_INSPECTION' FROM s
              RETURNING report_id)
            INSERT INTO platform.minibar_usage_report_version
              (hotel_id, report_id, version_no, kind, no_usage, submitted_by_account_id,
               submitted_role, cutoff_at)
            SELECT $1, rep.report_id, 1, 'NORMAL', true, gen_random_uuid(), 'CLEANER', now()
              FROM rep`,
      values: [hotelId],
    }),
    updateColumn: 'total_mnt',
  },

  {
    name: 'platform.minibar_usage_report_line',
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `WITH r AS (
              INSERT INTO platform.room (hotel_id, room_number, category_id)
              VALUES ($1, 'p09-' || substr(gen_random_uuid()::text, 1, 12),
                      coalesce((SELECT category_id FROM platform.room_category
                                 WHERE hotel_id = $1 ORDER BY category_id LIMIT 1), ${ABSENT_UUID}))
              RETURNING room_id, category_id),
            snap AS (
              INSERT INTO platform.stay_rate_snapshot
                (hotel_id, subject_type, subject_ref, stay_type, unit_price_mnt, source_level,
                 source_entity_id, pricing_config_version, category_id, room_id, cleaning_buffer_minutes)
              SELECT $1, 'WALK_IN_STAY', gen_random_uuid(), 'HOURLY', 20000, 'HOTEL', $1, 1,
                     r.category_id, r.room_id, 30
                FROM r
              RETURNING snapshot_id, category_id, room_id),
            s AS (
              INSERT INTO platform.stay
                (hotel_id, room_id, category_id, source, stay_type, actual_check_in_at,
                 check_in_recorded_at, planned_checkout_at, half_hour_units, duration_minutes,
                 cleaning_buffer_minutes, rate_snapshot_id, unit_rate_mnt, room_charge_mnt,
                 pricing_config_version, deposit_required, shift_id, checked_in_by_account_id)
              SELECT $1, snap.room_id, snap.category_id, 'WALK_IN', 'HOURLY', now(), now(),
                     now() + interval '60 minutes', 2, 60, 30, snap.snapshot_id, 20000, 20000, 1,
                     true,
                     coalesce((SELECT shift_id FROM platform.reception_shift
                                WHERE hotel_id = $1 AND state = 'OPEN' LIMIT 1), ${ABSENT_UUID}),
                     gen_random_uuid()
                FROM snap
              RETURNING stay_id, room_id, category_id),
            msnap AS (
              INSERT INTO platform.stay_minibar_snapshot (stay_id, hotel_id, room_id, template_id, version_id)
              SELECT s.stay_id, $1, s.room_id,
                     coalesce((SELECT template_id FROM platform.minibar_template_version
                                WHERE hotel_id = $1 ORDER BY created_at LIMIT 1), ${ABSENT_UUID}),
                     coalesce((SELECT version_id FROM platform.minibar_template_version
                                WHERE hotel_id = $1 ORDER BY created_at LIMIT 1), ${ABSENT_UUID})
                FROM s
              RETURNING stay_id, room_id),
            prod AS (
              INSERT INTO platform.minibar_product
                (hotel_id, name, category, unit, selling_price_mnt, purchase_cost_mnt)
              VALUES ($1, 'p09-' || substr(gen_random_uuid()::text, 1, 12), 'Ус', 'ш', 5000, 1000)
              RETURNING product_id),
            price AS (
              INSERT INTO platform.stay_minibar_price
                (stay_id, product_id, hotel_id, product_name, selling_price_mnt, target_quantity,
                 opening_quantity)
              SELECT msnap.stay_id, prod.product_id, $1, 'Fixture', 5000, 2, 2
                FROM msnap, prod
              RETURNING stay_id, product_id),
            rep AS (
              INSERT INTO platform.minibar_usage_report (hotel_id, stay_id, room_id, state)
              SELECT $1, s.stay_id, s.room_id, 'IN_INSPECTION' FROM s
              RETURNING report_id),
            ver AS (
              INSERT INTO platform.minibar_usage_report_version
                (hotel_id, report_id, version_no, kind, no_usage, submitted_by_account_id,
                 submitted_role, cutoff_at, total_mnt)
              SELECT $1, rep.report_id, 1, 'NORMAL', false, gen_random_uuid(), 'CLEANER', now(), 5000
                FROM rep
              RETURNING version_id, report_id)
            INSERT INTO platform.minibar_usage_report_line
              (hotel_id, version_id, stay_id, product_id, product_name, opening_quantity,
               refill_quantity, non_guest_out_quantity, counted_quantity, billable_quantity,
               unit_price_mnt, line_total_mnt)
            SELECT $1, ver.version_id, price.stay_id, price.product_id, 'Fixture', 2, 0, 0, 1, 1,
                   5000, 5000
              FROM ver, price`,
      values: [hotelId],
    }),
    updateColumn: 'counted_quantity',
  },

  {
    name: 'platform.minibar_usage_report_movement',
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `WITH r AS (
              INSERT INTO platform.room (hotel_id, room_number, category_id)
              VALUES ($1, 'p09-' || substr(gen_random_uuid()::text, 1, 12),
                      coalesce((SELECT category_id FROM platform.room_category
                                 WHERE hotel_id = $1 ORDER BY category_id LIMIT 1), ${ABSENT_UUID}))
              RETURNING room_id, category_id),
            snap AS (
              INSERT INTO platform.stay_rate_snapshot
                (hotel_id, subject_type, subject_ref, stay_type, unit_price_mnt, source_level,
                 source_entity_id, pricing_config_version, category_id, room_id, cleaning_buffer_minutes)
              SELECT $1, 'WALK_IN_STAY', gen_random_uuid(), 'HOURLY', 20000, 'HOTEL', $1, 1,
                     r.category_id, r.room_id, 30
                FROM r
              RETURNING snapshot_id, category_id, room_id),
            s AS (
              INSERT INTO platform.stay
                (hotel_id, room_id, category_id, source, stay_type, actual_check_in_at,
                 check_in_recorded_at, planned_checkout_at, half_hour_units, duration_minutes,
                 cleaning_buffer_minutes, rate_snapshot_id, unit_rate_mnt, room_charge_mnt,
                 pricing_config_version, deposit_required, shift_id, checked_in_by_account_id)
              SELECT $1, snap.room_id, snap.category_id, 'WALK_IN', 'HOURLY', now(), now(),
                     now() + interval '60 minutes', 2, 60, 30, snap.snapshot_id, 20000, 20000, 1,
                     true,
                     coalesce((SELECT shift_id FROM platform.reception_shift
                                WHERE hotel_id = $1 AND state = 'OPEN' LIMIT 1), ${ABSENT_UUID}),
                     gen_random_uuid()
                FROM snap
              RETURNING stay_id, room_id, category_id),
            rep AS (
              INSERT INTO platform.minibar_usage_report (hotel_id, stay_id, room_id, state)
              SELECT $1, s.stay_id, s.room_id, 'IN_INSPECTION' FROM s
              RETURNING report_id),
            ver AS (
              INSERT INTO platform.minibar_usage_report_version
                (hotel_id, report_id, version_no, kind, no_usage, submitted_by_account_id,
                 submitted_role, cutoff_at, total_mnt)
              SELECT $1, rep.report_id, 1, 'NORMAL', false, gen_random_uuid(), 'CLEANER', now(), 5000
                FROM rep
              RETURNING version_id, report_id),
            prod AS (
              INSERT INTO platform.minibar_product
                (hotel_id, name, category, unit, selling_price_mnt, purchase_cost_mnt)
              VALUES ($1, 'p09-' || substr(gen_random_uuid()::text, 1, 12), 'Ус', 'ш', 5000, 1000)
              RETURNING product_id),
            mv AS (
              INSERT INTO platform.inventory_movement
                (hotel_id, product_id, movement_type, location, quantity, unit_cost_mnt)
              SELECT $1, prod.product_id, 'OPENING', 'WAREHOUSE', 5, 1000 FROM prod
              RETURNING movement_id)
            INSERT INTO platform.minibar_usage_report_movement (version_id, movement_id, hotel_id, role)
            SELECT ver.version_id, mv.movement_id, $1, 'REFILL' FROM ver, mv`,
      values: [hotelId],
    }),
    updateColumn: 'role',
  },

  {
    name: 'platform.minibar_report_dispute',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `WITH r AS (
              INSERT INTO platform.room (hotel_id, room_number, category_id)
              VALUES ($1, 'p09-' || substr(gen_random_uuid()::text, 1, 12),
                      coalesce((SELECT category_id FROM platform.room_category
                                 WHERE hotel_id = $1 ORDER BY category_id LIMIT 1), ${ABSENT_UUID}))
              RETURNING room_id, category_id),
            snap AS (
              INSERT INTO platform.stay_rate_snapshot
                (hotel_id, subject_type, subject_ref, stay_type, unit_price_mnt, source_level,
                 source_entity_id, pricing_config_version, category_id, room_id, cleaning_buffer_minutes)
              SELECT $1, 'WALK_IN_STAY', gen_random_uuid(), 'HOURLY', 20000, 'HOTEL', $1, 1,
                     r.category_id, r.room_id, 30
                FROM r
              RETURNING snapshot_id, category_id, room_id),
            s AS (
              INSERT INTO platform.stay
                (hotel_id, room_id, category_id, source, stay_type, actual_check_in_at,
                 check_in_recorded_at, planned_checkout_at, half_hour_units, duration_minutes,
                 cleaning_buffer_minutes, rate_snapshot_id, unit_rate_mnt, room_charge_mnt,
                 pricing_config_version, deposit_required, shift_id, checked_in_by_account_id)
              SELECT $1, snap.room_id, snap.category_id, 'WALK_IN', 'HOURLY', now(), now(),
                     now() + interval '60 minutes', 2, 60, 30, snap.snapshot_id, 20000, 20000, 1,
                     true,
                     coalesce((SELECT shift_id FROM platform.reception_shift
                                WHERE hotel_id = $1 AND state = 'OPEN' LIMIT 1), ${ABSENT_UUID}),
                     gen_random_uuid()
                FROM snap
              RETURNING stay_id, room_id, category_id),
            rep AS (
              INSERT INTO platform.minibar_usage_report (hotel_id, stay_id, room_id, state)
              SELECT $1, s.stay_id, s.room_id, 'IN_INSPECTION' FROM s
              RETURNING report_id),
            ver AS (
              INSERT INTO platform.minibar_usage_report_version
                (hotel_id, report_id, version_no, kind, no_usage, submitted_by_account_id,
                 submitted_role, cutoff_at, total_mnt)
              SELECT $1, rep.report_id, 1, 'NORMAL', false, gen_random_uuid(), 'CLEANER', now(), 5000
                FROM rep
              RETURNING version_id, report_id),
            prod AS (
              INSERT INTO platform.minibar_product
                (hotel_id, name, category, unit, selling_price_mnt, purchase_cost_mnt)
              VALUES ($1, 'p09-' || substr(gen_random_uuid()::text, 1, 12), 'Ус', 'ш', 5000, 1000)
              RETURNING product_id)
            INSERT INTO platform.minibar_report_dispute
              (hotel_id, report_id, version_id, product_id, disputed_quantity, note,
               noted_by_account_id)
            SELECT $1, ver.report_id, ver.version_id, prod.product_id, 1, 'fixture',
                   gen_random_uuid()
              FROM ver, prod`,
      values: [hotelId],
    }),
    updateColumn: 'revision',
    updateSet: `state = 'UPHELD', resolved_at = now(), resolved_by_account_id = gen_random_uuid(),
                resolution_reason = 'fixture', revision = revision + 1`,
  },

  {
    name: 'platform.minibar_payment_lock',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `WITH r AS (
              INSERT INTO platform.room (hotel_id, room_number, category_id)
              VALUES ($1, 'p09-' || substr(gen_random_uuid()::text, 1, 12),
                      coalesce((SELECT category_id FROM platform.room_category
                                 WHERE hotel_id = $1 ORDER BY category_id LIMIT 1), ${ABSENT_UUID}))
              RETURNING room_id, category_id),
            snap AS (
              INSERT INTO platform.stay_rate_snapshot
                (hotel_id, subject_type, subject_ref, stay_type, unit_price_mnt, source_level,
                 source_entity_id, pricing_config_version, category_id, room_id, cleaning_buffer_minutes)
              SELECT $1, 'WALK_IN_STAY', gen_random_uuid(), 'HOURLY', 20000, 'HOTEL', $1, 1,
                     r.category_id, r.room_id, 30
                FROM r
              RETURNING snapshot_id, category_id, room_id),
            s AS (
              INSERT INTO platform.stay
                (hotel_id, room_id, category_id, source, stay_type, actual_check_in_at,
                 check_in_recorded_at, planned_checkout_at, half_hour_units, duration_minutes,
                 cleaning_buffer_minutes, rate_snapshot_id, unit_rate_mnt, room_charge_mnt,
                 pricing_config_version, deposit_required, shift_id, checked_in_by_account_id)
              SELECT $1, snap.room_id, snap.category_id, 'WALK_IN', 'HOURLY', now(), now(),
                     now() + interval '60 minutes', 2, 60, 30, snap.snapshot_id, 20000, 20000, 1,
                     true,
                     coalesce((SELECT shift_id FROM platform.reception_shift
                                WHERE hotel_id = $1 AND state = 'OPEN' LIMIT 1), ${ABSENT_UUID}),
                     gen_random_uuid()
                FROM snap
              RETURNING stay_id, room_id, category_id),
            rep AS (
              INSERT INTO platform.minibar_usage_report (hotel_id, stay_id, room_id, state)
              SELECT $1, s.stay_id, s.room_id, 'IN_INSPECTION' FROM s
              RETURNING report_id),
            ver AS (
              INSERT INTO platform.minibar_usage_report_version
                (hotel_id, report_id, version_no, kind, no_usage, submitted_by_account_id,
                 submitted_role, cutoff_at, total_mnt)
              SELECT $1, rep.report_id, 1, 'NORMAL', false, gen_random_uuid(), 'CLEANER', now(), 5000
                FROM rep
              RETURNING version_id, report_id)
            INSERT INTO platform.minibar_payment_lock
              (hotel_id, report_id, version_id, attempt_ref, amount_mnt, locked_by_account_id)
            SELECT $1, ver.report_id, ver.version_id,
                   'p09-' || substr(gen_random_uuid()::text, 1, 12), 5000, gen_random_uuid()
              FROM ver`,
      values: [hotelId],
    }),
    updateColumn: 'revision',
    updateSet: `state = 'RELEASED', provider_status = 'FAILED_NO_FUNDS', resolved_at = now(),
                resolved_by_account_id = gen_random_uuid(), revision = revision + 1`,
  },

  {
    name: 'platform.minibar_report_adjustment',
    grants: { api: ['SELECT', 'INSERT'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `WITH r AS (
              INSERT INTO platform.room (hotel_id, room_number, category_id)
              VALUES ($1, 'p09-' || substr(gen_random_uuid()::text, 1, 12),
                      coalesce((SELECT category_id FROM platform.room_category
                                 WHERE hotel_id = $1 ORDER BY category_id LIMIT 1), ${ABSENT_UUID}))
              RETURNING room_id, category_id),
            snap AS (
              INSERT INTO platform.stay_rate_snapshot
                (hotel_id, subject_type, subject_ref, stay_type, unit_price_mnt, source_level,
                 source_entity_id, pricing_config_version, category_id, room_id, cleaning_buffer_minutes)
              SELECT $1, 'WALK_IN_STAY', gen_random_uuid(), 'HOURLY', 20000, 'HOTEL', $1, 1,
                     r.category_id, r.room_id, 30
                FROM r
              RETURNING snapshot_id, category_id, room_id),
            s AS (
              INSERT INTO platform.stay
                (hotel_id, room_id, category_id, source, stay_type, actual_check_in_at,
                 check_in_recorded_at, planned_checkout_at, half_hour_units, duration_minutes,
                 cleaning_buffer_minutes, rate_snapshot_id, unit_rate_mnt, room_charge_mnt,
                 pricing_config_version, deposit_required, shift_id, checked_in_by_account_id)
              SELECT $1, snap.room_id, snap.category_id, 'WALK_IN', 'HOURLY', now(), now(),
                     now() + interval '60 minutes', 2, 60, 30, snap.snapshot_id, 20000, 20000, 1,
                     true,
                     coalesce((SELECT shift_id FROM platform.reception_shift
                                WHERE hotel_id = $1 AND state = 'OPEN' LIMIT 1), ${ABSENT_UUID}),
                     gen_random_uuid()
                FROM snap
              RETURNING stay_id, room_id, category_id),
            rep AS (
              INSERT INTO platform.minibar_usage_report (hotel_id, stay_id, room_id, state)
              SELECT $1, s.stay_id, s.room_id, 'IN_INSPECTION' FROM s
              RETURNING report_id),
            ver AS (
              INSERT INTO platform.minibar_usage_report_version
                (hotel_id, report_id, version_no, kind, no_usage, submitted_by_account_id,
                 submitted_role, cutoff_at, total_mnt)
              SELECT $1, rep.report_id, 1, 'NORMAL', false, gen_random_uuid(), 'CLEANER', now(), 5000
                FROM rep
              RETURNING version_id, report_id),
            lk AS (
              INSERT INTO platform.minibar_payment_lock
                (hotel_id, report_id, version_id, attempt_ref, amount_mnt, locked_by_account_id)
              SELECT $1, ver.report_id, ver.version_id,
                     'p09-' || substr(gen_random_uuid()::text, 1, 12), 5000, gen_random_uuid()
                FROM ver
              RETURNING lock_id, report_id, version_id)
            INSERT INTO platform.minibar_report_adjustment
              (hotel_id, report_id, original_version_id, lock_id, kind, amount_mnt, reason,
               actor_account_id)
            SELECT $1, lk.report_id, lk.version_id, lk.lock_id, 'OVERCHARGE_REVERSAL', 5000,
                   'fixture', gen_random_uuid()
              FROM lk`,
      values: [hotelId],
    }),
    updateColumn: 'reason',
  },

  {
    name: 'platform.minibar_refill_task',
    grants: { api: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT'], police: [] },
    insert: (hotelId) => ({
      sql: `WITH r AS (
              INSERT INTO platform.room (hotel_id, room_number, category_id)
              VALUES ($1, 'p09-' || substr(gen_random_uuid()::text, 1, 12),
                      coalesce((SELECT category_id FROM platform.room_category
                                 WHERE hotel_id = $1 ORDER BY category_id LIMIT 1), ${ABSENT_UUID}))
              RETURNING room_id, category_id),
            snap AS (
              INSERT INTO platform.stay_rate_snapshot
                (hotel_id, subject_type, subject_ref, stay_type, unit_price_mnt, source_level,
                 source_entity_id, pricing_config_version, category_id, room_id, cleaning_buffer_minutes)
              SELECT $1, 'WALK_IN_STAY', gen_random_uuid(), 'HOURLY', 20000, 'HOTEL', $1, 1,
                     r.category_id, r.room_id, 30
                FROM r
              RETURNING snapshot_id, category_id, room_id),
            s AS (
              INSERT INTO platform.stay
                (hotel_id, room_id, category_id, source, stay_type, actual_check_in_at,
                 check_in_recorded_at, planned_checkout_at, half_hour_units, duration_minutes,
                 cleaning_buffer_minutes, rate_snapshot_id, unit_rate_mnt, room_charge_mnt,
                 pricing_config_version, deposit_required, shift_id, checked_in_by_account_id)
              SELECT $1, snap.room_id, snap.category_id, 'WALK_IN', 'HOURLY', now(), now(),
                     now() + interval '60 minutes', 2, 60, 30, snap.snapshot_id, 20000, 20000, 1,
                     true,
                     coalesce((SELECT shift_id FROM platform.reception_shift
                                WHERE hotel_id = $1 AND state = 'OPEN' LIMIT 1), ${ABSENT_UUID}),
                     gen_random_uuid()
                FROM snap
              RETURNING stay_id, room_id, category_id),
            msnap AS (
              INSERT INTO platform.stay_minibar_snapshot (stay_id, hotel_id, room_id, template_id, version_id)
              SELECT s.stay_id, $1, s.room_id,
                     coalesce((SELECT template_id FROM platform.minibar_template_version
                                WHERE hotel_id = $1 ORDER BY created_at LIMIT 1), ${ABSENT_UUID}),
                     coalesce((SELECT version_id FROM platform.minibar_template_version
                                WHERE hotel_id = $1 ORDER BY created_at LIMIT 1), ${ABSENT_UUID})
                FROM s
              RETURNING stay_id, room_id),
            prod AS (
              INSERT INTO platform.minibar_product
                (hotel_id, name, category, unit, selling_price_mnt, purchase_cost_mnt)
              VALUES ($1, 'p09-' || substr(gen_random_uuid()::text, 1, 12), 'Ус', 'ш', 5000, 1000)
              RETURNING product_id),
            price AS (
              INSERT INTO platform.stay_minibar_price
                (stay_id, product_id, hotel_id, product_name, selling_price_mnt, target_quantity,
                 opening_quantity)
              SELECT msnap.stay_id, prod.product_id, $1, 'Fixture', 5000, 2, 2
                FROM msnap, prod
              RETURNING stay_id, product_id)
            INSERT INTO platform.minibar_refill_task
              (hotel_id, room_id, stay_id, product_id, requested_quantity,
               requested_by_account_id)
            SELECT $1, msnap.room_id, price.stay_id, price.product_id, 1, gen_random_uuid()
              FROM price, msnap`,
      values: [hotelId],
    }),
    updateColumn: 'revision',
    updateSet: `state = 'IN_PROGRESS', cleaner_account_id = gen_random_uuid(), claimed_at = now(),
                revision = revision + 1`,
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
