// ============================================================
// /api/services — appointment services administration (047)
//
//   GET   — list the account's services. Any member (agents need
//           the menu to book; RLS scopes the rows).
//   POST  — create a service. Admin+ (RLS enforces; we pre-check
//           for the friendly 403).
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

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data, error } = await ctx.supabase
      .from("appointment_services")
      .select("*")
      .eq("account_id", ctx.accountId)
      .order("name", { ascending: true });

    if (error) {
      console.error("[GET /api/services] fetch error:", error);
      return NextResponse.json({ error: t("agenda.serviceLoadFailed") }, { status: 500 });
    }

    return NextResponse.json({ services: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    if (!hasMinRole(ctx.role, "admin")) {
      return NextResponse.json({ error: t("agenda.adminRequired") }, { status: 403 });
    }

    const body = (await request.json().catch(() => null)) as unknown;
    const input = normalizeServiceInput(body);
    if (!input.ok) {
      return NextResponse.json({ error: input.error }, { status: 400 });
    }

    // Friendly duplicate-name pre-check (the DB unique index on
    // lower(trim(name)) is the backstop).
    if (await serviceDuplicateNameError(ctx.supabase, ctx.accountId, input.value.name, null)) {
      return NextResponse.json({ error: t("agenda.serviceDuplicate") }, { status: 409 });
    }

    const { data, error } = await ctx.supabase
      .from("appointment_services")
      .insert({ ...input.value, account_id: ctx.accountId })
      .select("*")
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: t("agenda.serviceDuplicate") }, { status: 409 });
      }
      console.error("[POST /api/services] insert error:", error);
      return NextResponse.json({ error: t("agenda.serviceSaveFailed") }, { status: 500 });
    }

    // Default flag is moved atomically by the RPC (retires the old
    // default in the same transaction).
    if (data.is_default) {
      const { error: rpcErr } = await ctx.supabase.rpc("set_default_service", {
        p_service_id: data.id,
      });
      if (rpcErr) {
        console.error("[POST /api/services] set_default_service error:", rpcErr);
      }
    }

    return NextResponse.json({ service: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
