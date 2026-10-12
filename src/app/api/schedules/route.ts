// ============================================================
// /api/schedules — member working hours (migration 047)
//
//   GET  — every member's weekly windows + exceptions for the
//          account. Any member (the agenda renders availability).
//   PUT  — replace ONE member's weekly windows. Admin+ (enforced
//          here and by RLS). Agents cannot edit schedules — not
//          even their own.
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { hasMinRole } from "@/lib/auth/roles";
import { getT } from "@/lib/i18n/translate";

const t = getT("Api");

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

interface ScheduleInput {
  day_of_week: number;
  start_time: string;
  end_time: string;
  is_active: boolean;
}

function normalizeSchedules(raw: unknown): ScheduleInput[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ScheduleInput[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const r = item as Record<string, unknown>;
    const day = Number(r.day_of_week);
    const start = typeof r.start_time === "string" ? r.start_time.slice(0, 5) : "";
    const end = typeof r.end_time === "string" ? r.end_time.slice(0, 5) : "";
    if (!Number.isInteger(day) || day < 0 || day > 6) return null;
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) return null;
    if (end <= start) return null;
    out.push({
      day_of_week: day,
      start_time: start,
      end_time: end,
      is_active: r.is_active === false ? false : true,
    });
  }
  return out;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const [schedules, exceptions] = await Promise.all([
      ctx.supabase
        .from("appointment_member_schedules")
        .select("*")
        .eq("account_id", ctx.accountId)
        .order("day_of_week", { ascending: true }),
      ctx.supabase
        .from("appointment_schedule_exceptions")
        .select("*")
        .eq("account_id", ctx.accountId)
        .order("date", { ascending: true }),
    ]);

    if (schedules.error) {
      console.error("[GET /api/schedules] schedules error:", schedules.error);
      return NextResponse.json({ error: t("agenda.scheduleLoadFailed") }, { status: 500 });
    }
    if (exceptions.error) {
      console.error("[GET /api/schedules] exceptions error:", exceptions.error);
      return NextResponse.json({ error: t("agenda.scheduleLoadFailed") }, { status: 500 });
    }

    return NextResponse.json({
      schedules: schedules.data,
      exceptions: exceptions.data,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    if (!hasMinRole(ctx.role, "admin")) {
      return NextResponse.json({ error: t("agenda.adminRequired") }, { status: 403 });
    }

    const body = (await request.json().catch(() => null)) as
      | { user_id?: unknown; schedules?: unknown }
      | null;

    if (!body || typeof body.user_id !== "string" || !body.user_id) {
      return NextResponse.json({ error: t("agenda.payloadInvalid") }, { status: 400 });
    }

    // Target must be a member of the caller's account and eligible
    // to receive appointments (owner/admin/agent).
    const { data: target } = await ctx.supabase
      .from("profiles")
      .select("account_role")
      .eq("user_id", body.user_id)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (!target || target.account_role === "viewer") {
      return NextResponse.json({ error: t("agenda.specialistInvalid") }, { status: 400 });
    }

    const schedules = normalizeSchedules(body.schedules);
    if (schedules === null) {
      return NextResponse.json({ error: t("agenda.scheduleInvalid") }, { status: 400 });
    }

    // Replace semantics: wipe the member's windows, insert the new
    // set. Sequential ops (no cross-table transactions over the
    // client API); a failure mid-way leaves the member with a
    // partial (or empty) schedule — empty means "always bookable",
    // the documented safe default, never a lockout.
    const del = await ctx.supabase
      .from("appointment_member_schedules")
      .delete()
      .eq("account_id", ctx.accountId)
      .eq("user_id", body.user_id);
    if (del.error) {
      console.error("[PUT /api/schedules] delete error:", del.error);
      return NextResponse.json({ error: t("agenda.scheduleSaveFailed") }, { status: 500 });
    }

    if (schedules.length > 0) {
      const ins = await ctx.supabase.from("appointment_member_schedules").insert(
        schedules.map((s) => ({
          account_id: ctx.accountId,
          user_id: body.user_id,
          ...s,
        })),
      );
      if (ins.error) {
        console.error("[PUT /api/schedules] insert error:", ins.error);
        return NextResponse.json({ error: t("agenda.scheduleSaveFailed") }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
