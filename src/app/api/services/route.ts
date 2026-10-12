// ============================================================
// /api/services — appointment services administration (047/054)
//
//   GET   — list the account's services, each with its assigned
//           member ids (empty = applies to all members). Any member
//           (agents need the menu to book; RLS scopes the rows).
//   POST  — create a service + optional member assignments.
//           Admin+ (RLS enforces; we pre-check for the 403).
// ============================================================

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { hasMinRole } from "@/lib/auth/roles";
import { getT } from "@/lib/i18n/translate";
import {
  normalizeServiceInput,
  serviceDuplicateNameError,
} from "@/lib/appointments/service-input";

const t = getT("Api");

/** Insert the member rows for a service, replacing previous ones. */
async function syncServiceMembers(
  supabase: SupabaseClient,
  accountId: string,
  serviceId: string,
  memberIds: string[],
) {
  await supabase
    .from("appointment_service_members")
    .delete()
    .eq("service_id", serviceId)
    .eq("account_id", accountId);

  if (memberIds.length > 0) {
    const { error } = await supabase.from("appointment_service_members").insert(
      memberIds.map((user_id) => ({
        service_id: serviceId,
        user_id,
        account_id: accountId,
      })),
    );
    if (error) throw error;
  }
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const [servicesRes, membersRes] = await Promise.all([
      ctx.supabase
        .from("appointment_services")
        .select("*")
        .eq("account_id", ctx.accountId)
        .order("name", { ascending: true }),
      ctx.supabase
        .from("appointment_service_members")
        .select("service_id, user_id")
        .eq("account_id", ctx.accountId),
    ]);

    if (servicesRes.error || membersRes.error) {
      const err = servicesRes.error ?? membersRes.error;
      console.error("[GET /api/services] fetch error:", err);
      return NextResponse.json({ error: t("agenda.serviceLoadFailed") }, { status: 500 });
    }

    // Map service_id → assigned member ids.
    const byService = new Map<string, string[]>();
    for (const row of membersRes.data ?? []) {
      const list = byService.get(row.service_id) ?? [];
      list.push(row.user_id);
      byService.set(row.service_id, list);
    }

    const services = (servicesRes.data ?? []).map((s) => ({
      ...s,
      member_ids: byService.get(s.id) ?? [],
    }));

    return NextResponse.json({ services });
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

    const body = (await request.json().catch(() => null)) as
      | (Record<string, unknown> & { member_ids?: unknown })
      | null;
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

    // Member assignments (054). Only when the field was sent — an
    // absent key means "applies to all members".
    if (Array.isArray(body?.member_ids)) {
      try {
        await syncServiceMembers(
          ctx.supabase,
          ctx.accountId,
          data.id,
          body.member_ids as string[],
        );
      } catch (memberErr) {
        console.error("[POST /api/services] member sync error:", memberErr);
        return NextResponse.json({ error: t("agenda.serviceSaveFailed") }, { status: 500 });
      }
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

    return NextResponse.json(
      { service: { ...data, member_ids: Array.isArray(body?.member_ids) ? body.member_ids : [] } },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
