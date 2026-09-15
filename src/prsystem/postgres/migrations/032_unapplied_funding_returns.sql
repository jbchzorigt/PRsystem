ALTER TABLE prsystem.checkin_funding DROP CONSTRAINT checkin_funding_state_check;
ALTER TABLE prsystem.checkin_funding ADD CHECK(state IN ('PENDING','CONFIRMED','REFUNDING','APPLIED','CANCELLED'));
-- REFUNDING retains the original confirmed evidence and can never be applied.
ALTER TABLE prsystem.checkin_funding DROP CONSTRAINT checkin_funding_check1;
ALTER TABLE prsystem.checkin_funding ADD CHECK(
 (state IN ('CONFIRMED','REFUNDING','APPLIED') AND payment_id IS NOT NULL AND confirmed_at IS NOT NULL) OR state IN ('PENDING','CANCELLED'));
CREATE TABLE prsystem.checkin_funding_return (
 tenant_id text NOT NULL,funding_id text NOT NULL,actor_id text NOT NULL,reason text NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,provider_reference text,
 confirmation_envelope jsonb,PRIMARY KEY(tenant_id,funding_id),
 FOREIGN KEY(tenant_id,funding_id) REFERENCES prsystem.checkin_funding,
 CHECK((completed_at IS NULL AND provider_reference IS NULL AND confirmation_envelope IS NULL) OR
 (completed_at IS NOT NULL AND provider_reference IS NOT NULL AND confirmation_envelope IS NOT NULL))
);
CREATE UNIQUE INDEX one_funding_return_reference ON prsystem.checkin_funding_return(tenant_id,provider_reference) WHERE provider_reference IS NOT NULL;
CREATE FUNCTION prsystem.preserve_funding_return() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable funding return' USING ERRCODE='23514'; END IF;
 IF OLD.completed_at IS NOT NULL OR (to_jsonb(NEW)-ARRAY['completed_at','provider_reference','confirmation_envelope']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['completed_at','provider_reference','confirmation_envelope']) THEN
 RAISE EXCEPTION 'Immutable funding return' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER funding_return_immutable BEFORE UPDATE OR DELETE ON prsystem.checkin_funding_return FOR EACH ROW EXECUTE FUNCTION prsystem.preserve_funding_return();
REVOKE ALL ON prsystem.checkin_funding_return FROM PUBLIC;
