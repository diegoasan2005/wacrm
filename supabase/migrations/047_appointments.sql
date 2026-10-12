-- ============================================================
-- 047_appointments.sql — Services + Appointment scheduling
--
-- Adds two modules to WACRM:
--   1. appointment_services  — bookable services per account
--   2. appointments          — bookings linking a contact, a
--                              service and a member (specialist)
--   3. appointment_member_schedules / appointment_schedule_exceptions
--      — per-member working hours
--   4. appointment_history   — trigger-written audit trail
--
-- Plus:
--   - profiles.can_book_appointments — per-membership "Puede
--     registrar citas" flag (agents; membership IS the profile row
--     since 017, so the flag is naturally per-account).
--   - accounts.timezone — presentation + scheduling timezone,
--     default 'America/Bogota' (configurable per account).
--   - contacts extensions: identification, last_name, birth_month,
--     birth_day (all nullable / additive — nothing destructive).
--
-- Design notes
--   - Overlap protection is a GiST EXCLUDE constraint on
--     (assigned_user_id, tstzrange(starts_at, ends_at)) restricted
--     to the statuses that block a slot (PENDIENTE, CONFIRMADA,
--     LLEGA TARDE). Two requests racing for the same slot cannot
--     both commit regardless of what the app validates — the
--     constraint is the concurrency backstop. `[)` range bounds
--     make back-to-back appointments (end == start) legal.
--   - FINALIZADA / CANCELADA / NO LLEGA rows don't block the slot.
--     They are kept as history (never auto-deleted).
--   - All writes go through RLS + (for appointments) BEFORE
--     triggers that re-check the caller's authority, so a crafted
--     direct call to PostgREST is bound by the same rules as the
--     UI. created_by is always forced to auth.uid(); account_id is
--     derived server-side from the referenced rows, never trusted
--     from the payload.
--   - Status transition rules live in a trigger, not the client:
--     agents get the operational map, admin+ can make corrections,
--     and terminal states (CANCELADA / FINALIZADA) need admin+.
--   - If a member has no schedule rows, any time is bookable for
--     them (documented initial behaviour — adding a schedule row
--     is what turns the guard on).
--   - Realtime: appointments is added to the supabase_realtime
--     publication so the agenda can live-update. Wrapped in a
--     DO block because the publication may not exist on
--     non-Supabase Postgres instances.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ============================================================
-- ACCOUNTS: timezone
-- ============================================================
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Bogota';

-- ============================================================
-- PROFILES: "Puede registrar citas" flag
-- Meaningful for agents; admin+ can always book, viewers never.
-- ============================================================
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS can_book_appointments BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- CONTACTS: scheduling-friendly extensions (additive only)
-- ============================================================
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS identification TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_name TEXT,
  ADD COLUMN IF NOT EXISTS birth_month SMALLINT CHECK (birth_month BETWEEN 1 AND 12),
  ADD COLUMN IF NOT EXISTS birth_day SMALLINT CHECK (birth_day BETWEEN 1 AND 31);

CREATE INDEX IF NOT EXISTS idx_contacts_account_identification
  ON contacts(account_id, identification)
  WHERE identification <> '';

-- ============================================================
-- TYPES
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'appointment_status_enum') THEN
    CREATE TYPE appointment_status_enum AS ENUM (
      'PENDIENTE', 'CONFIRMADA', 'LLEGA TARDE',
      'NO LLEGA', 'CANCELADA', 'FINALIZADA'
    );
  END IF;
END $$;

