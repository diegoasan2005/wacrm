// ============================================================
// /api/appointments/history — "Agenda Historial" aggregation
//
// Per-contact rollup of the account's appointments:
//   - last visit  — most recent appointment that already started,
//     with its status / service / specialist
//   - days since  — whole days between that visit and now
//   - next        — earliest future appointment in a blocking
//     status (PENDIENTE / CONFIRMADA / LLEGA TARDE)
//   - last reminder / invitation sent (from appointment_reminder_log)
//
// Query params:
//   service  — filter by last visit's service id
//   minDays  — only contacts whose last visit is >= N days ago
//   search   — name / identification / phone substring
//
// RLS scopes every query to the caller's account (agents only see
// their own appointments, so their rollup covers their contacts).
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { localizeAppointmentDbError } from "@/lib/appointments/server-errors";
import { getT } from "@/lib/i18n/translate";

const t = getT("Api");

const BLOCKING = ["PENDIENTE", "CONFIRMADA", "LLEGA TARDE"];

interface ApptRow {
  id: string;
  contact_id: string;
  service_id: string | null;
  service_name: string | null;
  assigned_user_id: string;
  starts_at: string;
  status: string;
  contact: {
    id: string;
    name: string | null;
    last_name: string | null;
    identification: string | null;
    phone: string;
  } | null;
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const url = new URL(request.url);
    const serviceFilter = url.searchParams.get("service") || "";
    const minDays = Number(url.searchParams.get("minDays") || "0");
    const search = (url.searchParams.get("search") || "").trim().toLowerCase();

    // Last 2 years of appointments is the rollup universe — enough
    // for "última visita" while keeping the query bounded.
    const from = new Date(Date.now() - 2 * 365 * 86_400_000).toISOString();

    const [apptsRes, remindersRes, profilesRes] = await Promise.all([
      ctx.supabase
        .from("appointments")
        .select(
          "id, contact_id, service_id, service_name, assigned_user_id, starts_at, status, contact:contacts(id, name, last_name, identification, phone)",
        )
        .eq("account_id", ctx.accountId)
        .gte("starts_at", from)
        .order("starts_at", { ascending: true }),
      ctx.supabase
        .from("appointment_reminder_log")
        .select("contact_id, type, sent_at")
        .eq("account_id", ctx.accountId)
        .order("sent_at", { ascending: true }),
      ctx.supabase
        .from("profiles")
        .select("user_id, full_name")
        .eq("account_id", ctx.accountId),
    ]);

    if (apptsRes.error || remindersRes.error || profilesRes.error) {
      const err = apptsRes.error ?? remindersRes.error ?? profilesRes.error;
      console.error("[GET /api/appointments/history] fetch error:", err);
      return NextResponse.json(
        { error: localizeAppointmentDbError(err?.message ?? "") || t("agenda.appointmentLoadFailed") },
        { status: 500 },
      );
    }

    const appts = apptsRes.data as unknown as ApptRow[];
    const memberNames = new Map(
      (profilesRes.data ?? []).map((p) => [p.user_id, p.full_name]),
    );

    // Latest reminder / invitation per contact.
    const lastByType = new Map<string, { reminder: string | null; invitation: string | null }>();
    for (const r of (remindersRes.data ?? []) as {
      contact_id: string;
      type: string;
      sent_at: string;
    }[]) {
      const entry = lastByType.get(r.contact_id) ?? { reminder: null, invitation: null };
      if (r.type === "reminder") entry.reminder = r.sent_at;
      if (r.type === "invitation") entry.invitation = r.sent_at;
      lastByType.set(r.contact_id, entry);
    }

    // Rollup per contact.
    const now = Date.now();
    interface Rollup {
      contact_id: string;
      identification: string | null;
      name: string;
      phone: string;
      last_visit: {
        starts_at: string;
        status: string;
        service_id: string | null;
        service_name: string | null;
        specialist: string;
      } | null;
      days_since: number | null;
      next: { starts_at: string; service_name: string | null; status: string } | null;
      last_reminder_at: string | null;
      last_invitation_at: string | null;
    }
    const byContact = new Map<string, Rollup>();

    for (const appt of appts) {
      if (!appt.contact) continue;
      const c = appt.contact;
      let entry = byContact.get(c.id);
      if (!entry) {
        entry = {
          contact_id: c.id,
          identification: c.identification || null,
          name: [c.name, c.last_name].filter(Boolean).join(" "),
          phone: c.phone,
          last_visit: null,
          days_since: null,
          next: null,
          last_reminder_at: lastByType.get(c.id)?.reminder ?? null,
          last_invitation_at: lastByType.get(c.id)?.invitation ?? null,
        };
        byContact.set(c.id, entry);
      }

      const at = new Date(appt.starts_at).getTime();
      if (at <= now) {
        // Ascending order → the last match wins = most recent visit.
        entry.last_visit = {
          starts_at: appt.starts_at,
          status: appt.status,
          service_id: appt.service_id,
          service_name: appt.service_name,
          specialist: memberNames.get(appt.assigned_user_id) ?? appt.assigned_user_id,
        };
        entry.days_since = Math.floor((now - at) / 86_400_000);
      } else if (
        BLOCKING.includes(appt.status) &&
        (entry.next === null || at < new Date(entry.next.starts_at).getTime())
      ) {
        entry.next = {
          starts_at: appt.starts_at,
          service_name: appt.service_name,
          status: appt.status,
        };
      }
    }

    // Filters.
    let rows = [...byContact.values()].filter((r) => r.last_visit);
    if (serviceFilter) {
      rows = rows.filter((r) => r.last_visit?.service_id === serviceFilter);
    }
    if (Number.isFinite(minDays) && minDays > 0) {
      rows = rows.filter((r) => (r.days_since ?? 0) >= minDays);
    }
    if (search) {
      rows = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(search) ||
          (r.identification ?? "").toLowerCase().includes(search) ||
          r.phone.includes(search),
      );
    }

    // Soonest next appointment first, then oldest visit.
    rows.sort((a, b) => (b.last_visit?.starts_at ?? "").localeCompare(a.last_visit?.starts_at ?? ""));

    return NextResponse.json({ rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}
