ALTER TABLE users
ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user',
ADD COLUMN IF NOT EXISTS membership_tier TEXT NOT NULL DEFAULT 'standard';

-- Optional: useful index
CREATE INDEX IF NOT EXISTS idx_users_membership_tier ON users (membership_tier);
