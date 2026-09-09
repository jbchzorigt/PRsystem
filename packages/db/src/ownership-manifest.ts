import { GROUP_ROLES, LOGIN_PRINCIPALS, projectRoles } from './roles';

/**
 * The exact ownership contract for every object a migration creates.
 *
 * Ownership carries implicit rights that no grant reconciliation takes back: an
 * owner can drop the object, disable its RLS, and re-grant it to anybody. So it
 * is not enough to check that an owner is *one of* the four kernel owner roles —
 * `prsystem_maintenance_fn` owning `platform.job_run` would pass that test and
 * would hand the maintenance function owner the ability to rewrite the job
 * ledger it is supposed to be constrained by. Every object has one expected
 * owner, named here.
 */

/**
 * Two Phase 18 signatures long enough that writing them inline would wrap in a
 * way `pg_get_function_identity_arguments` does not.
 */
const POLICE_MATCHER =
  'police.record_check_in_match(p_stay_id uuid, p_hotel_id uuid, p_room_number text, p_check_in_recorded_at timestamp with time zone, p_actual_check_in_at timestamp with time zone, p_detected_at timestamp with time zone, p_eligibility text, p_namespace text, p_token text, p_key_version text)';
const POLICE_CHECK_IN_LIST =
  'police.check_in_list(p_from timestamp with time zone, p_to timestamp with time zone, p_active_only boolean, p_limit integer, p_offset integer)';

/** The Phase 19 subscription page, for the same reason. */
const OPERATION_SUBSCRIPTION_PAGE =
  'platform.operation_subscription_page(p_name text, p_phone text, p_email text, p_owner_type text, p_district text, p_package text, p_term_months integer, p_status text, p_expires_from timestamp with time zone, p_expires_to timestamp with time zone, p_as_of timestamp with time zone, p_limit integer, p_offset integer)';
const OPERATION_SMS_RECIPIENTS =
  'platform.operation_sms_recipients(p_hotel_ids uuid[], p_package text, p_status text, p_expires_from timestamp with time zone, p_expires_to timestamp with time zone, p_as_of timestamp with time zone)';

export const KERNEL_OWNERS = {
  /** DDL owner. Owns everything not listed as an exception below. */
  migrate: 'prsystem_migrate',
  /** Owns the two append-only audit writers and nothing else. */
  auditWriter: 'prsystem_audit_writer',
  /** Owns the partitioned audit parents, their partitions, and the partition functions. */
  partitionMgr: 'prsystem_partition_mgr',
  /** Owns the D-09 scheduler and maintenance wrappers. */
  maintenanceFn: 'prsystem_maintenance_fn',
} as const;

/** Schemas the migration owns end to end. `public` is handled separately. */
export const KERNEL_SCHEMAS = ['platform', 'audit', 'police_audit', 'police', 'drizzle'] as const;

/** Everything in a kernel schema that is not named below belongs to the DDL owner. */
export const DEFAULT_KERNEL_OWNER: string = KERNEL_OWNERS.migrate;

/**
 * Objects whose owner is deliberately *not* the DDL owner.
 *
 * Keyed by `schema.name`. A partition's expected owner is its parent's, resolved
 * through `pg_inherits` rather than by name pattern, because partition names are
 * generated per month and a name-shaped rule stops covering them the moment the
 * naming changes.
 */
export const OWNERSHIP_MANIFEST: Readonly<Record<string, string>> = {
  // Partitioned audit parents. Their partitions inherit this expectation.
  'audit.platform_event': KERNEL_OWNERS.partitionMgr,
  'police_audit.security_event': KERNEL_OWNERS.partitionMgr,
};

/**
 * Functions whose owner is deliberately *not* the DDL owner, keyed by exact
 * signature.
 *
 * By `schema.name` alone, an added overload inherited the exception: creating a
 * second `platform.schedule_maintenance_job(...)` with different arguments and
 * giving it to `prsystem_maintenance_fn` matched the entry for the real one and
 * passed. PostgreSQL identifies a function by its argument types, so the
 * manifest does too — an overload nobody declared falls under the default owner
 * and is refused there.
 */
