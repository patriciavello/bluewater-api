CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL,

  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  is_goldmember BOOLEAN NOT NULL DEFAULT FALSE,
  is_captain BOOLEAN NOT NULL DEFAULT FALSE,

  first_name TEXT,
  last_name TEXT,

  address1 TEXT,
  address2 TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  country TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS boats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT,
  capacity INT,
  number_of_beds INT,
  location TEXT,
  image_url TEXT,
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS certifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asa_id TEXT,
  course_code TEXT NOT NULL,
  cert_date DATE,
  instructor_name TEXT,
  boat_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, course_code)
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reservation_status') THEN
    CREATE TYPE reservation_status AS ENUM (
      'PENDING',
      'APPROVED',
      'DENIED',
      'CANCEL_REQUESTED',
      'CHANGE_REQUESTED',
      'CANCELED',
      'BLOCKED'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  boat_id UUID NOT NULL REFERENCES boats(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  start_date DATE NOT NULL,
  end_exclusive DATE NOT NULL,

  status reservation_status NOT NULL,
  created_by_admin BOOLEAN NOT NULL DEFAULT FALSE,

  captain_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT end_after_start CHECK (end_exclusive > start_date)
);

-- ✅ Prevent overlap for ACTIVE reservations only (ignore DENIED/CANCELED)
-- We'll use a partial exclusion by splitting into a generated column approach:
-- simplest v1: do overlap checks in code OR keep this broad constraint.
-- For now, enforce overlap on statuses that should block:
-- PENDING, APPROVED, BLOCKED, CHANGE_REQUESTED, CANCEL_REQUESTED
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reservations_no_overlap'
  ) THEN
    ALTER TABLE reservations
      ADD CONSTRAINT reservations_no_overlap
      EXCLUDE USING GIST (
        boat_id WITH =,
        daterange(start_date, end_exclusive, '[)') WITH &&
      )
      WHERE (status IN ('PENDING','APPROVED','BLOCKED','CHANGE_REQUESTED','CANCEL_REQUESTED'));
  END IF;
END$$;


DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'request_type') THEN
    CREATE TYPE request_type AS ENUM ('CANCEL','CHANGE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'request_status') THEN
    CREATE TYPE request_status AS ENUM ('PENDING','APPROVED','DENIED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS reservation_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  type request_type NOT NULL,
  requested_changes JSONB,
  fee_quote JSONB,
  status request_status NOT NULL DEFAULT 'PENDING',
  admin_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fee_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type request_type NOT NULL,
  days_before_start_min INT NOT NULL,
  days_before_start_max INT NOT NULL,
  fee_amount_cents INT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
