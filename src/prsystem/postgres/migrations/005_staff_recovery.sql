ALTER TABLE prsystem.staff_lifecycle_event DROP CONSTRAINT staff_lifecycle_event_kind_check;
ALTER TABLE prsystem.staff_lifecycle_event ADD CONSTRAINT staff_lifecycle_event_kind_check
    CHECK (kind IN ('INVITE_CREATED', 'INVITE_RESENT', 'INVITE_REVOKED', 'INVITE_ACCEPTED',
        'RESET_REQUESTED', 'PASSWORD_RESET', 'ADMIN_RESET_REQUESTED', 'INVITE_RECOVERED'));
ALTER TABLE prsystem.staff_lifecycle_event ADD COLUMN details jsonb NOT NULL DEFAULT '{}';

-- Denials persist after the rejected command transaction has rolled back.
-- Route templates and resolved identities only: no URL, request body or secret.
CREATE TABLE prsystem.staff_denied_event (
    id text PRIMARY KEY,
    actor_id text REFERENCES prsystem.staff_account,
    actor_tenant_id text REFERENCES prsystem.hotel_access,
    requested_tenant_id text REFERENCES prsystem.hotel_access,
    target_id text REFERENCES prsystem.staff_account,
    action text NOT NULL,
    method text NOT NULL,
    code text NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON prsystem.staff_denied_event FROM PUBLIC;
