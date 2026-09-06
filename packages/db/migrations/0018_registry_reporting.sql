-- =====================================================================
-- 0018 — Guest registry, exports, retention and Hotel Admin reporting
--
-- This phase adds almost no *facts*. The guest registry and the financial
-- dashboard are reads over rows Phases 07 to 15 already wrote, and doc 23 §10
-- is explicit that a report never rewrites what it reports on. What the phase
-- does add is the machinery around those reads, and five rules shape it.
--
-- **An export is a job, not a download** (`GUEST-DEC-006`). It carries the
-- filter, the sort, the timezone and the policy version it ran under as an
-- immutable snapshot, so a file and the numbers on the screen that produced it
-- can never disagree because a filter moved underneath them.
--
-- **A file's hour is not extendable** (`GUEST-DEC-007`). `expires_at` is a
-- CHECK on `ready_at` plus exactly one hour, and a download grant is a separate
-- append-only row with its own five minutes. Re-issuing a URL therefore cannot
-- lengthen the file's life however the code is written — the two clocks are
-- different columns on different tables.
--
-- **Ten thousand rows is a CHECK** (`GUEST-DEC-006`). A job that would exceed
-- it is never started, and a row count above it is unrepresentable — so a
-- partial or truncated file has no shape to exist in.
--
-- **Retention is snapshotted at checkout, and a hold stops it**
-- (`GUEST-DEC-008`). The policy version, the day count and the expiry are
-- written when the stay completes; a later policy edit does not silently move
-- an earlier row's deadline, and a live legal hold suspends the purge without
-- deleting the hold's own history.
--
-- **An expense is one of two kinds** (`FIN-DEC-004`). `Inventory purchase` is a
-- cash outflow whose cost reaches the operating result as COGS when the goods
-- are sold; `Operating expense` reaches it when it is paid. The column exists
-- so the dashboard cannot deduct the same money twice.
-- =====================================================================

-- =====================================================================
-- Expense kinds and the categories a hotel manages
-- =====================================================================

-- doc 23 §4.4: eight default categories, and the ones a Hotel Admin adds. A
-- category that has been used is deactivated, never deleted — the expenses
-- that named it keep naming it.
CREATE TABLE platform.expense_category (
  category_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id          uuid NOT NULL,
  name              text NOT NULL,
  -- doc 23 §4.1: the two reporting kinds, decided per category rather than per
  -- expense, so a hotel cannot book the same category both ways.
  kind              text NOT NULL,
  state             text NOT NULL DEFAULT 'ACTIVE',
  created_by_account_id uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  deactivated_at    timestamptz,
  revision          integer NOT NULL DEFAULT 0,
  CONSTRAINT expense_category_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT expense_category_created_by_fkey FOREIGN KEY (created_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT expense_category_identity_uq UNIQUE (hotel_id, category_id),
  CONSTRAINT expense_category_name_uq UNIQUE (hotel_id, name),
  CONSTRAINT expense_category_kind_known
    CHECK (kind = ANY (ARRAY['INVENTORY_PURCHASE'::text, 'OPERATING'::text])),
  CONSTRAINT expense_category_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text])),
  CONSTRAINT expense_category_deactivated_shape
    CHECK ((state = 'INACTIVE'::text) = (deactivated_at IS NOT NULL)),
  CONSTRAINT expense_category_name_bounded CHECK (length(name) BETWEEN 1 AND 80),
  CONSTRAINT expense_category_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
ALTER TABLE platform.expense_category ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.expense_category FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.expense_category
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- `FIN-DEC-004`: the kind an expense reports under, and the stock receipt it
-- paid for when it is an inventory purchase.
--
-- Defaulted to `OPERATING` for the rows Phase 11 already wrote, then the
-- default is dropped: a future expense states its kind rather than inheriting
-- one, because the whole point of the column is that the two are not the same.
ALTER TABLE platform.expense ADD COLUMN expense_type text NOT NULL DEFAULT 'OPERATING';
--> statement-breakpoint
ALTER TABLE platform.expense ALTER COLUMN expense_type DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE platform.expense ADD COLUMN category_id uuid;
--> statement-breakpoint
ALTER TABLE platform.expense ADD COLUMN supplier text;
--> statement-breakpoint
ALTER TABLE platform.expense ADD COLUMN stock_movement_id uuid;
--> statement-breakpoint
ALTER TABLE platform.expense
  ADD CONSTRAINT expense_type_known
    CHECK (expense_type = ANY (ARRAY['INVENTORY_PURCHASE'::text, 'OPERATING'::text]));
