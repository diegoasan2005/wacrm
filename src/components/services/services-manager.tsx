"use client";

// ============================================================
// ServicesManager — the "Servicios" screen (module spec §5).
//
// Layout mirrors the reference design (form row on top, table
// below) but styled with WACRM's shadcn tokens. Admin+ can write;
// agents and viewers get a read-only roster (the server enforces
// it too — this only hides the controls).
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Save, Search, Star, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/hooks/use-auth";
import { canManageServices } from "@/lib/appointments/permissions";
import { DEFAULT_DURATIONS } from "@/lib/appointments/constants";
import type { AppointmentService } from "@/types/appointments";

const PAGE_SIZE = 25;

const EMPTY_FORM = {
  name: "",
  duration_minutes: "30",
  is_default: false,
  is_active: true,
  available_for_booking: true,
  price: "",
  color: "",
  description: "",
  max_concurrent: "1",
};

interface FormState {
  name: string;
  duration_minutes: string;
  is_default: boolean;
  is_active: boolean;
  available_for_booking: boolean;
  price: string;
  color: string;
  description: string;
  max_concurrent: string;
}

export function ServicesManager() {
  const t = useTranslations("Services");
  const { accountRole, defaultCurrency } = useAuth();
  const canWrite = accountRole ? canManageServices(accountRole) : false;

  const [services, setServices] = useState<AppointmentService[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);

  const loadServices = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/services", { cache: "no-store" });
      const payload = (await res.json().catch(() => ({}))) as {
        services?: AppointmentService[];
        error?: string;
      };
      if (!res.ok) {
        toast.error(payload.error || t("loadFailed"));
        return;
      }
      setServices(payload.services ?? []);
    } catch (err) {
      console.error("[ServicesManager] load error:", err);
      toast.error(t("networkError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadServices();
  }, [loadServices]);

  // Search filter (case-insensitive, on the loaded set — services
  // lists are small; server-side search would be over-engineering).
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const base = term
      ? services.filter(
          (s) =>
            s.name.toLowerCase().includes(term) ||
            (s.description ?? "").toLowerCase().includes(term),
        )
      : services;
    return base;
  }, [services, search]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function resetForm() {
    setForm({ ...EMPTY_FORM });
    setEditingId(null);
  }

  function startEdit(service: AppointmentService) {
    setEditingId(service.id);
    setForm({
      name: service.name,
      duration_minutes: String(service.duration_minutes),
      is_default: service.is_default,
      is_active: service.is_active,
      available_for_booking: service.available_for_booking,
      price: service.price != null ? String(service.price) : "",
      color: service.color ?? "",
      description: service.description ?? "",
      max_concurrent: String(service.max_concurrent ?? 1),
    });
    nameRef.current?.focus();
  }

  function validate(): string | null {
    const name = form.name.trim();
    if (name.length < 1 || name.length > 120) return t("form.nameRequired");
    const dur = Number(form.duration_minutes);
    if (!Number.isInteger(dur) || dur <= 0) return t("form.durationInvalid");
    const mc = Number(form.max_concurrent);
    if (!Number.isInteger(mc) || mc < 1 || mc > 50) return t("form.maxConcurrentInvalid");
    if (form.price !== "" && (Number.isNaN(Number(form.price)) || Number(form.price) < 0)) {
      return t("form.priceInvalid");
    }
    if (form.color && !/^#[0-9a-fA-F]{6}$/.test(form.color)) return t("form.colorInvalid");
    return null;
  }

  async function handleSave() {
    const invalid = validate();
    if (invalid) {
      toast.error(invalid);
      return;
    }
    // Client-side duplicate hint (server re-checks with the DB
    // unique index as the backstop).
    const term = form.name.trim().toLowerCase();
    if (
      services.some(
        (s) => s.id !== editingId && s.name.trim().toLowerCase() === term,
      )
    ) {
      toast.error(t("duplicateName"));
      return;
    }

    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        duration_minutes: Number(form.duration_minutes),
        is_default: form.is_default,
        is_active: form.is_active,
        available_for_booking: form.available_for_booking,
        price: form.price === "" ? null : Number(form.price),
        color: form.color === "" ? null : form.color,
        description: form.description.trim() || null,
        max_concurrent: Number(form.max_concurrent),
      };
      const res = await fetch(
        editingId ? `/api/services/${editingId}` : "/api/services",
        {
          method: editingId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        toast.error(payload.error || t("saveFailed"));
        return;
      }
      toast.success(editingId ? t("updatedToast") : t("createdToast"));
      resetForm();
      await loadServices();
    } catch (err) {
      console.error("[ServicesManager] save error:", err);
      toast.error(t("networkError"));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(service: AppointmentService) {
    setTogglingId(service.id);
    try {
      const res = await fetch(`/api/services/${service.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !service.is_active }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(payload.error || t("saveFailed"));
        return;
      }
      toast.success(
        !service.is_active ? t("activatedToast") : t("deactivatedToast"),
      );
      await loadServices();
    } catch (err) {
      console.error("[ServicesManager] toggle error:", err);
      toast.error(t("networkError"));
    } finally {
      setTogglingId(null);
    }
  }

  const priceFormatter = useMemo(
    () =>
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: defaultCurrency,
        maximumFractionDigits: 2,
      }),
    [defaultCurrency],
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t("subtitle")}</p>
      </div>

      {/* Form (admin+). Viewers / agents without admin see nothing —
          they only consume services through the booking modal. */}
      {canWrite && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5 lg:col-span-2">
              <Label htmlFor="service-name">{t("form.name")}</Label>
              <Input
                id="service-name"
                ref={nameRef}
                value={form.name}
                maxLength={120}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t("form.namePlaceholder")}
                className="bg-background border-border"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="service-duration">{t("form.duration")}</Label>
              <Input
                id="service-duration"
                type="number"
                min={5}
                step={5}
                inputMode="numeric"
                value={form.duration_minutes}
                onChange={(e) =>
                  setForm((f) => ({ ...f, duration_minutes: e.target.value }))
                }
                placeholder="5, 15, 30, 60…"
                className="bg-background border-border"
              />
              <div className="flex flex-wrap gap-1 pt-1">
                {DEFAULT_DURATIONS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() =>
                      setForm((f) => ({ ...f, duration_minutes: String(m) }))
                    }
                    className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t("form.isDefault")}</Label>
              <div className="flex h-9 items-center gap-2">
                <Switch
                  checked={form.is_default}
                  onCheckedChange={(v) =>
                    setForm((f) => ({ ...f, is_default: v }))
                  }
                  aria-label={t("form.isDefault")}
                />
                <span className="text-sm text-muted-foreground">
                  {form.is_default ? t("yes") : t("no")}
                </span>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t("form.status")}</Label>
              <Select
                value={form.is_active ? "active" : "inactive"}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, is_active: v === "active" }))
                }
              >
                {/* SelectValue renders the raw item value unless a
                    child label is given — pass the translated one. */}
                <SelectTrigger className="bg-background border-border">
                  <SelectValue>
                    {form.is_active ? t("statusActive") : t("statusInactive")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">{t("statusActive")}</SelectItem>
                  <SelectItem value="inactive">{t("statusInactive")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="service-max-concurrent">
                {t("form.maxConcurrent")}
              </Label>
              <Input
                id="service-max-concurrent"
                type="number"
                min={1}
                max={50}
                step={1}
                inputMode="numeric"
                value={form.max_concurrent}
                onChange={(e) =>
                  setForm((f) => ({ ...f, max_concurrent: e.target.value }))
                }
                placeholder="1"
                className="bg-background border-border"
              />
              <p className="text-xs text-muted-foreground">
                {t("form.maxConcurrentHint")}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="service-price">
                {t("form.price", { currency: defaultCurrency })}
              </Label>
              <Input
                id="service-price"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={form.price}
                onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                placeholder={t("form.pricePlaceholder")}
                className="bg-background border-border"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="service-color">{t("form.color")}</Label>
              <div className="flex h-9 items-center gap-2">
                <input
                  id="service-color"
                  type="color"
                  value={form.color || "#ec4899"}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, color: e.target.value }))
                  }
                  className="h-9 w-12 cursor-pointer rounded border border-border bg-background"
                  disabled={!form.color && false}
                  aria-label={t("form.color")}
                />
                {form.color ? (
                  <button
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, color: "" }))}
                    className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                  >
                    <X className="size-3" />
                    {t("form.colorClear")}
                  </button>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {t("form.colorNone")}
                  </span>
                )}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t("form.bookable")}</Label>
              <div className="flex h-9 items-center gap-2">
                <Switch
                  checked={form.available_for_booking}
                  onCheckedChange={(v) =>
                    setForm((f) => ({ ...f, available_for_booking: v }))
                  }
                  aria-label={t("form.bookable")}
                />
                <span className="text-sm text-muted-foreground">
                  {form.available_for_booking ? t("yes") : t("no")}
                </span>
              </div>
            </div>
            <div className="space-y-1.5 sm:col-span-2 lg:col-span-4">
              <Label htmlFor="service-description">{t("form.description")}</Label>
              <Input
                id="service-description"
                value={form.description}
                maxLength={1000}
                onChange={(e) =>
                  setForm((f) => ({ ...f, description: e.target.value }))
                }
                placeholder={t("form.descriptionPlaceholder")}
                className="bg-background border-border"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              {editingId ? t("save") : t("create")}
            </Button>
            {editingId && (
              <Button
                variant="outline"
                onClick={resetForm}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                <Plus className="size-4" />
                {t("newService")}
              </Button>
            )}
            {editingId && (
              <span className="text-xs text-muted-foreground">
                {t("editingExisting")}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative w-full max-w-sm">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          placeholder={t("searchPlaceholder")}
          className="pl-8 bg-card border-border"
        />
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="text-muted-foreground">{t("table.name")}</TableHead>
              <TableHead className="text-muted-foreground">{t("table.duration")}</TableHead>
              <TableHead className="text-muted-foreground hidden md:table-cell">
                {t("table.price")}
              </TableHead>
              <TableHead className="text-muted-foreground hidden lg:table-cell">
                {t("table.maxConcurrent")}
              </TableHead>
              <TableHead className="text-muted-foreground">{t("table.isDefault")}</TableHead>
              <TableHead className="text-muted-foreground">{t("table.status")}</TableHead>
              {canWrite && (
                <TableHead className="text-muted-foreground">{t("table.actions")}</TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow className="border-border">
                <TableCell colSpan={6} className="text-center py-12">
                  <Loader2 className="size-6 animate-spin text-primary mx-auto" />
                </TableCell>
              </TableRow>
            ) : pageRows.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={6} className="text-center py-12 text-sm text-muted-foreground">
                  {search ? t("noMatch") : t("empty")}
                </TableCell>
              </TableRow>
            ) : (
              pageRows.map((service) => (
                <TableRow key={service.id} className="border-border hover:bg-muted/50">
                  <TableCell className="text-foreground font-medium">
                    <span className="flex items-center gap-2">
                      {service.color && (
                        <span
                          aria-hidden
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: service.color }}
                        />
                      )}
                      <span className="truncate">{service.name}</span>
                    </span>
                    {service.description && (
                      <span className="block text-xs text-muted-foreground max-w-xs truncate">
                        {service.description}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {t("durationMinutes", { count: service.duration_minutes })}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden md:table-cell">
                    {service.price != null
                      ? priceFormatter.format(service.price)
                      : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden lg:table-cell">
                    {service.max_concurrent ?? 1}
                  </TableCell>
                  <TableCell>
                    {service.is_default ? (
                      <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300">
                        <Star className="size-3" />
                        {t("defaultYes")}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t("defaultNo")}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      className={
                        service.is_active
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                          : "border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-300"
                      }
                    >
                      {service.is_active ? t("statusActive") : t("statusInactive")}
                    </Badge>
                  </TableCell>
                  {canWrite && (
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => startEdit(service)}
                          className="border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <Pencil className="size-3.5" />
                          {t("edit")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => toggleActive(service)}
                          disabled={togglingId === service.id}
                          className={
                            service.is_active
                              ? "border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20"
                              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                          }
                        >
                          {togglingId === service.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            t(service.is_active ? "deactivate" : "activate")
                          )}
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {t("pageCount", { page: page + 1, total: totalPages })}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="border-border text-muted-foreground disabled:opacity-30"
            >
              {t("prevPage")}
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="border-border text-muted-foreground disabled:opacity-30"
            >
              {t("nextPage")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