-- ============================================================
-- APPOINTMENT_SERVICES
-- ============================================================
CREATE TABLE IF NOT EXISTS appointment_services (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  description TEXT,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0 AND duration_minutes <= 24 * 60),
  price NUMERIC(12,2) CHECK (price IS NULL OR price >= 0),
  color TEXT CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$'),
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  available_for_booking BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- No duplicate names inside one account (case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_services_account_name
  ON appointment_services(account_id, lower(trim(name)));

-- Exactly one default per account, enforced by the DB.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_services_one_default
  ON appointment_services(account_id)
  WHERE is_default;

CREATE INDEX IF NOT EXISTS idx_appointment_services_account_active
  ON appointment_services(account_id, is_active);

ALTER TABLE appointment_services ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON appointment_services;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON appointment_services
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- APPOINTMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  service_id UUID REFERENCES appointment_services(id) ON DELETE SET NULL,
  -- Historical snapshot: a later rename/delete of the service must
  -- not rewrite what the appointment actually was.
  service_name TEXT,
  -- auth.users id of the member who attends (specialist).
  assigned_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  status appointment_status_enum NOT NULL DEFAULT 'PENDIENTE',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT appointments_ends_after_starts CHECK (ends_at > starts_at),
  -- ends_at is derived from starts_at + duration_minutes; kept as a
  -- CHECK so the overlap constraint below can never be gamed by a
  -- mismatched pair written through a path other than the RPC.
  CONSTRAINT appointments_duration_consistent CHECK (
    ends_at = starts_at + make_interval(mins => duration_minutes)
  )
);
-- NOTE: there is deliberately NO CHECK constraining `status` to the
-- blocking set — a CHECK fires on EVERY UPDATE too, which would
-- make CANCELADA / NO LLEGA unreachable. The initial state is
-- guaranteed by create_appointment (it only inserts PENDIENTE).
-- NOTE: cross-account consistency (contact/service must belong to
-- the same account) can NOT be a CHECK constraint — Postgres
-- forbids subqueries inside CHECK. It is enforced by the
-- appointments_account_guard trigger below instead.

-- Concurrency backstop: one blocking appointment per specialist per
-- time range. [) bounds make consecutive appointments legal. A race
-- that the app-level pre-check misses still cannot double-commit.
-- NOTE: exclusion constraints can only be declared via
-- ALTER TABLE ... ADD CONSTRAINT ... EXCLUDE — a `CREATE UNIQUE
-- INDEX ... USING gist` does not accept the WITH operator clause.
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_no_overlap;
ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (
    assigned_user_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('PENDIENTE', 'CONFIRMADA', 'LLEGA TARDE'));

CREATE INDEX IF NOT EXISTS idx_appointments_account_starts
  ON appointments(account_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_assigned_starts
  ON appointments(assigned_user_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_contact
  ON appointments(contact_id);

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON appointments;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- ACCOUNT-CONSISTENCY GUARD (BEFORE INSERT / UPDATE)
--
-- The CHECK-constraint equivalent of "every referenced row lives in
-- the same account as the appointment" (CHECK can't hold a
-- subquery). Makes cross-account references impossible even for a
-- crafted direct PostgREST write, regardless of the RPC layer.
-- ============================================================
CREATE OR REPLACE FUNCTION appointment_guard_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM contacts c
    WHERE c.id = NEW.contact_id AND c.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'Contact does not belong to the appointment account'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.service_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM appointment_services s
    WHERE s.id = NEW.service_id AND s.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'Service does not belong to the appointment account'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION appointment_guard_account() OWNER TO postgres;

DROP TRIGGER IF EXISTS appointments_account_guard ON appointments;
CREATE TRIGGER appointments_account_guard
  BEFORE INSERT OR UPDATE OF contact_id, service_id, account_id ON appointments
  FOR EACH ROW
  EXECUTE FUNCTION appointment_guard_account();

-- ============================================================
-- APPOINTMENT_MEMBER_SCHEDULES
-- Working windows per member + weekday. No rows = always bookable
-- (documented initial behaviour; row presence turns the guard on).
-- ============================================================
CREATE TABLE IF NOT EXISTS appointment_member_schedules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- 0 = Sunday … 6 = Saturday (Postgres DOW convention).
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL CHECK (end_time > start_time),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, user_id, day_of_week, start_time)
);

CREATE INDEX IF NOT EXISTS idx_appointment_schedules_member
  ON appointment_member_schedules(account_id, user_id, day_of_week);

