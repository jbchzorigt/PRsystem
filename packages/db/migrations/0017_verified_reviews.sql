-- =====================================================================
-- 0017 — Verified-stay reviews, reports, moderation and the official reply
--
-- A review is the one piece of user-generated content this platform publishes,
-- and doc 10 is unusually specific about who may write it, who may hide it, and
-- what may never be done to it. Five rules shape the tables below.
--
-- **A review is earned, not offered** (`RV-DEC-002`, `BK-DEC-005`). The right to
-- write one comes from a `COMPLETED` online booking the account itself made.
-- `booking_id` is UNIQUE, so "one review per completed booking" is a constraint
-- rather than a check the application performs and then trusts — and because a
-- soft-deleted review keeps its row, the same booking can never yield a second.
--
-- **Nothing here is ever deleted.** The owner's delete is `status = 'DELETED'`;
-- the moderator's hide is `status = 'HIDDEN'`. Both keep the content, the owner,
-- the booking link and the audit; every table is `BEFORE DELETE` rejected. doc
-- 10 §7.3 says a moderator may not hard-delete and may not edit the owner's
-- words, and neither is representable here.
--
-- **The aggregate is arithmetic the database owns** (doc 10 §6). Published
-- count, rating sum and the average in integer hundredths are one row with a
-- CHECK binding the three: the average cannot drift from the sum, and a client
-- never computes it. Hide, restore and soft-delete each recompute it inside the
-- transaction that moved the review.
--
-- **The 30-day window is snapshotted, not re-derived** (`RV-DEC-003`,
-- `RV-DEC-004`). `review_deadline_at` is written once from the stay's actual
-- checkout time; the create and the edit are both judged against the row rather
-- than against a checkout time that a later correction might move.
--
-- **Reporting is a Guest action and moderation is a Platform one**
-- (`RV-DEC-005`). They are different tables, different realms and different
-- permissions: no hotel, Operation or Police *role name* opens either, and the
-- only thing that opens moderation is the explicitly granted `REVIEW_MODERATE`.
-- =====================================================================

-- =====================================================================
-- The review
-- =====================================================================

