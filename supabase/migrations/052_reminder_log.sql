-- ============================================================
-- 052_reminder_log.sql — "Agenda Historial" reminder tracking
--
-- appointment_reminder_log — one row per WhatsApp reminder /
-- invitation sent to a contact from the history view:
--   type = 'reminder'    — next-appointment reminder
--          'invitation'  — come-back-and-book invitation
-- appointment_id is nullable: invitations have no specific booking.
--
-- RLS: members read; agent+ records. Immutable for clients (the
-- audit-style log is only written by the send endpoint).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS appointment_reminder_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Specific appointment being reminded (null for invitations).
  appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('reminder', 'invitation')),
  sent_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reminder_log_account_contact
  ON appointment_reminder_log(account_id, contact_id, sent_at);

ALTER TABLE appointment_reminder_log ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'appointment_reminder_log'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END $$;

CREATE POLICY reminder_log_select ON appointment_reminder_log FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY reminder_log_insert ON appointment_reminder_log FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
-- No UPDATE/DELETE — the send log is append-only for clients.
