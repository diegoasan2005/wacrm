// ============================================================
// /api/appointments/[id]
//
//   PATCH — edit an appointment through update_appointment (reassign,
//           reschedule, change service/duration/notes), or change
//           its status with a direct field update (the
//           appointment_guard_transition trigger enforces the
//           per-role transition map and stamps cancellation
//           bookkeeping). All authorisation is re-checked DB-side.
//   DELETE — remove the row entirely. Admin+ (RLS), kept for
//           GDPR-style cleanups; the operational flow is cancel.
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { hasMinRole } from "@/lib/auth/roles";
import { localizeAppointmentDbError } from "@/lib/appointments/server-errors";
import { getT } from "@/lib/i18n/translate";
import { APPOINTMENT_STATUSES, type AppointmentStatus } from "@/types/appointments";

const t = getT("Api");

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;

    const body = (await request.json().catch(() => null)) as
      | {
          status?: unknown;
          contact_id?: unknown;
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

    // --- field edit through the RPC (NULL = keep current).
    let startsAtIso: string | null = null;
    if (body.starts_at !== undefined && body.starts_at !== null) {
      const d = new Date(String(body.starts_at));
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: t("agenda.dateInvalid") }, { status: 400 });
      }
      startsAtIso = d.toISOString();
    }

    let duration: number | null = null;
    if (body.duration_minutes !== undefined && body.duration_minutes !== null) {
      duration = Number(body.duration_minutes);
      if (!Number.isInteger(duration) || duration <= 0) {
        return NextResponse.json({ error: t("agenda.durationInvalid") }, { status: 400 });
      }
    }

    const notes =
      typeof body.notes === "string" ? body.notes.trim().slice(0, 2000) || null : null;

    const hasFieldEdit =
      startsAtIso !== null ||
      duration !== null ||
      (typeof body.service_id === "string" && !!body.service_id) ||
      (typeof body.assigned_user_id === "string" && !!body.assigned_user_id) ||
      (typeof body.contact_id === "string" && !!body.contact_id) ||
      typeof body.notes === "string";

    // The edit dialog ALWAYS sends status alongside the fields, so
    // this used to fall into the status-only branch and silently
    // drop the time/duration/service changes. Now: field edits go
    // through the RPC first; the status change (if any) is applied
    // on top of the result.
    let row: Record<string, unknown> | null = null;

    if (hasFieldEdit) {
      const { data, error } = await ctx.supabase.rpc("update_appointment", {
        p_id: id,
        p_contact_id:
          typeof body.contact_id === "string" && body.contact_id ? body.contact_id : null,
        p_service_id:
          typeof body.service_id === "string" && body.service_id ? body.service_id : null,
        p_assigned_user_id:
          typeof body.assigned_user_id === "string" && body.assigned_user_id
            ? body.assigned_user_id
            : null,
        p_starts_at: startsAtIso,
        p_duration_minutes: duration,
        p_notes: notes,
      });

      if (error) {
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
        console.error("[PATCH /api/appointments/[id]] rpc error:", error);
        return NextResponse.json({ error: t("agenda.appointmentSaveFailed") }, { status: 500 });
      }
      row = data as Record<string, unknown>;
    }

    // --- status change: direct update; the DB trigger enforces the
    // transition map and stamps cancelled_at/cancelled_by. Skipped
    // when the status didn't actually change (avoids a redundant
    // audit entry).
    if (typeof body.status === "string") {
      if (!APPOINTMENT_STATUSES.includes(body.status as AppointmentStatus)) {
        return NextResponse.json({ error: t("agenda.statusInvalid") }, { status: 400 });
      }
      const current = row as { status?: string } | null;
      if (!hasFieldEdit || !current || current.status !== body.status) {
        const { data, error } = await ctx.supabase
          .from("appointments")
          .update({ status: body.status })
          .eq("id", id)
          .eq("account_id", ctx.accountId)
          .select("*")
          .single();

        if (error) {
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
          console.error("[PATCH /api/appointments/[id]] status error:", error);
          return NextResponse.json({ error: t("agenda.appointmentSaveFailed") }, { status: 500 });
        }
        row = data as Record<string, unknown>;
      }
    }

    if (!row) {
      return NextResponse.json({ error: t("agenda.payloadInvalid") }, { status: 400 });
    }

    return NextResponse.json({ appointment: row });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;

    // RLS limits DELETE to admins+; a non-admin gets 0 rows affected
    // with no error — surface the friendly 403 by pre-checking role.
    if (!hasMinRole(ctx.role, "admin")) {
      return NextResponse.json({ error: t("agenda.adminRequired") }, { status: 403 });
    }

    const { error } = await ctx.supabase
      .from("appointments")
      .delete()
      .eq("id", id)
      .eq("account_id", ctx.accountId);

    if (error) {
      console.error("[DELETE /api/appointments/[id]] error:", error);
      return NextResponse.json({ error: t("agenda.appointmentSaveFailed") }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
