import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================
// Shared validation / normalisation for appointment-service
// payloads (POST /api/services, PATCH /api/services/[id]).
//
// Pure helpers — unit-testable, no I/O except the duplicate-name
// probe which takes the client explicitly.
// ============================================================

export const SERVICE_COLORS_OK = /^#[0-9a-fA-F]{6}$/;

export interface ServiceInput {
  name: string;
  description: string | null;
  duration_minutes: number;
  price: number | null;
  color: string | null;
  is_default: boolean;
  is_active: boolean;
  available_for_booking: boolean;
  /** Simultaneous appointments allowed on the same slot (049). */
  max_concurrent: number;
}

type NormalizeResult =
  | { ok: true; value: ServiceInput }
  | { ok: false; error: string };

/**
 * Validate + normalise a service payload. `partial` lets PATCH
 * calls omit fields (missing keys keep the stored value at the
 * call site); present keys are fully validated either way.
 */
export function normalizeServiceInput(
  body: unknown,
  partial = false,
): NormalizeResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "invalid_payload" };
  }
  const b = body as Record<string, unknown>;
  const out: Partial<ServiceInput> = {};

  if (!partial || "name" in b) {
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (name.length < 1 || name.length > 120) {
      return { ok: false, error: "name_invalid" };
    }
    out.name = name;
  }

  if ("description" in b) {
    if (b.description === null || b.description === undefined) {
      out.description = null;
    } else if (typeof b.description === "string") {
      const d = b.description.trim();
      out.description = d.length > 0 ? d.slice(0, 1000) : null;
    } else {
      return { ok: false, error: "description_invalid" };
    }
  } else if (!partial) {
    out.description = null;
  }

  if (!partial || "duration_minutes" in b) {
    const dur = Number(b.duration_minutes);
    if (!Number.isInteger(dur) || dur <= 0 || dur > 24 * 60) {
      return { ok: false, error: "duration_invalid" };
    }
    out.duration_minutes = dur;
  }

  if ("price" in b) {
    if (b.price === null || b.price === undefined || b.price === "") {
      out.price = null;
    } else {
      const price = Number(b.price);
      if (!Number.isFinite(price) || price < 0) {
        return { ok: false, error: "price_invalid" };
      }
      out.price = Math.round(price * 100) / 100;
    }
  } else if (!partial) {
    out.price = null;
  }

  if ("color" in b) {
    if (b.color === null || b.color === undefined || b.color === "") {
      out.color = null;
    } else if (
      typeof b.color === "string" &&
      SERVICE_COLORS_OK.test(b.color)
    ) {
      out.color = b.color.toLowerCase();
    } else {
      return { ok: false, error: "color_invalid" };
    }
  } else if (!partial) {
    out.color = null;
  }

  if ("max_concurrent" in b) {
    const mc = Number(b.max_concurrent);
    if (!Number.isInteger(mc) || mc < 1 || mc > 50) {
      return { ok: false, error: "max_concurrent_invalid" };
    }
    out.max_concurrent = mc;
  } else if (!partial) {
    out.max_concurrent = 1;
  }

  for (const key of [
    "is_default",
    "is_active",
    "available_for_booking",
  ] as const) {
    if (key in b) {
      if (typeof b[key] !== "boolean") return { ok: false, error: `${key}_invalid` };
      out[key] = b[key] as boolean;
    } else if (!partial) {
      out[key] = key !== "is_default"; // defaults: false/true/true
    }
  }

  return { ok: true, value: out as ServiceInput };
}

/**
 * True when another service in the account already uses `name`
 * (case-insensitive, trimmed) other than `excludeId`.
 */
export async function serviceDuplicateNameError(
  supabase: SupabaseClient,
  accountId: string,
  name: string,
  excludeId: string | null,
): Promise<boolean> {
  // ilike takes a pattern — escape the wildcards so a service
  // literally named "50% off" doesn't match "50x off".
  const escaped = name
    .trim()
    .replace(/[\\%_]/g, (ch) => `\\${ch}`);
  let query = supabase
    .from("appointment_services")
    .select("id")
    .eq("account_id", accountId)
    .ilike("name", escaped)
    .limit(1);
  if (excludeId) query = query.neq("id", excludeId);
  const { data } = await query;
  return (data?.length ?? 0) > 0;
}
