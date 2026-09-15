ALTER TABLE prsystem.booking_contract ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE prsystem.booking_contract ADD COLUMN platform_actor_id text REFERENCES prsystem.platform_account;
ALTER TABLE prsystem.booking_contract ADD CHECK((actor_id IS NULL)<>(platform_actor_id IS NULL));
