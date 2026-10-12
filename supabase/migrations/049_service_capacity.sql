-- ============================================================
-- 049_service_capacity.sql — concurrent capacity per service
--
-- New column:
--   appointment_services.max_concurrent SMALLINT NOT NULL DEFAULT 1
--
-- A service may host up to `max_concurrent` simultaneous
-- appointments on the same specialist at the same time (a stylist
-- taking two manicures at 10:00, etc.).
--
-- This REPLACES the hard no-overlap EXCLUDE constraint from 047:
-- an exclusion constraint cannot express "up to N overlaps", so
-- slot safety now lives in the create/update RPCs, which:
--   1. take a transaction-scoped advisory lock on the specialist
--      (pg_advisory_xact_lock) — concurrent bookings for the same
--      specialist serialise, so the capacity count cannot race;
--   2. count overlapping blocking appointments and reject only
--      when the count has reached the service's capacity.
--
-- Consecutive appointments (end == start) remain legal.
--
-- Requires 048 to have been applied. Idempotent.
-- ============================================================

ALTER TABLE appointment_services
  ADD COLUMN IF NOT EXISTS max_concurrent SMALLINT NOT NULL DEFAULT 1;

-- Re-normalise any out-of-range values a manual write may have set
-- before the CHECK lands (CHECK below re-validates).
UPDATE appointment_services
SET max_concurrent = 1
WHERE max_concurrent < 1 OR max_concurrent > 50;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'appointment_services_max_concurrent_range'
  ) THEN
    ALTER TABLE appointment_services ADD CONSTRAINT
      appointment_services_max_concurrent_range
      CHECK (max_concurrent BETWEEN 1 AND 50);
  END IF;
END $$;

-- The EXCLUDE constraint can no longer express the rule (capacity
-- varies per service) — drop it; the RPC count + advisory lock take
-- over as the concurrency guarantee.
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_no_overlap;

-- ============================================================
-- RPC — create_appointment (capacity-aware)
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

  SELECT account_id INTO v_contact_account
  FROM contacts WHERE id = p_contact_id;
  IF v_contact_account IS NULL OR v_contact_account <> v_caller_account_id THEN
    RAISE EXCEPTION 'Contact not found in your account' USING ERRCODE = '22023';
  END IF;

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

  IF NOT appointment_specialist_eligible(v_caller_account_id, p_assigned_user_id) THEN
    RAISE EXCEPTION 'The selected specialist is not eligible in your account'
      USING ERRCODE = '22023';
  END IF;

  v_ends_at := p_starts_at + make_interval(mins => p_duration_minutes);

  IF v_ends_at <= p_starts_at THEN
    RAISE EXCEPTION 'Invalid appointment window' USING ERRCODE = '22023';
  END IF;

  PERFORM appointment_validate_window(
    v_caller_account_id, p_assigned_user_id, p_starts_at, v_ends_at
  );

  -- Serialise concurrent bookings for this specialist, then count
  -- overlaps against the service's capacity. Two racing requests
  -- cannot both pass: the second waits on the advisory lock and
  -- sees the first's committed row inside its own transaction.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_assigned_user_id::text, 0));

  SELECT count(*) INTO v_overlaps
  FROM appointments a
  WHERE a.assigned_user_id = p_assigned_user_id
    AND a.status IN ('PENDIENTE', 'CONFIRMADA', 'LLEGA TARDE')
    AND tstzrange(p_starts_at, v_ends_at, '[)') && tstzrange(a.starts_at, a.ends_at, '[)');

  IF v_overlaps >= v_service.max_concurrent THEN
    RAISE EXCEPTION 'That time slot is already taken for this specialist'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO appointments (
    account_id, contact_id, service_id, service_name,
    assigned_user_id, created_by, starts_at, ends_at,
    duration_minutes, status, notes
  ) VALUES (
    v_caller_account_id, p_contact_id, p_service_id, v_service.name,
    p_assigned_user_id, auth.uid(), p_starts_at, v_ends_at,
    p_duration_minutes, 'PENDIENTE', p_notes
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

ALTER FUNCTION public.create_appointment(UUID, UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_appointment(UUID, UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_appointment(UUID, UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT) TO authenticated;

-- ============================================================
-- RPC — update_appointment (capacity-aware)
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
  v_capacity INT;
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

  v_new_assigned    := COALESCE(p_assigned_user_id, v_cur.assigned_user_id);
  v_new_start       := COALESCE(p_starts_at, v_cur.starts_at);
  v_new_duration    := COALESCE(p_duration_minutes, v_cur.duration_minutes);
  v_new_contact     := COALESCE(p_contact_id, v_cur.contact_id);
  v_new_service     := COALESCE(p_service_id, v_cur.service_id);
  v_new_end         := v_new_start + make_interval(mins => v_new_duration);

  IF v_new_duration <= 0 THEN
    RAISE EXCEPTION 'Invalid duration' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM contacts c
    WHERE c.id = v_new_contact AND c.account_id = v_cur.account_id
  ) THEN
    RAISE EXCEPTION 'Contact not found in your account' USING ERRCODE = '22023';
  END IF;

  IF v_new_service IS DISTINCT FROM v_cur.service_id THEN
    SELECT name, max_concurrent INTO v_service_name, v_capacity
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
    SELECT name, max_concurrent INTO v_service_name, v_capacity
    FROM appointment_services WHERE id = v_new_service;
  END IF;
  v_capacity := COALESCE(v_capacity, 1);

  IF v_new_assigned IS DISTINCT FROM v_cur.assigned_user_id THEN
    IF NOT appointment_specialist_eligible(v_cur.account_id, v_new_assigned) THEN
      RAISE EXCEPTION 'The selected specialist is not eligible in your account'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF (v_new_start, v_new_end, v_new_assigned) IS DISTINCT FROM
     (v_cur.starts_at, v_cur.ends_at, v_cur.assigned_user_id) THEN
    PERFORM appointment_validate_window(
      v_cur.account_id, v_new_assigned, v_new_start, v_new_end
    );

    -- Same serialisation as create: lock the (new) specialist.
    PERFORM pg_advisory_xact_lock(hashtextextended(v_new_assigned::text, 0));

    SELECT count(*) INTO v_overlaps
    FROM appointments a
    WHERE a.id <> v_cur.id
      AND a.assigned_user_id = v_new_assigned
      AND a.status IN ('PENDIENTE', 'CONFIRMADA', 'LLEGA TARDE')
      AND tstzrange(v_new_start, v_new_end, '[)') && tstzrange(a.starts_at, a.ends_at, '[)');

    -- Capacity counts every OTHER overlapping appointment; this row
    -- keeps its slot, so no +1.
    IF v_overlaps >= v_capacity THEN
      RAISE EXCEPTION 'That time slot is already taken for this specialist'
        USING ERRCODE = '22023';
    END IF;
  END IF;

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

  RETURN v_row;
END;
$$;

ALTER FUNCTION public.update_appointment(UUID, UUID, UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.update_appointment(UUID, UUID, UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_appointment(UUID, UUID, UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT) TO authenticated;
