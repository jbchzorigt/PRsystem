-- =====================================================================
-- 0021 — The stay's booking reference is the booking's reference
--
-- Phase 08 declared `platform.stay.booking_ref` as a uuid, before a booking
-- existed to refer to. Phase 13 then gave a booking a reference the guest
-- holds — an 8–12 character code (`booking_ref_shape`) — and the fulfilment
-- contract looks a booking up by that code. The two never met: an ONLINE
-- check-in carrying a real reference failed at the insert, so no confirmed
-- booking could be fulfilled (Phase 22, `A-P22-3`).
--
-- Expand only: the column widens to text and takes the booking's own shape
-- rule; the partial index and the source/reference check are unchanged. No
-- row with a uuid reference exists anywhere, because no such check-in ever
-- succeeded.
-- =====================================================================

ALTER TABLE platform.stay
  ALTER COLUMN booking_ref TYPE text USING booking_ref::text;

ALTER TABLE platform.stay
  ADD CONSTRAINT stay_booking_ref_shape
    CHECK (booking_ref IS NULL OR booking_ref ~ '^[A-Z0-9]{8,12}$'::text);

-- The fulfilment conflict names the booking the same way (doc 05 §23).
ALTER TABLE platform.booking_fulfillment_conflict
  ALTER COLUMN booking_ref TYPE text USING booking_ref::text;

ALTER TABLE platform.booking_fulfillment_conflict
  ADD CONSTRAINT booking_fulfillment_conflict_booking_ref_shape
    CHECK (booking_ref ~ '^[A-Z0-9]{8,12}$'::text);
