-- ============================================================
-- 060_agent_time_restrictions
--
-- Account policy: agents no longer backdate or re-status.
--
--   agent  — can only create appointments from today forward
--            (account timezone), can never change an appointment's
--            status, and can never move an appointment into the
--            past. Editing other fields of their own appointments
--            (time today+, service, notes) is unchanged.
--   owner / admin — keep the full correction path (backdating and
--            any status transition, audit-trailed as before).
--
-- Enforcement lives in the DB so a crafted client can't bypass it:
--   1. create_appointment — new agent branch (42501).
--   2. appointment_guard_transition — agents: any status change
--      raises; also blocks moving starts_at into the past.
--
-- The transition matrix from 047 (AGENT_TRANSITIONS) is superseded:
-- agents get no transitions at all. cancelled_at bookkeeping and
-- the audit trail are unchanged.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ----------------------------------------------------------------
-- 1) create_appointment — add the past-date gate for agents.
-- Same body as 047 plus the agent block; admins/owners untouched.
-- ----------------------------------------------------------------
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
  v_tz TEXT;
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

  SELECT COALESCE(timezone, 'America/Bogota') INTO v_tz
  FROM accounts WHERE id = v_caller_account_id;

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
    -- 060: agents book from today forward (account-local calendar).
    IF (p_starts_at AT TIME ZONE v_tz)::date
       < (now() AT TIME ZONE v_tz)::date THEN
      RAISE EXCEPTION
        'Agents cannot create appointments in the past'
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

-- ----------------------------------------------------------------
-- 2) Transition/UPDATE guard — agents: no status changes, no
-- moving appointments into the past. Owner/admin unchanged.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION appointment_guard_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role account_role_enum;
  v_is_own BOOLEAN;
  v_tz TEXT;
BEGIN
  IF NEW.status = OLD.status
     AND NEW.starts_at IS NOT DISTINCT FROM OLD.starts_at THEN
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
    -- 060: status changes are owner/admin-only.
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION
        'Agents cannot change appointment statuses'
        USING ERRCODE = '42501';
    END IF;
    -- 060: agents cannot move an appointment into the past either.
    SELECT COALESCE(timezone, 'America/Bogota') INTO v_tz
    FROM accounts WHERE id = NEW.account_id;
    IF (NEW.starts_at AT TIME ZONE v_tz)::date
       < (now() AT TIME ZONE v_tz)::date THEN
      RAISE EXCEPTION
        'Agents cannot move appointments into the past'
        USING ERRCODE = '42501';
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

-- The trigger already points at appointment_guard_transition();
-- CREATE OR REPLACE above re-applies the new logic in place.