export const FUNCTION_OWNERSHIP_MANIFEST: Readonly<Record<string, string>> = {
  // Append-only audit writers.
  'audit.append_platform_audit_event(p_action text, p_outcome text, p_target_type text, p_target_ref text, p_reason text, p_payload jsonb)':
    KERNEL_OWNERS.auditWriter,
  'police_audit.append_police_security_event(p_action text, p_outcome text, p_case_ref text, p_reason text, p_payload jsonb)':
    KERNEL_OWNERS.auditWriter,

  // Partition maintenance.
  'platform.ensure_month_partitions(p_schema text, p_table text, p_from timestamp with time zone, p_months integer)':
    KERNEL_OWNERS.partitionMgr,
  'platform.partition_horizon(p_schema text, p_table text)': KERNEL_OWNERS.partitionMgr,
  'platform.check_partition_horizon(p_threshold integer)': KERNEL_OWNERS.partitionMgr,

  // D-09 scheduler and maintenance wrappers.
  'platform.assert_exact_role_closure(p_login text, p_group text)': KERNEL_OWNERS.maintenanceFn,
  'platform.schedule_maintenance_job(p_job_name text, p_hotel_id uuid, p_executor_identity text)':
    KERNEL_OWNERS.maintenanceFn,
  'platform.begin_worker_job(p_job_name text, p_hotel_id uuid)': KERNEL_OWNERS.maintenanceFn,
  'platform.finish_worker_job(p_job_run_id uuid, p_state text, p_error_name text)':
    KERNEL_OWNERS.maintenanceFn,
  'platform.maintenance_expire_idempotency_keys(p_job_run_id uuid)': KERNEL_OWNERS.maintenanceFn,

  // Phase 05. The paid-onboarding provisioning wrapper: the only path by which a
  // hotel tenant, its owner link, its subscription, its Primary Hotel Admin
  // membership and its default drawer come into existence. It belongs to the
  // same narrow, unreachable definer owner as the D-09 wrappers rather than to a
  // new role, for the reason that role exists — no runtime holds it, nobody can
  // connect as it, and it owns nothing but wrappers whose bodies are the whole
  // of what it can do.
  'platform.provision_paid_hotel(p_application_id uuid, p_idempotency_key text, p_owner_id uuid, p_owner_ciphertext bytea, p_owner_wrapped_dek bytea, p_owner_key_version text, p_activation_id uuid, p_token_hash text, p_token_key_version text, p_token_expires_at timestamp with time zone, p_secret_ciphertext bytea, p_secret_wrapped_dek bytea, p_secret_key_version text, p_claim_token uuid)':
    KERNEL_OWNERS.maintenanceFn,

  // Cross-tenant queue discovery. Identifiers only: the alternative was a policy
  // letting the worker read every hotel's subscriptions, which is the broad
  // grant this boundary exists to avoid.
  'platform.resolve_onboarding_applicant(p_token_hash text)': KERNEL_OWNERS.maintenanceFn,
  'platform.resolve_payment_attempt(p_provider text, p_provider_invoice_id text)':
    KERNEL_OWNERS.maintenanceFn,
  'platform.probe_subscription_owner(p_application_id uuid)': KERNEL_OWNERS.maintenanceFn,
  // Phase 05 remediation 1.
  'platform.probe_existing_hotel_account(p_application_id uuid)': KERNEL_OWNERS.maintenanceFn,
  'platform.account_linked_to_owner(p_application_id uuid, p_account_id uuid)':
    KERNEL_OWNERS.maintenanceFn,
  'platform.owner_challenge_destination(p_application_id uuid)': KERNEL_OWNERS.maintenanceFn,
  'platform.pending_provisioning_applications(p_limit integer, p_max_attempts integer)':
    KERNEL_OWNERS.maintenanceFn,
  'platform.manual_ebarimt_issuances(p_limit integer)': KERNEL_OWNERS.maintenanceFn,
  'platform.owner_holds_other_hotel(p_application_id uuid)': KERNEL_OWNERS.maintenanceFn,
  'platform.due_upgrade_boundaries(p_limit integer)': KERNEL_OWNERS.maintenanceFn,
  'platform.pending_activation_deliveries(p_limit integer)': KERNEL_OWNERS.maintenanceFn,
  'platform.pending_ebarimt_issuances(p_limit integer)': KERNEL_OWNERS.maintenanceFn,
  // Phase 05 remediation 2: receipt delivery is its own job.
  'platform.pending_ebarimt_deliveries(p_limit integer)': KERNEL_OWNERS.maintenanceFn,

  // Phase 12. The public listing projection: the one path by which an
  // unauthenticated searcher reads across tenants (doc 09 §§3, 5). The bodies
  // return the listing fields and a count of free rooms; the role that owns
  // them cannot log in and reaches the underlying rows only through the narrow
  // `public_listing_read` / `public_availability_read` policies.
  'platform.public_hotel_listings()': KERNEL_OWNERS.maintenanceFn,
  'platform.public_category_offers(p_hotel_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)':
    KERNEL_OWNERS.maintenanceFn,

  // Phase 13. A Guest names a category; the hotel a booking belongs to is the
  // server's to resolve, and a hotel id in a request must never choose the
  // tenant a command runs in. One identifier in, one out.
  'platform.hotel_of_category(p_category_id uuid)': KERNEL_OWNERS.maintenanceFn,
  // A public search subtracts what bookings hold, and the expiry sweep finds
  // lapsed holds across every hotel. Both run with no tenant of their own.
  'platform.public_category_holds(p_hotel_ids uuid[], p_nights date[])':
    KERNEL_OWNERS.maintenanceFn,
  'platform.lapsed_booking_holds(p_limit integer, p_now timestamp with time zone)':
    KERNEL_OWNERS.maintenanceFn,

  // Phase 14. Two job dispatchers with the same shape: a payout batch and a
  // refund execution both have to find waiting work across every hotel before
  // they can do any of it, and each answers identifiers and nothing else.
  'platform.due_payout_batches(p_limit integer, p_now timestamp with time zone)':
    KERNEL_OWNERS.maintenanceFn,
  'platform.open_booking_refunds(p_limit integer)': KERNEL_OWNERS.maintenanceFn,
  // A provider callback names an invoice and no tenant, so the hotel it belongs
  // to is resolved the same narrow way a category's is.
  'platform.booking_attempt_of_invoice(p_provider text, p_invoice_id text)':
    KERNEL_OWNERS.maintenanceFn,

  // Phase 15. A guest scans a QR and presents a token; the hotel and room it
  // names are the server's to resolve. The two sweeps have the same shape as
  // Phase 13's: find the work across every hotel, and decide nothing.
  'platform.room_of_access_token(p_token_hash text)': KERNEL_OWNERS.maintenanceFn,
  'platform.hotel_of_guest_session(p_token_hash text)': KERNEL_OWNERS.maintenanceFn,

  // Phase 16. A stranger reads a hotel's published reviews and its rating with
  // no session and no tenant; both answer for published hotels only.
  'platform.public_hotel_reviews(p_hotel_id uuid, p_limit integer, p_offset integer)':
    KERNEL_OWNERS.maintenanceFn,
  // A reporter and a moderator each name a review and no tenant, so the hotel
  // they act in is resolved here and the command runs in that hotel's scope.
  'platform.hotel_of_published_review(p_review_id uuid)': KERNEL_OWNERS.maintenanceFn,
  'platform.hotel_of_moderatable_review(p_review_id uuid)': KERNEL_OWNERS.maintenanceFn,
  'platform.open_review_reports(p_limit integer)': KERNEL_OWNERS.maintenanceFn,

  // Phase 17. Two sweeps with the shape every sweep since Phase 13 has: find
  // the work across every hotel, answer identifiers only, and decide nothing.
  'platform.lapsed_export_files(p_limit integer, p_now timestamp with time zone)':
    KERNEL_OWNERS.maintenanceFn,
  'platform.due_retention_purges(p_limit integer, p_now timestamp with time zone)':
    KERNEL_OWNERS.maintenanceFn,
  'platform.queued_export_jobs(p_limit integer)': KERNEL_OWNERS.maintenanceFn,
  'platform.lapsed_restaurant_invoices(p_limit integer, p_now timestamp with time zone)':
    KERNEL_OWNERS.maintenanceFn,
  'platform.unresolved_refund_requests(p_limit integer, p_now timestamp with time zone)':
    KERNEL_OWNERS.maintenanceFn,
  'platform.restaurant_attempt_of_invoice(p_invoice_id text)': KERNEL_OWNERS.maintenanceFn,

  // Phase 18. The three readings that cross between the hotel world and the
  // Police one, and the only ones that do. Each is granted to exactly one
  // runtime role: the matcher to the worker, the sweep and the check-in list to
  // the Police role, and nothing here is reachable from the API role at all.
  [POLICE_MATCHER]: KERNEL_OWNERS.maintenanceFn,
  'police.active_stays_for_match(p_namespace text, p_token text, p_key_version text)':
    KERNEL_OWNERS.maintenanceFn,
  'police.stale_match_locations(p_limit integer)': KERNEL_OWNERS.maintenanceFn,
  'police.pending_check_in_events(p_limit integer)': KERNEL_OWNERS.maintenanceFn,
  [POLICE_CHECK_IN_LIST]: KERNEL_OWNERS.maintenanceFn,

  // Phase 19. The Operation dashboard's resolvers, and the two commands that
  // reach past a tenant. The dashboard ones exist so the registered address is
  // masked *before* it leaves the database rather than after it reaches the
  // application (doc 14 §3.2); the password-reset one queues a link to an
  // address the operator never receives; and the scope revocation closes one
  // hotel's staff authority without touching the same person's other hotels.
  'platform.operation_kpi(p_as_of timestamp with time zone)': KERNEL_OWNERS.maintenanceFn,
  [OPERATION_SUBSCRIPTION_PAGE]: KERNEL_OWNERS.maintenanceFn,
  'platform.operation_application_queue(p_group text, p_limit integer, p_offset integer)':
    KERNEL_OWNERS.maintenanceFn,
  [OPERATION_SMS_RECIPIENTS]: KERNEL_OWNERS.maintenanceFn,
  'platform.operation_reconciliation_queue(p_limit integer)': KERNEL_OWNERS.maintenanceFn,
  'platform.operation_queue_password_reset(p_hotel_id uuid, p_initiator_account_id uuid)':
    KERNEL_OWNERS.maintenanceFn,
  'platform.operation_revoke_hotel_scope(p_hotel_id uuid)': KERNEL_OWNERS.maintenanceFn,
  'platform.operation_subscription_account(p_hotel_id uuid)': KERNEL_OWNERS.maintenanceFn,

  // Phase 07. The inventory ledger's two triggers: the only path by which a
  // warehouse or room balance changes, on tables no runtime may write. They
  // belong to the same narrow definer owner for the same reason the
  // provisioning wrapper does — it can connect as nothing and holds nothing
  // beyond what its bodies need.
  'platform.inventory_movement_apply()': KERNEL_OWNERS.maintenanceFn,
  'platform.inventory_movement_cost()': KERNEL_OWNERS.maintenanceFn,
};

