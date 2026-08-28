import type { Pool } from 'pg';

/**
 * A deterministic, normalised description of a database schema.
 *
 * The migration contract is "a fresh install and an upgraded install are the
 * same database", and that claim is only as strong as the comparison behind it.
 * A fingerprint listing function *names* reports two databases as equivalent
 * when one of them has had a function body rewritten, so every property this
 * covers is one whose divergence would be a real defect — and every one of them
 * has a sensitivity test proving a one-line change to it changes the result.
 *
 * Ordering is total in every projection, so the output depends on the schema
 * and not on the order PostgreSQL happened to return rows in.
 */
/**
 * Every schema the kernel owns, plus the migration ledger's own schema. A
 * fingerprint that skipped the ledger schema could not detect drift in the thing
 * that records which migrations ran.
 */
const FINGERPRINT_SCHEMAS = ['platform', 'audit', 'police_audit', 'police', 'drizzle'];

export async function schemaFingerprint(pool: Pool): Promise<string> {
  const schemas = FINGERPRINT_SCHEMAS;

  /** Runs one catalogue projection. Every query orders fully, so the result is stable. */
  const q = async (sql: string): Promise<Record<string, unknown>[]> =>
    (await pool.query<Record<string, unknown>>(sql, [schemas])).rows;

  // Schema identity, ownership and ACLs — the security posture, not only shape.
  const namespaces = await q(
    `SELECT n.nspname, pg_get_userbyid(n.nspowner) AS owner,
            coalesce(array_to_string(n.nspacl, ' '), '(default)') AS acl
       FROM pg_namespace n WHERE n.nspname = ANY($1) ORDER BY 1`,
  );

  // Default privileges decide what *future* objects inherit; drift here is
  // invisible in today's ACLs and shows up as a privilege bug much later.
  const defaultAcl = await q(
    `SELECT n.nspname, pg_get_userbyid(d.defaclrole) AS role, d.defaclobjtype::text AS objtype,
            coalesce(array_to_string(d.defaclacl, ' '), '') AS acl
       FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
      WHERE n.nspname = ANY($1) ORDER BY 1, 2, 3`,
  );

  // Relations of every kind, with ownership, ACLs, RLS flags, partitioning
  // strategy and partition bound.
  const relations = await q(
    `SELECT n.nspname, c.relname, c.relkind::text, c.relpersistence::text,
            pg_get_userbyid(c.relowner) AS owner,
            coalesce(array_to_string(c.relacl, ' '), '(default)') AS acl,
            c.relrowsecurity::text AS rls, c.relforcerowsecurity::text AS force_rls,
            coalesce(pg_get_partkeydef(c.oid), '') AS partition_key,
            coalesce(pg_get_expr(c.relpartbound, c.oid), '') AS partition_bound
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      ORDER BY 1, 2`,
  );

  const columns = await q(
    `SELECT c.table_schema, c.table_name, c.ordinal_position::text, c.column_name,
            c.data_type, c.udt_name, c.is_nullable,
            coalesce(c.column_default, '') AS column_default,
            coalesce(c.character_maximum_length::text, '') AS max_length,
            coalesce(c.numeric_precision::text, '') AS numeric_precision,
            coalesce(c.numeric_scale::text, '') AS numeric_scale,
            coalesce(c.collation_name, '') AS collation_name,
            c.is_identity, c.is_generated, coalesce(c.generation_expression, '') AS generation
       FROM information_schema.columns c
      WHERE c.table_schema = ANY($1) ORDER BY 1, 2, 3`,
  );

  const constraints = await q(
    `SELECT n.nspname, rel.relname, con.conname, con.contype::text,
            pg_get_constraintdef(con.oid) AS def, con.condeferrable::text, con.convalidated::text
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname = ANY($1) ORDER BY 1, 2, 3`,
  );

  const indexes = await q(
    `SELECT schemaname, tablename, indexname, indexdef
       FROM pg_indexes WHERE schemaname = ANY($1) ORDER BY 1, 2, 3`,
  );

  const policies = await q(
    `SELECT schemaname, tablename, policyname, permissive, cmd,
            coalesce(array_to_string(roles, ' '), '') AS roles,
            coalesce(qual, '') AS qual, coalesce(with_check, '') AS with_check
       FROM pg_policies WHERE schemaname = ANY($1) ORDER BY 1, 2, 3`,
  );

  // Sequence definitions only. `last_value` is state, not schema, and including
  // it would make the comparison depend on how many rows a test happened to write.
  const sequences = await q(
    `SELECT s.schemaname, s.sequencename, s.data_type::text, s.start_value::text,
            s.min_value::text, s.max_value::text, s.increment_by::text,
            s.cycle::text, s.cache_size::text,
            pg_get_userbyid(c.relowner) AS owner,
            coalesce(array_to_string(c.relacl, ' '), '(default)') AS acl
       FROM pg_sequences s
       JOIN pg_class c ON c.relname = s.sequencename
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = s.schemaname
      WHERE s.schemaname = ANY($1) ORDER BY 1, 2`,
  );

  // Types, enums and domains, including every enum label in order and every
  // domain constraint: a reordered enum is a different type.
  const types = await q(
    `SELECT n.nspname, t.typname, t.typtype::text, pg_get_userbyid(t.typowner) AS owner,
            coalesce(array_to_string(t.typacl, ' '), '(default)') AS acl,
            coalesce(
              (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
                 FROM pg_enum e WHERE e.enumtypid = t.oid), '') AS enum_labels,
            coalesce(format_type(t.typbasetype, t.typtypmod), '') AS domain_base,
            t.typnotnull::text AS domain_not_null,
            coalesce(
              (SELECT string_agg(pg_get_constraintdef(dc.oid), ',' ORDER BY dc.conname)
                 FROM pg_constraint dc WHERE dc.contypid = t.oid), '') AS domain_constraints
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = ANY($1) AND t.typtype IN ('e', 'd', 'c', 'r')
        AND NOT EXISTS (
          SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c')
      ORDER BY 1, 2`,
  );

  // Views and materialised views by definition, not merely by name.
  const views = await q(
    `SELECT n.nspname, c.relname, c.relkind::text, pg_get_viewdef(c.oid, true) AS def
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1) AND c.relkind IN ('v', 'm') ORDER BY 1, 2`,
  );

  // Functions by *complete* definition. Name, owner and security mode alone
  // would let a rewritten body pass as an identical schema, which is precisely
  // the drift a migration-equivalence check exists to catch.
  const functions = await q(
    `SELECT n.nspname, p.proname,
            pg_get_function_identity_arguments(p.oid) AS identity_args,
            pg_get_function_result(p.oid) AS returns,
            pg_get_functiondef(p.oid) AS def,
            p.prosecdef::text, p.provolatile::text, p.proleakproof::text, p.prokind::text,
            coalesce(array_to_string(p.proconfig, ' '), '') AS config,
            pg_get_userbyid(p.proowner) AS owner,
            coalesce(array_to_string(p.proacl, ' '), '(default)') AS acl
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = ANY($1) AND p.prokind IN ('f', 'p')
      ORDER BY 1, 2, 3`,
  );

  const triggers = await q(
    `SELECT n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid) AS def, t.tgenabled::text
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = ANY($1) ORDER BY 1, 2, 3`,
  );

  const inheritance = await q(
    `SELECT pn.nspname AS parent_schema, pc.relname AS parent,
            cn.nspname AS child_schema, cc.relname AS child,
            coalesce(pg_get_expr(cc.relpartbound, cc.oid), '') AS bound
       FROM pg_inherits i
       JOIN pg_class cc ON cc.oid = i.inhrelid
       JOIN pg_namespace cn ON cn.oid = cc.relnamespace
       JOIN pg_class pc ON pc.oid = i.inhparent
       JOIN pg_namespace pn ON pn.oid = pc.relnamespace
      WHERE cn.nspname = ANY($1) OR pn.nspname = ANY($1)
      ORDER BY 1, 2, 3, 4`,
  );

  // Extensions are schema too: a database missing one, or carrying a different
  // version, is not equivalent even when every table matches.
  const extensions = (
    await pool.query<Record<string, unknown>>(
      `SELECT e.extname, e.extversion, n.nspname AS schema
         FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname <> 'plpgsql' ORDER BY 1`,
    )
  ).rows;

  // Default privileges decide what *future* objects inherit. The global rows
  // (defaclnamespace = 0) apply to every schema including ones not yet created,
  // so they matter more than the schema-local ones, and neither is visible in
  // any object's current ACL.
  const globalDefaultAcl = (
    await pool.query<Record<string, unknown>>(
      `SELECT pg_get_userbyid(d.defaclrole) AS role, d.defaclobjtype::text AS objtype,
              coalesce(array_to_string(d.defaclacl, ' '), '') AS acl
         FROM pg_default_acl d
        WHERE d.defaclnamespace = 0
        ORDER BY 1, 2`,
    )
  ).rows;

  // Column-level grants. A table-level ACL says nothing about them, and
  // `GRANT UPDATE (state) ON t` is exactly the kind of narrowing that must not
  // silently differ between a fresh and an upgraded database.
  const columnAcl = await q(
    `SELECT n.nspname, c.relname, a.attname,
            coalesce(array_to_string(a.attacl, ' '), '') AS acl
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attacl IS NOT NULL
      ORDER BY 1, 2, 3`,
  );

  // Storage-level properties. `relreplident` changes what logical replication
  // emits, `reloptions` changes autovacuum and fillfactor behaviour, and the
  // access method changes the on-disk representation; none show up in a column
  // or constraint listing.
  //
  // Views are included deliberately: `security_invoker`, `security_barrier` and
  // `check_option` all live in `reloptions`, and they decide whose privileges
  // and whose RLS policies a view runs under. Excluding views — as this
  // projection first did — made a change of view security mode invisible.
  const storage = await q(
    `SELECT n.nspname, c.relname, c.relreplident::text AS replica_identity,
            coalesce(am.amname, '') AS access_method,
            coalesce(ts.spcname, '(default)') AS tablespace,
            coalesce(array_to_string(c.reloptions, ' '), '') AS reloptions,
            coalesce(
              (SELECT i.relname FROM pg_class i
                JOIN pg_index x ON x.indexrelid = i.oid
               WHERE x.indrelid = c.oid AND x.indisreplident), '') AS replica_index
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_am am ON am.oid = c.relam
       LEFT JOIN pg_tablespace ts ON ts.oid = c.reltablespace
      WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p', 'v', 'm', 'i', 'S')
      ORDER BY 1, 2`,
  );

  // Sequence ownership: which column a sequence is tied to, and how. A sequence
  // that loses its OWNED BY link survives a DROP COLUMN it should not have.
  const sequenceOwnership = await q(
    `SELECT sn.nspname AS sequence_schema, s.relname AS sequence,
            tn.nspname AS table_schema, t.relname AS table_name, a.attname AS column_name,
            d.deptype::text
       FROM pg_depend d
       JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
       JOIN pg_namespace sn ON sn.oid = s.relnamespace
       JOIN pg_class t ON t.oid = d.refobjid
       JOIN pg_namespace tn ON tn.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
      WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
        AND (sn.nspname = ANY($1) OR tn.nspname = ANY($1))
      ORDER BY 1, 2, 3, 4, 5`,
  );

  return JSON.stringify(
    {
      namespaces,
      defaultAcl,
      globalDefaultAcl,
      columnAcl,
      storage,
      sequenceOwnership,
      relations,
      columns,
      constraints,
      indexes,
      policies,
      sequences,
      types,
      views,
      functions,
      triggers,
      inheritance,
      extensions,
    },
    null,
    0,
  );
}
