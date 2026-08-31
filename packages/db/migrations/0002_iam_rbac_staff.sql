-- IAM, tenancy, RBAC and the staff lifecycle.
--
-- Adds the tenant root (`hotel`), the account/credential/session primitives, the
-- membership and role-grant model, the invitation and reset token lifecycles,
-- the explicit per-account permission grant, and the IAM-owned work handoff
-- queue that suspension feeds.
--
-- It creates NO later-phase domain aggregate. A Restaurant, a Reception shift, a
-- Cleaner task and a Restaurant order are referenced by an opaque `subject_ref`
-- with no foreign key, because Phases 15, 11, 09 and 15 own those tables and
-- inventing them here to satisfy a constraint would put the wrong module in
-- charge of them. The owning phase is named beside every such column.
--
-- docs 18 (`RBAC-DEC-001`…`017`) and 19 (`STAFF-DEC-001`…`009`);
-- ADR-0017 (RLS + roles), ADR-0018 (audit), ADR-0009 (append-only),
-- ADR-0011 (revision/CAS), ADR-0020 (key management), ADR-0004 (versioned SQL).

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint

-- ------------------------------------------------- account-scoped context
-- The authenticated account, carried in the same transaction-local way as the
-- tenant scope (ADR-0017 §2). It exists because two IAM facts are true at once:
-- a membership row belongs to a hotel, and it is *about* an account. Resolving
-- scope from membership (doc 06 §2) requires reading one's own membership rows
-- before any hotel scope exists, which the tenant policy alone cannot express.
CREATE OR REPLACE FUNCTION platform.current_account_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$ SELECT nullif(current_setting('app.account_id', true), '')::uuid $$;
--> statement-breakpoint

-- ------------------------------------------------------------ the tenant root
-- doc 06 §1: the tenant is the hotel. Phase 05 provisions rows through paid
-- onboarding; Phase 04 owns the table and the scope it defines, and no runtime
-- holds INSERT — a hotel that a runtime could create would be a tenant nobody
-- paid for.
CREATE TABLE platform.hotel (
  hotel_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  text NOT NULL,
  timezone      text NOT NULL DEFAULT 'Asia/Ulaanbaatar',
  state         text NOT NULL DEFAULT 'ACTIVE',
  created_at    timestamptz NOT NULL DEFAULT now(),
  revision      integer NOT NULL DEFAULT 0,
  CONSTRAINT hotel_display_name_bounded CHECK (length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT hotel_revision_non_negative CHECK (revision >= 0),
  CONSTRAINT hotel_state_known CHECK (state = ANY (ARRAY['ACTIVE'::text, 'SUSPENDED'::text])),
  CONSTRAINT hotel_timezone_known CHECK (timezone IN ('Asia/Ulaanbaatar'))
);
--> statement-breakpoint

-- ------------------------------------------------------------- user accounts
-- doc 19 §2 / `STAFF-DEC-002`: one account per verified email, many memberships.
-- Realms never merge (doc 05 §1.1), so uniqueness is per realm and an account
-- carries the realm it belongs to. Guest accounts are Phase 12 and are not this
-- table's population.
CREATE TABLE platform.user_account (
  account_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  realm             text NOT NULL,
  email_normalized  text NOT NULL,
  state             text NOT NULL DEFAULT 'ACTIVE',
  email_verified_at timestamptz,
  -- Account-wide revocation marker. A password change bumps it and every
  -- session issued under the old value stops being valid (doc 19 §10).
  auth_epoch        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  revision          integer NOT NULL DEFAULT 0,
  CONSTRAINT user_account_auth_epoch_non_negative CHECK (auth_epoch >= 0),
  CONSTRAINT user_account_email_normalised CHECK (email_normalized = lower(email_normalized)),
  CONSTRAINT user_account_email_shape
    CHECK (email_normalized ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'::text),
  CONSTRAINT user_account_realm_known
    CHECK (realm = ANY (ARRAY['hotel'::text, 'operation'::text, 'police'::text])),
  CONSTRAINT user_account_revision_non_negative CHECK (revision >= 0),
  CONSTRAINT user_account_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'SUSPENDED'::text, 'DISABLED'::text])),
  CONSTRAINT user_account_realm_email_uq UNIQUE (realm, email_normalized)
);
--> statement-breakpoint

