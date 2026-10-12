"use client";

// ============================================================
// AppointmentDialog — create / edit / view an appointment.
//
// Two sections, mirroring the reference design: client info
// (existing-contact search or inline creation) and appointment
// info (date, time, specialist, service, duration, status,
// notes). All authorisation is enforced server-side; the dialog
// only adapts which controls are enabled.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Loader2, Search, UserPlus, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import {
  allowedTransitions,
  canCreateAppointments,
  canEditAppointment,
  canReassignAppointments,
  type AgendaRoleContext,
} from "@/lib/appointments/permissions";
import { STATUS_META } from "@/lib/appointments/statuses";
import {
  minutesToHHMM,
  wallTimeToUtc,
  utcToDateKey,
  utcToMinutes,
} from "@/lib/appointments/time";
import { DEFAULT_DURATIONS } from "@/lib/appointments/constants";
import type {
  Appointment,
  AppointmentService,
  AppointmentStatus,
} from "@/types/appointments";
import type { AccountMember } from "@/types";

export interface DialogPreset {
  dateKey: string;
  minutes: number;
  memberId?: string;
  contactId?: string;
}

interface ContactHit {
  id: string;
  name: string | null;
  last_name: string | null;
  identification: string | null;
  phone: string;
}

interface AppointmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing appointment → edit mode. */
  appointment: Appointment | null;
  /** Slot preset → create mode. */
  preset: DialogPreset | null;
  services: AppointmentService[];
  members: AccountMember[];
  onSaved: () => void;
}

const MONTHS_I18N_NS = "Agenda.months";
const MONTH_KEYS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

