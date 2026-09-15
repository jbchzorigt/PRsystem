-- Historical role classification was absent before this migration. Unknown
-- records conservatively require Admin review; never invent historical roles.
ALTER TABLE prsystem.reception_shift ADD COLUMN owner_roles text[] NOT NULL DEFAULT ARRAY['UNKNOWN'];
