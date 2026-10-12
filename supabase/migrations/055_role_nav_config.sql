-- ============================================================
-- 055_role_nav_config.sql — per-role option visibility
--
-- accounts.role_nav_config JSONB — owner-controlled visibility of
-- nav options and settings sections per role. Model: HIDDEN keys —
-- anything not listed is visible. Shape:
--
--   {
--     "admin":  { "nav": ["pipelines"], "settings": ["api"] },
--     "agent":  { "nav": [],            "settings": [] },
--     "viewer": { "nav": ["inbox"],     "settings": ["deals"] }
--   }
--
-- The owner always sees every option regardless of this config.
-- Enforcement is UI-level (sidebar + settings rail); every API
-- keeps its own role gates, so hiding an option never grants
-- access — it only declutters.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS role_nav_config JSONB NOT NULL DEFAULT '{}'::jsonb;