export function AppointmentDialog({
  open,
  onOpenChange,
  appointment,
  preset,
  services,
  members,
  onSaved,
}: AppointmentDialogProps) {
  const t = useTranslations("Agenda.dialog");
  const tMonths = useTranslations(MONTHS_I18N_NS);
  const { accountRole, userId, accountTimezone } = useAuth();

  const roleCtx: AgendaRoleContext | null = useMemo(
    () =>
      accountRole && userId
        ? {
            role: accountRole,
            // The live flag for agents — resolved from the profile in
            // useAuth (canBookAppointments already folds admin+ in).
            canBookAppointments: canCreateAppointments({
              role: accountRole,
              canBookAppointments: true,
              userId,
            }),
            userId,
          }
        : null,
    [accountRole, userId],
  );

  const isEdit = !!appointment;
  const canWrite = !!roleCtx && isEdit
    ? canEditAppointment(roleCtx, appointment)
    : !!roleCtx && canCreateAppointments(roleCtx);
  const canReassign = !!accountRole && canReassignAppointments(accountRole);
  // Read-only mode: viewers inspecting an appointment.
  const readOnly = isEdit && !canWrite;

  // --- client section state
  const [contactQuery, setContactQuery] = useState("");
  const [contactHits, setContactHits] = useState<ContactHit[]>([]);
  const [searchingContacts, setSearchingContacts] = useState(false);
  const [selectedContact, setSelectedContact] = useState<ContactHit | null>(null);
  const [creatingContact, setCreatingContact] = useState(false);
  const [newContact, setNewContact] = useState({
    identification: "",
    name: "",
    last_name: "",
    phone: "",
    birth_month: "",
    birth_day: "",
  });

  // --- appointment section state
  const [dateKey, setDateKey] = useState(preset?.dateKey ?? "");
  const [timeMinutes, setTimeMinutes] = useState(preset?.minutes ?? 9 * 60);
  const [serviceId, setServiceId] = useState("");
  const [duration, setDuration] = useState("30");
  const [memberId, setMemberId] = useState(preset?.memberId ?? "");
  const [status, setStatus] = useState<AppointmentStatus>("PENDIENTE");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  // Migration 048: a member is offered as specialist iff their
  // "Visible en agenda" flag is on — any role.
  const eligibleMembers = useMemo(
    () => members.filter((m) => m.show_in_agenda ?? true),
    [members],
  );

  const bookableServices = useMemo(
    () => services.filter((s) => s.is_active && s.available_for_booking),
    [services],
  );

  // Reset state when the dialog opens.
  useEffect(() => {
    if (!open) return;
    if (appointment) {
      setDateKey(utcToDateKey(appointment.starts_at, accountTimezone));
      setTimeMinutes(utcToMinutes(appointment.starts_at, accountTimezone));
      setServiceId(appointment.service_id ?? "");
      setDuration(String(appointment.duration_minutes));
      setMemberId(appointment.assigned_user_id);
      setStatus(appointment.status);
      setNotes(appointment.notes ?? "");
      setSelectedContact(
        appointment.contact
          ? {
              id: appointment.contact.id,
              name: appointment.contact.name ?? null,
              last_name: appointment.contact.last_name ?? null,
              identification: appointment.contact.identification ?? null,
              phone: appointment.contact.phone,
            }
          : null,
      );
      setCreatingContact(false);
      setContactQuery("");
      setContactHits([]);
    } else if (preset) {
      setDateKey(preset.dateKey);
      setTimeMinutes(preset.minutes);
      setMemberId(preset.memberId ?? userId ?? "");
      setStatus("PENDIENTE");
      setNotes("");
      setSelectedContact(null);
      setCreatingContact(false);
      setContactQuery("");
      setContactHits([]);
      // Preload the account's default service.
      const def = services.find((s) => s.is_default && s.is_active);
      if (def) {
        setServiceId(def.id);
        setDuration(String(def.duration_minutes));
      } else {
        setServiceId("");
        setDuration("30");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, appointment, preset, accountTimezone]);

  // Service → duration autoload (spec §5.3).
  const handleServiceChange = useCallback(
    (id: string) => {
      setServiceId(id);
      const svc = services.find((s) => s.id === id);
      if (svc) setDuration(String(svc.duration_minutes));
    },
    [services],
  );

  // --- contact search (debounced) — runs while the search box is
  // visible (NOT in inline-creation mode; the condition was
  // inverted, which made results only appear after toggling to the
  // create form and back).
  const searchSeq = useRef(0);
  useEffect(() => {
    if (!open || creatingContact) return;
    const term = contactQuery.trim();
    if (term.length < 2) {
      setContactHits([]);
      return;
    }
    const timer = setTimeout(async () => {
      const seq = ++searchSeq.current;
      setSearchingContacts(true);
      const supabase = createClient();
      const like = `%${term}%`;
      const digits = term.replace(/\D/g, "");
      const parts = [
        `name.ilike.${like}`,
        `identification.ilike.${like}`,
      ];
      if (digits.length >= 3) parts.push(`phone.ilike.%${digits}%`);
      const { data } = await supabase
        .from("contacts")
        .select("id, name, last_name, identification, phone")
        .or(parts.join(","))
        .limit(8);
      if (seq === searchSeq.current) {
        setContactHits((data ?? []) as ContactHit[]);
        setSearchingContacts(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [contactQuery, creatingContact, open]);

  async function handleSave() {
    if (!dateKey || !serviceId || !memberId) {
      toast.error(t("missingFields"));
      return;
    }

    setSaving(true);
    try {
      const startsAt = wallTimeToUtc(dateKey, timeMinutes, accountTimezone);
      const payload: Record<string, unknown> = {
        service_id: serviceId,
        assigned_user_id: memberId,
        starts_at: startsAt.toISOString(),
        duration_minutes: Number(duration),
      };
      // Only send notes when there is content — an empty string
      // would otherwise route every status-only edit through the
      // field-update path.
      if (notes.trim()) payload.notes = notes;

      let res: Response;
      if (isEdit && appointment) {
        payload.status = status;
        res = await fetch(`/api/appointments/${appointment.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        if (selectedContact) {
          payload.contact_id = selectedContact.id;
        } else {
          payload.contact = {
            identification: newContact.identification,
            name: newContact.name,
            last_name: newContact.last_name,
            phone: newContact.phone,
            birth_month:
              newContact.birth_month === "" ? null : newContact.birth_month,
            birth_day: newContact.birth_day === "" ? null : newContact.birth_day,
          };
        }
        res = await fetch("/api/appointments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }

      const resp = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(resp.error || t("saveFailed"));
        return;
      }
      toast.success(isEdit ? t("updatedToast") : t("createdToast"));
      onSaved();
      onOpenChange(false);
    } catch (err) {
      console.error("[AppointmentDialog] save error:", err);
      toast.error(t("networkError"));
    } finally {
      setSaving(false);
    }
  }

  const statusOptions = useMemo(() => {
    if (!roleCtx || !isEdit) return ["PENDIENTE"] as const;
    return allowedTransitions(roleCtx, appointment.status);
  }, [roleCtx, isEdit, appointment]);

  const endTime = useMemo(
    () => minutesToHHMM(timeMinutes + Number(duration || 0)),
    [timeMinutes, duration],
  );

  // Contact search box visibility: editing shows the linked contact;
  // creating offers search + inline creation.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("editTitle") : t("createTitle")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-primary">
            {t("clientSection")}
          </h3>

            {isEdit ? (
              <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                <p className="font-medium text-foreground">
                  {[
                    selectedContact?.name,
                    selectedContact?.last_name,
                  ]
                    .filter(Boolean)
                    .join(" ") || t("unnamedContact")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {selectedContact?.phone || "—"}
                  {selectedContact?.identification
                    ? ` · ${selectedContact.identification}`
                    : ""}
                </p>
              </div>
            ) : selectedContact ? (
              <div className="flex items-center justify-between rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm">
                <div>
                  <p className="font-medium text-foreground">
                    {[
                      selectedContact.name,
                      selectedContact.last_name,
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {selectedContact.phone}
                    {selectedContact.identification
                      ? ` · ${selectedContact.identification}`
                      : ""}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setSelectedContact(null)}
                  aria-label={t("changeContact")}
                >
                  <X className="size-4" />
                </Button>
              </div>
            ) : creatingContact ? (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="appt-id">{t("identification")} *</Label>
                    <Input
                      id="appt-id"
                      value={newContact.identification}
                      onChange={(e) =>
                        setNewContact((c) => ({
                          ...c,
                          identification: e.target.value,
                        }))
                      }
                      maxLength={60}
                      className="bg-background border-border"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="appt-name">{t("firstName")} *</Label>
                    <Input
                      id="appt-name"
                      value={newContact.name}
                      onChange={(e) =>
                        setNewContact((c) => ({ ...c, name: e.target.value }))
                      }
                      className="bg-background border-border"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="appt-last">{t("lastName")} *</Label>
                    <Input
                      id="appt-last"
                      value={newContact.last_name}
                      onChange={(e) =>
                        setNewContact((c) => ({
                          ...c,
                          last_name: e.target.value,
                        }))
                      }
                      className="bg-background border-border"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="appt-phone">{t("phone")}</Label>
                    <Input
                      id="appt-phone"
                      value={newContact.phone}
                      onChange={(e) =>
                        setNewContact((c) => ({ ...c, phone: e.target.value }))
                      }
                      inputMode="tel"
                      className="bg-background border-border"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("birthMonth")}</Label>
                    <Select
                      value={newContact.birth_month}
                      onValueChange={(v) =>
                        setNewContact((c) => ({ ...c, birth_month: v ?? "" }))
                      }
                    >
                      <SelectTrigger className="bg-background border-border">
                        <SelectValue placeholder={t("select")}>
                          {newContact.birth_month
                            ? tMonths(
                                MONTH_KEYS[Number(newContact.birth_month) - 1],
                              )
                            : t("select")}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {MONTH_KEYS.map((key, i) => (
                          <SelectItem key={key} value={String(i + 1)}>
                            {tMonths(key)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("birthDay")}</Label>
                    <Select
                      value={newContact.birth_day}
                      onValueChange={(v) =>
                        setNewContact((c) => ({ ...c, birth_day: v ?? "" }))
                      }
                    >
                      <SelectTrigger className="bg-background border-border">
                        <SelectValue placeholder={t("select")} />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                          <SelectItem key={d} value={String(d)}>
                            {d}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setCreatingContact(false)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  ← {t("searchExistingInstead")}
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                  <Input
                    value={contactQuery}
                    onChange={(e) => setContactQuery(e.target.value)}
                    placeholder={t("contactSearchPlaceholder")}
                    className="pl-8 bg-background border-border"
                  />
                  {searchingContacts && (
                    <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 size-4 animate-spin text-muted-foreground" />
                  )}
                </div>
                {contactHits.length > 0 && (
                  <ul className="max-h-40 overflow-y-auto rounded-md border border-border divide-y divide-border">
                    {contactHits.map((hit) => (
                      <li key={hit.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedContact(hit);
                            setContactQuery("");
                            setContactHits([]);
                          }}
                          className="w-full px-3 py-2 text-left text-sm hover:bg-muted/60"
                        >
                          <span className="font-medium text-foreground">
                            {[hit.name, hit.last_name].filter(Boolean).join(" ") ||
                              t("unnamedContact")}
                          </span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {hit.phone}
                            {hit.identification ? ` · ${hit.identification}` : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  type="button"
                  onClick={() => {
                    // Prefill from the search term: digits → ID
                    // number, text → first name.
                    const term = contactQuery.trim();
                    if (term) {
                      if (/^[\d\s.\-()]+$/.test(term)) {
                        setNewContact((c) => ({
                          ...c,
                          identification: term,
                        }));
                      } else {
                        setNewContact((c) => ({ ...c, name: term }));
                      }
                    }
                    setCreatingContact(true);
                  }}
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <UserPlus className="size-3.5" />
                  {t("createNewContact")}
                </button>
              </div>
            )}
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-primary">
            {t("appointmentSection")}
          </h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="appt-date">{t("date")} *</Label>
              <Input
                id="appt-date"
                type="date"
                value={dateKey}
                onChange={(e) => setDateKey(e.target.value)}
                disabled={readOnly}
                className="bg-background border-border"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="appt-time">{t("time")} *</Label>
              <Input
                id="appt-time"
                type="time"
                step={300}
                value={minutesToHHMM(timeMinutes)}
                onChange={(e) => {
                  const [h = "0", m = "0"] = e.target.value.split(":");
                  setTimeMinutes(Number(h) * 60 + Number(m));
                }}
                disabled={readOnly}
                className="bg-background border-border"
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("specialist")} *</Label>
              {isEdit && !canReassign ? (
                <Input
                  value={
                    eligibleMembers.find((m) => m.user_id === memberId)
                      ?.full_name ?? "—"
                  }
                  readOnly
                  disabled
                  className="bg-muted border-border"
                />
              ) : (
                <Select
                  value={memberId}
                  onValueChange={(v) => v && setMemberId(v)}
                  disabled={readOnly || (!!accountRole && accountRole === "agent")}
                >
                  <SelectTrigger className="bg-background border-border">
                    <SelectValue placeholder={t("select")}>
                      {eligibleMembers.find((m) => m.user_id === memberId)
                        ?.full_name ?? t("select")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {eligibleMembers.map((m) => (
                      <SelectItem key={m.user_id} value={m.user_id}>
                        {m.full_name || m.user_id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>{t("service")} *</Label>
              <Select
                value={serviceId}
                onValueChange={(v) => v && handleServiceChange(v)}
                disabled={readOnly}
              >
                <SelectTrigger className="bg-background border-border">
                  <SelectValue placeholder={t("select")}>
                    {bookableServices.find((s) => s.id === serviceId)?.name ??
                      t("select")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {bookableServices.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="appt-duration">{t("duration")} *</Label>
              <Select
                value={duration}
                onValueChange={(v) => v && setDuration(v)}
                disabled={readOnly}
              >
                <SelectTrigger className="bg-background border-border">
                  <SelectValue>
                    {t("minutes", { count: Number(duration) || 30 })}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Array.from(
                    new Set([
                      ...DEFAULT_DURATIONS,
                      Number(duration) || 30,
                    ]),
                  )
                    .sort((a, b) => a - b)
                    .map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {t("minutes", { count: m })}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("status")}</Label>
              <Select
                value={status}
                onValueChange={(v) => v && setStatus(v as AppointmentStatus)}
                disabled={readOnly || statusOptions.length === 0}
              >
                <SelectTrigger className="bg-background border-border">
                  <SelectValue>
                    <span className={STATUS_META[status].textClass}>
                      {t(`statuses.${STATUS_META[status].labelKey}`)}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(statusOptions as readonly AppointmentStatus[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      <span className={STATUS_META[s].textClass}>
                        {t(`statuses.${STATUS_META[s].labelKey}`)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-3">
              <Label htmlFor="appt-notes">{t("notes")}</Label>
              <Input
                id="appt-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={readOnly}
                maxLength={2000}
                placeholder={t("notesPlaceholder")}
                className="bg-background border-border"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("endTimeLabel", { time: endTime })}
          </p>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t("cancel")}
          </Button>
          {!readOnly && (
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {t("accept")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
