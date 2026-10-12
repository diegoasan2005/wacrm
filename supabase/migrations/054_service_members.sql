-- ============================================================
-- 054_service_members.sql — per-member service assignment
--
-- appointment_service_members — which team members offer a service.
-- A service with NO rows here applies to ALL members; with rows,
-- only those members see/book it in the agenda.
--
-- Enforcement is app-level (the services API and the booking
-- dialog filter by member), matching how the agenda consumes it.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS appointment_service_members (
  service_id UUID NOT NULL REFERENCES appointment_services(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (service_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_service_members_account
  ON appointment_service_members(account_id, user_id);

ALTER TABLE appointment_service_members ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'appointment_service_members'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END $$;

CREATE POLICY service_members_select ON appointment_service_members FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY service_members_modify ON appointment_service_members FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
