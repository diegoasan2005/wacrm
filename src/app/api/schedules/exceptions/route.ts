// ============================================================
// /api/schedules/exceptions — date-scoped availability overrides
//
//   POST   — add an exception (unavailable / available window).
//            Admin+.
//   DELETE — remove one by id (?id=). Admin+.
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { hasMinRole } from "@/lib/auth/roles";
import { getT } from "@/lib/i18n/translate";

const t = getT("Api");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    if (!hasMinRole(ctx.role, "admin")) {
      return NextResponse.json({ error: t("agenda.adminRequired") }, { status: 403 });
    }

    const body = (await request.json().catch(() => null)) as
      | {
          user_id?: unknown;
          date?: unknown;
          start_time?: unknown;
          end_time?: unknown;
          exception_type?: unknown;
          notes?: unknown;
        }
      | null;

    if (!body || typeof body.user_id !== "string" || !body.user_id) {
      return NextResponse.json({ error: t("agenda.payloadInvalid") }, { status: 400 });
    }
    if (typeof body.date !== "string" || !DATE_RE.test(body.date)) {
      return NextResponse.json({ error: t("agenda.dateInvalid") }, { status: 400 });
    }
    if (body.exception_type !== "unavailable" && body.exception_type !== "available") {
      return NextResponse.json({ error: t("agenda.payloadInvalid") }, { status: 400 });
    }

    let startTime: string | null = null;
    let endTime: string | null = null;
    if (body.start_time !== undefined && body.start_time !== null && body.start_time !== "") {
      if (
        typeof body.start_time !== "string" ||
        !TIME_RE.test(body.start_time.slice(0, 5)) ||
        typeof body.end_time !== "string" ||
        !TIME_RE.test(body.end_time.slice(0, 5)) ||
        body.end_time.slice(0, 5) <= body.start_time.slice(0, 5)
      ) {
        return NextResponse.json({ error: t("agenda.scheduleInvalid") }, { status: 400 });
      }
      startTime = body.start_time.slice(0, 5);
      endTime = body.end_time.slice(0, 5);
    }

    // Target must be a member of the caller's account.
    const { data: target } = await ctx.supabase
      .from("profiles")
      .select("account_role")
      .eq("user_id", body.user_id)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (!target) {
      return NextResponse.json({ error: t("agenda.specialistInvalid") }, { status: 400 });
    }

    const notes =
      typeof body.notes === "string" && body.notes.trim()
        ? body.notes.trim().slice(0, 500)
        : null;

    const { data, error } = await ctx.supabase
      .from("appointment_schedule_exceptions")
      .insert({
        account_id: ctx.accountId,
        user_id: body.user_id,
        date: body.date,
        start_time: startTime,
        end_time: endTime,
        exception_type: body.exception_type,
        notes,
      })
      .select("*")
      .single();

    if (error) {
      console.error("[POST /api/schedules/exceptions] error:", error);
      return NextResponse.json({ error: t("agenda.scheduleSaveFailed") }, { status: 500 });
    }

    return NextResponse.json({ exception: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    if (!hasMinRole(ctx.role, "admin")) {
      return NextResponse.json({ error: t("agenda.adminRequired") }, { status: 403 });
    }

    const id = new URL(request.url).searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: t("agenda.payloadInvalid") }, { status: 400 });
    }

    const { error } = await ctx.supabase
      .from("appointment_schedule_exceptions")
      .delete()
      .eq("id", id)
      .eq("account_id", ctx.accountId);

    if (error) {
      console.error("[DELETE /api/schedules/exceptions] error:", error);
      return NextResponse.json({ error: t("agenda.scheduleSaveFailed") }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