/**
 * Roles that must own nothing at all, anywhere in the database.
 *
 * Every project role that is not one of the four kernel owners: the runtimes,
 * both readers, the D-09 scheduler, the break-glass role and every canonical
 * login. Checked across the whole database rather than the kernel schemas, so a
 * runtime role that acquired ownership of something in `public` is caught too.
 */
export function rolesThatOwnNothing(): ReadonlySet<string> {
  const owners = new Set<string>(Object.values(KERNEL_OWNERS));
  return new Set(
    [...GROUP_ROLES, ...Object.keys(LOGIN_PRINCIPALS)].filter((role) => !owners.has(role)),
  );
}

/**
 * The three narrow owners, which own only what the manifest names.
 *
 * They were excluded from the reverse census entirely, so any of them could own
 * an arbitrary relation or function anywhere outside the kernel schemas — in
 * `public`, or in a schema an operator created — and nothing looked. Owning an
 * object means being able to drop it, disable its RLS and re-grant it, so
 * "narrow owner" has to mean narrow everywhere, not narrow inside five schemas.
 */
export const NARROW_OWNERS: readonly string[] = [
  KERNEL_OWNERS.auditWriter,
  KERNEL_OWNERS.partitionMgr,
  KERNEL_OWNERS.maintenanceFn,
];

