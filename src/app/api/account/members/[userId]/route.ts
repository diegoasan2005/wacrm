// ============================================================
// /api/account/members/[userId]
//
//   PATCH  — change a member's role, or toggle their agenda
//            booking flag ("Puede registrar citas").  Admin+.
//   DELETE — remove a member.          Admin+.
//
// Role changes delegate to the set_member_role RPC (migration 018);
// the booking flag to set_member_booking_permission (migration
// 047). Both RPCs do the *real* authorisation work — caller must
// be admin+, target must be in caller's account. The TS layer
// only forwards the call and maps Postgres SQLSTATEs back to
// HTTP statuses.
// ============================================================

import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { isAccountRole } from "@/lib/auth/roles";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { getT } from "@/lib/i18n/translate";

const t = getT("Api");

// Map known SQLSTATEs from the RPCs (see migration 018) onto HTTP
// statuses. The `error.code` field is the SQLSTATE; the `message`
// is the human-readable RAISE message we put in the migration.
function rpcErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === "42501") {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err.code === "22023") {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error("[members route] unexpected RPC error:", err);
  return NextResponse.json(
    { error: t('account.members.updateFailed') },
    { status: 500 },
  );
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:memberRole:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const body = (await request.json().catch(() => null)) as
      | { role?: unknown; canBookAppointments?: unknown; showInAgenda?: unknown }
      | null;

    // Booking-flag branch: exactly one of the fields is acted on per
    // request; each RPC validates the target against the caller's
    // account.
    if (body && "canBookAppointments" in body && typeof body.canBookAppointments === "boolean") {
      const { error } = await ctx.supabase.rpc(
        "set_member_booking_permission",
        {
          p_user_id: userId,
          p_can_book: body.canBookAppointments,
        },
      );
      if (error) return rpcErrorToResponse(error);
      return NextResponse.json({ ok: true });
    }

    // Agenda-visibility branch (migration 048) — any member, any
    // role; the owner can hide themselves from the agenda.
    if (body && "showInAgenda" in body && typeof body.showInAgenda === "boolean") {
      const { error } = await ctx.supabase.rpc(
        "set_member_agenda_visibility",
        {
          p_user_id: userId,
          p_visible: body.showInAgenda,
        },
      );
      if (error) return rpcErrorToResponse(error);
      return NextResponse.json({ ok: true });
    }

    const role = body?.role;

    if (!isAccountRole(role)) {
      return NextResponse.json(
        { error: t('account.members.roleInvalid') },
        { status: 400 },
      );
    }

    // The RPC blocks promotion to / demotion from owner, but
    // surface the friendlier 400 before crossing the wire too.
    if (role === "owner") {
      return NextResponse.json(
        {
          error:
            t('account.members.useTransferOwnership'),
        },
        { status: 400 },
      );
    }

    const { error } = await ctx.supabase.rpc("set_member_role", {
      p_user_id: userId,
      p_new_role: role,
    });

    if (error) return rpcErrorToResponse(error);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:memberRemove:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const { data, error } = await ctx.supabase.rpc("remove_account_member", {
      p_user_id: userId,
    });

    if (error) return rpcErrorToResponse(error);

    return NextResponse.json({ ok: true, newPersonalAccountId: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
