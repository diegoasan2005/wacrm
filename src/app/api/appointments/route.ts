// ============================================================
// /api/appointments
//
//   GET  — list appointments in a UTC range with optional filters.
//          RLS scopes rows: agents receive only their own.
//   POST — create an appointment through the create_appointment
//          RPC (permission, service availability, working-window
//          and overlap validation live in the DB). Optionally
//          creates/links the contact inline.
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { findExistingContact } from "@/lib/contacts/dedupe";
import { withColombiaPrefix } from "@/lib/whatsapp/phone-utils";
import { localizeAppointmentDbError } from "@/lib/appointments/server-errors";
import { getT } from "@/lib/i18n/translate";

const t = getT("Api");

const CONTACT_EMBED = "contacts(id, name, last_name, identification, phone, avatar_url)";

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const url = new URL(request.url);

    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!from || !to) {
      return NextResponse.json({ error: t("agenda.rangeRequired") }, { status: 400 });
    }

    let query = ctx.supabase
      .from("appointments")
      .select(`*, contact:${CONTACT_EMBED}`)
      .eq("account_id", ctx.accountId)
      .gte("starts_at", from)
      .lte("starts_at", to)
      .order("starts_at", { ascending: true });

    const members = url.searchParams.get("members");
    if (members) {
      const ids = members.split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.length > 0) query = query.in("assigned_user_id", ids);
    }

    const statuses = url.searchParams.get("statuses");
    if (statuses) {
      const list = statuses.split(",").map((s) => s.trim()).filter(Boolean);
      if (list.length > 0) query = query.in("status", list);
    }

    const service = url.searchParams.get("service");
    if (service) query = query.eq("service_id", service);

    const contact = url.searchParams.get("contact");
    if (contact) query = query.eq("contact_id", contact);

    const { data, error } = await query;
    if (error) {
      console.error("[GET /api/appointments] fetch error:", error);
      return NextResponse.json({ error: t("agenda.appointmentLoadFailed") }, { status: 500 });
    }

    return NextResponse.json({ appointments: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

interface InlineContact {
  identification?: unknown;
  name?: unknown;
  last_name?: unknown;
  phone?: unknown;
  birth_month?: unknown;
  birth_day?: unknown;
}

/**
 * Validate + create (or find) the inline contact. Returns the
 * contact id, or a friendly error string.
 *
 * Dedup follows the CRM rules: an existing contact with the same
 * identification (when provided) or the same normalized phone wins
 * over creating a new row — the modal links the appointment to it.
 */
async function resolveContact(
  ctx: Awaited<ReturnType<typeof getCurrentAccount>>,
  raw: InlineContact,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const identification =
    typeof raw.identification === "string" ? raw.identification.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const lastName =
    typeof raw.last_name === "string" ? raw.last_name.trim() : "";
  const phone = typeof raw.phone === "string" ? raw.phone.trim() : "";

  if (!identification) return { ok: false, error: t("agenda.identificationRequired") };
  if (!name) return { ok: false, error: t("agenda.nameRequired") };
  if (!lastName) return { ok: false, error: t("agenda.lastNameRequired") };
  if (identification.length > 60) {
    return { ok: false, error: t("agenda.identificationTooLong") };
  }

  const birthMonth = raw.birth_month === null || raw.birth_month === undefined || raw.birth_month === ""
    ? null
    : Number(raw.birth_month);
  const birthDay = raw.birth_day === null || raw.birth_day === undefined || raw.birth_day === ""
    ? null
    : Number(raw.birth_day);
  if (birthMonth !== null && (!Number.isInteger(birthMonth) || birthMonth < 1 || birthMonth > 12)) {
    return { ok: false, error: t("agenda.birthMonthInvalid") };
  }
  if (birthDay !== null && (!Number.isInteger(birthDay) || birthDay < 1 || birthDay > 31)) {
    return { ok: false, error: t("agenda.birthDayInvalid") };
  }

  // Dedup pass 1 — identification (case-exact; identification is an
  // exact business key, not free text).
  if (identification) {
    const { data } = await ctx.supabase
      .from("contacts")
      .select("id")
      .eq("account_id", ctx.accountId)
      .eq("identification", identification)
      .limit(1);
    if (data && data.length > 0) return { ok: true, id: data[0].id };
  }

  // Dedup pass 2 — phone via the SHARED CRM dedupe helper (the same
  // one the WhatsApp webhook uses): last-8-digit suffix tolerant, so
  // "3104023557" matches an existing "573104023557" created by an
  // inbound message. Exact phone_normalized equality alone would
  // miss cross-prefix pairs and split the client in two.
  if (phone) {
    const prefixed = withColombiaPrefix(phone);
    const existing = await findExistingContact(ctx.supabase, ctx.accountId, prefixed);
    if (existing) return { ok: true, id: existing.id };
  }

  // Create — phone is stored DIGITS-ONLY with Colombia's 57 prefix
  // applied when the user typed a local number, the same shape the
  // webhook writes (Meta's `from` digits).
  const prefixedPhone = withColombiaPrefix(phone);
  const { data: created, error } = await ctx.supabase
    .from("contacts")
    .insert({
      account_id: ctx.accountId,
      user_id: ctx.userId,
      phone: prefixedPhone,
      name,
      last_name: lastName || null,
      identification,
      birth_month: birthMonth,
      birth_day: birthDay,
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = UNIQUE(account_id, phone_normalized) — a concurrent
    // creation of the same number; treat as "link to existing".
    if (error.code === "23505" && phone) {
      const existing = await findExistingContact(ctx.supabase, ctx.accountId, phone);
      if (existing) return { ok: true, id: existing.id };
    }
    console.error("[POST /api/appointments] contact insert error:", error);
    return { ok: false, error: t("agenda.contactCreateFailed") };
  }

  return { ok: true, id: created.id };
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();

    const body = (await request.json().catch(() => null)) as
      | {
          contact_id?: unknown;
          contact?: InlineContact;
          service_id?: unknown;
          assigned_user_id?: unknown;
          starts_at?: unknown;
          duration_minutes?: unknown;
          notes?: unknown;
        }
      | null;

    if (!body) {
      return NextResponse.json({ error: t("agenda.payloadInvalid") }, { status: 400 });
    }

    let contactId: string | null = null;
    if (typeof body.contact_id === "string" && body.contact_id) {
      contactId = body.contact_id;
    } else if (body.contact && typeof body.contact === "object") {
      const resolved = await resolveContact(ctx, body.contact);
      if (!resolved.ok) {
        return NextResponse.json({ error: resolved.error }, { status: 400 });
      }
      contactId = resolved.id;
    }
    if (!contactId) {
      return NextResponse.json({ error: t("agenda.contactRequired") }, { status: 400 });
    }

    if (typeof body.service_id !== "string" || !body.service_id) {
      return NextResponse.json({ error: t("agenda.serviceRequired") }, { status: 400 });
    }
    if (typeof body.assigned_user_id !== "string" || !body.assigned_user_id) {
      return NextResponse.json({ error: t("agenda.specialistRequired") }, { status: 400 });
    }

    const startsAt = new Date(String(body.starts_at));
    if (Number.isNaN(startsAt.getTime())) {
      return NextResponse.json({ error: t("agenda.dateInvalid") }, { status: 400 });
    }

    let duration: number | null = null;
    if (body.duration_minutes !== undefined && body.duration_minutes !== null) {
      duration = Number(body.duration_minutes);
      if (!Number.isInteger(duration) || duration <= 0) {
        return NextResponse.json({ error: t("agenda.durationInvalid") }, { status: 400 });
      }
    }

    const notes =
      typeof body.notes === "string" && body.notes.trim().length > 0
        ? body.notes.trim().slice(0, 2000)
        : null;

    const { data, error } = await ctx.supabase.rpc("create_appointment", {
      p_contact_id: contactId,
      p_service_id: body.service_id,
      p_assigned_user_id: body.assigned_user_id,
      p_starts_at: startsAt.toISOString(),
      p_duration_minutes: duration,
      p_notes: notes,
    });

    if (error) {
      // 22023 = our validation raises (slot taken / outside working
      // hours…), 42501 = permission surfaced from the RPC. Both
      // carry the DB's English message — localize known ones.
      if (error.code === "42501") {
        return NextResponse.json(
          { error: localizeAppointmentDbError(error.message) },
          { status: 403 },
        );
      }
      if (error.code === "22023") {
        return NextResponse.json(
          { error: localizeAppointmentDbError(error.message) },
          { status: 409 },
        );
      }
      console.error("[POST /api/appointments] rpc error:", error);
      return NextResponse.json({ error: t("agenda.appointmentSaveFailed") }, { status: 500 });
    }

    return NextResponse.json({ appointment: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
