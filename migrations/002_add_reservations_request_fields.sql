-- 002_add_reservations_request_fields.sql

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS requester_name TEXT,
  ADD COLUMN IF NOT EXISTS requester_email TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT;

-- Default for existing + future rows
ALTER TABLE reservations
  ALTER COLUMN status SET DEFAULT 'confirmed';

-- If you already have rows and status is NULL, set them to confirmed
UPDATE reservations
SET status = 'confirmed'
WHERE status IS NULL;
