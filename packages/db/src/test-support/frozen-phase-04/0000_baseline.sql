-- Baseline migration.
--
-- Establishes the database-level prerequisites the data model depends on, and
-- nothing else. It creates NO table: no platform, IAM, audit, outbox,
-- idempotency or business table exists before Phase 03 (ADR-0004).
--
-- btree_gist backs the GiST exclusion constraints that enforce non-overlapping
-- occupancy intervals; pgcrypto backs digest and random identifier generation.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;
