-- Recorded identity/time are authority for LIFE-DEC-008, never editable facts.
CREATE TRIGGER reception_shift_identity_immutable
BEFORE UPDATE OF tenant_id,id,owner_id,drawer_id,opening_actual,opened_at,owner_roles
ON prsystem.reception_shift FOR EACH ROW
EXECUTE FUNCTION prsystem.reject_history_mutation();

CREATE FUNCTION prsystem.reception_shift_terminal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.state='CLOSED' AND (NEW.state<>OLD.state OR NEW.closed_at IS DISTINCT FROM OLD.closed_at) THEN
        RAISE EXCEPTION 'closed shift is terminal';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER reception_shift_terminal BEFORE UPDATE ON prsystem.reception_shift
FOR EACH ROW EXECUTE FUNCTION prsystem.reception_shift_terminal_guard();
ALTER TABLE prsystem.reception_shift ADD CONSTRAINT reception_shift_close_consistency
CHECK ((state='OPEN' AND closed_at IS NULL) OR
       (state='CLOSED' AND closed_at IS NOT NULL AND closed_at>=opened_at));
