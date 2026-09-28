-- RC-DEC-046: server-held ХУР lookup bound once to a check-in. No plaintext РД or names.
CREATE TABLE prsystem.xyp_lookup (
 tenant_id text NOT NULL, id text NOT NULL, actor_id text NOT NULL, lookup_token text NOT NULL,
 status text NOT NULL CHECK (status IN ('FOUND','NOT_FOUND','UNAVAILABLE')),
 reason text CHECK (reason IN ('NOT_CONFIGURED','TIMEOUT','PROVIDER_ERROR','INVALID_EVIDENCE')),
 envelope jsonb, consent_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, stay_id text,
 PRIMARY KEY (tenant_id,id),
 FOREIGN KEY (tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id),
 FOREIGN KEY (tenant_id,stay_id) REFERENCES prsystem.stay(tenant_id,id),
 CHECK (expires_at = created_at + interval '15 minutes'),
 CHECK (consent_at <= created_at),
 CHECK ((status='FOUND') = (envelope IS NOT NULL)),
 CHECK ((status='UNAVAILABLE') = (reason IS NOT NULL))
);
CREATE UNIQUE INDEX xyp_lookup_one_stay ON prsystem.xyp_lookup (tenant_id,stay_id) WHERE stay_id IS NOT NULL;
CREATE INDEX xyp_lookup_actor_recent ON prsystem.xyp_lookup (tenant_id,actor_id,created_at);
CREATE FUNCTION prsystem.guard_xyp_lookup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.stay_id IS NOT NULL OR NEW.stay_id IS NULL
    OR (to_jsonb(NEW)-'stay_id') IS DISTINCT FROM (to_jsonb(OLD)-'stay_id') THEN
  RAISE EXCEPTION 'xyp_lookup is append-only except one stay binding' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER xyp_lookup_guard BEFORE UPDATE OR DELETE ON prsystem.xyp_lookup
FOR EACH ROW EXECUTE FUNCTION prsystem.guard_xyp_lookup();
ALTER TABLE prsystem.xyp_lookup ENABLE ROW LEVEL SECURITY;
ALTER TABLE prsystem.xyp_lookup FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON prsystem.xyp_lookup
 USING (tenant_id=current_setting('prsystem.tenant_id',true)) WITH CHECK (tenant_id=current_setting('prsystem.tenant_id',true));
REVOKE ALL ON prsystem.xyp_lookup FROM PUBLIC;
REVOKE ALL ON FUNCTION prsystem.guard_xyp_lookup() FROM PUBLIC;
-- 018's inline CHECK is named stay_guest_identity_provenance_check (verified in pg_constraint).
ALTER TABLE prsystem.stay_guest_identity DROP CONSTRAINT stay_guest_identity_provenance_check;
ALTER TABLE prsystem.stay_guest_identity ADD CONSTRAINT stay_guest_identity_provenance_check
 CHECK (provenance='MANUAL' OR (provenance='XYP_VERIFIED' AND identity_type='MN_REG_NO'));