/** PostgreSQL's own owner of `public` since 15. Resolves to the database owner. */
export const PG_DATABASE_OWNER = 'pg_database_owner';

export interface OwnedObject {
  readonly kind: 'database' | 'schema' | 'relation' | 'function';
  readonly name: string;
  readonly owner: string;
  /** For a partition, its parent's qualified name. Null otherwise. */
  readonly parent: string | null;
  readonly secdef: boolean;
}

/**
 * Every object the manifest covers, in one query.
 *
 * Extension members are excluded: `btree_gist` and `pgcrypto` install their
 * functions into `public` owned by whoever ran `CREATE EXTENSION`, and those are
 * not kernel objects. `pg_depend` is the catalogue's own record of that, so the
 * exclusion is a fact rather than a name list to maintain.
 *
 * The dependency is matched on its full identity — `classid`, `objid`,
 * `objsubid`, `refclassid` and `deptype`. OIDs are unique within a catalogue and
 * not across them, so `objid = c.oid` alone compares an OID from `pg_class`
 * against OIDs recorded for `pg_proc`, `pg_type` and every other catalogue.
 *
 * This exclusion governs which objects the *expected-owner* comparison covers.
 * It is not an exemption from the narrow-owner census, which reports extension
 * membership and refuses regardless.
 */
const MANIFEST_QUERY = `
  -- ::text on every name. The first branch of a UNION fixes the column type,
  -- and pg_database.datname is of type name, which truncates at 63 bytes: long
  -- enough to cut a function signature in half and make it match nothing.
  SELECT 'database'::text AS kind, d.datname::text AS name,
         pg_get_userbyid(d.datdba)::text AS owner, NULL::text AS parent, false AS secdef
    FROM pg_database d
   WHERE d.datname = current_database()
  UNION ALL
  SELECT 'schema', n.nspname::text, pg_get_userbyid(n.nspowner)::text, NULL, false
    FROM pg_namespace n
   WHERE n.nspname = ANY($1) OR n.nspname = 'public'
  UNION ALL
  SELECT 'relation', n.nspname || '.' || c.relname, pg_get_userbyid(c.relowner)::text,
         (SELECT pn.nspname || '.' || pc.relname
            FROM pg_inherits i
            JOIN pg_class pc ON pc.oid = i.inhparent
            JOIN pg_namespace pn ON pn.oid = pc.relnamespace
           WHERE i.inhrelid = c.oid),
         false
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = ANY($1)
     AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
     AND NOT EXISTS (
       SELECT 1 FROM pg_depend e
        WHERE e.classid = 'pg_class'::regclass
          AND e.objid = c.oid
          AND e.objsubid = 0
          AND e.refclassid = 'pg_extension'::regclass
          AND e.deptype = 'e')
  UNION ALL
  SELECT 'function',
         n.nspname || '.' || p.proname || '(' ||
           pg_get_function_identity_arguments(p.oid) || ')',
         pg_get_userbyid(p.proowner)::text, NULL, p.prosecdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = ANY($1)
     AND NOT EXISTS (
       SELECT 1 FROM pg_depend e
        WHERE e.classid = 'pg_proc'::regclass
          AND e.objid = p.oid
          AND e.objsubid = 0
          AND e.refclassid = 'pg_extension'::regclass
          AND e.deptype = 'e')
  ORDER BY 1, 2`;

/**
 * Every object a role owns, from PostgreSQL's own ownership dependency.
 *
 * `pg_shdepend` with `deptype = 'o'` and `refclassid = pg_authid` *is* the
 * catalogue's record of ownership, so it covers every ownable class rather than
 * the three a hand-written scan happened to query. Foreign tables, enums,
 * domains, composite types, foreign data wrappers, servers, extensions and
 * everything else arrive without being enumerated here — which is the point: a
 * class nobody thought of is reported rather than silently skipped.
 *
 * `class` is the catalogue the object lives in. `name` is resolved for the
 * classes this census knows how to name, and is null otherwise, which the
 * caller treats as a failure: an unrecognised ownable class must fail closed.
 *
 * Extension membership is reported, not used as an exemption. It is matched on
 * the full dependency identity — `classid`, `objid`, `refclassid` and
 * `deptype` — because OIDs are unique per catalogue and not across them, so
 * matching on `objid` alone compares an OID from one catalogue against an OID
 * from another.
 */