-- doc 19 §12 / `STAFF-DEC-001`: the platform never issues a password. The stored
-- value is a memory-hard KDF output with its parameter version beside it, and
-- the check refuses anything that is not one — a plaintext password cannot be
-- written into this column by accident.
CREATE TABLE platform.account_credential (
  credential_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL,
  kind            text NOT NULL DEFAULT 'password',
  secret_hash     text NOT NULL,
  params_version  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  revision        integer NOT NULL DEFAULT 0,
  CONSTRAINT account_credential_account_id_fkey FOREIGN KEY (account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT account_credential_kind_known CHECK (kind = 'password'::text),
  CONSTRAINT account_credential_params_shape
    CHECK (params_version ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text),
  CONSTRAINT account_credential_revision_non_negative CHECK (revision >= 0),
  CONSTRAINT account_credential_secret_is_derived
    CHECK (secret_hash ~ '^scrypt\$v=[0-9]+\$n=[0-9]+,r=[0-9]+,p=[0-9]+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$'::text),
  CONSTRAINT account_credential_one_per_kind UNIQUE (account_id, kind)
);
--> statement-breakpoint

-- ---------------------------------------------------------- server sessions
-- doc 19 §10: logout and revocation are server state, never a cleared browser
-- store. The session holds no secret: only a versioned keyed HMAC of the token
-- (ADR-0020 §6), so a database reader cannot mint a session.
CREATE TABLE platform.server_session (
  session_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL,
  realm               text NOT NULL,
  token_hash          text NOT NULL,
  token_key_version   text NOT NULL,
  account_epoch       integer NOT NULL,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  step_up_at          timestamptz,
  revoked_at          timestamptz,
  revoked_reason      text,
  revision            integer NOT NULL DEFAULT 0,
  CONSTRAINT server_session_account_id_fkey FOREIGN KEY (account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT server_session_epoch_non_negative CHECK (account_epoch >= 0),
  CONSTRAINT server_session_expiry_ordered CHECK (idle_expires_at <= absolute_expires_at),
  CONSTRAINT server_session_realm_known
    CHECK (realm = ANY (ARRAY['hotel'::text, 'operation'::text, 'police'::text])),
  CONSTRAINT server_session_revision_non_negative CHECK (revision >= 0),
  CONSTRAINT server_session_revoked_has_reason
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT server_session_token_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'::text),
  CONSTRAINT server_session_token_uq UNIQUE (token_hash)
);
--> statement-breakpoint

-- ------------------------------------------------------- staff memberships
-- doc 19 §2 and §4. One canonical row per `(hotel scope, email)` and per
-- `(hotel scope, account)`, whatever the row's history: rehire is the explicit
-- reactivation of §8, never a second row.
--
-- `restaurant_id` is the Restaurant sub-scope of doc 06 §4.1. It carries **no
-- foreign key**: the `restaurant` aggregate is owned by Phase 15, and creating
-- it here to satisfy a constraint would hand IAM a table it does not own. The
-- linkage is completed in Phase 15.
CREATE TABLE platform.staff_membership (
  membership_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                 uuid NOT NULL,
  restaurant_id            uuid,
  account_id               uuid,
  invited_email_normalized text NOT NULL,
  state                    text NOT NULL DEFAULT 'PENDING',
  is_primary_admin         boolean NOT NULL DEFAULT false,
  membership_revision      integer NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by_account_id    uuid,
  activated_at             timestamptz,
  state_changed_at         timestamptz,
  state_reason             text,
  CONSTRAINT staff_membership_hotel_id_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT staff_membership_account_id_fkey FOREIGN KEY (account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT staff_membership_created_by_fkey FOREIGN KEY (created_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT staff_membership_active_has_account
    CHECK ((state = 'PENDING'::text) OR (account_id IS NOT NULL)),
  CONSTRAINT staff_membership_email_normalised
    CHECK (invited_email_normalized = lower(invited_email_normalized)),
  -- `STAFF-DEC-006`: Primary is a hotel-scope role and is never a Restaurant
  -- membership, and it is never in a state that would leave a hotel without one.
  CONSTRAINT staff_membership_primary_is_hotel_scope
    CHECK ((NOT is_primary_admin) OR (restaurant_id IS NULL)),
  CONSTRAINT staff_membership_primary_is_active
    CHECK ((NOT is_primary_admin) OR (state = 'ACTIVE'::text)),
  CONSTRAINT staff_membership_revision_non_negative CHECK (membership_revision >= 0),
  CONSTRAINT staff_membership_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'ACTIVE'::text, 'SUSPENDED'::text, 'TERMINATED'::text])),
  -- doc 06 §3.1: children carry `hotel_id` so a cross-hotel reference is
  -- unrepresentable rather than merely prevented.
  CONSTRAINT staff_membership_scope_uq UNIQUE (hotel_id, membership_id)
);
--> statement-breakpoint

-- One canonical membership per scope, in both of its identities. Two partial
-- indexes rather than one over `COALESCE(restaurant_id, …)`: a sentinel UUID
-- inside a unique key is a value a caller could one day supply.
CREATE UNIQUE INDEX staff_membership_hotel_email_uq
  ON platform.staff_membership (hotel_id, invited_email_normalized)
  WHERE restaurant_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX staff_membership_restaurant_email_uq
  ON platform.staff_membership (hotel_id, restaurant_id, invited_email_normalized)
  WHERE restaurant_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX staff_membership_hotel_account_uq
  ON platform.staff_membership (hotel_id, account_id)
  WHERE restaurant_id IS NULL AND account_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX staff_membership_restaurant_account_uq
  ON platform.staff_membership (hotel_id, restaurant_id, account_id)
  WHERE restaurant_id IS NOT NULL AND account_id IS NOT NULL;
--> statement-breakpoint
-- `STAFF-DEC-006`: one Primary Hotel Admin per hotel.
CREATE UNIQUE INDEX staff_membership_primary_admin_uq
  ON platform.staff_membership (hotel_id)
  WHERE (is_primary_admin IS TRUE);
--> statement-breakpoint
CREATE INDEX staff_membership_account_idx
  ON platform.staff_membership (account_id, hotel_id)
  WHERE account_id IS NOT NULL;
--> statement-breakpoint

-- ------------------------------------------------------------- role grants
-- doc 19 §7: a role change never rewrites history. Grants are append-only and a
-- revocation is a new value on the same row, never a deletion — the actor
-- identity on a past stay, shift or payment must stay resolvable.
CREATE TABLE platform.membership_role_grant (
  role_grant_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id              uuid NOT NULL,
  membership_id         uuid NOT NULL,
  role                  text NOT NULL,
  granted_at            timestamptz NOT NULL DEFAULT now(),
  granted_by_account_id uuid,
  revoked_at            timestamptz,
  revoked_by_account_id uuid,
  revoked_reason        text,
  CONSTRAINT membership_role_grant_membership_fkey FOREIGN KEY (hotel_id, membership_id)
    REFERENCES platform.staff_membership (hotel_id, membership_id) ON DELETE RESTRICT,
  CONSTRAINT membership_role_grant_granted_by_fkey FOREIGN KEY (granted_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT membership_role_grant_revoked_by_fkey FOREIGN KEY (revoked_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT membership_role_grant_revocation_complete
    CHECK ((revoked_at IS NULL) = (revoked_by_account_id IS NULL)),
  CONSTRAINT membership_role_grant_role_known
    CHECK (role = ANY (ARRAY['HOTEL_ADMIN'::text, 'MANAGER'::text, 'MANAGER_PLUS'::text,
                             'RECEPTION'::text, 'CLEANER'::text, 'RESTAURANT_MANAGER'::text]))
);
--> statement-breakpoint
CREATE UNIQUE INDEX membership_role_grant_active_uq
  ON platform.membership_role_grant (hotel_id, membership_id, role)
  WHERE revoked_at IS NULL;
--> statement-breakpoint

-- ------------------------------------------------------------- invitations
-- doc 19 §4 / `STAFF-DEC-009`. The token lifecycle is separate from the
-- membership's: `ACTIVE → ACCEPTED | SUPERSEDED | EXPIRED | REVOKED`, at most one
-- ACTIVE per membership, enforced by a partial unique index rather than by the
-- service that writes it.
CREATE TABLE platform.staff_invitation (
  invitation_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                    uuid NOT NULL,
  membership_id               uuid NOT NULL,
  state                       text NOT NULL DEFAULT 'ACTIVE',
  token_hash                  text NOT NULL,
  token_key_version           text NOT NULL,
  email_normalized            text NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  created_by_account_id       uuid NOT NULL,
  expires_at                  timestamptz NOT NULL,
  terminal_at                 timestamptz,
  terminal_reason             text,
  superseded_by_invitation_id uuid,
  CONSTRAINT staff_invitation_membership_fkey FOREIGN KEY (hotel_id, membership_id)
    REFERENCES platform.staff_membership (hotel_id, membership_id) ON DELETE RESTRICT,
  CONSTRAINT staff_invitation_created_by_fkey FOREIGN KEY (created_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT staff_invitation_superseded_by_fkey FOREIGN KEY (superseded_by_invitation_id)
    REFERENCES platform.staff_invitation (invitation_id) ON DELETE RESTRICT,
  CONSTRAINT staff_invitation_email_normalised
    CHECK (email_normalized = lower(email_normalized)),
  CONSTRAINT staff_invitation_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT staff_invitation_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'ACCEPTED'::text, 'SUPERSEDED'::text,
                              'EXPIRED'::text, 'REVOKED'::text])),
  CONSTRAINT staff_invitation_terminal_has_time
    CHECK ((state = 'ACTIVE'::text) = (terminal_at IS NULL)),
  CONSTRAINT staff_invitation_token_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'::text),
  CONSTRAINT staff_invitation_token_uq UNIQUE (token_hash),
  CONSTRAINT staff_invitation_scope_uq UNIQUE (hotel_id, invitation_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX staff_invitation_one_active_uq
  ON platform.staff_invitation (hotel_id, membership_id)
  WHERE state = 'ACTIVE'::text;
--> statement-breakpoint

-- The roles an invitation asks for. A child table rather than an array so the
-- role vocabulary is constrained by the same CHECK the grants use.
CREATE TABLE platform.invitation_requested_role (
  hotel_id      uuid NOT NULL,
  invitation_id uuid NOT NULL,
  role          text NOT NULL,
  CONSTRAINT invitation_requested_role_pk PRIMARY KEY (hotel_id, invitation_id, role),
  CONSTRAINT invitation_requested_role_invitation_fkey FOREIGN KEY (hotel_id, invitation_id)
    REFERENCES platform.staff_invitation (hotel_id, invitation_id) ON DELETE RESTRICT,
  CONSTRAINT invitation_requested_role_known
    CHECK (role = ANY (ARRAY['HOTEL_ADMIN'::text, 'MANAGER'::text, 'MANAGER_PLUS'::text,
                             'RECEPTION'::text, 'CLEANER'::text, 'RESTAURANT_MANAGER'::text]))
);
--> statement-breakpoint

-- --------------------------------------------------------- password resets
-- doc 19 §6 / `STAFF-DEC-003`. Account-scoped, so it carries no `hotel_id`: a
-- reset revokes sessions across every membership because the credential itself
-- changed. A Hotel Admin may initiate one and never sees the token.
CREATE TABLE platform.password_reset_request (
  reset_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id               uuid NOT NULL,
  state                    text NOT NULL DEFAULT 'ACTIVE',
  token_hash               text NOT NULL,
  token_key_version        text NOT NULL,
  initiated_by             text NOT NULL,
  initiated_by_account_id  uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  expires_at               timestamptz NOT NULL,
  terminal_at              timestamptz,
  terminal_reason          text,
  CONSTRAINT password_reset_request_account_id_fkey FOREIGN KEY (account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT password_reset_request_initiator_fkey FOREIGN KEY (initiated_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT password_reset_request_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT password_reset_request_initiator_known
    CHECK (initiated_by = ANY (ARRAY['self'::text, 'hotel_admin'::text])),
  CONSTRAINT password_reset_request_initiator_recorded
    CHECK ((initiated_by = 'self'::text) = (initiated_by_account_id IS NULL)),
  CONSTRAINT password_reset_request_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'USED'::text, 'SUPERSEDED'::text,
                              'EXPIRED'::text, 'REVOKED'::text])),
  CONSTRAINT password_reset_request_terminal_has_time
    CHECK ((state = 'ACTIVE'::text) = (terminal_at IS NULL)),
  CONSTRAINT password_reset_request_token_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'::text),
  CONSTRAINT password_reset_request_token_uq UNIQUE (token_hash)
);
--> statement-breakpoint
CREATE UNIQUE INDEX password_reset_request_one_active_uq
  ON platform.password_reset_request (account_id)
  WHERE state = 'ACTIVE'::text;
--> statement-breakpoint

-- ------------------------------------------------ explicit permission grants
-- doc 18 §5 and §6 / `RBAC-DEC-004`, `RBAC-DEC-017`, `POL-DEC-021`: a role name
-- grants nothing. Operation, Platform and Police authority is a named permission
-- granted to a named account, revocable, and never implied by a label.
CREATE TABLE platform.account_permission_grant (
  permission_grant_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL,
  permission            text NOT NULL,
  granted_at            timestamptz NOT NULL DEFAULT now(),
  granted_by_account_id uuid NOT NULL,
  revoked_at            timestamptz,
  revoked_by_account_id uuid,
  revoked_reason        text,
  CONSTRAINT account_permission_grant_account_id_fkey FOREIGN KEY (account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT account_permission_grant_granted_by_fkey FOREIGN KEY (granted_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT account_permission_grant_revoked_by_fkey FOREIGN KEY (revoked_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT account_permission_grant_permission_shape
    CHECK (permission ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'::text),
  CONSTRAINT account_permission_grant_revocation_complete
    CHECK ((revoked_at IS NULL) = (revoked_by_account_id IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX account_permission_grant_active_uq
  ON platform.account_permission_grant (account_id, permission)
  WHERE revoked_at IS NULL;
--> statement-breakpoint

-- ------------------------------------------------------ session scope grants
-- doc 19 §10, the scope-targeted half of the revocation matrix.
--
-- A session belongs to an account; the authority it carries inside one hotel is
-- this row, stamped with the membership revision it was issued against. A role
-- change, a suspension or a termination bumps that revision and revokes the row,
-- so the scope's session dies immediately while the same session's authority in
-- another hotel is untouched. A password change bumps the account epoch instead
-- and takes all of them at once.
CREATE TABLE platform.session_scope_grant (
  scope_grant_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id            uuid NOT NULL,
  account_id          uuid NOT NULL,
  session_id          uuid NOT NULL,
  membership_id       uuid NOT NULL,
  membership_revision integer NOT NULL,
  granted_at          timestamptz NOT NULL DEFAULT now(),
  revoked_at          timestamptz,
  revoked_reason      text,
  CONSTRAINT session_scope_grant_session_fkey FOREIGN KEY (session_id)
    REFERENCES platform.server_session (session_id) ON DELETE RESTRICT,
  CONSTRAINT session_scope_grant_account_id_fkey FOREIGN KEY (account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT session_scope_grant_membership_fkey FOREIGN KEY (hotel_id, membership_id)
    REFERENCES platform.staff_membership (hotel_id, membership_id) ON DELETE RESTRICT,
  CONSTRAINT session_scope_grant_revision_non_negative CHECK (membership_revision >= 0),
  CONSTRAINT session_scope_grant_revoked_has_reason
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX session_scope_grant_live_uq
  ON platform.session_scope_grant (session_id, membership_id)
  WHERE revoked_at IS NULL;
--> statement-breakpoint

-- ------------------------------------------------------- work handoff queue
-- doc 19 §8.1–§8.4 / `STAFF-DEC-007`, `RBAC-DEC-014`.
--
-- The generic queue IAM owns. Security revocation commits immediately and never
-- waits for open work, so the open work becomes an item here instead.
--
-- `subject_ref` names a Reception shift (Phase 11), a Cleaner task (Phase 09) or
-- a Restaurant order (Phase 15). None of those tables exists, and none is
-- created here: the item carries the opaque reference and its kind, and the
-- owning phase completes the linkage.
CREATE TABLE platform.work_handoff_item (
  item_id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                     uuid NOT NULL,
  restaurant_id                uuid,
  subject_kind                 text NOT NULL,
  subject_ref                  uuid NOT NULL,
  state                        text NOT NULL,
  opened_reason                text NOT NULL,
  previous_actor_membership_id uuid NOT NULL,
  claimant_membership_id       uuid,
  assignee_membership_id       uuid,
  movement_started             boolean NOT NULL DEFAULT false,
  continuation_of_item_id      uuid,
  assignment_version           integer NOT NULL DEFAULT 0,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  resolved_at                  timestamptz,
  CONSTRAINT work_handoff_item_previous_actor_fkey FOREIGN KEY (hotel_id, previous_actor_membership_id)
    REFERENCES platform.staff_membership (hotel_id, membership_id) ON DELETE RESTRICT,
  CONSTRAINT work_handoff_item_claimant_fkey FOREIGN KEY (hotel_id, claimant_membership_id)
    REFERENCES platform.staff_membership (hotel_id, membership_id) ON DELETE RESTRICT,
  CONSTRAINT work_handoff_item_assignee_fkey FOREIGN KEY (hotel_id, assignee_membership_id)
    REFERENCES platform.staff_membership (hotel_id, membership_id) ON DELETE RESTRICT,
  CONSTRAINT work_handoff_item_continuation_fkey FOREIGN KEY (continuation_of_item_id)
    REFERENCES platform.work_handoff_item (item_id) ON DELETE RESTRICT,
  CONSTRAINT work_handoff_item_assigned_has_both
    CHECK ((state <> 'ASSIGNED'::text)
           OR (claimant_membership_id IS NOT NULL AND assignee_membership_id IS NOT NULL)),
  CONSTRAINT work_handoff_item_claimed_has_claimant
    CHECK ((state <> 'CLAIMED'::text) OR (claimant_membership_id IS NOT NULL)),
  CONSTRAINT work_handoff_item_continuation_is_cleaner
    CHECK ((continuation_of_item_id IS NULL) OR (subject_kind = 'cleaner_task'::text)),
  CONSTRAINT work_handoff_item_open_has_no_actor
    CHECK ((state <> ALL (ARRAY['TAKEOVER_REQUIRED'::text, 'REASSIGNMENT_REQUIRED'::text,
                                'UNASSIGNED_REQUIRES_ACTION'::text]))
           OR (claimant_membership_id IS NULL AND assignee_membership_id IS NULL)),
  CONSTRAINT work_handoff_item_reason_known
    CHECK (opened_reason = ANY (ARRAY['suspension'::text, 'termination'::text])),
  CONSTRAINT work_handoff_item_resolved_has_time
    CHECK ((state = 'RESOLVED'::text) = (resolved_at IS NOT NULL)),
  CONSTRAINT work_handoff_item_restaurant_scope
    CHECK ((subject_kind = 'restaurant_order'::text) = (restaurant_id IS NOT NULL)),
  CONSTRAINT work_handoff_item_state_known
    CHECK (state = ANY (ARRAY['TAKEOVER_REQUIRED'::text, 'REASSIGNMENT_REQUIRED'::text,
                              'CLAIMED'::text, 'ASSIGNED'::text, 'RESOLVED'::text,
                              'UNASSIGNED_REQUIRES_ACTION'::text])),
  CONSTRAINT work_handoff_item_subject_known
    CHECK (subject_kind = ANY (ARRAY['reception_shift'::text, 'cleaner_task'::text,
                                     'restaurant_order'::text])),
  CONSTRAINT work_handoff_item_version_non_negative CHECK (assignment_version >= 0),
  CONSTRAINT work_handoff_item_scope_uq UNIQUE (hotel_id, item_id)
);
--> statement-breakpoint
-- One non-terminal item per subject. Two claimants therefore produce one winner
-- at the database, not at whichever service happened to check first.
CREATE UNIQUE INDEX work_handoff_item_open_subject_uq
  ON platform.work_handoff_item (hotel_id, subject_kind, subject_ref)
  WHERE state <> 'RESOLVED'::text;
--> statement-breakpoint
CREATE INDEX work_handoff_item_queue_idx
  ON platform.work_handoff_item (hotel_id, state, created_at);
--> statement-breakpoint

-- Append-only movement history. `created_by`, a historical assignee and a posted
-- movement are never overwritten (doc 19 §8.4).
CREATE TABLE platform.work_handoff_event (
  hotel_id                       uuid NOT NULL,
  item_id                        uuid NOT NULL,
  seq                            integer NOT NULL,
  event_id                       uuid NOT NULL DEFAULT gen_random_uuid(),
  kind                           text NOT NULL,
  actor_membership_id            uuid,
  previous_assignee_membership_id uuid,
  new_assignee_membership_id     uuid,
  reason                         text,
  idempotency_key                text NOT NULL,
  occurred_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_handoff_event_pk PRIMARY KEY (hotel_id, item_id, seq),
  CONSTRAINT work_handoff_event_item_fkey FOREIGN KEY (hotel_id, item_id)
    REFERENCES platform.work_handoff_item (hotel_id, item_id) ON DELETE RESTRICT,
  CONSTRAINT work_handoff_event_actor_fkey FOREIGN KEY (hotel_id, actor_membership_id)
    REFERENCES platform.staff_membership (hotel_id, membership_id) ON DELETE RESTRICT,
  CONSTRAINT work_handoff_event_idempotency_shape
    CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT work_handoff_event_kind_known
    CHECK (kind = ANY (ARRAY['opened'::text, 'claimed'::text, 'released'::text,
                             'assigned'::text, 'resolved'::text, 'unassigned'::text,
                             'continuation_created'::text])),
  CONSTRAINT work_handoff_event_seq_positive CHECK (seq >= 1),
  CONSTRAINT work_handoff_event_idempotency_uq UNIQUE (hotel_id, item_id, idempotency_key)
);
--> statement-breakpoint

-- ------------------------------------------------------------------ guards
-- Transition rules the column grants and CHECK constraints cannot express.
-- Ordinary (invoker-rights) trigger functions: they refuse, they never widen.

-- `STAFF-DEC-008`: the revision is monotonic, and the identity of a membership
-- is fixed. `STAFF-DEC-006`: a Primary Hotel Admin cannot be demoted, suspended
-- or terminated — the transfer is the offline Platform process of doc 19 §9.
CREATE OR REPLACE FUNCTION platform.staff_membership_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'staff history is never hard deleted (STAFF-DEC-005)'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.membership_id IS DISTINCT FROM OLD.membership_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.restaurant_id IS DISTINCT FROM OLD.restaurant_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.invited_email_normalized IS DISTINCT FROM OLD.invited_email_normalized THEN
    RAISE EXCEPTION 'a membership identity is immutable' USING ERRCODE = '42501';
  END IF;

  IF NEW.membership_revision <= OLD.membership_revision THEN
    RAISE EXCEPTION 'membership_revision must increase (was %, offered %)',
      OLD.membership_revision, NEW.membership_revision USING ERRCODE = '40001';
  END IF;

  IF OLD.account_id IS NOT NULL AND NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'a membership never moves to another account' USING ERRCODE = '42501';
  END IF;

  IF OLD.is_primary_admin AND NOT NEW.is_primary_admin THEN
    RAISE EXCEPTION 'the Primary Hotel Admin is not demoted by a staff action (STAFF-DEC-006)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.is_primary_admin AND NEW.state <> 'ACTIVE'::text THEN
    RAISE EXCEPTION 'the Primary Hotel Admin is not suspended or terminated by a staff action'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.state = 'PENDING'::text
     AND NEW.state NOT IN ('PENDING'::text, 'ACTIVE'::text, 'TERMINATED'::text) THEN
    RAISE EXCEPTION 'a pending membership becomes ACTIVE or TERMINATED, not %', NEW.state
      USING ERRCODE = '22023';
  END IF;
  IF OLD.state = 'ACTIVE'::text AND NEW.state = 'PENDING'::text THEN
    RAISE EXCEPTION 'an active membership never returns to PENDING' USING ERRCODE = '22023';
  END IF;
  IF OLD.state = 'SUSPENDED'::text AND NEW.state = 'PENDING'::text THEN
    RAISE EXCEPTION 'a suspended membership never returns to PENDING' USING ERRCODE = '22023';
  END IF;
  IF OLD.state = 'TERMINATED'::text AND NEW.state NOT IN ('TERMINATED'::text, 'ACTIVE'::text) THEN
    RAISE EXCEPTION 'a terminated membership is reactivated or left terminated, not %', NEW.state
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- doc 19 §7: role history is immutable. The only permitted update is the
-- revocation of a live grant, and it touches nothing else.
CREATE OR REPLACE FUNCTION platform.membership_role_grant_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a role grant is revoked, never deleted (doc 19 §7)' USING ERRCODE = '42501';
  END IF;

  IF NEW.role_grant_id IS DISTINCT FROM OLD.role_grant_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
     OR NEW.granted_by_account_id IS DISTINCT FROM OLD.granted_by_account_id THEN
    RAISE EXCEPTION 'a role grant records who held what, and is not rewritten'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked role grant is terminal' USING ERRCODE = '22023';
  END IF;
  IF NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'the only update to a role grant is its revocation' USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- doc 19 §4: `ACTIVE → ACCEPTED | SUPERSEDED | EXPIRED | REVOKED`, once, and the
-- token digest never changes.
CREATE OR REPLACE FUNCTION platform.staff_invitation_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an invitation is terminalised, never deleted' USING ERRCODE = '42501';
  END IF;

  IF NEW.invitation_id IS DISTINCT FROM OLD.invitation_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.token_key_version IS DISTINCT FROM OLD.token_key_version
     OR NEW.email_normalized IS DISTINCT FROM OLD.email_normalized
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by_account_id IS DISTINCT FROM OLD.created_by_account_id
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'an invitation is immutable apart from its terminal state'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.state <> 'ACTIVE'::text THEN
    RAISE EXCEPTION 'invitation % is already %', OLD.invitation_id, OLD.state
      USING ERRCODE = '22023';
  END IF;
  IF NEW.state = 'ACTIVE'::text THEN
    RAISE EXCEPTION 'the only update to an invitation is its terminal transition'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.password_reset_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a reset request is terminalised, never deleted' USING ERRCODE = '42501';
  END IF;

  IF NEW.reset_id IS DISTINCT FROM OLD.reset_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.token_key_version IS DISTINCT FROM OLD.token_key_version
     OR NEW.initiated_by IS DISTINCT FROM OLD.initiated_by
     OR NEW.initiated_by_account_id IS DISTINCT FROM OLD.initiated_by_account_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'a reset request is immutable apart from its terminal state'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.state <> 'ACTIVE'::text THEN
    RAISE EXCEPTION 'reset request % is already %', OLD.reset_id, OLD.state
      USING ERRCODE = '22023';
  END IF;
  IF NEW.state = 'ACTIVE'::text THEN
    RAISE EXCEPTION 'the only update to a reset request is its terminal transition'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- doc 19 §8.4: one current claimant or assignee, a strictly increasing
-- assignment version, and a previous actor that is never overwritten.
CREATE OR REPLACE FUNCTION platform.work_handoff_item_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a handoff item is resolved, never deleted' USING ERRCODE = '42501';
  END IF;

  IF NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.restaurant_id IS DISTINCT FROM OLD.restaurant_id
     OR NEW.subject_kind IS DISTINCT FROM OLD.subject_kind
     OR NEW.subject_ref IS DISTINCT FROM OLD.subject_ref
     OR NEW.opened_reason IS DISTINCT FROM OLD.opened_reason
     OR NEW.previous_actor_membership_id IS DISTINCT FROM OLD.previous_actor_membership_id
     OR NEW.continuation_of_item_id IS DISTINCT FROM OLD.continuation_of_item_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'the subject and the previous actor of a handoff item are immutable'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.assignment_version <= OLD.assignment_version THEN
    RAISE EXCEPTION 'assignment_version must increase (was %, offered %)',
      OLD.assignment_version, NEW.assignment_version USING ERRCODE = '40001';
  END IF;

  IF OLD.state = 'RESOLVED'::text THEN
    RAISE EXCEPTION 'handoff item % is already resolved', OLD.item_id USING ERRCODE = '22023';
  END IF;

  IF OLD.movement_started AND NOT NEW.movement_started THEN
    RAISE EXCEPTION 'a posted movement is never unrecorded' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER staff_membership_no_delete
  BEFORE DELETE ON platform.staff_membership
  FOR EACH ROW EXECUTE FUNCTION platform.staff_membership_guard();
--> statement-breakpoint
CREATE TRIGGER staff_membership_transition_guard
  BEFORE UPDATE ON platform.staff_membership
  FOR EACH ROW EXECUTE FUNCTION platform.staff_membership_guard();
--> statement-breakpoint
CREATE TRIGGER user_account_no_delete
  BEFORE DELETE ON platform.user_account
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER membership_role_grant_no_delete
  BEFORE DELETE ON platform.membership_role_grant
  FOR EACH ROW EXECUTE FUNCTION platform.membership_role_grant_guard();
--> statement-breakpoint
CREATE TRIGGER membership_role_grant_transition_guard
  BEFORE UPDATE ON platform.membership_role_grant
  FOR EACH ROW EXECUTE FUNCTION platform.membership_role_grant_guard();
--> statement-breakpoint
CREATE TRIGGER staff_invitation_no_delete
  BEFORE DELETE ON platform.staff_invitation
  FOR EACH ROW EXECUTE FUNCTION platform.staff_invitation_guard();
--> statement-breakpoint
CREATE TRIGGER staff_invitation_transition_guard
  BEFORE UPDATE ON platform.staff_invitation
  FOR EACH ROW EXECUTE FUNCTION platform.staff_invitation_guard();
--> statement-breakpoint
CREATE TRIGGER invitation_requested_role_append_only
  BEFORE UPDATE OR DELETE ON platform.invitation_requested_role
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER password_reset_request_no_delete
  BEFORE DELETE ON platform.password_reset_request
  FOR EACH ROW EXECUTE FUNCTION platform.password_reset_guard();
--> statement-breakpoint
CREATE TRIGGER password_reset_request_transition_guard
  BEFORE UPDATE ON platform.password_reset_request
  FOR EACH ROW EXECUTE FUNCTION platform.password_reset_guard();
--> statement-breakpoint
CREATE TRIGGER work_handoff_item_no_delete
  BEFORE DELETE ON platform.work_handoff_item
  FOR EACH ROW EXECUTE FUNCTION platform.work_handoff_item_guard();
--> statement-breakpoint
CREATE TRIGGER work_handoff_item_transition_guard
  BEFORE UPDATE ON platform.work_handoff_item
  FOR EACH ROW EXECUTE FUNCTION platform.work_handoff_item_guard();
--> statement-breakpoint
CREATE TRIGGER work_handoff_event_append_only
  BEFORE UPDATE OR DELETE ON platform.work_handoff_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER account_permission_grant_no_delete
  BEFORE DELETE ON platform.account_permission_grant
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------- row level security
-- ADR-0017 §1: enabled and FORCEd, so the owner is subject to the policy too.
ALTER TABLE platform.hotel                     ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.hotel                     FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.staff_membership          ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.staff_membership          FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.membership_role_grant     ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.membership_role_grant     FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.staff_invitation          ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.staff_invitation          FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.invitation_requested_role ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.invitation_requested_role FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.session_scope_grant       ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.session_scope_grant       FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.work_handoff_item         ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.work_handoff_item         FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.work_handoff_event        ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.work_handoff_event        FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON platform.hotel
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.staff_membership
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
-- doc 06 §2: scope is derived from membership, so a principal must be able to
-- read its own membership rows before any hotel scope exists. SELECT only: a
-- write still requires the tenant scope above.
CREATE POLICY own_membership_read ON platform.staff_membership
  FOR SELECT USING (account_id = platform.current_account_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.membership_role_grant
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
-- The same reason as the membership policy above: the effective permission set
-- for a session is the union of the roles on one membership, and it has to be
-- readable before any hotel scope exists. SELECT only, and only for the grants
-- on the principal's own memberships — the subquery is itself subject to
-- `staff_membership`'s policies, so it can widen nothing.
CREATE POLICY own_membership_roles_read ON platform.membership_role_grant
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM platform.staff_membership m
       WHERE m.hotel_id = membership_role_grant.hotel_id
         AND m.membership_id = membership_role_grant.membership_id
         AND m.account_id = platform.current_account_id()
    )
  );
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.staff_invitation
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.invitation_requested_role
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.session_scope_grant
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
-- Account-wide revocation crosses every hotel the account is a member of, so it
-- cannot run under one hotel's scope. The row is about the account, and the
-- account is the one the transaction authenticated as.
CREATE POLICY own_account_scope ON platform.session_scope_grant
  USING (account_id = platform.current_account_id())
  WITH CHECK (account_id = platform.current_account_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.work_handoff_item
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.work_handoff_event
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- ---------------------------------------------------------------- ownership
ALTER TABLE platform.hotel                     OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.user_account              OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.account_credential        OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.server_session            OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.session_scope_grant       OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.staff_membership          OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.membership_role_grant     OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.staff_invitation          OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.invitation_requested_role OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.password_reset_request    OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.account_permission_grant  OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.work_handoff_item         OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.work_handoff_event        OWNER TO prsystem_migrate;
--> statement-breakpoint

-- ------------------------------------------------------------------- grants
-- PUBLIC gets nothing, and no role holds DELETE anywhere in this migration:
-- `STAFF-DEC-005` makes hard deletion of staff history impossible rather than
-- merely forbidden.
REVOKE ALL ON platform.hotel, platform.user_account, platform.account_credential,
              platform.server_session, platform.session_scope_grant,
              platform.staff_membership, platform.membership_role_grant,
              platform.staff_invitation, platform.invitation_requested_role,
              platform.password_reset_request, platform.account_permission_grant,
              platform.work_handoff_item, platform.work_handoff_event
  FROM PUBLIC;
--> statement-breakpoint

-- The API is the only runtime with an IAM code path. The worker has none in
-- Phase 04, and the Police runtime never reaches the Hotel realm.
GRANT SELECT ON platform.hotel TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.user_account TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.account_credential TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.server_session TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.session_scope_grant TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.staff_membership TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.membership_role_grant TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.staff_invitation TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.invitation_requested_role TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.password_reset_request TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.account_permission_grant TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.work_handoff_item TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.work_handoff_event TO prsystem_api;
--> statement-breakpoint

-- The context function the policies evaluate, and the guards the API's own
-- statements fire. A missing EXECUTE would refuse the write with a privilege
-- error instead of the diagnosable message the guard raises.
GRANT EXECUTE ON FUNCTION platform.current_account_id()
  TO prsystem_api, prsystem_worker, prsystem_police;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  platform.staff_membership_guard(), platform.membership_role_grant_guard(),
  platform.staff_invitation_guard(), platform.password_reset_guard(),
  platform.work_handoff_item_guard(), platform.reject_mutation()
  TO prsystem_api;
--> statement-breakpoint

-- ------------------------------------------------------------ internal gate
-- CLAUDE.md §9: staff email delivery has no contracted provider, and the kernel
-- already records that as `INT-MAIL-01`. Phase 04 adds the typed port and its
-- deterministic simulator behind that control; the production adapter does not
-- exist, the port fails closed, and the outbox intent is durable so nothing is
-- lost while the control stays closed. No second register row is created — one
-- control, one row.