ALTER TABLE appointment_member_schedules ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- APPOINTMENT_SCHEDULE_EXCEPTIONS
-- Date-scoped overrides: 'unavailable' blocks the whole day (or
-- start_time..end_time when given); 'available' opens a window on
-- an otherwise-blocked day.
-- ============================================================
CREATE TABLE IF NOT EXISTS appointment_schedule_exceptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  exception_type TEXT NOT NULL CHECK (exception_type IN ('unavailable', 'available')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT appointment_schedule_exceptions_window CHECK (
    (start_time IS NULL AND end_time IS NULL) OR
    (start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)
  )
);

CREATE INDEX IF NOT EXISTS idx_appointment_exceptions_member_date
  ON appointment_schedule_exceptions(account_id, user_id, date);

ALTER TABLE appointment_schedule_exceptions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- APPOINTMENT_HISTORY
-- Written exclusively by the audit trigger (SECURITY DEFINER), so
-- clients get SELECT only — the trail cannot be rewritten.
-- ============================================================
CREATE TABLE IF NOT EXISTS appointment_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  previous_values JSONB,
  new_values JSONB,
  changed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointment_history_appointment
  ON appointment_history(appointment_id, created_at);

ALTER TABLE appointment_history ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- PERMISSION HELPERS
-- ============================================================

-- True when the caller (auth.uid()) may create/edit appointments
-- for `p_assigned_user_id` inside `p_account_id`:
--   admin+/owner      — any member of their account
--   agent             — only themselves, and only with the flag
--   viewer            — never
CREATE OR REPLACE FUNCTION appointment_write_allowed(
  p_account_id UUID,
  p_assigned_user_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = p_account_id
      AND (
        CASE p.account_role
          WHEN 'owner' THEN 4
          WHEN 'admin' THEN 3
          WHEN 'agent' THEN 2
          WHEN 'viewer' THEN 1
        END >= 3
        OR (
          p.account_role = 'agent'
          AND p.can_book_appointments
          AND p_assigned_user_id = auth.uid()
        )
      )
  );
$$;

-- True when the caller may READ the appointment row:
--   everyone in the account EXCEPT agents, who only see their own.
CREATE OR REPLACE FUNCTION appointment_read_allowed(
  p_account_id UUID,
  p_assigned_user_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = p_account_id
      AND (
        p.account_role IN ('owner', 'admin', 'viewer')
        OR (
          p.account_role = 'agent'
          AND p_assigned_user_id = auth.uid()
        )
      )
  );
$$;

