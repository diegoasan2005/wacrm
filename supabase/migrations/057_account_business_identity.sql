-- ============================================================
-- 057_account_business_identity
--
-- Per-account business identity: title + subtitle.
--
-- The agenda-history WhatsApp templates (reminder / invitation) used
-- the account name as the business name, but the account is often
-- named after its owner, so customer-facing messages ended up with
-- whatever the signed-up person typed there. This adds two optional
-- columns to `accounts` so each business can set how it presents
-- itself — e.g. "Luzdy Jiménez" / "Especialista en Cejas y Belleza".
--
-- The agenda-history message builder prefers `business_title` and
-- falls back to the account name when it is empty, so nothing breaks
-- for accounts that never fill it in.
--
-- RLS: no change needed. The existing `accounts_update` policy
-- (017) already restricts writes to admins+.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS business_title TEXT;
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS business_subtitle TEXT;