-- doc 10 §5. The `hotel_id` is the tenant column every policy uses; the
-- `account_id` is what makes the row the owner's; the `booking_id` is what makes
-- it earned, and what makes it unrepeatable.
CREATE TABLE platform.hotel_review (
  review_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id              uuid NOT NULL,
  booking_id            uuid NOT NULL,
  account_id            uuid NOT NULL,
  rating                integer NOT NULL,
  comment               text NOT NULL,
  -- doc 10 §5 and §8: what the public sees instead of a name. Masked when the
  -- review is written, so a later profile edit cannot retroactively expose a
  -- reviewer, and never the account's phone, email or registration number.
  display_name_snapshot text NOT NULL,
  status                text NOT NULL DEFAULT 'PUBLISHED',
  -- `RV-DEC-003`: 30 days from the booking's *actual* checkout, snapshotted at
  -- creation. The edit window closes with it; the owner's delete does not.
  review_deadline_at    timestamptz NOT NULL,
  -- doc 10 §7.1: the `Засварласан` badge is a fact about the row, not a guess
  -- from comparing two timestamps.
  edited                boolean NOT NULL DEFAULT false,
  hidden_at             timestamptz,
  hidden_by_account_id  uuid,
  deleted_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  revision              integer NOT NULL DEFAULT 0,
  CONSTRAINT hotel_review_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_review_booking_fkey FOREIGN KEY (hotel_id, booking_id)
    REFERENCES platform.booking (hotel_id, booking_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_review_account_fkey FOREIGN KEY (account_id)
    REFERENCES platform.guest_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_review_hidden_by_fkey FOREIGN KEY (hidden_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_review_identity_uq UNIQUE (hotel_id, review_id),
  -- `RV-DEC-002`: one review per completed booking, forever. The uniqueness is
  -- on the booking alone rather than on `(booking, status)`, so a soft-deleted
  -- review still occupies its booking and doc 10 §7.1's "no new review for this
  -- booking" needs no second rule.
  CONSTRAINT hotel_review_booking_uq UNIQUE (booking_id),
  -- `RV-DEC-003`: whole stars, one to five. No fractions, at any layer.
  CONSTRAINT hotel_review_rating_range CHECK (rating BETWEEN 1 AND 5),
  -- doc 10 §5: 10–1000 characters *after* trimming. The application trims; this
  -- refuses anything that was not trimmed, so an untrimmed string cannot pass.
  CONSTRAINT hotel_review_comment_trimmed CHECK (comment = btrim(comment)),
  CONSTRAINT hotel_review_comment_bounded CHECK (length(comment) BETWEEN 10 AND 1000),
  CONSTRAINT hotel_review_display_name_bounded
    CHECK (length(display_name_snapshot) BETWEEN 1 AND 120),
  CONSTRAINT hotel_review_status_known
    CHECK (status = ANY (ARRAY['PUBLISHED'::text, 'HIDDEN'::text, 'DELETED'::text])),
  -- The two terminal marks belong to the two different actors and are recorded
  -- separately: a hidden review is the moderator's, a deleted one is the
  -- owner's, and a row can carry the history of both without either being
  -- inferred from the status.
  CONSTRAINT hotel_review_hidden_shape
    CHECK ((hidden_at IS NULL) = (hidden_by_account_id IS NULL)),
  CONSTRAINT hotel_review_hidden_when_hidden
    CHECK (status <> 'HIDDEN'::text OR hidden_at IS NOT NULL),
  CONSTRAINT hotel_review_deleted_when_deleted
    CHECK ((status = 'DELETED'::text) = (deleted_at IS NOT NULL)),
  CONSTRAINT hotel_review_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE INDEX hotel_review_hotel_idx ON platform.hotel_review (hotel_id, status, created_at DESC);
--> statement-breakpoint
CREATE INDEX hotel_review_account_idx ON platform.hotel_review (account_id, created_at DESC);
--> statement-breakpoint
ALTER TABLE platform.hotel_review ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.hotel_review FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.hotel_review
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
-- The shape Phase 13 established for `own_booking_read`: in the platform scope,
-- and only there, an account sees the rows that are its own. A review belongs
-- to no hotel tenant from the writer's point of view — they reach it from their
-- own account — so this is the policy every owner command runs under.
CREATE POLICY own_review_read ON platform.hotel_review
  FOR SELECT USING (
    platform.current_hotel_id() = '00000000-0000-0000-0000-000000000000'::uuid
    AND account_id = platform.current_account_id()
  );
--> statement-breakpoint

-- doc 10 §7.1: the previous rating and comment, kept. An edit is a new row here
-- and an update there, so what the reviewer first wrote survives the edit.
CREATE TABLE platform.hotel_review_edit (
  edit_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id       uuid NOT NULL,
  review_id      uuid NOT NULL,
  account_id     uuid NOT NULL,
  from_rating    integer NOT NULL,
  from_comment   text NOT NULL,
  to_rating      integer NOT NULL,
  to_comment     text NOT NULL,
  edited_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hotel_review_edit_review_fkey FOREIGN KEY (hotel_id, review_id)
    REFERENCES platform.hotel_review (hotel_id, review_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_review_edit_rating_range
    CHECK (from_rating BETWEEN 1 AND 5 AND to_rating BETWEEN 1 AND 5),
  CONSTRAINT hotel_review_edit_comment_bounded
    CHECK (length(from_comment) BETWEEN 10 AND 1000
           AND length(to_comment) BETWEEN 10 AND 1000)
);
--> statement-breakpoint
CREATE INDEX hotel_review_edit_review_idx ON platform.hotel_review_edit (review_id, edited_at);
--> statement-breakpoint
ALTER TABLE platform.hotel_review_edit ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.hotel_review_edit FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.hotel_review_edit
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY own_review_edit_read ON platform.hotel_review_edit
  FOR SELECT USING (
    platform.current_hotel_id() = '00000000-0000-0000-0000-000000000000'::uuid
    AND account_id = platform.current_account_id()
  );
--> statement-breakpoint

-- =====================================================================
-- The published aggregate
-- =====================================================================

-- doc 10 §6. One row per hotel, holding the count, the sum and the average in
-- integer hundredths — never a float, and never something a client computes.
--
-- The CHECK is the point: the average is a function of the other two columns
-- and cannot be written to disagree with them. `(sum × 200 + count) /
-- (count × 2)` on non-negative integers is exactly half-up rounding of
-- `sum × 100 / count`, the same shape Phase 14's commission uses.
CREATE TABLE platform.hotel_review_aggregate (
  hotel_id             uuid PRIMARY KEY,
  published_count      integer NOT NULL DEFAULT 0,
  rating_sum           bigint NOT NULL DEFAULT 0,
  average_rating_centi integer NOT NULL DEFAULT 0,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  revision             integer NOT NULL DEFAULT 0,
  CONSTRAINT hotel_review_aggregate_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_review_aggregate_counts_non_negative
    CHECK (published_count >= 0 AND rating_sum >= 0),
  -- A count and a sum that could not have come from ratings of 1 to 5.
  CONSTRAINT hotel_review_aggregate_sum_in_range
    CHECK (rating_sum >= published_count AND rating_sum <= published_count * 5),
  -- No CASE and no branch: the sum constraint above already forces a zero sum
  -- when the count is zero, so `greatest(count, 1)` divides by one and yields
  -- the same zero the empty hotel should report.
  CONSTRAINT hotel_review_aggregate_average_derived
    CHECK (average_rating_centi
           = ((rating_sum * 200 + published_count) / (greatest(published_count, 1) * 2))::integer),
  CONSTRAINT hotel_review_aggregate_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
ALTER TABLE platform.hotel_review_aggregate ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.hotel_review_aggregate FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.hotel_review_aggregate
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- The Guest's report
-- =====================================================================

-- doc 10 §7.2 and `RV-DEC-005`. Any authenticated Guest account may report a
-- published review: no completed stay, no hotel membership, no role, no package.
-- A report is a *request for attention* — it hides nothing and changes no
-- aggregate — and one account may hold at most one open report per review.
CREATE TABLE platform.review_report (
  report_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id             uuid NOT NULL,
  review_id            uuid NOT NULL,
  account_id           uuid NOT NULL,
  reason               text NOT NULL,
  note                 text,
  state                text NOT NULL DEFAULT 'OPEN',
  resolved_at          timestamptz,
  resolved_by_account_id uuid,
  resolution           text,
  resolution_note      text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  revision             integer NOT NULL DEFAULT 0,
  CONSTRAINT review_report_review_fkey FOREIGN KEY (hotel_id, review_id)
    REFERENCES platform.hotel_review (hotel_id, review_id) ON DELETE RESTRICT,
  CONSTRAINT review_report_account_fkey FOREIGN KEY (account_id)
    REFERENCES platform.guest_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT review_report_resolved_by_fkey FOREIGN KEY (resolved_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT review_report_identity_uq UNIQUE (hotel_id, report_id),
  -- doc 10 §7.2: the four approved reasons, and no others.
  CONSTRAINT review_report_reason_known
    CHECK (reason = ANY (ARRAY['PERSONAL_DATA'::text, 'ABUSE_ILLEGAL'::text,
                               'SPAM_FRAUD'::text, 'OTHER'::text])),
  -- `OTHER` explains itself in 10–500 trimmed characters; the other three carry
  -- no note at all, so a reason cannot be smuggled into free text.
  CONSTRAINT review_report_note_shape
    CHECK ((reason = 'OTHER'::text) = (note IS NOT NULL)),
  CONSTRAINT review_report_note_bounded
    CHECK (note IS NULL OR (note = btrim(note) AND length(note) BETWEEN 10 AND 500)),
  CONSTRAINT review_report_state_known
    CHECK (state = ANY (ARRAY['OPEN'::text, 'RESOLVED'::text])),
  CONSTRAINT review_report_resolution_known
    CHECK (resolution IS NULL
           OR resolution = ANY (ARRAY['UPHELD'::text, 'DISMISSED'::text])),
  CONSTRAINT review_report_resolved_shape
    CHECK ((state = 'RESOLVED'::text)
           = (resolved_at IS NOT NULL AND resolved_by_account_id IS NOT NULL
              AND resolution IS NOT NULL AND resolution_note IS NOT NULL)),
  CONSTRAINT review_report_resolution_note_bounded
    CHECK (resolution_note IS NULL
           OR (resolution_note = btrim(resolution_note)
               AND length(resolution_note) BETWEEN 10 AND 500)),
  CONSTRAINT review_report_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
-- doc 10 §7.2: at most one open report per account and review. A resolved one
-- does not block a fresh report about a review that has changed since.
CREATE UNIQUE INDEX review_report_one_open_uq
  ON platform.review_report (account_id, review_id) WHERE state = 'OPEN'::text;
--> statement-breakpoint
CREATE INDEX review_report_queue_idx ON platform.review_report (state, created_at);
--> statement-breakpoint
ALTER TABLE platform.review_report ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.review_report FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.review_report
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
-- A reporter sees their own report and nobody else's — including no hint of
-- another account's report on the same review.
CREATE POLICY own_report_read ON platform.review_report
  FOR SELECT USING (
    platform.current_hotel_id() = '00000000-0000-0000-0000-000000000000'::uuid
    AND account_id = platform.current_account_id()
  );
--> statement-breakpoint

-- =====================================================================
-- Moderation history
-- =====================================================================

-- doc 10 §7.3: append-only, with the actor, the permission it was exercised
-- under, the mandatory reason and note, the previous and new state, and the
-- server's time. Hide, restore and report resolution all land here.
CREATE TABLE platform.review_moderation_event (
  event_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id           uuid NOT NULL,
  review_id          uuid NOT NULL,
  report_id          uuid,
  action             text NOT NULL,
  actor_account_id   uuid NOT NULL,
  -- Recorded rather than assumed: the moderator's authority is an explicitly
  -- granted permission, and the record says which one it was.
  permission         text NOT NULL,
  reason             text NOT NULL,
  note               text NOT NULL,
  from_status        text,
  to_status          text,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_moderation_event_review_fkey FOREIGN KEY (hotel_id, review_id)
    REFERENCES platform.hotel_review (hotel_id, review_id) ON DELETE RESTRICT,
  CONSTRAINT review_moderation_event_report_fkey FOREIGN KEY (hotel_id, report_id)
    REFERENCES platform.review_report (hotel_id, report_id) ON DELETE RESTRICT,
  CONSTRAINT review_moderation_event_actor_fkey FOREIGN KEY (actor_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT review_moderation_event_action_known
    CHECK (action = ANY (ARRAY['HIDE'::text, 'RESTORE'::text, 'REPORT_RESOLVE'::text])),
  CONSTRAINT review_moderation_event_permission_known
    CHECK (permission = 'REVIEW_MODERATE'::text),
  -- doc 10 §7.3: a hide states an approved report reason and a note. Neither is
  -- optional, and a negative rating is not a reason.
  CONSTRAINT review_moderation_event_reason_known
    CHECK (reason = ANY (ARRAY['PERSONAL_DATA'::text, 'ABUSE_ILLEGAL'::text,
                               'SPAM_FRAUD'::text, 'OTHER'::text,
                               'RESTORED'::text, 'DISMISSED'::text, 'UPHELD'::text])),
  CONSTRAINT review_moderation_event_note_bounded
    CHECK (note = btrim(note) AND length(note) BETWEEN 10 AND 500),
  CONSTRAINT review_moderation_event_status_known
    CHECK ((from_status IS NULL
            OR from_status = ANY (ARRAY['PUBLISHED'::text, 'HIDDEN'::text, 'DELETED'::text]))
           AND (to_status IS NULL
                OR to_status = ANY (ARRAY['PUBLISHED'::text, 'HIDDEN'::text, 'DELETED'::text])))
);
--> statement-breakpoint
CREATE INDEX review_moderation_event_review_idx
  ON platform.review_moderation_event (review_id, occurred_at);
--> statement-breakpoint
ALTER TABLE platform.review_moderation_event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.review_moderation_event FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.review_moderation_event
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- The one official hotel reply
-- =====================================================================

-- doc 10 §7.4 and `RV-DEC-007`. One reply record per review — `review_id` is
-- UNIQUE, so a soft-deleted reply is *restored* rather than replaced, and a
-- second record cannot exist however the row is written.
CREATE TABLE platform.hotel_review_reply (
  reply_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id             uuid NOT NULL,
  review_id            uuid NOT NULL,
  body                 text NOT NULL,
  state                text NOT NULL DEFAULT 'ACTIVE',
  edited               boolean NOT NULL DEFAULT false,
  created_by_account_id uuid NOT NULL,
  updated_by_account_id uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  revision             integer NOT NULL DEFAULT 0,
  CONSTRAINT hotel_review_reply_review_fkey FOREIGN KEY (hotel_id, review_id)
    REFERENCES platform.hotel_review (hotel_id, review_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_review_reply_created_by_fkey FOREIGN KEY (created_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_review_reply_updated_by_fkey FOREIGN KEY (updated_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_review_reply_identity_uq UNIQUE (hotel_id, reply_id),
  -- `RV-DEC-007`: one reply record per review, at the database.
  CONSTRAINT hotel_review_reply_review_uq UNIQUE (review_id),
  CONSTRAINT hotel_review_reply_body_trimmed CHECK (body = btrim(body)),
  CONSTRAINT hotel_review_reply_body_bounded CHECK (length(body) BETWEEN 10 AND 1000),
  CONSTRAINT hotel_review_reply_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'DELETED'::text])),
  CONSTRAINT hotel_review_reply_deleted_shape
    CHECK ((state = 'DELETED'::text) = (deleted_at IS NOT NULL)),
  CONSTRAINT hotel_review_reply_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
ALTER TABLE platform.hotel_review_reply ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.hotel_review_reply FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.hotel_review_reply
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- doc 10 §7.4: the reply's own lifecycle history, append-only.
CREATE TABLE platform.hotel_review_reply_event (
  event_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id         uuid NOT NULL,
  reply_id         uuid NOT NULL,
  review_id        uuid NOT NULL,
  action           text NOT NULL,
  actor_account_id uuid NOT NULL,
  from_body        text,
  to_body          text,
  from_state       text,
  to_state         text,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hotel_review_reply_event_reply_fkey FOREIGN KEY (hotel_id, reply_id)
    REFERENCES platform.hotel_review_reply (hotel_id, reply_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_review_reply_event_actor_fkey FOREIGN KEY (actor_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_review_reply_event_action_known
    CHECK (action = ANY (ARRAY['CREATE'::text, 'EDIT'::text, 'DELETE'::text, 'RESTORE'::text]))
);
--> statement-breakpoint
CREATE INDEX hotel_review_reply_event_reply_idx
  ON platform.hotel_review_reply_event (reply_id, occurred_at);
--> statement-breakpoint
ALTER TABLE platform.hotel_review_reply_event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.hotel_review_reply_event FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.hotel_review_reply_event
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- Nothing is deleted, and identity is immutable
-- =====================================================================

-- doc 10 §7.1 and §7.3: the owner's delete and the moderator's hide are both
-- *status transitions*. A hard delete is refused on every table of this phase,
-- so "soft-delete" is a property of the schema rather than a discipline.
CREATE OR REPLACE FUNCTION platform.hotel_review_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.review_id IS DISTINCT FROM OLD.review_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.review_deadline_at IS DISTINCT FROM OLD.review_deadline_at THEN
    RAISE EXCEPTION 'a review''s identity, its booking and its deadline are immutable'
      USING ERRCODE = '42501';
  END IF;
  -- doc 10 §7.1: a deleted review is the owner's last word on it. Nothing
  -- brings it back — not an edit, and not a moderator's restore (doc 10 §7.3).
  IF OLD.status = 'DELETED'::text AND NEW.status <> 'DELETED'::text THEN
    RAISE EXCEPTION 'a review the owner deleted is not restored' USING ERRCODE = '22023';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER hotel_review_update_guard
  BEFORE UPDATE ON platform.hotel_review
  FOR EACH ROW EXECUTE FUNCTION platform.hotel_review_guard();
--> statement-breakpoint
CREATE TRIGGER hotel_review_no_delete
  BEFORE DELETE ON platform.hotel_review
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- The three histories are append-only: no update, no delete.
CREATE TRIGGER hotel_review_edit_append_only
  BEFORE UPDATE OR DELETE ON platform.hotel_review_edit
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER review_moderation_event_append_only
  BEFORE UPDATE OR DELETE ON platform.review_moderation_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER hotel_review_reply_event_append_only
  BEFORE UPDATE OR DELETE ON platform.hotel_review_reply_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.review_report_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.report_id IS DISTINCT FROM OLD.report_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.review_id IS DISTINCT FROM OLD.review_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a report''s identity and its stated reason are immutable'
      USING ERRCODE = '42501';
  END IF;
  -- A resolution stands. Re-resolving would let a second moderator quietly
  -- overwrite the first's decision and its recorded note.
  IF OLD.state = 'RESOLVED'::text THEN
    RAISE EXCEPTION 'a resolved report is not resolved again' USING ERRCODE = '22023';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER review_report_update_guard
  BEFORE UPDATE ON platform.review_report
  FOR EACH ROW EXECUTE FUNCTION platform.review_report_guard();
--> statement-breakpoint
CREATE TRIGGER review_report_no_delete
  BEFORE DELETE ON platform.review_report
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.hotel_review_reply_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.reply_id IS DISTINCT FROM OLD.reply_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.review_id IS DISTINCT FROM OLD.review_id
     OR NEW.created_by_account_id IS DISTINCT FROM OLD.created_by_account_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a reply''s identity and its review are immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER hotel_review_reply_update_guard
  BEFORE UPDATE ON platform.hotel_review_reply
  FOR EACH ROW EXECUTE FUNCTION platform.hotel_review_reply_guard();
--> statement-breakpoint
CREATE TRIGGER hotel_review_reply_no_delete
  BEFORE DELETE ON platform.hotel_review_reply
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.hotel_review_aggregate_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.hotel_id IS DISTINCT FROM OLD.hotel_id THEN
    RAISE EXCEPTION 'an aggregate belongs to one hotel' USING ERRCODE = '42501';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER hotel_review_aggregate_update_guard
  BEFORE UPDATE ON platform.hotel_review_aggregate
  FOR EACH ROW EXECUTE FUNCTION platform.hotel_review_aggregate_guard();
--> statement-breakpoint
CREATE TRIGGER hotel_review_aggregate_no_delete
  BEFORE DELETE ON platform.hotel_review_aggregate
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- Grants
-- =====================================================================

-- The API holds the whole lifecycle. The worker holds nothing at all: this
-- phase has no job, no sweep and no scheduled recomputation — the aggregate
-- moves inside the transaction that moved the review, and never afterwards.
GRANT SELECT, INSERT, UPDATE ON platform.hotel_review            TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.hotel_review_edit       TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.hotel_review_aggregate  TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.review_report           TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.review_moderation_event TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.hotel_review_reply      TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.hotel_review_reply_event TO prsystem_api;
--> statement-breakpoint

-- =====================================================================
-- The public projection
-- =====================================================================

-- doc 10 §6: an unauthenticated visitor sees the average, the count and the
-- published reviews. They carry no tenant, so this is the same narrow shape
-- Phase 12 used for the listing: functions owned by the login-less resolver
-- role, reading through policies written for exactly that role and no wider.
GRANT CREATE ON SCHEMA platform TO prsystem_maintenance_fn;
--> statement-breakpoint

-- The published reviews of one published hotel, newest first.
--
-- What it does *not* return is the point: no `account_id`, no `booking_id`, no
-- room number and no contact detail (doc 10 §8). The masked name and the review
-- are all a stranger gets, plus the hotel's own reply when there is a live one.
CREATE OR REPLACE FUNCTION platform.public_hotel_reviews(
  p_hotel_id uuid,
  p_limit    integer DEFAULT 20,
  p_offset   integer DEFAULT 0
) RETURNS TABLE (
  review_id             uuid,
  rating                integer,
  comment               text,
  display_name_snapshot text,
  edited                boolean,
  created_at            timestamptz,
  updated_at            timestamptz,
  reply_body            text,
  reply_edited          boolean,
  reply_updated_at      timestamptz
)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.review_id,
         r.rating,
         r.comment,
         r.display_name_snapshot,
         r.edited,
         r.created_at,
         r.updated_at,
         y.body,
         y.edited,
         y.updated_at
    FROM platform.hotel_review r
    JOIN platform.hotel_profile p ON p.hotel_id = r.hotel_id
    -- doc 10 §7.4: a reply is shown only while it is live *and* its review is.
    -- The join is LEFT because most reviews have none, and filtered because a
    -- soft-deleted reply is invisible without ceasing to exist.
    LEFT JOIN platform.hotel_review_reply y
      ON y.review_id = r.review_id AND y.state = 'ACTIVE'::text
   WHERE r.hotel_id = p_hotel_id
     AND r.status = 'PUBLISHED'::text
     AND p.listing_state = 'PUBLISHED'::text
   ORDER BY r.created_at DESC, r.review_id
   LIMIT least(greatest(p_limit, 1), 100) OFFSET greatest(p_offset, 0)
$$;
--> statement-breakpoint
ALTER FUNCTION platform.public_hotel_reviews(uuid, integer, integer)
  OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint

-- `BK-DEC-004` and doc 10 §6: the listing carries the rating and the count.
--
-- Replaced rather than wrapped, because doc 09 §3.2's listing is one row per
-- hotel and a second function would have made two sources of it. A hotel with
-- no published review has no aggregate row and reports `0` and `0` — not a
-- null the caller has to interpret, and not an invented average.
--
-- Dropped first: PostgreSQL will not widen an existing function's `RETURNS
-- TABLE`, and the drop is safe because nothing depends on the function itself —
-- the API calls it by name and is deployed with this migration.
DROP FUNCTION platform.public_hotel_listings();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION platform.public_hotel_listings()
  RETURNS TABLE (
    hotel_id             uuid,
    public_name          text,
    district             text,
    khoroo               text,
    address_line         text,
    public_phone         text,
    latitude_micro       integer,
    longitude_micro      integer,
    cover_object_key     text,
    from_rate_mnt        bigint,
    review_count         integer,
    average_rating_centi integer
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.hotel_id,
         p.public_name,
         p.district,
         p.khoroo,
         p.address_line,
         p.public_phone,
         p.latitude_micro,
         p.longitude_micro,
         (SELECT ph.object_key
            FROM platform.hotel_photo ph
           WHERE ph.hotel_id = p.hotel_id AND ph.is_cover AND ph.state = 'ACTIVE'
           LIMIT 1),
         (SELECT pg_catalog.min(c.nightly_rate_mnt)
            FROM platform.room_category c
           WHERE c.hotel_id = p.hotel_id
             AND c.state = 'ACTIVE'
             AND c.nightly_rate_mnt IS NOT NULL
             AND c.nightly_rate_mnt > 0),
         COALESCE(a.published_count, 0),
         COALESCE(a.average_rating_centi, 0)
    FROM platform.hotel_profile p
    JOIN platform.hotel h ON h.hotel_id = p.hotel_id
    LEFT JOIN platform.hotel_review_aggregate a ON a.hotel_id = p.hotel_id
   WHERE p.listing_state = 'PUBLISHED'::text
     AND h.state = 'ACTIVE'::text
     AND EXISTS (
       SELECT 1 FROM platform.hotel_subscription s
        WHERE s.hotel_id = p.hotel_id
          AND s.suspended_at IS NULL
          AND s.starts_at <= pg_catalog.now()
          AND s.expires_at > pg_catalog.now()
     )
$$;
--> statement-breakpoint

ALTER FUNCTION platform.public_hotel_listings() OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.public_hotel_listings() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.public_hotel_listings() TO prsystem_api;
--> statement-breakpoint
-- A reporter and a moderator both name a review and no tenant.
--
-- The reporter saw it on a public page and has no relationship with the hotel
-- at all; the moderator is a Platform account with no membership anywhere. So
-- the hotel each of them acts in is resolved here, narrowly, and the command
-- then runs inside that hotel's own scope like every other command does.
CREATE OR REPLACE FUNCTION platform.hotel_of_published_review(p_review_id uuid)
  RETURNS TABLE (hotel_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.hotel_id
    FROM platform.hotel_review r
   WHERE r.review_id = p_review_id
     AND r.status = 'PUBLISHED'::text
$$;
--> statement-breakpoint
ALTER FUNCTION platform.hotel_of_published_review(uuid) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint

-- The moderator's version, which also answers for a *hidden* review.
--
-- Separate from the reporter's on purpose: a Guest may report only what is
-- published, while `RV-DEC-006`'s restore addresses exactly the reviews that
-- are not. Neither answers for a review the owner deleted, so the one thing a
-- moderator may never reach is the one thing neither resolver returns.
CREATE OR REPLACE FUNCTION platform.hotel_of_moderatable_review(p_review_id uuid)
  RETURNS TABLE (hotel_id uuid, status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.hotel_id, r.status
    FROM platform.hotel_review r
   WHERE r.review_id = p_review_id
     AND r.status = ANY (ARRAY['PUBLISHED'::text, 'HIDDEN'::text])
$$;
--> statement-breakpoint
ALTER FUNCTION platform.hotel_of_moderatable_review(uuid) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint

-- doc 10 §7.3: the moderation queue. Open reports across every hotel, answering
-- identifiers only — the review's text, its author and the reporter's note are
-- read afterwards inside the hotel's own scope, under the moderator's own
-- permission, and never from here.
CREATE OR REPLACE FUNCTION platform.open_review_reports(p_limit integer DEFAULT 50)
  RETURNS TABLE (report_id uuid, review_id uuid, hotel_id uuid, created_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT rr.report_id, rr.review_id, rr.hotel_id, rr.created_at
    FROM platform.review_report rr
   WHERE rr.state = 'OPEN'::text
   ORDER BY rr.created_at
   LIMIT least(greatest(p_limit, 1), 200)
$$;
--> statement-breakpoint
ALTER FUNCTION platform.open_review_reports(integer) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint

REVOKE ALL ON FUNCTION platform.hotel_of_published_review(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.hotel_of_published_review(uuid) TO prsystem_api;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.hotel_of_moderatable_review(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.hotel_of_moderatable_review(uuid) TO prsystem_api;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.open_review_reports(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.open_review_reports(integer) TO prsystem_api;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.public_hotel_reviews(uuid, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.public_hotel_reviews(uuid, integer, integer) TO prsystem_api;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA platform FROM prsystem_maintenance_fn;
--> statement-breakpoint
GRANT SELECT ON platform.hotel_review, platform.hotel_review_reply,
                platform.hotel_review_aggregate, platform.review_report
  TO prsystem_maintenance_fn;
--> statement-breakpoint

-- RLS applies to the definer's owner too, so each read is exactly as narrow as
-- the projection needs: published reviews of published hotels, the live replies
-- to them, and the aggregate.
CREATE POLICY public_review_read ON platform.hotel_review
  FOR SELECT TO prsystem_maintenance_fn
  USING (status = 'PUBLISHED'::text
         AND EXISTS (SELECT 1 FROM platform.hotel_profile p
                      WHERE p.hotel_id = hotel_review.hotel_id
                        AND p.listing_state = 'PUBLISHED'::text));
--> statement-breakpoint
CREATE POLICY public_reply_read ON platform.hotel_review_reply
  FOR SELECT TO prsystem_maintenance_fn
  USING (state = 'ACTIVE'::text
         AND EXISTS (SELECT 1 FROM platform.hotel_profile p
                      WHERE p.hotel_id = hotel_review_reply.hotel_id
                        AND p.listing_state = 'PUBLISHED'::text));
--> statement-breakpoint
-- The queue resolver's own read: open reports, and nothing about resolved ones.
CREATE POLICY queue_resolution_read ON platform.review_report
  FOR SELECT TO prsystem_maintenance_fn
  USING (state = 'OPEN'::text);
--> statement-breakpoint
-- The moderation resolvers' own read: the two statuses moderation addresses.
--
-- A review the owner deleted is in neither, which is what makes doc 10 §7.3's
-- "a moderator does not undo an owner's delete" true of the read as well as of
-- the write.
CREATE POLICY moderation_resolution_read ON platform.hotel_review
  FOR SELECT TO prsystem_maintenance_fn
  USING (status = ANY (ARRAY['PUBLISHED'::text, 'HIDDEN'::text]));
--> statement-breakpoint
CREATE POLICY public_aggregate_read ON platform.hotel_review_aggregate
  FOR SELECT TO prsystem_maintenance_fn
  USING (EXISTS (SELECT 1 FROM platform.hotel_profile p
                  WHERE p.hotel_id = hotel_review_aggregate.hotel_id
                    AND p.listing_state = 'PUBLISHED'::text));
--> statement-breakpoint