ALTER FUNCTION appointment_write_allowed(UUID, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION appointment_write_allowed(UUID, UUID) TO authenticated, service_role;
ALTER FUNCTION appointment_read_allowed(UUID, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION appointment_read_allowed(UUID, UUID) TO authenticated, service_role;

-- ============================================================
-- RLS — APPOINTMENT_SERVICES
-- Everyone reads (agents need the menu to book); admin+ writes.
-- ============================================================
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('appointment_services', 'appointments',
                        'appointment_member_schedules',
                        'appointment_schedule_exceptions',
                        'appointment_history')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END $$;

CREATE POLICY appointment_services_select ON appointment_services FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY appointment_services_insert ON appointment_services FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY appointment_services_update ON appointment_services FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY appointment_services_delete ON appointment_services FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- RLS — APPOINTMENTS
-- ============================================================
CREATE POLICY appointments_select ON appointments FOR SELECT
  USING (appointment_read_allowed(account_id, assigned_user_id));

CREATE POLICY appointments_insert ON appointments FOR INSERT
  WITH CHECK (appointment_write_allowed(account_id, assigned_user_id));

CREATE POLICY appointments_update ON appointments FOR UPDATE
  USING (appointment_write_allowed(account_id, assigned_user_id))
  WITH CHECK (appointment_write_allowed(account_id, assigned_user_id));

-- Deleting history is an admin operation; regular flow cancels.
CREATE POLICY appointments_delete ON appointments FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- RLS — SCHEDULES / EXCEPTIONS
-- Everyone reads (the agenda needs availability); admin+ writes.
-- ============================================================
CREATE POLICY appointment_schedules_select ON appointment_member_schedules FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY appointment_schedules_modify ON appointment_member_schedules FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

CREATE POLICY appointment_exceptions_select ON appointment_schedule_exceptions FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY appointment_exceptions_modify ON appointment_schedule_exceptions FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- ============================================================
-- RLS — HISTORY
-- ============================================================
CREATE POLICY appointment_history_select ON appointment_history FOR SELECT
  USING (is_account_member(account_id));
-- No client INSERT/UPDATE/DELETE — the audit trigger is SECURITY DEFINER.

-- ============================================================
-- STATUS TRANSITION GUARD (BEFORE UPDATE on appointments)
--
-- Agent map (only their own rows — RLS already scopes that):
--   PENDIENTE   → CONFIRMADA, LLEGA TARDE, NO LLEGA, CANCELADA
--   CONFIRMADA  → LLEGA TARDE, NO LLEGA, FINALIZADA, CANCELADA
--   LLEGA TARDE → FINALIZADA, NO LLEGA, CANCELADA
-- Admin+/owner: any transition (documented correction path, the
-- audit trail records it).
-- Terminal states (CANCELADA / FINALIZADA): admin+ only.
-- ============================================================
CREATE OR REPLACE FUNCTION appointment_guard_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role account_role_enum;
  v_is_own BOOLEAN;
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT account_role, (user_id = auth.uid())
  INTO v_role, v_is_own
  FROM profiles
  WHERE account_id = NEW.account_id AND user_id = auth.uid();

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Caller is not a member of this account'
      USING ERRCODE = '42501';
  END IF;

  IF v_role = 'agent' THEN
    IF NOT v_is_own THEN
      RAISE EXCEPTION 'Agents can only change the status of their own appointments'
        USING ERRCODE = '42501';
    END IF;
    IF OLD.status = 'CANCELADA' OR OLD.status = 'FINALIZADA' THEN
      RAISE EXCEPTION 'Terminal appointments can only be corrected by an administrator'
        USING ERRCODE = '42501';
    END IF;
    IF NOT (
      (OLD.status = 'PENDIENTE'   AND NEW.status IN ('CONFIRMADA', 'LLEGA TARDE', 'NO LLEGA', 'CANCELADA'))
      OR
      (OLD.status = 'CONFIRMADA'  AND NEW.status IN ('LLEGA TARDE', 'NO LLEGA', 'FINALIZADA', 'CANCELADA'))
      OR
      (OLD.status = 'LLEGA TARDE' AND NEW.status IN ('FINALIZADA', 'NO LLEGA', 'CANCELADA'))
    ) THEN
      RAISE EXCEPTION 'Status transition % → % is not allowed for agents',
        OLD.status, NEW.status
        USING ERRCODE = '22023';
    END IF;
  ELSIF v_role = 'viewer' THEN
    RAISE EXCEPTION 'Viewers cannot change appointment statuses'
      USING ERRCODE = '42501';
  END IF;
  -- owner / admin: allowed (correction path), audit trail records it.

  -- Bookkeeping for cancellations.
  IF NEW.status = 'CANCELADA' AND OLD.status <> 'CANCELADA' THEN
    NEW.cancelled_at := NOW();
    NEW.cancelled_by := auth.uid();
  ELSIF NEW.status <> 'CANCELADA' THEN
    NEW.cancelled_at := NULL;
    NEW.cancelled_by := NULL;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION appointment_guard_transition() OWNER TO postgres;

DROP TRIGGER IF EXISTS appointments_transition_guard ON appointments;
CREATE TRIGGER appointments_transition_guard
  BEFORE UPDATE ON appointments
  FOR EACH ROW
  EXECUTE FUNCTION appointment_guard_transition();

-- ============================================================
-- AUDIT TRAIL (AFTER INSERT / UPDATE / DELETE)
-- ============================================================
CREATE OR REPLACE FUNCTION appointment_write_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO appointment_history
      (account_id, appointment_id, action, previous_values, new_values, changed_by)
    VALUES
      (NEW.account_id, NEW.id, 'created', NULL, to_jsonb(NEW), auth.uid());
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO appointment_history
      (account_id, appointment_id, action, previous_values, new_values, changed_by)
    VALUES
      (NEW.account_id, NEW.id, 'updated', to_jsonb(OLD), to_jsonb(NEW), auth.uid());
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO appointment_history
      (account_id, appointment_id, action, previous_values, new_values, changed_by)
    VALUES
      (OLD.account_id, OLD.id, 'deleted', to_jsonb(OLD), NULL, auth.uid());
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

ALTER FUNCTION appointment_write_history() OWNER TO postgres;

DROP TRIGGER IF EXISTS appointments_audit ON appointments;
CREATE TRIGGER appointments_audit
  AFTER INSERT OR UPDATE OR DELETE ON appointments
  FOR EACH ROW
  EXECUTE FUNCTION appointment_write_history();

-- ============================================================
-- AVAILABILITY VALIDATION
--
-- Shared by create/update. Raises (22023) when the requested
-- window falls outside the specialist's configured working hours
-- or inside an 'unavailable' exception. Members with no schedule
-- rows are always bookable. All wall-clock math runs in the
-- account timezone.
-- ============================================================
CREATE OR REPLACE FUNCTION appointment_validate_window(
  p_account_id UUID,
  p_assigned_user_id UUID,
  p_starts_at TIMESTAMPTZ,
  p_ends_at TIMESTAMPTZ
) RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz TEXT;
  v_local_start TIMESTAMP;
  v_local_end TIMESTAMP;
  v_dow SMALLINT;
  v_has_schedule BOOLEAN;
  v_open_windows INT;
  v_exceptions INT;
BEGIN
  SELECT timezone INTO v_tz FROM accounts WHERE id = p_account_id;
  v_tz := COALESCE(v_tz, 'America/Bogota');

  v_local_start := p_starts_at AT TIME ZONE v_tz;
  v_local_end   := p_ends_at   AT TIME ZONE v_tz;
  v_dow         := EXTRACT(DOW FROM v_local_start);

  SELECT EXISTS (
    SELECT 1 FROM appointment_member_schedules
    WHERE account_id = p_account_id
      AND user_id = p_assigned_user_id
      AND is_active
  ) INTO v_has_schedule;

  IF v_has_schedule THEN
    -- Must start AND end inside one open window on that weekday.
    SELECT count(*) INTO v_open_windows
    FROM appointment_member_schedules s
    WHERE s.account_id = p_account_id
      AND s.user_id = p_assigned_user_id
      AND s.is_active
      AND s.day_of_week = v_dow
      AND v_local_start::time >= s.start_time
      AND v_local_end::time   <= s.end_time;

    IF v_open_windows = 0 THEN
      RAISE EXCEPTION 'The requested time is outside the specialist working hours'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 'unavailable' exceptions block the whole day (null window) or
  -- the given range. Overlap against [start, end).
  SELECT count(*) INTO v_exceptions
  FROM appointment_schedule_exceptions e
  WHERE e.account_id = p_account_id
    AND e.user_id = p_assigned_user_id
    AND e.exception_type = 'unavailable'
    AND e.date = v_local_start::date
    AND (
      (e.start_time IS NULL)
      OR (v_local_start::time < e.end_time AND v_local_end::time > e.start_time)
    );

  IF v_exceptions > 0 THEN
    RAISE EXCEPTION 'The specialist is not available on that date'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

ALTER FUNCTION appointment_validate_window(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION appointment_validate_window(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;

-- ============================================================
-- RPC — set_member_booking_permission(p_user_id, p_can_book)
-- Admin+ toggles an agent's "Puede registrar citas" flag.
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_member_booking_permission(
  p_user_id UUID,
  p_can_book BOOLEAN
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_target_account_id, v_target_role
  FROM profiles WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'The owner always has booking permissions'
      USING ERRCODE = '22023';
  END IF;

  IF v_target_role <> 'agent' THEN
    RAISE EXCEPTION 'The booking permission only applies to agents'
      USING ERRCODE = '22023';
  END IF;

  UPDATE profiles
  SET can_book_appointments = p_can_book
  WHERE user_id = p_user_id;
END;
$$;

ALTER FUNCTION public.set_member_booking_permission(UUID, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_booking_permission(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_booking_permission(UUID, BOOLEAN) TO authenticated;

-- ============================================================
-- RPC — set_default_service(p_service_id)
-- Atomically moves the account default flag to one service.
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_default_service(p_service_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id INTO v_account_id
  FROM appointment_services WHERE id = p_service_id;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Service not found' USING ERRCODE = '22023';
  END IF;

  IF NOT is_account_member(v_account_id, 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  UPDATE appointment_services
  SET is_default = false
  WHERE account_id = v_account_id AND is_default AND id <> p_service_id;

  UPDATE appointment_services
  SET is_default = true
  WHERE id = p_service_id;
END;
$$;

ALTER FUNCTION public.set_default_service(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_default_service(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_default_service(UUID) TO authenticated;

-- ============================================================
-- RPC — create_appointment(...)
-- The single write path for new bookings. Validates permission,
-- cross-account references, service availability, the specialist's
-- working window and (as backstop, via the EXCLUDE index) overlap.
-- Returns the inserted row.
--
-- The overlap pre-check exists for a friendly error message; the
-- unique-exclusion index is what actually guarantees no double
-- booking under concurrency (we re-raise it as the same friendly
-- message in the exception handler).
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_appointment(
  p_contact_id UUID,
  p_service_id UUID,
  p_assigned_user_id UUID,
  p_starts_at TIMESTAMPTZ,
  p_duration_minutes INTEGER,
  p_notes TEXT DEFAULT NULL
) RETURNS appointments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_contact_account UUID;
  v_service record;
  v_assigned_account UUID;
  v_assigned_role account_role_enum;
  v_ends_at TIMESTAMPTZ;
  v_overlaps INT;
  v_row appointments;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role = 'viewer' THEN
    RAISE EXCEPTION 'Viewers cannot create appointments' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role = 'agent' THEN
    IF p_assigned_user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Agents can only create appointments for themselves'
        USING ERRCODE = '42501';
    END IF;
    IF NOT (
      SELECT can_book_appointments FROM profiles WHERE user_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'You do not have permission to register appointments'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Contact must exist and belong to the caller's account.
  SELECT account_id INTO v_contact_account
  FROM contacts WHERE id = p_contact_id;
  IF v_contact_account IS NULL OR v_contact_account <> v_caller_account_id THEN
    RAISE EXCEPTION 'Contact not found in your account' USING ERRCODE = '22023';
  END IF;

  -- Service must exist, belong to the account, and be active +
  -- bookable.
  SELECT * INTO v_service FROM appointment_services WHERE id = p_service_id;
  IF v_service.id IS NULL OR v_service.account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Service not found in your account' USING ERRCODE = '22023';
  END IF;
  IF NOT v_service.is_active OR NOT v_service.available_for_booking THEN
    RAISE EXCEPTION 'The selected service is not available for booking'
      USING ERRCODE = '22023';
  END IF;

  IF p_duration_minutes IS NULL OR p_duration_minutes <= 0 THEN
    RAISE EXCEPTION 'Invalid duration' USING ERRCODE = '22023';
  END IF;

  -- Specialist must be a member of the same account (never a
  -- viewer — they don't attend customers) and never from another
  -- account.
  SELECT p.account_id, p.account_role
  INTO v_assigned_account, v_assigned_role
  FROM profiles p WHERE p.user_id = p_assigned_user_id;
  IF v_assigned_account IS NULL
     OR v_assigned_account <> v_caller_account_id
     OR v_assigned_role = 'viewer' THEN
    RAISE EXCEPTION 'The selected specialist is not eligible in your account'
      USING ERRCODE = '22023';
  END IF;

  v_ends_at := p_starts_at + make_interval(mins => p_duration_minutes);

  IF v_ends_at <= p_starts_at THEN
    RAISE EXCEPTION 'Invalid appointment window' USING ERRCODE = '22023';
  END IF;

  -- Working hours / exceptions.
  PERFORM appointment_validate_window(
    v_caller_account_id, p_assigned_user_id, p_starts_at, v_ends_at
  );

  -- Friendly overlap pre-check (blocking statuses only).
  SELECT count(*) INTO v_overlaps
  FROM appointments a
  WHERE a.assigned_user_id = p_assigned_user_id
    AND a.status IN ('PENDIENTE', 'CONFIRMADA', 'LLEGA TARDE')
    AND tstzrange(p_starts_at, v_ends_at, '[)') && tstzrange(a.starts_at, a.ends_at, '[)');

  IF v_overlaps > 0 THEN
    RAISE EXCEPTION 'That time slot is already taken for this specialist'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    INSERT INTO appointments (
      account_id, contact_id, service_id, service_name,
      assigned_user_id, created_by, starts_at, ends_at,
      duration_minutes, status, notes
    ) VALUES (
      v_caller_account_id, p_contact_id, p_service_id, v_service.name,
      p_assigned_user_id, auth.uid(), p_starts_at, v_ends_at,
      p_duration_minutes, 'PENDIENTE', p_notes
    )
    ON CONFLICT DO NOTHING
    RETURNING * INTO v_row;

    IF v_row.id IS NULL THEN
      -- Lost a race against the EXCLUDE index.
      RAISE EXCEPTION 'That time slot is already taken for this specialist'
        USING ERRCODE = '22023';
    END IF;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'That time slot is already taken for this specialist'
      USING ERRCODE = '22023';
  END;

  RETURN v_row;
END;
$$;

ALTER FUNCTION public.create_appointment(UUID, UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_appointment(UUID, UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_appointment(UUID, UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT) TO authenticated;

-- ============================================================
-- RPC — update_appointment(p_id, ...)
-- NULL = keep current value. Validates the same rules as create,
-- for the resulting row. Agents may only edit their own
-- appointments (and never reassign them); viewers can't write;
-- admin+ can do everything within the account.
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_appointment(
  p_id UUID,
  p_contact_id UUID DEFAULT NULL,
  p_service_id UUID DEFAULT NULL,
  p_assigned_user_id UUID DEFAULT NULL,
  p_starts_at TIMESTAMPTZ DEFAULT NULL,
  p_duration_minutes INTEGER DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
) RETURNS appointments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cur appointments;
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_new_assigned UUID;
  v_new_start TIMESTAMPTZ;
  v_new_duration INTEGER;
  v_new_end TIMESTAMPTZ;
  v_new_contact UUID;
  v_new_service UUID;
  v_service_name TEXT;
  v_overlaps INT;
  v_row appointments;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_cur FROM appointments WHERE id = p_id;
  IF v_cur.id IS NULL THEN
    RAISE EXCEPTION 'Appointment not found' USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL OR v_caller_account_id <> v_cur.account_id THEN
    RAISE EXCEPTION 'Appointment not found in your account' USING ERRCODE = '22023';
  END IF;

  IF v_caller_role = 'viewer' THEN
    RAISE EXCEPTION 'Viewers cannot edit appointments' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role = 'agent' THEN
    IF v_cur.assigned_user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Agents can only edit their own appointments'
        USING ERRCODE = '42501';
    END IF;
    IF NOT (
      SELECT can_book_appointments FROM profiles WHERE user_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'You do not have permission to edit appointments'
        USING ERRCODE = '42501';
    END IF;
    -- Reassignment is an admin operation.
    IF p_assigned_user_id IS NOT NULL
       AND p_assigned_user_id IS DISTINCT FROM v_cur.assigned_user_id THEN
      RAISE EXCEPTION 'Only administrators can reassign appointments'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_cur.status IN ('CANCELADA', 'FINALIZADA') AND v_caller_role = 'agent' THEN
    RAISE EXCEPTION 'Terminal appointments can only be corrected by an administrator'
      USING ERRCODE = '42501';
  END IF;

  -- Resolve effective new values.
  v_new_assigned    := COALESCE(p_assigned_user_id, v_cur.assigned_user_id);
  v_new_start       := COALESCE(p_starts_at, v_cur.starts_at);
  v_new_duration    := COALESCE(p_duration_minutes, v_cur.duration_minutes);
  v_new_contact     := COALESCE(p_contact_id, v_cur.contact_id);
  v_new_service     := COALESCE(p_service_id, v_cur.service_id);
  v_new_end         := v_new_start + make_interval(mins => v_new_duration);

  IF v_new_duration <= 0 THEN
    RAISE EXCEPTION 'Invalid duration' USING ERRCODE = '22023';
  END IF;

  -- Cross-account guards on the new references.
  IF NOT EXISTS (
    SELECT 1 FROM contacts c
    WHERE c.id = v_new_contact AND c.account_id = v_cur.account_id
  ) THEN
    RAISE EXCEPTION 'Contact not found in your account' USING ERRCODE = '22023';
  END IF;

  IF v_new_service IS DISTINCT FROM v_cur.service_id THEN
    SELECT name INTO v_service_name
    FROM appointment_services
    WHERE id = v_new_service AND account_id = v_cur.account_id;
    IF v_service_name IS NULL THEN
      RAISE EXCEPTION 'Service not found in your account' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM appointment_services
      WHERE id = v_new_service AND is_active AND available_for_booking
    ) AND v_cur.status IN ('PENDIENTE', 'CONFIRMADA', 'LLEGA TARDE') THEN
      RAISE EXCEPTION 'The selected service is not available for booking'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    SELECT name INTO v_service_name
    FROM appointment_services WHERE id = v_new_service;
  END IF;

  -- Specialist reassignment target must be eligible.
  IF v_new_assigned IS DISTINCT FROM v_cur.assigned_user_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM profiles
      WHERE user_id = v_new_assigned
        AND account_id = v_cur.account_id
        AND account_role IN ('owner', 'admin', 'agent')
    ) THEN
      RAISE EXCEPTION 'The selected specialist is not eligible in your account'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Window validation when the time / specialist / duration changed.
  IF (v_new_start, v_new_end, v_new_assigned) IS DISTINCT FROM
     (v_cur.starts_at, v_cur.ends_at, v_cur.assigned_user_id) THEN
    PERFORM appointment_validate_window(
      v_cur.account_id, v_new_assigned, v_new_start, v_new_end
    );

    SELECT count(*) INTO v_overlaps
    FROM appointments a
    WHERE a.id <> v_cur.id
      AND a.assigned_user_id = v_new_assigned
      AND a.status IN ('PENDIENTE', 'CONFIRMADA', 'LLEGA TARDE')
      AND tstzrange(v_new_start, v_new_end, '[)') && tstzrange(a.starts_at, a.ends_at, '[)');

    IF v_overlaps > 0 THEN
      RAISE EXCEPTION 'That time slot is already taken for this specialist'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  BEGIN
    UPDATE appointments SET
      contact_id        = v_new_contact,
      service_id        = v_new_service,
      service_name      = COALESCE(v_service_name, service_name),
      assigned_user_id  = v_new_assigned,
      starts_at         = v_new_start,
      ends_at           = v_new_end,
      duration_minutes  = v_new_duration,
      notes             = COALESCE(p_notes, notes)
    WHERE id = p_id
    RETURNING * INTO v_row;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'That time slot is already taken for this specialist'
      USING ERRCODE = '22023';
  END;

  RETURN v_row;
END;
$$;

ALTER FUNCTION public.update_appointment(UUID, UUID, UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.update_appointment(UUID, UUID, UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_appointment(UUID, UUID, UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT) TO authenticated;

-- ============================================================
-- RPC — reschedule_appointment(p_id, p_starts_at, p_duration_minutes)
-- Thin semantic wrapper over update_appointment used by the
-- drag-and-reschedule UI paths, so the call site reads clearly.
-- ============================================================
CREATE OR REPLACE FUNCTION public.reschedule_appointment(
  p_id UUID,
  p_starts_at TIMESTAMPTZ,
  p_duration_minutes INTEGER DEFAULT NULL
) RETURNS appointments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.update_appointment(p_id, NULL, NULL, NULL, p_starts_at, p_duration_minutes, NULL);
END;
$$;

ALTER FUNCTION public.reschedule_appointment(UUID, TIMESTAMPTZ, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reschedule_appointment(UUID, TIMESTAMPTZ, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reschedule_appointment(UUID, TIMESTAMPTZ, INTEGER) TO authenticated;

-- ============================================================
-- REALTIME — publish appointments for live agenda updates
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'appointments'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.appointments;
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Could not add appointments to supabase_realtime: %', SQLERRM;
END $$;
