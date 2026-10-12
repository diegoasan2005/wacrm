// ============================================================
// /api/account/role-config — per-role option visibility (055)
//
//   GET  — the parsed config. Any member (sidebar + settings rail
//          read it on every load).
//   PUT  — save a new config. OWNER only: this decides what every
//          other role can see, so administering it is an owner
//          power by design.
//
// The payload is sanitized through parseRoleVisibilityConfig —
// unknown keys/roles are dropped, so a crafted PUT can only ever
// store a well-formed hide-list. Hiding options is decluttering:
// every API keeps its own role gates, so this never grants access.
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { parseRoleVisibilityConfig } from "@/lib/auth/role-visibility";
import { getT } from "@/lib/i18n/translate";

const t = getT("Api");

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data, error } = await ctx.supabase
      .from("accounts")
      .select("role_nav_config")
      .eq("id", ctx.accountId)
      .maybeSingle();

    if (error) {
      console.error("[GET /api/account/role-config] error:", error);
      return NextResponse.json({ error: t("account.loadFailed") }, { status: 500 });
    }

    return NextResponse.json({ config: parseRoleVisibilityConfig(data?.role_nav_config) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    if (ctx.role !== "owner") {
      return NextResponse.json({ error: t("agenda.adminRequired") }, { status: 403 });
    }

    const body = (await request.json().catch(() => null)) as { config?: unknown } | null;
    const config = parseRoleVisibilityConfig(body?.config);

    const { error } = await ctx.supabase
      .from("accounts")
      .update({ role_nav_config: config })
      .eq("id", ctx.accountId);

    if (error) {
      console.error("[PUT /api/account/role-config] error:", error);
      return NextResponse.json({ error: t("account.saveFailed") }, { status: 500 });
    }

    return NextResponse.json({ ok: true, config });
  } catch (err) {
    return toErrorResponse(err);
  }
}
