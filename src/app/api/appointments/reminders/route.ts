// ============================================================
// /api/appointments/reminders — record a sent reminder / invitation
//
// Called AFTER /api/whatsapp/send succeeds, so the "Agenda
// Historial" table can show whether a contact was already contacted.
// The WhatsApp delivery itself lives in the send endpoint; this one
// only writes the append-only log (migration 052).
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { getT } from "@/lib/i18n/translate";

const t = getT("Api");

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    // Viewers can't send WhatsApp messages either (the send endpoint
    // requires agent+) — mirror that gate here.
    if (ctx.role === "viewer") {
      return NextResponse.json({ error: t("agenda.adminRequired") }, { status: 403 });
    }

    const body = (await request.json().catch(() => null)) as
      | { contact_id?: unknown; type?: unknown; appointment_id?: unknown }
      | null;

    if (!body || typeof body.contact_id !== "string" || !body.contact_id) {
      return NextResponse.json({ error: t("agenda.payloadInvalid") }, { status: 400 });
    }
    if (body.type !== "reminder" && body.type !== "invitation") {
      return NextResponse.json({ error: t("agenda.payloadInvalid") }, { status: 400 });
    }

    // Contact must belong to the caller's account.
    const { data: contact } = await ctx.supabase
      .from("contacts")
      .select("id")
      .eq("id", body.contact_id)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (!contact) {
      return NextResponse.json({ error: t("agenda.contactNotFound") }, { status: 404 });
    }

    const { data, error } = await ctx.supabase
      .from("appointment_reminder_log")
      .insert({
        account_id: ctx.accountId,
        contact_id: body.contact_id,
        appointment_id:
          typeof body.appointment_id === "string" && body.appointment_id
            ? body.appointment_id
            : null,
        type: body.type,
        sent_by: ctx.userId,
      })
      .select("*")
      .single();

    if (error) {
      console.error("[POST /api/appointments/reminders] insert error:", error);
      return NextResponse.json({ error: t("agenda.appointmentSaveFailed") }, { status: 500 });
    }

    return NextResponse.json({ reminder: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
