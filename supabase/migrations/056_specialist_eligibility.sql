-- ============================================================
-- 056_specialist_eligibility.sql — booking permission lists agents
-- in the import combo
--
-- The import dialog lists an AGENT when he has "Puede registrar
-- citas" (can_book_appointments), even if "En agenda" is off. The
-- DB eligibility helper now matches that rule: any NON-viewer
-- member of the account is a valid specialist — the visibility
-- flag no longer blocks assignments made explicitly by an admin.
--
--   appointment_specialist_eligible =
--     member of the account AND role <> viewer
--
-- "En agenda" keeps governing the AGENDA COLUMNS / specialist
-- picker in the UI; the per-row capacity + schedule + permission
-- validation in create_appointment / update_appointment is
-- unchanged.
--
-- Requires 047-055 applied. Idempotent.
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
      AND p.account_role <> 'viewer'
  );
$$;

ALTER FUNCTION appointment_specialist_eligible(UUID, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION appointment_specialist_eligible(UUID, UUID) TO authenticated, service_role;