const OWNERSHIP_CENSUS_QUERY = `
  WITH owned AS (
    SELECT d.classid, d.objid, r.rolname AS owner
      FROM pg_shdepend d
      JOIN pg_roles r ON r.oid = d.refobjid
     WHERE d.deptype = 'o'
       AND d.refclassid = 'pg_authid'::regclass
       AND d.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
       AND r.rolname = ANY($1)
  )
  SELECT o.owner::text AS owner,
         o.classid::regclass::text AS class,
         CASE o.classid
           WHEN 'pg_class'::regclass THEN (
             SELECT n.nspname || '.' || c.relname
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.oid = o.objid)
           WHEN 'pg_proc'::regclass THEN (
             SELECT n.nspname || '.' || p.proname || '(' ||
                    pg_get_function_identity_arguments(p.oid) || ')'
               FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE p.oid = o.objid)
           WHEN 'pg_namespace'::regclass THEN (
             SELECT n.nspname FROM pg_namespace n WHERE n.oid = o.objid)
           WHEN 'pg_type'::regclass THEN (
             SELECT n.nspname || '.' || t.typname
               FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
              WHERE t.oid = o.objid)
           WHEN 'pg_extension'::regclass THEN (
             SELECT e.extname FROM pg_extension e WHERE e.oid = o.objid)
           WHEN 'pg_database'::regclass THEN (
             SELECT d2.datname FROM pg_database d2 WHERE d2.oid = o.objid)
           ELSE NULL
         END::text AS name,
         (SELECT c.relkind::text FROM pg_class c WHERE c.oid = o.objid
           AND o.classid = 'pg_class'::regclass) AS relkind,
         (SELECT pn.nspname || '.' || pc.relname
            FROM pg_inherits i
            JOIN pg_class pc ON pc.oid = i.inhparent
            JOIN pg_namespace pn ON pn.oid = pc.relnamespace
           WHERE i.inhrelid = o.objid AND o.classid = 'pg_class'::regclass)::text AS parent,
         (SELECT e.extname
            FROM pg_depend dep
            JOIN pg_extension e ON e.oid = dep.refobjid
           WHERE dep.classid = o.classid
             AND dep.objid = o.objid
             AND dep.objsubid = 0
             AND dep.refclassid = 'pg_extension'::regclass
             AND dep.deptype = 'e')::text AS extension
    FROM owned o
   ORDER BY 1, 2, 3`;

/**
 * Every catalogue whose rows are objects *contained in a schema* and owned.
 *
 * Keyed by catalogue, with the namespace and owner columns PostgreSQL stores
 * them in. The kernel census is generated from this map, so classifying a
 * catalogue is the same act as censusing it: the two cannot drift apart the way
 * a hand-written query and a hand-written comment do.
 */
export const OWNABLE_SCHEMA_CATALOGUES: Readonly<
  Record<string, { readonly namespace: string; readonly owner: string; readonly where?: string }>
> = {
  pg_class: {
    namespace: 'relnamespace',
    owner: 'relowner',
    // Indexes, TOAST tables and composite-type rowtypes have no owner of their
    // own: PostgreSQL refuses `ALTER INDEX ... OWNER TO` outright, TOAST tables
    // live in `pg_toast`, and a standalone composite type is censused through
    // `pg_type`, where `ALTER TYPE ... OWNER TO` actually applies.
    where: "o.relkind NOT IN ('i', 'I', 't', 'c')",
  },
  pg_collation: { namespace: 'collnamespace', owner: 'collowner' },
  pg_conversion: { namespace: 'connamespace', owner: 'conowner' },
  pg_extension: { namespace: 'extnamespace', owner: 'extowner' },
  pg_opclass: { namespace: 'opcnamespace', owner: 'opcowner' },
  pg_operator: { namespace: 'oprnamespace', owner: 'oprowner' },
  pg_opfamily: { namespace: 'opfnamespace', owner: 'opfowner' },
  pg_proc: { namespace: 'pronamespace', owner: 'proowner' },
  pg_statistic_ext: { namespace: 'stxnamespace', owner: 'stxowner' },
  pg_ts_config: { namespace: 'cfgnamespace', owner: 'cfgowner' },
  pg_ts_dict: { namespace: 'dictnamespace', owner: 'dictowner' },
  pg_type: {
    namespace: 'typnamespace',
    owner: 'typowner',
    // Derived types carry the owner of the thing they were generated from and
    // cannot be reassigned on their own — PostgreSQL refuses "cannot alter array
    // type", "cannot alter multirange type" and "is a table's row type" — so
    // each is judged through the object it belongs to, which this census already
    // covers.
    where: `NOT EXISTS (SELECT 1 FROM pg_type e WHERE e.typarray = o.oid)
        AND NOT EXISTS (SELECT 1 FROM pg_range rg WHERE rg.rngmultitypid = o.oid)
        AND NOT (o.typrelid <> 0
                 AND (SELECT rc.relkind FROM pg_class rc WHERE rc.oid = o.typrelid) <> 'c')`,
  },
};

/**
 * Schema-contained catalogues whose rows have no owner at all, and why.
 *
 * Present so the coverage guard can tell "this class has no owner" from "nobody
 * thought about this class". If a future PostgreSQL gives one of these an owner
 * column, the guard fails rather than leaving it uncensused.
 */