--> statement-breakpoint
ALTER TABLE platform.expense
  ADD CONSTRAINT expense_category_fkey FOREIGN KEY (hotel_id, category_id)
    REFERENCES platform.expense_category (hotel_id, category_id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE platform.expense
  ADD CONSTRAINT expense_stock_movement_fkey FOREIGN KEY (stock_movement_id)
    REFERENCES platform.inventory_movement (movement_id) ON DELETE RESTRICT;
--> statement-breakpoint
-- doc 23 §4.1: one stock receipt is expensed once. A second expense naming the
-- same receipt is the double deduction `FIN-DEC-004` exists to prevent, and it
-- is refused here rather than detected in a report.
CREATE UNIQUE INDEX expense_stock_movement_uq
  ON platform.expense (stock_movement_id) WHERE stock_movement_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE platform.expense
  ADD CONSTRAINT expense_supplier_bounded
    CHECK (supplier IS NULL OR length(supplier) BETWEEN 1 AND 200);
--> statement-breakpoint
-- Only an inventory purchase names a stock receipt.
ALTER TABLE platform.expense
  ADD CONSTRAINT expense_stock_movement_kind
    CHECK (stock_movement_id IS NULL OR expense_type = 'INVENTORY_PURCHASE'::text);
--> statement-breakpoint

-- doc 23 §4.4: the category decides the kind, so the two cannot disagree.
-- A CHECK cannot reach another table, and the application resolving the kind
-- is not enough on its own — this is the constraint that makes the resolution
-- true of the row rather than of the code path that wrote it.
CREATE FUNCTION platform.expense_category_kind_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  category_kind text;
BEGIN
  IF NEW.category_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT c.kind INTO category_kind
    FROM platform.expense_category c
   WHERE c.category_id = NEW.category_id;
  IF category_kind IS NULL THEN
    RAISE EXCEPTION 'the expense category does not exist'
      USING ERRCODE = '23503';
  END IF;
  IF category_kind <> NEW.expense_type THEN
    RAISE EXCEPTION 'an expense must carry its category''s kind'
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER expense_category_kind_guard
  BEFORE INSERT OR UPDATE ON platform.expense
  FOR EACH ROW EXECUTE FUNCTION platform.expense_category_kind_guard();
--> statement-breakpoint

-- =====================================================================
-- Retention and legal hold
-- =====================================================================

-- `GUEST-DEC-008`: the versioned policy a checkout snapshots.
--
-- Append-only and versioned per hotel, because doc 12 §9 requires that a later
-- policy does **not** silently move an earlier row's deadline: a row keeps the
-- version it was written under, and a retroactive change is a new version that
-- says so in writing.
CREATE TABLE platform.retention_policy (
  policy_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id       uuid NOT NULL,
  version        integer NOT NULL,
  retention_days integer NOT NULL,
  effective_at   timestamptz NOT NULL,
  owner          text NOT NULL,
  legal_basis    text NOT NULL,
  retroactive    boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retention_policy_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT retention_policy_version_uq UNIQUE (hotel_id, version),
  CONSTRAINT retention_policy_version_positive CHECK (version >= 1),
  -- doc 12 §9: 365 days is the MVP default. A shorter or longer period needs a
  -- named owner and a legal basis, which are `NOT NULL` above.
  CONSTRAINT retention_policy_days_bounded CHECK (retention_days BETWEEN 1 AND 3650),
  CONSTRAINT retention_policy_owner_bounded CHECK (length(owner) BETWEEN 1 AND 200),
  CONSTRAINT retention_policy_basis_bounded CHECK (length(legal_basis) BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE platform.retention_policy ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.retention_policy FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.retention_policy
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- `GUEST-DEC-008`: what one completed stay's guest data is kept under.
--
-- Written at checkout and not before: doc 12 §9 says an active stay's countdown
-- has not started, so a row here means the stay has ended and the clock is
-- running.
CREATE TABLE platform.stay_retention (
  stay_id                  uuid PRIMARY KEY,
  hotel_id                 uuid NOT NULL,
  retention_policy_version integer NOT NULL,
  retention_days           integer NOT NULL,
  checkout_at              timestamptz NOT NULL,
  retention_expires_at     timestamptz NOT NULL,
  anonymized_at            timestamptz,
  anonymized_reason        text,
  revision                 integer NOT NULL DEFAULT 0,
  CONSTRAINT stay_retention_stay_fkey FOREIGN KEY (hotel_id, stay_id)
    REFERENCES platform.stay (hotel_id, stay_id) ON DELETE RESTRICT,
  CONSTRAINT stay_retention_policy_fkey FOREIGN KEY (hotel_id, retention_policy_version)
    REFERENCES platform.retention_policy (hotel_id, version) ON DELETE RESTRICT,
  CONSTRAINT stay_retention_identity_uq UNIQUE (hotel_id, stay_id),
  CONSTRAINT stay_retention_days_bounded CHECK (retention_days BETWEEN 1 AND 3650),
  -- The expiry is the checkout plus the snapshotted day count, and the CHECK
  -- recomputes it: a row cannot claim a deadline its own policy does not give.
  CONSTRAINT stay_retention_expiry_derived
    CHECK (retention_expires_at = checkout_at + make_interval(days => retention_days)),
  CONSTRAINT stay_retention_anonymized_shape
    CHECK ((anonymized_at IS NULL) = (anonymized_reason IS NULL)),
  CONSTRAINT stay_retention_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE INDEX stay_retention_due_idx
  ON platform.stay_retention (retention_expires_at) WHERE anonymized_at IS NULL;
--> statement-breakpoint
ALTER TABLE platform.stay_retention ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.stay_retention FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.stay_retention
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- doc 12 §9: a legal hold suspends the purge, and says who imposed it and why.
CREATE TABLE platform.retention_legal_hold (
  hold_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id             uuid NOT NULL,
  stay_id              uuid,
  reason               text NOT NULL,
  authority_reference  text NOT NULL,
  imposed_by_account_id uuid NOT NULL,
  starts_at            timestamptz NOT NULL DEFAULT now(),
  ends_at              timestamptz,
  released_at          timestamptz,
  released_by_account_id uuid,
  released_reason      text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  revision             integer NOT NULL DEFAULT 0,
  CONSTRAINT retention_legal_hold_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT retention_legal_hold_stay_fkey FOREIGN KEY (hotel_id, stay_id)
    REFERENCES platform.stay (hotel_id, stay_id) ON DELETE RESTRICT,
  CONSTRAINT retention_legal_hold_imposed_by_fkey FOREIGN KEY (imposed_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT retention_legal_hold_released_by_fkey FOREIGN KEY (released_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT retention_legal_hold_reason_bounded CHECK (length(reason) BETWEEN 10 AND 500),
  CONSTRAINT retention_legal_hold_authority_bounded
    CHECK (length(authority_reference) BETWEEN 1 AND 200),
  CONSTRAINT retention_legal_hold_window CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT retention_legal_hold_released_shape
    CHECK (num_nulls(released_at, released_by_account_id, released_reason) IN (0, 3)),
  CONSTRAINT retention_legal_hold_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE INDEX retention_legal_hold_live_idx
  ON platform.retention_legal_hold (hotel_id, stay_id) WHERE released_at IS NULL;
--> statement-breakpoint
ALTER TABLE platform.retention_legal_hold ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.retention_legal_hold FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.retention_legal_hold
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- The export job and its download grants
-- =====================================================================

-- `GUEST-DEC-006`, `GUEST-DEC-007` and `FIN-DEC-008`: one table for all five
-- export kinds, because they share every rule that matters — the immutable
-- filter snapshot, the row cap, the state machine and the file's hour.
CREATE TABLE platform.report_export_job (
  job_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id          uuid NOT NULL,
  kind              text NOT NULL,
  state             text NOT NULL DEFAULT 'QUEUED',
  -- The filter, the sort and the timezone the job ran under. Immutable: doc 12
  -- §8 requires the file and the screen that produced it to agree, and a filter
  -- that could move afterwards would make that impossible to guarantee.
  filters           jsonb NOT NULL,
  timezone          text NOT NULL,
  -- doc 12 §7: the retention policy version in force when the job was created,
  -- so an export carries the rules it was made under.
  policy_version    integer NOT NULL,
  row_count         integer,
  storage_key       text,
  content_hash      text,
  requested_by_account_id uuid NOT NULL,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  ready_at          timestamptz,
  expires_at        timestamptz,
  expired_at        timestamptz,
  failed_at         timestamptz,
  failure_reason    text,
  revision          integer NOT NULL DEFAULT 0,
  CONSTRAINT report_export_job_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT report_export_job_requested_by_fkey FOREIGN KEY (requested_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT report_export_job_identity_uq UNIQUE (hotel_id, job_id),
  -- doc 12 §7 and doc 23 §8: the guest registry, and the four financial ones.
  CONSTRAINT report_export_job_kind_known
    CHECK (kind = ANY (ARRAY['GUEST_REGISTRY'::text, 'ROOM_SALES'::text,
                             'MINIBAR_SALES'::text, 'EXPENSE'::text,
                             'PAYMENT_BREAKDOWN'::text])),
  CONSTRAINT report_export_job_state_known
    CHECK (state = ANY (ARRAY['QUEUED'::text, 'RUNNING'::text, 'COMPLETED'::text,
                              'FAILED'::text, 'EXPIRED'::text])),
  -- `GUEST-DEC-006`: ten thousand rows, and a partial file has no shape to
  -- exist in — a job that would exceed the cap is refused before it starts.
  CONSTRAINT report_export_job_row_cap CHECK (row_count IS NULL OR row_count <= 10000),
  CONSTRAINT report_export_job_rows_non_negative CHECK (row_count IS NULL OR row_count >= 0),
  CONSTRAINT report_export_job_hash_shape
    CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT report_export_job_timezone_bounded CHECK (length(timezone) BETWEEN 1 AND 64),
  CONSTRAINT report_export_job_policy_version_positive CHECK (policy_version >= 1),
  -- A completed job has its file, its count and its hash; nothing else does.
  CONSTRAINT report_export_job_completed_shape
    CHECK ((state = ANY (ARRAY['COMPLETED'::text, 'EXPIRED'::text]))
           = (ready_at IS NOT NULL AND row_count IS NOT NULL AND content_hash IS NOT NULL)),
  -- `GUEST-DEC-007`: the file's hour is a *derived* column. Re-issuing a
  -- download URL cannot extend it, because a grant is a different row on a
  -- different table and this expiry is a function of `ready_at` alone.
  CONSTRAINT report_export_job_ttl_derived
    CHECK ((ready_at IS NULL AND expires_at IS NULL)
           OR expires_at = ready_at + interval '1 hour'),
  -- An expired job has lost its file; the storage key goes with it.
  CONSTRAINT report_export_job_expired_shape
    CHECK ((state = 'EXPIRED'::text) = (expired_at IS NOT NULL)),
  CONSTRAINT report_export_job_storage_shape
    CHECK ((state = 'COMPLETED'::text) = (storage_key IS NOT NULL)),
  CONSTRAINT report_export_job_failed_shape
    CHECK ((state = 'FAILED'::text)
           = (failed_at IS NOT NULL AND failure_reason IS NOT NULL)),
  CONSTRAINT report_export_job_failure_bounded
    CHECK (failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 500),
  -- doc 12 §7: no guest name, no registration number, nothing personal in a
  -- file name. The key is a generated path, and the shape says so.
  CONSTRAINT report_export_job_storage_key_shape
    CHECK (storage_key IS NULL OR storage_key ~ '^exports/[0-9a-f-]{36}/[0-9a-f]{32}\.xlsx$'),
  CONSTRAINT report_export_job_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE INDEX report_export_job_hotel_idx
  ON platform.report_export_job (hotel_id, requested_at DESC);
--> statement-breakpoint
CREATE INDEX report_export_job_due_idx
  ON platform.report_export_job (expires_at) WHERE state = 'COMPLETED'::text;
--> statement-breakpoint
ALTER TABLE platform.report_export_job ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.report_export_job FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.report_export_job
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- `GUEST-DEC-007`: one row per signed URL issued, append-only.
--
-- Separate from the job on purpose. The five minutes and the hour are two
-- different clocks on two different tables, so the code that hands out a URL
-- has nothing it could touch that would lengthen the file's life.
CREATE TABLE platform.report_export_grant (
  grant_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id         uuid NOT NULL,
  job_id           uuid NOT NULL,
  issued_by_account_id uuid NOT NULL,
  issued_at        timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  CONSTRAINT report_export_grant_job_fkey FOREIGN KEY (hotel_id, job_id)
    REFERENCES platform.report_export_job (hotel_id, job_id) ON DELETE RESTRICT,
  CONSTRAINT report_export_grant_issued_by_fkey FOREIGN KEY (issued_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  -- Five minutes exactly, derived the same way the file's hour is.
  CONSTRAINT report_export_grant_ttl_derived
    CHECK (expires_at = issued_at + interval '5 minutes')
);
--> statement-breakpoint
CREATE INDEX report_export_grant_job_idx
  ON platform.report_export_grant (job_id, issued_at DESC);
--> statement-breakpoint
ALTER TABLE platform.report_export_grant ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.report_export_grant FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.report_export_grant
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- Guards: identity is immutable, and history is append-only
-- =====================================================================

CREATE OR REPLACE FUNCTION platform.report_export_job_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.requested_by_account_id IS DISTINCT FROM OLD.requested_by_account_id
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'an export job''s identity and requester are immutable'
      USING ERRCODE = '42501';
  END IF;
  -- doc 12 §8: the filter, the timezone and the policy version are the
  -- snapshot the job ran under. A file whose filter could move afterwards
  -- could not be reconciled with the screen that produced it.
  IF NEW.filters IS DISTINCT FROM OLD.filters
     OR NEW.timezone IS DISTINCT FROM OLD.timezone
     OR NEW.policy_version IS DISTINCT FROM OLD.policy_version THEN
    RAISE EXCEPTION 'an export job''s filter snapshot is immutable' USING ERRCODE = '42501';
  END IF;
  -- `GUEST-DEC-007`: the file's own clock is written once. Nothing re-issues it,
  -- and no download grant can reach it.
  IF OLD.ready_at IS NOT NULL
     AND (NEW.ready_at IS DISTINCT FROM OLD.ready_at
          OR NEW.expires_at IS DISTINCT FROM OLD.expires_at) THEN
    RAISE EXCEPTION 'an export file''s one-hour life is not extended' USING ERRCODE = '22023';
  END IF;
  -- The state machine runs forward. An expired or failed job does not resume,
  -- and a completed one is not re-run under the same id.
  IF OLD.state = ANY (ARRAY['EXPIRED'::text, 'FAILED'::text])
     AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'a terminal export job does not change state' USING ERRCODE = '22023';
  END IF;
  IF OLD.state = 'COMPLETED'::text
     AND NEW.state <> ALL (ARRAY['COMPLETED'::text, 'EXPIRED'::text]) THEN
    RAISE EXCEPTION 'a completed export job only expires' USING ERRCODE = '22023';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER report_export_job_update_guard
  BEFORE UPDATE ON platform.report_export_job
  FOR EACH ROW EXECUTE FUNCTION platform.report_export_job_guard();
--> statement-breakpoint
CREATE TRIGGER report_export_job_no_delete
  BEFORE DELETE ON platform.report_export_job
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- A grant is a record that a URL was handed out. It is never edited away.
CREATE TRIGGER report_export_grant_append_only
  BEFORE UPDATE OR DELETE ON platform.report_export_grant
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- doc 12 §9: a policy version is what earlier rows were written under. Editing
-- one would silently move deadlines that were already snapshotted.
CREATE TRIGGER retention_policy_append_only
  BEFORE UPDATE OR DELETE ON platform.retention_policy
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.stay_retention_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.stay_id IS DISTINCT FROM OLD.stay_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.checkout_at IS DISTINCT FROM OLD.checkout_at
     OR NEW.retention_policy_version IS DISTINCT FROM OLD.retention_policy_version
     OR NEW.retention_days IS DISTINCT FROM OLD.retention_days
     OR NEW.retention_expires_at IS DISTINCT FROM OLD.retention_expires_at THEN
    RAISE EXCEPTION 'a retention snapshot is written once, at checkout'
      USING ERRCODE = '42501';
  END IF;
  -- Anonymisation is one-way: doc 12 §9 removes the identity from product
  -- access, and nothing un-removes it.
  IF OLD.anonymized_at IS NOT NULL AND NEW.anonymized_at IS DISTINCT FROM OLD.anonymized_at THEN
    RAISE EXCEPTION 'an anonymised stay is not re-identified' USING ERRCODE = '22023';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stay_retention_update_guard
  BEFORE UPDATE ON platform.stay_retention
  FOR EACH ROW EXECUTE FUNCTION platform.stay_retention_guard();
--> statement-breakpoint
CREATE TRIGGER stay_retention_no_delete
  BEFORE DELETE ON platform.stay_retention
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.retention_legal_hold_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.hold_id IS DISTINCT FROM OLD.hold_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.stay_id IS DISTINCT FROM OLD.stay_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.authority_reference IS DISTINCT FROM OLD.authority_reference
     OR NEW.imposed_by_account_id IS DISTINCT FROM OLD.imposed_by_account_id
     OR NEW.starts_at IS DISTINCT FROM OLD.starts_at THEN
    RAISE EXCEPTION 'a legal hold''s authority and reason are immutable'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'a released legal hold is not re-imposed' USING ERRCODE = '22023';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER retention_legal_hold_update_guard
  BEFORE UPDATE ON platform.retention_legal_hold
  FOR EACH ROW EXECUTE FUNCTION platform.retention_legal_hold_guard();
--> statement-breakpoint
CREATE TRIGGER retention_legal_hold_no_delete
  BEFORE DELETE ON platform.retention_legal_hold
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.expense_category_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.category_id IS DISTINCT FROM OLD.category_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an expense category''s identity is immutable' USING ERRCODE = '42501';
  END IF;
  -- doc 23 §4.4: the reporting kind is what past expenses were booked under.
  -- Changing it would move money between the two halves of the operating
  -- result retroactively.
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'an expense category''s reporting kind is immutable'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER expense_category_update_guard
  BEFORE UPDATE ON platform.expense_category
  FOR EACH ROW EXECUTE FUNCTION platform.expense_category_guard();
--> statement-breakpoint
-- doc 23 §4.4: a used category is deactivated, never deleted.
CREATE TRIGGER expense_category_no_delete
  BEFORE DELETE ON platform.expense_category
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- The one update a written guest revision allows
-- =====================================================================

-- `GUEST-DEC-008` and doc 12 §9: the retention purge.
--
-- Phase 08's guard made a guest revision append-only, with exactly one
-- permitted update — the flip that retires it when the next revision is
-- written. That was right for a *correction*, and it is wrong for a *deletion*:
-- writing a cleared new revision would leave the identity in the old one, which
-- is the thing the purge exists to remove.
--
-- So the guard gains a second permitted shape, and it is narrow: the names
-- become the constant, the date of birth becomes the sentinel, every
-- identifier, lookup token, document and guardian field becomes NULL, and
-- nothing else about the row may move. An update that changed anything else,
-- or that cleared only some of them, is refused exactly as before.
CREATE OR REPLACE FUNCTION platform.stay_guest_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  anonymising boolean;
BEGIN
  -- The identity fields, cleared to their sentinel values.
  anonymising :=
    NEW.family_name = 'Устгасан'::text
    AND NEW.given_name = 'Устгасан'::text
    AND NEW.date_of_birth = '1900-01-01'::date
    AND NEW.age_at_check_in IS NULL
    AND NEW.identifier_ciphertext IS NULL
    AND NEW.identifier_wrapped_dek IS NULL
    AND NEW.identifier_key_version IS NULL
    AND NEW.lookup_token IS NULL
    AND NEW.lookup_key_version IS NULL
    AND NEW.lookup_namespace IS NULL
    AND NEW.document_country IS NULL
    AND NEW.document_expires_on IS NULL
    AND NEW.document_type IS NULL
    AND NEW.document_authority IS NULL
    AND NEW.guardian_name IS NULL
    AND NEW.guardian_phone IS NULL
    AND NEW.guardian_relationship IS NULL
    -- After the purge there is no document, so the identity shape moves with
    -- the data it described: doc 05 §3's constraints tie an identity type to
    -- the ciphertext that proves it, and a row with no registration number is
    -- not Police-matchable.
    AND NEW.identity_type = 'NO_DOCUMENT'::text
    AND NEW.assurance = 'LOW_ASSURANCE'::text
    AND NEW.provenance = 'MANUAL'::text
    AND NEW.no_document_reason = 'RETENTION_ANONYMISED'::text
    AND NEW.police_match_eligibility = 'NOT_ELIGIBLE_EXACT_RD'::text;

  -- And everything else about the row, unchanged. Enumerated rather than
  -- compared as a whole, so a column added later is not silently exempted from
  -- the check: a new field has to be listed here or in the block above.
  anonymising := anonymising
    AND NEW.guest_record_id IS NOT DISTINCT FROM OLD.guest_record_id
    AND NEW.hotel_id IS NOT DISTINCT FROM OLD.hotel_id
    AND NEW.stay_id IS NOT DISTINCT FROM OLD.stay_id
    AND NEW.revision_no IS NOT DISTINCT FROM OLD.revision_no
    AND NEW.is_current IS NOT DISTINCT FROM OLD.is_current
    AND NEW.nationality IS NOT DISTINCT FROM OLD.nationality
    AND NEW.no_document_note IS NOT DISTINCT FROM OLD.no_document_note
    AND NEW.correction_reason IS NOT DISTINCT FROM OLD.correction_reason
    AND NEW.recorded_by_account_id IS NOT DISTINCT FROM OLD.recorded_by_account_id
    AND NEW.recorded_at IS NOT DISTINCT FROM OLD.recorded_at;

  IF anonymising THEN
    RETURN NEW;
  END IF;

  IF NOT (OLD.is_current IS TRUE AND NEW.is_current IS FALSE) THEN
    RAISE EXCEPTION 'a guest identity revision is append-only; correct it with a new revision'
      USING ERRCODE = '42501';
  END IF;
  IF to_jsonb(NEW) - 'is_current' IS DISTINCT FROM to_jsonb(OLD) - 'is_current' THEN
    RAISE EXCEPTION 'a guest identity revision is append-only; correct it with a new revision'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- =====================================================================
-- Grants
-- =====================================================================

-- The API owns the whole surface. The worker owns the two sweeps: expiring a
-- file whose hour has passed, and anonymising a stay whose retention has run
-- out — so it updates those two tables and creates nothing.
GRANT SELECT, INSERT, UPDATE ON platform.expense_category      TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.retention_policy      TO prsystem_api;
--> statement-breakpoint
GRANT SELECT                 ON platform.retention_policy      TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.stay_retention        TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, UPDATE         ON platform.stay_retention        TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.retention_legal_hold  TO prsystem_api;
--> statement-breakpoint
GRANT SELECT                 ON platform.retention_legal_hold  TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.report_export_job     TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, UPDATE         ON platform.report_export_job     TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.report_export_grant   TO prsystem_api;
--> statement-breakpoint

-- The worker anonymises guest identity, which is the stay module's table. It
-- reads nothing else of the guest's and writes only the columns the purge
-- clears.
GRANT SELECT, UPDATE ON platform.stay_guest TO prsystem_worker;
--> statement-breakpoint

-- =====================================================================
-- The two sweeps
-- =====================================================================

-- Both have the shape every sweep since Phase 13 has: find the work across
-- every hotel, answer identifiers only, and decide nothing. Each row is then
-- settled in its own hotel's scope on its own lock.
GRANT CREATE ON SCHEMA platform TO prsystem_maintenance_fn;
--> statement-breakpoint

-- `GUEST-DEC-007`: completed exports whose hour has passed.
CREATE OR REPLACE FUNCTION platform.lapsed_export_files(
  p_limit integer,
  p_now   timestamptz DEFAULT NULL
) RETURNS TABLE (job_id uuid, hotel_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT j.job_id, j.hotel_id
    FROM platform.report_export_job j
   WHERE j.state = 'COMPLETED'::text
     AND j.expires_at <= COALESCE(p_now, pg_catalog.now())
   ORDER BY j.expires_at
   LIMIT least(greatest(p_limit, 1), 500)
$$;
--> statement-breakpoint
ALTER FUNCTION platform.lapsed_export_files(integer, timestamptz)
  OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint

-- `GUEST-DEC-008`: stays past their snapshotted retention with no live hold.
--
-- The hold test is in the resolver rather than in the job, so a stay under a
-- legal hold is not merely skipped by the code — it is never offered to it.
CREATE OR REPLACE FUNCTION platform.due_retention_purges(
  p_limit integer,
  p_now   timestamptz DEFAULT NULL
) RETURNS TABLE (stay_id uuid, hotel_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.stay_id, r.hotel_id
    FROM platform.stay_retention r
   WHERE r.anonymized_at IS NULL
     AND r.retention_expires_at <= COALESCE(p_now, pg_catalog.now())
     AND NOT EXISTS (
       SELECT 1 FROM platform.retention_legal_hold h
        WHERE h.hotel_id = r.hotel_id
          AND (h.stay_id = r.stay_id OR h.stay_id IS NULL)
          AND h.released_at IS NULL
          AND h.starts_at <= COALESCE(p_now, pg_catalog.now())
          AND (h.ends_at IS NULL OR h.ends_at > COALESCE(p_now, pg_catalog.now()))
     )
   ORDER BY r.retention_expires_at
   LIMIT least(greatest(p_limit, 1), 500)
$$;
--> statement-breakpoint
ALTER FUNCTION platform.due_retention_purges(integer, timestamptz)
  OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint

-- The jobs a worker has yet to run. A queued job lives behind a tenant policy
-- and the worker is in no tenant, so it is found the same narrow way.
CREATE OR REPLACE FUNCTION platform.queued_export_jobs(p_limit integer)
  RETURNS TABLE (job_id uuid, hotel_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT j.job_id, j.hotel_id
    FROM platform.report_export_job j
   WHERE j.state = 'QUEUED'::text
   ORDER BY j.requested_at
   LIMIT least(greatest(p_limit, 1), 100)
$$;
--> statement-breakpoint
ALTER FUNCTION platform.queued_export_jobs(integer) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint

REVOKE ALL ON FUNCTION
  platform.lapsed_export_files(integer, timestamptz),
  platform.due_retention_purges(integer, timestamptz),
  platform.queued_export_jobs(integer)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.lapsed_export_files(integer, timestamptz)
  TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.due_retention_purges(integer, timestamptz)
  TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.queued_export_jobs(integer) TO prsystem_api, prsystem_worker;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA platform FROM prsystem_maintenance_fn;
--> statement-breakpoint
GRANT SELECT ON platform.report_export_job, platform.stay_retention,
                platform.retention_legal_hold
  TO prsystem_maintenance_fn;
--> statement-breakpoint

-- RLS applies to the definer's owner too, so each sweep gets exactly the narrow
-- read it needs: a completed export, an unanonymised retention row, and the
-- holds that might suspend it.
CREATE POLICY export_sweep_read ON platform.report_export_job
  FOR SELECT TO prsystem_maintenance_fn
  USING (state = ANY (ARRAY['QUEUED'::text, 'COMPLETED'::text]));
--> statement-breakpoint
CREATE POLICY retention_sweep_read ON platform.stay_retention
  FOR SELECT TO prsystem_maintenance_fn
  USING (anonymized_at IS NULL);
--> statement-breakpoint
CREATE POLICY retention_hold_read ON platform.retention_legal_hold
  FOR SELECT TO prsystem_maintenance_fn
  USING (released_at IS NULL);
--> statement-breakpoint
