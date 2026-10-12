import type { AccountRole } from "@/lib/auth/roles";

// ============================================================
// Role-based option visibility (migration 055).
//
// The OWNER always sees every option. For admin / agent / viewer
// the owner can hide nav options and settings sections; the config
// stores HIDDEN keys per role — anything not listed is visible.
//
// Enforcement is UI-level (sidebar + settings rail). APIs keep
// their own role gates: hiding an option only declutters, it can
// never GRANT access.
// ============================================================

/** Roles whose visibility can be configured (owner is exempt). */
export const CONFIGURABLE_ROLES = ["admin", "agent", "viewer"] as const;
export type ConfigurableRole = (typeof CONFIGURABLE_ROLES)[number];

/** Sidebar nav option keys (href segment of each nav item). */
export const NAV_KEYS = [
  "dashboard",
  "inbox",
  "notifications",
  "contacts",
  "agenda",
  "agenda-historial",
  "services",
  "pipelines",
  "broadcasts",
  "automations",
  "flows",
  "agents",
  "settings",
] as const;
export type NavKey = (typeof NAV_KEYS)[number];

/** Settings sections that can be hidden per role. The Overview
 *  landing is always visible (it's the section's home). */
export const HIDEABLE_SETTINGS_KEYS = [
  "whatsapp",
  "templates",
  "quick-replies",
  "fields",
  "deals",
  "members",
  "api",
] as const;
export type HideableSettingsKey = (typeof HIDEABLE_SETTINGS_KEYS)[number];

/** Hidden-key lists per configurable role. */
export interface RoleVisibilityEntry {
  nav: string[];
  settings: string[];
}

export type RoleVisibilityConfig = Partial<
  Record<ConfigurableRole, RoleVisibilityEntry>
>;

function sanitizeKeyList(raw: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((k): k is string => typeof k === "string" && allowed.includes(k)))];
}

/** Parse + sanitize an unknown JSONB payload into a safe config. */
export function parseRoleVisibilityConfig(raw: unknown): RoleVisibilityConfig {
  if (typeof raw !== "object" || raw === null) return {};
  const source = raw as Record<string, unknown>;
  const out: RoleVisibilityConfig = {};
  for (const role of CONFIGURABLE_ROLES) {
    const entry = source[role];
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    out[role] = {
      nav: sanitizeKeyList(e.nav, NAV_KEYS),
      settings: sanitizeKeyList(e.settings, HIDEABLE_SETTINGS_KEYS),
    };
  }
  return out;
}

function isConfigurableRole(role: AccountRole): role is ConfigurableRole {
  return (CONFIGURABLE_ROLES as readonly string[]).includes(role);
}

/** Nav option visible for this role? Owner sees everything. */
export function isNavVisible(
  config: RoleVisibilityConfig,
  role: AccountRole | null,
  key: string,
): boolean {
  if (role === "owner" || !role || !isConfigurableRole(role)) return true;
  const hidden = config[role]?.nav ?? [];
  return !hidden.includes(key);
}

/** Settings section visible for this role? Overview always shows. */
export function isSettingsVisible(
  config: RoleVisibilityConfig,
  role: AccountRole | null,
  sectionId: string,
): boolean {
  if (sectionId === "overview") return true;
  if (role === "owner" || !role || !isConfigurableRole(role)) return true;
  const hidden = config[role]?.settings ?? [];
  return !hidden.includes(sectionId);
}

/**
 * First nav path this role can see, in sidebar order. Used to land
 * members whose dashboard is hidden somewhere useful instead of a
 * 404-ish empty shell. Falls back to /dashboard when nothing is
 * visible (misconfiguration) so the app always renders something.
 */
export function firstVisibleNavPath(
  config: RoleVisibilityConfig,
  role: AccountRole | null,
): string {
  for (const key of NAV_KEYS) {
    if (isNavVisible(config, role, key)) return `/${key}`;
  }
  return "/dashboard";
}
