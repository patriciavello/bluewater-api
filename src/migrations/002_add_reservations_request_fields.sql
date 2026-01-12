ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS requester_name TEXT,
  ADD COLUMN IF NOT EXISTS requester_email TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT;

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS status TEXT;

ALTER TABLE reservations
  ALTER COLUMN status SET DEFAULT 'confirmed';
