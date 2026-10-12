"use client";

// ============================================================
// RoleConfigPanel — Settings → Roles & access (owner-only).
//
// The owner picks, per configurable role (admin / agent / viewer),
// which nav options and settings sections are HIDDEN. Unchecked =
// visible (the default). The owner always sees every option.
// Saving PUTs the hide-lists to /api/account/role-config.
// ============================================================

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Save } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import {
  HIDEABLE_SETTINGS_KEYS,
  NAV_KEYS,
  type ConfigurableRole,
  type RoleVisibilityConfig,
  type RoleVisibilityEntry,
} from "@/lib/auth/role-visibility";

const CONFIGURABLE_ROLES: ConfigurableRole[] = ["admin", "agent", "viewer"];

/** Sidebar i18n label key for a nav option key. */
function navLabelKey(key: string): string {
  if (key === "agents") return "aiAgents";
  if (key === "agenda-historial") return "agendaHistorial";
  return key;
}

function emptyEntry(): RoleVisibilityEntry {
  return { nav: [], settings: [] };
}

export function RoleConfigPanel() {
  const t = useTranslations("Settings.rolesConfig");
  const tRoles = useTranslations("Settings.roles");
  const tSections = useTranslations("Settings.sections");
  const { roleNavConfig, refreshProfile } = useAuth();

  const [role, setRole] = useState<ConfigurableRole>("admin");
  const [config, setConfig] = useState<RoleVisibilityConfig>(roleNavConfig);
  const [saving, setSaving] = useState(false);

  const entry: RoleVisibilityEntry = config[role] ?? emptyEntry();

  function toggle(list: "nav" | "settings", key: string) {
    setConfig((prev) => {
      const current = prev[role] ?? emptyEntry();
      const has = current[list].includes(key);
      return {
        ...prev,
        [role]: {
          nav: current.nav,
          settings: current.settings,
          [list]: has
            ? current[list].filter((k) => k !== key)
            : [...current[list], key],
        },
      };
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/account/role-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(payload.error || t("saveFailed"));
        return;
      }
      toast.success(t("savedToast"));
      // Refresh the account context so the sidebar/rail reflect the
      // new visibility without a full reload.
      await refreshProfile();
    } catch (err) {
      console.error("[RoleConfigPanel] save error:", err);
      toast.error(t("networkError"));
    } finally {
      setSaving(false);
    }
  }

  const settingsOptions = useMemo(
    () =>
      HIDEABLE_SETTINGS_KEYS.map((id) => ({
        id,
        label: tSections(id),
      })),
    [tSections],
  );

  const navOptions = useMemo(
    () =>
      NAV_KEYS.filter((k) => k !== "settings").map((key) => ({
        key,
      })),
    [],
  );
  void navOptions;

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
        <p className="mt-2 text-xs text-muted-foreground">{t("ownerHint")}</p>
      </div>

      <div className="max-w-xs space-y-1.5">
        <label className="text-sm font-medium text-foreground">{t("roleLabel")}</label>
        <Select value={role} onValueChange={(v) => v && setRole(v as ConfigurableRole)}>
          <SelectTrigger className="w-full bg-card border-border">
            {/* SelectValue renders the raw item value without a child
                label — pass the translated one. */}
            <SelectValue>{tRoles(role)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {CONFIGURABLE_ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {tRoles(r)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-border">
          <CardContent className="p-4">
            <p className="text-sm font-semibold text-foreground">{t("navGroup")}</p>
            <p className="mb-3 mt-1 text-xs text-muted-foreground">{t("hiddenHint")}</p>
            <div className="flex flex-col gap-2">
              {NAV_KEYS.filter((k) => k !== "settings").map((key) => (
                <label
                  key={key}
                  className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
                >
                  <Checkbox
                    checked={entry.nav.includes(key)}
                    onCheckedChange={() => toggle("nav", key)}
                    aria-label={t(`navKeys.${navLabelKey(key)}`)}
                  />
                  {t(`navKeys.${navLabelKey(key)}`)}
                </label>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="border-border">
          <CardContent className="p-4">
            <p className="text-sm font-semibold text-foreground">{t("settingsGroup")}</p>
            <p className="mb-3 mt-1 text-xs text-muted-foreground">{t("hiddenHint")}</p>
            <div className="flex flex-col gap-2">
              {settingsOptions.map(({ id, label }) => (
                <label
                  key={id}
                  className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
                >
                  <Checkbox
                    checked={entry.settings.includes(id)}
                    onCheckedChange={() => toggle("settings", id)}
                    aria-label={label}
                  />
                  {label}
                </label>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Button
        onClick={handleSave}
        disabled={saving}
        className="bg-primary hover:bg-primary/90 text-primary-foreground"
      >
        {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
        {t("save")}
      </Button>
    </section>
  );
}
