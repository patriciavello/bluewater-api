-- 002_add_reservations_request_fields.sql

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS requester_name TEXT,
  ADD COLUMN IF NOT EXISTS requester_email TEXT;

