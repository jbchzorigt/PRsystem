-- Booker realm is independent of staff and of the staying guest's identity.
CREATE TABLE prsystem.booker_account(id text PRIMARY KEY,phone_hash text NOT NULL UNIQUE,phone_envelope jsonb NOT NULL,password_hash text NOT NULL,active boolean NOT NULL DEFAULT true,revision bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE prsystem.booker_challenge(id text PRIMARY KEY,phone_hash text NOT NULL,phone_envelope jsonb NOT NULL,purpose text NOT NULL CHECK(purpose IN ('REGISTER','RESET')),expires_at timestamptz NOT NULL,consumed_at timestamptz);
CREATE TABLE prsystem.booker_session(token_hash text PRIMARY KEY,account_id text NOT NULL REFERENCES prsystem.booker_account,revision bigint NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz);
CREATE TABLE prsystem.booker_event(id text PRIMARY KEY,account_id text REFERENCES prsystem.booker_account,kind text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE prsystem.booker_receipt(account_id text NOT NULL REFERENCES prsystem.booker_account,key text NOT NULL,tenant_id text NOT NULL,command jsonb NOT NULL,hold_id text NOT NULL,PRIMARY KEY(account_id,key),FOREIGN KEY(tenant_id,hold_id) REFERENCES prsystem.booking_hold(tenant_id,id));
ALTER TABLE prsystem.booking_hold ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE prsystem.booking_hold ADD COLUMN booker_id text REFERENCES prsystem.booker_account;
ALTER TABLE prsystem.booking_hold ADD CHECK((actor_id IS NULL)<>(booker_id IS NULL));
REVOKE ALL ON prsystem.booker_account,prsystem.booker_challenge,prsystem.booker_session,prsystem.booker_event,prsystem.booker_receipt FROM PUBLIC;
CREATE TRIGGER booker_event_immutable BEFORE UPDATE OR DELETE ON prsystem.booker_event FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE TRIGGER booker_receipt_immutable BEFORE UPDATE OR DELETE ON prsystem.booker_receipt FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
