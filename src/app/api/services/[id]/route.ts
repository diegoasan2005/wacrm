// ============================================================
// /api/services/[id]
//
//   PATCH  — edit a service (fields, activate/deactivate, set as
//            default). Admin+.
//   DELETE — physically remove a service. Admin+, and only when
//            no appointment references it — otherwise the client
//            is told to deactivate instead (history preservation,
//            module spec §5.2).
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { hasMinRole } from "@/lib/auth/roles";
import { getT } from "@/lib/i18n/translate";
import {
  normalizeServiceInput,
  serviceDuplicateNameError,
} from "@/lib/appointments/service-input";

const t = getT("Api");

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getCurrentAccount();
    if (!hasMinRole(ctx.role, "admin")) {
      return NextResponse.json({ error: t("agenda.adminRequired") }, { status: 403 });
    }

    const { id } = await params;
    const body = (await request.json().catch(() => null)) as unknown;
    const input = normalizeServiceInput(body, true);
    if (!input.ok) {
      return NextResponse.json({ error: input.error }, { status: 400 });
    }

    // Row must exist in the caller's account (RLS would filter the
    // update anyway; this yields the friendly 404).
    const { data: existing } = await ctx.supabase
      .from("appointment_services")
      .select("id")
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (!existing) {
      return NextResponse.json({ error: t("agenda.serviceNotFound") }, { status: 404 });
    }

    if (
      input.value.name &&
      (await serviceDuplicateNameError(ctx.supabase, ctx.accountId, input.value.name, id))
    ) {
      return NextResponse.json({ error: t("agenda.serviceDuplicate") }, { status: 409 });
    }

    const { data, error } = await ctx.supabase
      .from("appointment_services")
      .update(input.value)
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .select("*")
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: t("agenda.serviceDuplicate") }, { status: 409 });
      }
      console.error("[PATCH /api/services/[id]] update error:", error);
      return NextResponse.json({ error: t("agenda.serviceSaveFailed") }, { status: 500 });
    }

    if (data.is_default) {
      const { error: rpcErr } = await ctx.supabase.rpc("set_default_service", {
        p_service_id: id,
      });
      if (rpcErr) {
        console.error("[PATCH /api/services/[id]] set_default_service error:", rpcErr);
      }
    }

    return NextResponse.json({ service: data });
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
    if (!hasMinRole(ctx.role, "admin")) {
      return NextResponse.json({ error: t("agenda.adminRequired") }, { status: 403 });
    }

    const { id } = await params;

    // A service with appointment history must not vanish — the
    // appointments keep the FK (ON DELETE SET NULL) but the UI is
    // steered to deactivation instead.
    const { count } = await ctx.supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("service_id", id)
      .eq("account_id", ctx.accountId);

    if ((count ?? 0) > 0) {
      return NextResponse.json(
        { error: t("agenda.serviceInUse") },
        { status: 409 },
      );
    }

    const { error } = await ctx.supabase
      .from("appointment_services")
      .delete()
      .eq("id", id)
      .eq("account_id", ctx.accountId);

    if (error) {
      console.error("[DELETE /api/services/[id]] delete error:", error);
      return NextResponse.json({ error: t("agenda.serviceSaveFailed") }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
