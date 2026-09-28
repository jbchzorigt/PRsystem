-- A newly opened stay has no released service payment. All subsequent credit
-- changes require the deferred linked-release proof introduced in migration 064.
CREATE FUNCTION prsystem.require_zero_initial_service_credit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.service_credit<>0 THEN
  RAISE EXCEPTION 'Initial service credit must be zero' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER initial_service_credit BEFORE INSERT ON prsystem.guest_finance
 FOR EACH ROW EXECUTE FUNCTION prsystem.require_zero_initial_service_credit();
