-- ============================================================
-- 051_fix_status_constraints.sql — remove appointments_initial_status
--
-- appointments_initial_status (from 047) was a CHECK limiting the
-- status to the blocking set — but a CHECK fires on EVERY UPDATE,
-- which made CANCELADA / NO LLEGA unreachable (violates on save).
-- The initial state is guaranteed by create_appointment (it only
-- ever inserts PENDIENTE).
--
-- Dropped UNCONDITIONALLY here — 050 only dropped it inside its
-- FINALIZADA-rebuild branch, so an install where that branch was
-- skipped kept the broken constraint.
--
-- Also completes the FINALIZADA removal if 050's rebuild didn't
-- run (same steps, guarded).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- 1. The fix for "CANCELADA / NO LLEGA won't save".
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_initial_status;
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_no_overlap;

-- 2. Complete the FINALIZADA removal, if it's still in the enum.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'appointment_status_enum'
      AND e.enumlabel = 'FINALIZADA'
  ) THEN
    UPDATE appointments SET status = 'CONFIRMADA' WHERE status = 'FINALIZADA';

    ALTER TYPE appointment_status_enum RENAME TO appointment_status_enum_old;
    CREATE TYPE appointment_status_enum AS ENUM (
      'PENDIENTE', 'CONFIRMADA', 'LLEGA TARDE', 'NO LLEGA', 'CANCELADA'
    );
    ALTER TABLE appointments ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE appointments
      ALTER COLUMN status TYPE appointment_status_enum
      USING status::text::appointment_status_enum;
    ALTER TABLE appointments ALTER COLUMN status SET DEFAULT 'PENDIENTE';
    DROP TYPE appointment_status_enum_old;

    -- Refresh the DB objects that reference 'FINALIZADA' as a
    -- literal (see 050 for the full rationale).
    CREATE OR REPLACE FUNCTION appointment_guard_transition()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $fn$
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
        IF OLD.status = 'CANCELADA' THEN
          RAISE EXCEPTION 'Cancelled appointments can only be corrected by an administrator'
            USING ERRCODE = '42501';
        END IF;
        IF NOT (
          (OLD.status = 'PENDIENTE'   AND NEW.status IN ('CONFIRMADA', 'LLEGA TARDE', 'NO LLEGA', 'CANCELADA'))
          OR
          (OLD.status = 'CONFIRMADA'  AND NEW.status IN ('LLEGA TARDE', 'NO LLEGA', 'CANCELADA'))
          OR
          (OLD.status = 'LLEGA TARDE' AND NEW.status IN ('NO LLEGA', 'CANCELADA'))
        ) THEN
          RAISE EXCEPTION 'Status transition % → % is not allowed for agents',
            OLD.status, NEW.status
            USING ERRCODE = '22023';
        END IF;
      ELSIF v_role = 'viewer' THEN
        RAISE EXCEPTION 'Viewers cannot change appointment statuses'
          USING ERRCODE = '42501';
      END IF;

      IF NEW.status = 'CANCELADA' AND OLD.status <> 'CANCELADA' THEN
        NEW.cancelled_at := NOW();
        NEW.cancelled_by := auth.uid();
      ELSE
        NEW.cancelled_at := NULL;
        NEW.cancelled_by := NULL;
      END IF;

      RETURN NEW;
    END;
    $fn$;

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
    AS $fn$
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

      IF v_cur.status = 'CANCELADA' AND v_caller_role = 'agent' THEN
        RAISE EXCEPTION 'Cancelled appointments can only be corrected by an administrator'
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

        PERFORM pg_advisory_xact_lock(hashtextextended(v_new_assigned::text, 0));

        SELECT count(*) INTO v_overlaps
        FROM appointments a
        WHERE a.id <> v_cur.id
          AND a.assigned_user_id = v_new_assigned
          AND a.status IN ('PENDIENTE', 'CONFIRMADA', 'LLEGA TARDE')
          AND tstzrange(v_new_start, v_new_end, '[)') && tstzrange(a.starts_at, a.ends_at, '[)');

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
    $fn$;

    ALTER FUNCTION public.update_appointment(UUID, UUID, UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT) OWNER TO postgres;
    REVOKE ALL ON FUNCTION public.update_appointment(UUID, UUID, UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.update_appointment(UUID, UUID, UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT) TO authenticated;
  END IF;
END $$;
