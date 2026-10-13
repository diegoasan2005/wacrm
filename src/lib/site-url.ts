// Base URL used for auth email links (confirmation, password reset).
//
// NEXT_PUBLIC_SITE_URL wins when set — so the link in the email
// always points at the real deployment even if the signup happened
// from localhost during development. Falls back to the current
// origin. Supabase must also allow this origin under
// Authentication → URL Configuration → Redirect URLs, or it will
// silently fall back to its own Site URL (see docs/auth-emails.md).
export function getSiteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}