export const UNOWNED_SCHEMA_CATALOGUES: Readonly<Record<string, string>> = {
  pg_constraint: 'a constraint belongs to its table; PostgreSQL records no separate owner',
  pg_default_acl: 'a default-privilege entry keyed by role, not an ownable object',
  pg_ts_parser: 'no owner column; creating one is superuser-only',
  pg_ts_template: 'no owner column; creating one is superuser-only',
};

/** `pg_class.relkind` values the census expects to judge. */
const CENSUSED_RELKINDS = new Set(['r', 'p', 'v', 'm', 'S', 'f']);

/** `pg_type.typtype` values the census expects to judge. */
const CENSUSED_TYPTYPES = new Set(['b', 'c', 'd', 'e', 'p', 'r', 'm']);

/**
 * Every catalogue that contains schema-scoped rows, and whether it has an owner.
 *
 * Read from the running server rather than from a list, so a PostgreSQL upgrade
 * that introduces an ownable schema-contained class is reported instead of being
 * silently omitted from the census.
 */
const SCHEMA_CATALOGUE_COVERAGE_QUERY = `
  SELECT c.relname::text AS catalogue,
         EXISTS (
           SELECT 1 FROM pg_attribute owner_column
            WHERE owner_column.attrelid = c.oid AND owner_column.attnum > 0
              AND owner_column.attname ~ 'owner$'
         ) AS has_owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0
   WHERE n.nspname = 'pg_catalog' AND c.relkind = 'r' AND a.attname ~ 'namespace$'
   GROUP BY c.oid, c.relname
   ORDER BY 1`;

/**
 * Every object located in a kernel schema, whoever owns it.
 *
 * Enumerated from the catalogues themselves, not from `pg_shdepend`. PostgreSQL
 * records no ownership dependency for an object owned by a *pinned* role — OID
 * 10, the bootstrap superuser initdb creates — so a census built on
 * `pg_shdepend` saw nothing at all for those objects. An enum, a domain, a
 * composite type or extended statistics inside `platform` could be reassigned to
 * the bootstrap operator and stay invisible, which is the identity anybody with
 * cluster access already holds.
 *
 * `pg_get_userbyid` on the catalogue's own owner column has no such gap: it
 * reports the owner PostgreSQL actually stores, pinned or not.
 *
 * `pg_identify_object` names any class generically, so a class nobody
 * enumerated is described rather than skipped; relations and functions are named
 * exactly as the manifest keys them so the comparison is against the manifest
 * and not against a rendering of it.
 */
function kernelObjectCensusQuery(): string {
  const branches = Object.entries(OWNABLE_SCHEMA_CATALOGUES).map(([catalogue, spec]) => {
    const subkind =
      catalogue === 'pg_class'
        ? 'o.relkind::text'
        : catalogue === 'pg_type'
          ? 'o.typtype::text'
          : "''";
    return (
      `    SELECT '${catalogue}'::regclass AS classid, o.oid AS objid, ` +
      `o.${spec.owner} AS ownerid, ${subkind} AS subkind
` +
      `      FROM ${catalogue} o JOIN pg_namespace n ON n.oid = o.${spec.namespace}
` +
      `     WHERE n.nspname = ANY($1)` +
      (spec.where === undefined
        ? ''
        : `
       AND ${spec.where}`)
    );
  });

  return `
  WITH candidates AS (
${branches.join('\n    UNION ALL\n')}
  )
  SELECT pg_get_userbyid(c.ownerid)::text AS owner,
         c.classid::regclass::text AS class,
         c.subkind::text AS subkind,
         o.type::text AS object_type,
         CASE c.classid
           WHEN 'pg_proc'::regclass THEN (
             SELECT n.nspname || '.' || p.proname || '(' ||
                    pg_get_function_identity_arguments(p.oid) || ')'
               FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE p.oid = c.objid)
           WHEN 'pg_class'::regclass THEN (
             SELECT n.nspname || '.' || r.relname
               FROM pg_class r JOIN pg_namespace n ON n.oid = r.relnamespace
              WHERE r.oid = c.objid)
           ELSE o.identity
         END::text AS name,
         COALESCE(
           (SELECT pn.nspname || '.' || pc.relname
              FROM pg_inherits i
              JOIN pg_class pc ON pc.oid = i.inhparent
              JOIN pg_namespace pn ON pn.oid = pc.relnamespace
             WHERE i.inhrelid = c.objid AND c.classid = 'pg_class'::regclass),
           (SELECT pn.nspname || '.' || pc.relname
              FROM pg_depend dep
              JOIN pg_class pc ON pc.oid = dep.refobjid
              JOIN pg_namespace pn ON pn.oid = pc.relnamespace
             WHERE dep.classid = 'pg_class'::regclass AND dep.objid = c.objid
               AND dep.refclassid = 'pg_class'::regclass AND dep.deptype IN ('a', 'i')
               AND c.classid = 'pg_class'::regclass)
         )::text AS parent
    FROM candidates c
    CROSS JOIN LATERAL pg_identify_object(c.classid, c.objid, 0) o
   ORDER BY 1, 2, 5`;
}

const KERNEL_OBJECT_CENSUS_QUERY = kernelObjectCensusQuery();

interface CatalogueCoverageRow {
  readonly catalogue: string;
  readonly has_owner: boolean;
}

interface KernelObjectRow {
  readonly owner: string;
  readonly class: string;
  /** `relkind` for a relation, `typtype` for a type, empty otherwise. */
  readonly subkind: string;
  readonly object_type: string;
  readonly name: string | null;
  readonly parent: string | null;
}

