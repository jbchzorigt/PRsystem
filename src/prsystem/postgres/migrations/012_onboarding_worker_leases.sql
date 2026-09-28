ALTER TABLE prsystem.onboarding_job ADD COLUMN lease_token text;
ALTER TABLE prsystem.onboarding_job ADD COLUMN lease_until timestamptz;
ALTER TABLE prsystem.onboarding_application DROP CONSTRAINT onboarding_application_state_check;
ALTER TABLE prsystem.onboarding_application ADD CHECK (state IN ('DRAFT','OWNER_VERIFICATION_REQUIRED','PENDING_PAYMENT','PAYMENT_UNCERTAIN','PAYMENT_FAILED','PAYMENT_EXPIRED','PAID_OWNER_VERIFICATION_REQUIRED','PAID_PENDING_PROVISIONING','PROVISIONING','PROVISIONING_FAILED','PROVISIONED'));
CREATE TABLE prsystem.onboarding_owner_proof (
    application_id text PRIMARY KEY REFERENCES prsystem.onboarding_application,
    owner_id text NOT NULL REFERENCES prsystem.subscription_owner,
    challenge_id text NOT NULL,
    verified_at timestamptz
);
REVOKE ALL ON prsystem.onboarding_owner_proof FROM PUBLIC;
