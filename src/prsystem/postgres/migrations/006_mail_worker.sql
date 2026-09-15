ALTER TABLE prsystem.staff_mail_intent
    ADD COLUMN lease_token text,
    ADD COLUMN lease_until timestamptz,
    ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ADD COLUMN discarded_at timestamptz,
    ADD COLUMN dead_letter_at timestamptz,
    ADD COLUMN last_error_code text;
ALTER TABLE prsystem.staff_mail_intent ADD CONSTRAINT mail_lease_pair
    CHECK ((lease_token IS NULL) = (lease_until IS NULL));
CREATE INDEX staff_mail_due ON prsystem.staff_mail_intent (next_attempt_at, link_id)
    WHERE delivered_at IS NULL AND discarded_at IS NULL AND dead_letter_at IS NULL;
