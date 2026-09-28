-- Preserve the bounded authentication audit vocabulary while allowing the
-- contact version and its audit record to commit in the same transaction.
ALTER TABLE prsystem.auth_event DROP CONSTRAINT auth_event_kind_check;
ALTER TABLE prsystem.auth_event ADD CONSTRAINT auth_event_kind_check CHECK
 (kind IN ('LOGIN','LOGOUT','LOGOUT_ALL','PASSWORD_CHANGED','CASH_READ_DENIED','SUBSCRIPTION_CONTACT_CHANGED'));
