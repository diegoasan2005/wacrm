// ============================================================
// /api/appointments/metrics — dashboard agenda/service metrics
//
// Powers the dashboard cards the owner approved:
//   - Citas de hoy (total + per-status breakdown, per member too)
//   - Próximos 7 días
//   - Carga por miembro (próximos 7 días)
//   - Clientes con próxima cita (+ la más lejana)
//   - NO LLEGA (30 días)
//   - Cancelaciones (30 días)
//   - Top 3 servicios (30 días)
//
// All windows are computed in the ACCOUNT timezone (migration 047),
// never the browser's. RLS scopes rows: agents see their own
// appointments only, so their metrics reflect their agenda.
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { getT } from "@/lib/i18n/translate";
import { addDaysToKey, utcToDateKey, wallTimeToUtc } from "@/lib/appointments/time";
import { FALLBACK_TIMEZONE } from "@/lib/appointments/constants";

const t = getT("Api");

const BLOCKING = ["PENDIENTE", "CONFIRMADA", "LLEGA TARDE"];

interface ApptRow {
  contact_id: string;
  service_id: string | null;
  service_name: string | null;
  assigned_user_id: string;
  starts_at: string;
  status: string;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data: account } = await ctx.supabase
      .from("accounts")
      .select("timezone")
      .eq("id", ctx.accountId)
      .maybeSingle();
    const tz = account?.timezone || FALLBACK_TIMEZONE;

    const now = new Date();
    const todayKey = utcToDateKey(now, tz);
    const dayStart = wallTimeToUtc(todayKey, 0, tz);
    const dayEnd = wallTimeToUtc(addDaysToKey(todayKey, 1), 0, tz);
    const next7End = wallTimeToUtc(addDaysToKey(todayKey, 8), 0, tz);
    const past30 = new Date(now.getTime() - 30 * 86_400_000);
    // The rollup universe: 30 days back … 1 year forward.
    const from = past30.toISOString();
    const to = new Date(now.getTime() + 365 * 86_400_000).toISOString();

    const [apptsRes, profilesRes] = await Promise.all([
      ctx.supabase
        .from("appointments")
        .select(
          "contact_id, service_id, service_name, assigned_user_id, starts_at, status",
        )
        .eq("account_id", ctx.accountId)
        .gte("starts_at", from)
        .lte("starts_at", to),
      ctx.supabase
        .from("profiles")
        .select("user_id, full_name")
        .eq("account_id", ctx.accountId),
    ]);

    if (apptsRes.error || profilesRes.error) {
      const err = apptsRes.error ?? profilesRes.error;
      console.error("[GET /api/appointments/metrics] fetch error:", err);
      return NextResponse.json(
        { error: t("agenda.appointmentLoadFailed") },
        { status: 500 },
      );
    }

    const appts = apptsRes.data as unknown as ApptRow[];
    const memberNames = new Map(
      (profilesRes.data ?? []).map((p) => [p.user_id, p.full_name]),
    );
    const nameOf = (userId: string) =>
      memberNames.get(userId) || userId.slice(0, 8);

    const inWindow = (iso: string, a: Date, b: Date) => {
      const at = new Date(iso).getTime();
      return at >= a.getTime() && at < b.getTime();
    };

    // --- Citas de hoy ------------------------------------------------
    const today = { total: 0, PENDIENTE: 0, CONFIRMADA: 0, "LLEGA TARDE": 0 };
    const perMemberToday = new Map<
      string,
      { name: string; total: number; pending: number; confirmed: number; late: number }
    >();
    // --- Próximos 7 días + carga por miembro -------------------------
    let next7 = 0;
    const perMember7 = new Map<string, { name: string; count: number }>();
    // --- 30 días de calidad ------------------------------------------
    let noShow30 = 0;
    let cancelled30 = 0;
    const serviceCount30 = new Map<string, { name: string; count: number }>();
    // --- Clientes con próxima cita -----------------------------------
    const contactsWithNext = new Map<string, string>(); // contact → furthest start

    for (const a of appts) {
      if (inWindow(a.starts_at, dayStart, dayEnd)) {
        today.total += 1;
        if (a.status === "PENDIENTE" || a.status === "CONFIRMADA" || a.status === "LLEGA TARDE") {
          today[a.status as "PENDIENTE" | "CONFIRMADA" | "LLEGA TARDE"] += 1;
        }
        const m = perMemberToday.get(a.assigned_user_id) ?? {
          name: nameOf(a.assigned_user_id),
          total: 0,
          pending: 0,
          confirmed: 0,
          late: 0,
        };
        m.total += 1;
        if (a.status === "PENDIENTE") m.pending += 1;
        if (a.status === "CONFIRMADA") m.confirmed += 1;
        if (a.status === "LLEGA TARDE") m.late += 1;
        perMemberToday.set(a.assigned_user_id, m);
      }

      if (
        new Date(a.starts_at) > now &&
        new Date(a.starts_at) < next7End &&
        BLOCKING.includes(a.status)
      ) {
        next7 += 1;
        const m = perMember7.get(a.assigned_user_id) ?? {
          name: nameOf(a.assigned_user_id),
          count: 0,
        };
        m.count += 1;
        perMember7.set(a.assigned_user_id, m);
      }

      if (inWindow(a.starts_at, past30, now)) {
        if (a.status === "NO LLEGA") noShow30 += 1;
        if (a.status === "CANCELADA") cancelled30 += 1;
        if (a.service_id) {
          const key = a.service_id;
          const s =
            serviceCount30.get(key) ?? { name: a.service_name ?? "—", count: 0 };
          s.count += 1;
          serviceCount30.set(key, s);
        }
      }

      if (
        new Date(a.starts_at) > now &&
        BLOCKING.includes(a.status)
      ) {
        const furthest = contactsWithNext.get(a.contact_id);
        if (!furthest || new Date(a.starts_at) > new Date(furthest)) {
          contactsWithNext.set(a.contact_id, a.starts_at);
        }
      }
    }

    const topServices = [...serviceCount30.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    const memberToday = [...perMemberToday.entries()]
      .map(([userId, v]) => ({ userId, ...v }))
      .sort((a, b) => b.total - a.total);

    const memberLoad7 = [...perMember7.entries()]
      .map(([userId, v]) => ({ userId, ...v }))
      .sort((a, b) => b.count - a.count);

    let furthestNext: string | null = null;
    for (const starts of contactsWithNext.values()) {
      if (!furthestNext || new Date(starts) > new Date(furthestNext)) {
        furthestNext = starts;
      }
    }

    return NextResponse.json({
      today,
      memberToday,
      next7,
      memberLoad7,
      clientsWithNext: contactsWithNext.size,
      furthestNext,
      noShow30,
      cancelled30,
      topServices,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