interface CensusRow {
  readonly owner: string;
  readonly class: string;
  readonly name: string | null;
  readonly relkind: string | null;
  readonly parent: string | null;
  readonly extension: string | null;
}

export interface ManifestClient {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

/** Raised when ownership has drifted, before any new DDL is applied. */
export class MigrationOwnershipError extends Error {
  override readonly name = 'MigrationOwnershipError';
}

/** The owner every object is required to have. */
export function expectedOwnerOf(object: Pick<OwnedObject, 'kind' | 'name' | 'parent'>): string {
  // Functions are keyed by exact signature. An overload nobody declared falls
  // here, under the default owner, rather than inheriting the exception granted
  // to a function that merely shares its name.
  const table = object.kind === 'function' ? FUNCTION_OWNERSHIP_MANIFEST : OWNERSHIP_MANIFEST;
  const direct = table[object.name];
  if (direct !== undefined) return direct;
  if (object.parent !== null) {
    // A partition belongs to whoever owns its parent.
    return OWNERSHIP_MANIFEST[object.parent] ?? DEFAULT_KERNEL_OWNER;
  }
  return DEFAULT_KERNEL_OWNER;
}

/**
 * Validates the whole manifest against the live catalogue.
 *
 * @param approved operator identities allowed to own the database and `public`.
 *        Mandatory: there is no honest default, because the migration principal
 *        never owns the database.
 */
export async function assertOwnershipManifest(
  client: ManifestClient,
  approved: ReadonlySet<string>,
): Promise<void> {
  if (approved.size === 0) {
    throw new MigrationOwnershipError(
      'PRSYSTEM_APPROVED_OPERATOR_OWNERS is required and must name at least one operator ' +
        'identity allowed to own the database. There is no default: the migration principal ' +
        'never owns the database, so any inferred value would either refuse every real ' +
        'deployment or approve every owner.',
    );
  }

  // The catalogue coverage guard, before any census runs.
  //
  // The kernel census is generated from `OWNABLE_SCHEMA_CATALOGUES`, so a
  // schema-contained class that is missing from that map is a class nothing
  // looks at. Read from the running server rather than assumed, so a PostgreSQL
  // upgrade that adds one stops the migration instead of quietly narrowing the
  // census.
  const coverage = await client.query<CatalogueCoverageRow>(SCHEMA_CATALOGUE_COVERAGE_QUERY);
  for (const row of coverage.rows) {
    const ownable = row.catalogue in OWNABLE_SCHEMA_CATALOGUES;
    const unowned = row.catalogue in UNOWNED_SCHEMA_CATALOGUES;
    if (row.has_owner && ownable) continue;
    if (!row.has_owner && unowned) continue;
    throw new MigrationOwnershipError(
      `${row.catalogue} holds schema-contained rows and ` +
        (row.has_owner ? 'has an owner column' : 'has no owner column') +
        ', which contradicts its classification' +
        (ownable || unowned ? '' : ' (it is not classified at all)') +
        '. Ownership coverage fails closed: classify the catalogue in ' +
        'OWNABLE_SCHEMA_CATALOGUES or UNOWNED_SCHEMA_CATALOGUES rather than leaving objects ' +
        'of that class uncensused',
    );
  }
  const censused = new Set(coverage.rows.map((row) => row.catalogue));
  for (const catalogue of Object.keys(OWNABLE_SCHEMA_CATALOGUES)) {
    if (censused.has(catalogue)) continue;
    throw new MigrationOwnershipError(
      `${catalogue} is censused for ownership but this server has no such schema-contained ` +
        'catalogue: the census would silently cover nothing',
    );
  }

  // One census, over PostgreSQL's own ownership dependency, for every role that
  // must own nothing and every narrow owner. `pg_shdepend` covers every ownable
  // class, so a foreign table, an enum, a domain, a composite type or a class
  // nobody anticipated arrives here instead of being missed by a hand-written
  // scan of three catalogues.
  const censusRoles = [...rolesThatOwnNothing(), ...NARROW_OWNERS];
  const census = await client.query<CensusRow>(OWNERSHIP_CENSUS_QUERY, [censusRoles]);
  const ownsNothing = rolesThatOwnNothing();

  for (const row of census.rows) {
    // An ownable class this census cannot name is a class it cannot judge.
    // Skipping it silently is how foreign tables and types went unseen.
    if (row.name === null) {
      throw new MigrationOwnershipError(
        `${row.owner} owns an object of class ${row.class} that the ownership census cannot ` +
          'identify. Unrecognised ownable classes fail closed: extend the census rather than ' +
          'letting the object through unjudged',
      );
    }

    if (ownsNothing.has(row.owner)) {
      throw new MigrationOwnershipError(
        `${row.class} ${row.name} is owned by ${row.owner}, which must own nothing: ` +
          'no runtime, reader, scheduler, break-glass or login role may own any object',
      );
    }

    // A narrow owner holds only what the manifest names, or a partition
    // descendant of something it names. Extension membership is reported for
    // diagnosis and is deliberately not an exemption: an extension function
    // handed to a narrow owner is still an object the manifest never granted it.
    const declared =
      row.class === 'pg_proc'
        ? FUNCTION_OWNERSHIP_MANIFEST[row.name] === row.owner
        : OWNERSHIP_MANIFEST[row.name] === row.owner ||
          (row.parent !== null && OWNERSHIP_MANIFEST[row.parent] === row.owner);
    if (declared) continue;

    throw new MigrationOwnershipError(
      `${row.class} ${row.name} is owned by ${row.owner}, which owns only what the manifest ` +
        'names: a narrow owner may hold nothing else, in any schema' +
        (row.extension === null
          ? ''
          : ` (it belongs to extension ${row.extension}, which is ` + 'not an exemption)'),
    );
  }

  // Everything inside a kernel schema, whoever owns it, held to the exact
  // expected-owner rule.
  const kernelObjects = await client.query<KernelObjectRow>(KERNEL_OBJECT_CENSUS_QUERY, [
    [...KERNEL_SCHEMAS],
  ]);
  for (const row of kernelObjects.rows) {
    // A relation kind or type kind the census was not written to judge fails
    // closed. Naming an object is not the same as knowing what it is: a class
    // whose sub-kind nobody classified is exactly the case that went unseen.
    if (row.class === 'pg_class' && !CENSUSED_RELKINDS.has(row.subkind)) {
      throw new MigrationOwnershipError(
        `${row.name ?? '(unnamed)'} in a kernel schema has relkind "${row.subkind}", which the ` +
          'ownership census does not classify: extend CENSUSED_RELKINDS rather than letting the ' +
          'object through unjudged',
      );
    }
    if (row.class === 'pg_type' && !CENSUSED_TYPTYPES.has(row.subkind)) {
      throw new MigrationOwnershipError(
        `${row.name ?? '(unnamed)'} in a kernel schema has typtype "${row.subkind}", which the ` +
          'ownership census does not classify: extend CENSUSED_TYPTYPES rather than letting the ' +
          'object through unjudged',
      );
    }
    if (row.name === null) {
      throw new MigrationOwnershipError(
        `an object of class ${row.class} (${row.object_type}) in a kernel schema cannot be ` +
          'identified by the ownership census. Unrecognised classes fail closed: extend the ' +
          'census rather than letting the object through unjudged',
      );
    }
    const expected =
      row.class === 'pg_proc'
        ? (FUNCTION_OWNERSHIP_MANIFEST[row.name] ?? DEFAULT_KERNEL_OWNER)
        : (OWNERSHIP_MANIFEST[row.name] ??
          (row.parent === null ? undefined : OWNERSHIP_MANIFEST[row.parent]) ??
          DEFAULT_KERNEL_OWNER);
    if (row.owner === expected) continue;
    throw new MigrationOwnershipError(
      `${row.object_type} ${row.name} (class ${row.class}) in a kernel schema is owned by ` +
        `${row.owner}; the manifest requires ${expected}`,
    );
  }

  const objects = await client.query<OwnedObject>(MANIFEST_QUERY, [[...KERNEL_SCHEMAS]]);

  const databaseRow = objects.rows.find((row) => row.kind === 'database');
  if (databaseRow === undefined) {
    throw new MigrationOwnershipError('could not read the owner of the current database');
  }

  // No project role, whatever the allow-list says.
  //
  // The approved-operator list used to be the only gate here, so approving
  // `prsystem_migrate` or `prsystem_maintenance_fn` made a kernel owner the
  // database owner — while bootstrap forbade every project role at the same
  // position unconditionally. The two checks disagreed about one invariant. The
  // list is a tightening on top of this rule, never a way around it.
  const project = projectRoles();
  if (project.has(databaseRow.owner)) {
    throw new MigrationOwnershipError(
      `database ${databaseRow.name} is owned by the project role ${databaseRow.owner}, which ` +
        'must own nothing at this position: no group role or canonical login may own the ' +
        'database or schema public, whatever PRSYSTEM_APPROVED_OPERATOR_OWNERS names',
    );
  }
  if (!approved.has(databaseRow.owner)) {
    throw new MigrationOwnershipError(
      `database ${databaseRow.name} is owned by ${databaseRow.owner}, which is not an approved ` +
        `operator owner (approved: ${[...approved].join(', ')})`,
    );
  }

  for (const row of objects.rows) {
    if (row.kind === 'database') continue;

    if (row.kind === 'schema' && row.name === 'public') {
      if (project.has(row.owner)) {
        throw new MigrationOwnershipError(
          `schema public is owned by the project role ${row.owner}, which must own nothing at ` +
            'this position: no group role or canonical login may own the database or schema ' +
            'public, whatever PRSYSTEM_APPROVED_OPERATOR_OWNERS names',
        );
      }
      // `pg_database_owner` resolves to the database owner, already checked above.
      if (row.owner === PG_DATABASE_OWNER || approved.has(row.owner)) continue;
      throw new MigrationOwnershipError(
        `schema public is owned by ${row.owner}, which is not an approved operator owner ` +
          `(approved: ${[...approved].join(', ')})`,
      );
    }

    const expected = expectedOwnerOf(row);
    if (row.owner !== expected) {
      throw new MigrationOwnershipError(
        `${row.kind} ${row.name} is owned by ${row.owner}; the manifest requires ${expected}` +
          (row.secdef ? ' (SECURITY DEFINER)' : ''),
      );
    }
  }
}
