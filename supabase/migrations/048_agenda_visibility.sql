-- ============================================================
-- 048_agenda_visibility.sql — "Visible en agenda" per member
--
-- Lets each account decide WHICH members appear as bookable
-- specialists (agenda columns / specialist picker). Complements
-- 047's can_book_appointments (which gates what an AGENT may
-- write): this flag gates who is offered for booking at all.
--
--   profiles.show_in_agenda BOOLEAN NOT NULL DEFAULT true
--
-- Default true keeps the pre-048 behaviour (owner/admin/agent all
-- listed). An owner who doesn't attend customers switches
-- themselves off and their column disappears from every agenda and
-- from the specialist picker.
--
-- Enforcement:
--   - create_appointment / update_appointment are recreated with
--     the eligibility helper (a hidden member cannot be assigned,
--     even through a direct RPC call).
--   - set_member_agenda_visibility RPC — admin+ toggles any member
--     of their account (the flag carries no privilege, so self and
--     owner rows are allowed).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS show_in_agenda BOOLEAN NOT NULL DEFAULT true;

-- ============================================================
-- ELIGIBILITY HELPER
-- Any member with the flag on is bookable, REGARDLESS of role —
-- the owner decides who appears (an observer who attends can be
-- listed too). Writing appointments remains gated separately by
-- 047's can_book_appointments (agents) / role (admin+).
-- ============================================================
CREATE OR REPLACE FUNCTION appointment_specialist_eligible(
  p_account_id UUID,
  p_user_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = p_user_id
      AND p.account_id = p_account_id
      AND p.show_in_agenda
  );
$$;

ALTER FUNCTION appointment_specialist_eligible(UUID, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION appointment_specialist_eligible(UUID, UUID) TO authenticated, service_role;

-- ============================================================
-- RPC — set_member_agenda_visibility(p_user_id, p_visible)
-- Admin+ toggles any member's agenda visibility (self included).
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_member_agenda_visibility(
  p_user_id UUID,
  p_visible BOOLEAN
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
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

  SELECT account_id INTO v_target_account_id
  FROM profiles WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  UPDATE profiles
  SET show_in_agenda = p_visible
  WHERE user_id = p_user_id;
END;
$$;

ALTER FUNCTION public.set_member_agenda_visibility(UUID, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_agenda_visibility(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_agenda_visibility(UUID, BOOLEAN) TO authenticated;

-- ============================================================
-- RPC — set_member_booking_permission (relaxed re-issue of 047)
-- The switch now renders on EVERY member row, so the RPC accepts
-- any member of the caller's account. The flag is only *effective*
-- for agents — admins/owners can always book and viewers never
-- can, regardless of the stored value (role-derived in the app and
-- in appointment_write_allowed).
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

  SELECT account_id INTO v_target_account_id
  FROM profiles WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
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
-- RPC — create_appointment (recreated: specialist eligibility now
-- includes the visibility flag)
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

  -- Specialist must be an eligible member of the same account
  -- (owner/admin/agent AND visible in the agenda) — never a viewer,
  -- a hidden member, or someone from another account.
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
-- RPC — update_appointment (recreated: reassignment target
-- eligibility now includes the visibility flag)
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

  -- Reassignment target must be an eligible (visible) specialist.
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
