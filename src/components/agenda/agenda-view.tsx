"use client";

// ============================================================
// AgendaView — the "Agenda" screen orchestrator (module spec §7).
//
// Owns: view mode (day/week/month/list), selected date, filters
// (members / statuses / service), range fetching, the realtime
// subscription (appointments table, RLS-scoped) and the
// appointment dialog. Day-by-member is the primary view.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/hooks/use-auth";
import {
  canCreateAppointments,
  canViewAllAgendas,
  type AgendaRoleContext,
} from "@/lib/appointments/permissions";
import {
  APPOINTMENT_STATUSES,
  type Appointment,
  type AppointmentService,
  type MemberSchedule,
  type ScheduleException,
} from "@/types/appointments";
import type { AccountMember } from "@/types";
import { fetchAccountMembers, memberLabel } from "@/lib/account/members";
import { STATUS_META } from "@/lib/appointments/statuses";
import {
  addDaysToKey,
  monthGridKeysFor,
  utcToDateKey,
  utcToMinutes,
  wallTimeToUtc,
  weekKeysFor,
} from "@/lib/appointments/time";
import { FALLBACK_TIMEZONE } from "@/lib/appointments/constants";
import { cn } from "@/lib/utils";
import { MemberDayColumns } from "./member-day-columns";
import { ListView, MonthView, WeekView } from "./other-views";
import { AppointmentDialog, type DialogPreset } from "./appointment-dialog";

type ViewMode = "day" | "week" | "month" | "list";

export function AgendaView() {
  const t = useTranslations("Agenda");
  const searchParams = useSearchParams();
  const {
    accountRole,
    userId,
    accountId,
    accountTimezone,
    canBookAppointments: canBook,
  } = useAuth();
  const timezone = accountTimezone || FALLBACK_TIMEZONE;

  const roleCtx: AgendaRoleContext | null = useMemo(
    () =>
      accountRole && userId
        ? { role: accountRole, canBookAppointments: canBook, userId }
        : null,
    [accountRole, userId, canBook],
  );

  const [view, setView] = useState<ViewMode>("day");
  // Today in the ACCOUNT timezone, not the browser's.
  const [dateKey, setDateKey] = useState(() =>
    utcToDateKey(new Date(), timezone),
  );
  const [memberFilter, setMemberFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [serviceFilter, setServiceFilter] = useState("");

  const [members, setMembers] = useState<AccountMember[]>([]);
  const [services, setServices] = useState<AppointmentService[]>([]);
  const [schedules, setSchedules] = useState<MemberSchedule[]>([]);
  const [exceptions, setExceptions] = useState<ScheduleException[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogAppointment, setDialogAppointment] = useState<Appointment | null>(null);
  const [dialogPreset, setDialogPreset] = useState<DialogPreset | null>(null);
  // Bumped on every open so the dialog REMOUNTS with fresh state —
  // editing always shows the data of the appointment just clicked,
  // never leftovers from a previous open.
  const [dialogKey, setDialogKey] = useState(0);

  // --- static loads ------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [memberList, servicesRes, schedulesRes] = await Promise.all([
        fetchAccountMembers(),
        fetch("/api/services", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : { services: [] }))
          .catch(() => ({ services: [] })) as Promise<{
          services?: AppointmentService[];
        }>,
        fetch("/api/schedules", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : {}))
          .catch(() => ({})) as Promise<{
          schedules?: MemberSchedule[];
          exceptions?: ScheduleException[];
        }>,
      ]);
      if (cancelled) return;
      setMembers(memberList);
      setServices(servicesRes.services ?? []);
      setSchedules(schedulesRes.schedules ?? []);
      setExceptions(schedulesRes.exceptions ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Deep links: /agenda?contact=<id> opens the create dialog with
  // the contact preloaded via the dialog's contact search; we just
  // preset the current time slot.
  useEffect(() => {
    const contactId = searchParams.get("contact");
    if (contactId && roleCtx && canCreateAppointments(roleCtx)) {
      const nowMin = utcToMinutes(new Date(), timezone);
      setDialogPreset({
        dateKey: utcToDateKey(new Date(), timezone),
        minutes: Math.floor(nowMin / 30) * 30,
        memberId: userId ?? undefined,
        contactId,
      });
      setDialogAppointment(null);
      setDialogKey((k) => k + 1);
      setDialogOpen(true);
    }
    // Only on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- which members' columns does the viewer see? ------------------
  const visibleMembers = useMemo(() => {
    // Migration 048: a member is listed iff their "Visible en
    // agenda" flag is on — any role, owner included.
    let list = members.filter((m) => m.show_in_agenda ?? true);
    if (accountRole && !canViewAllAgendas(accountRole)) {
      // Agents see only their own agenda (spec §6.1).
      list = list.filter((m) => m.user_id === userId);
    } else if (memberFilter.length > 0) {
      list = list.filter((m) => memberFilter.includes(m.user_id));
    }
    return list;
  }, [members, accountRole, userId, memberFilter]);

  // On phones the multi-column day view collapses to a picker: if a
  // single member is selected show just them; otherwise all (the
  // container scrolls horizontally — spec §7.4).
  const dayViewMembers = visibleMembers;

  // --- range --------------------------------------------------------
  const range = useMemo(() => {
    const fromKey =
      view === "week"
        ? weekKeysFor(dateKey)[0]
        : view === "month"
          ? monthGridKeysFor(dateKey)[0]
          : dateKey;
    const days =
      view === "week" ? 7 : view === "month" ? 42 : 1;
    const toExclusive = addDaysToKey(fromKey, days);
    return {
      from: wallTimeToUtc(fromKey, 0, timezone),
      to: wallTimeToUtc(toExclusive, 0, timezone),
    };
  }, [view, dateKey, timezone]);

  const fetchSeq = useRef(0);
  const fetchAppointments = useCallback(async () => {
    if (!accountId) return;
    const seq = ++fetchSeq.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        from: range.from.toISOString(),
        to: range.to.toISOString(),
      });
      if (statusFilter.length > 0) params.set("statuses", statusFilter.join(","));
      if (serviceFilter) params.set("service", serviceFilter);
      const res = await fetch(`/api/appointments?${params}`, {
        cache: "no-store",
      });
      const payload = (await res.json().catch(() => ({}))) as {
        appointments?: Appointment[];
        error?: string;
      };
      if (!res.ok) {
        toast.error(payload.error || t("loadFailed"));
        return;
      }
      if (seq !== fetchSeq.current) return;
      let rows = payload.appointments ?? [];
      if (memberFilter.length > 0) {
        const set = new Set(memberFilter);
        rows = rows.filter((r) => set.has(r.assigned_user_id));
      }
      setAppointments(rows);
    } catch (err) {
      console.error("[AgendaView] fetch error:", err);
      toast.error(t("networkError"));
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [accountId, range, statusFilter, serviceFilter, memberFilter, t]);

  useEffect(() => {
    void fetchAppointments();
  }, [fetchAppointments]);

  // --- realtime ------------------------------------------------------
  // postgres_changes is authorised with the caller's session and RLS
  // applies — events from other accounts never arrive. Any change
  // (create / edit / status / cancel) refetches the visible range;
  // the payload itself is ignored so filters stay in one place.
  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    let channel: RealtimeChannel | null = null;
    let refetchTimer: ReturnType<typeof setTimeout> | null = null;

    channel = supabase
      .channel(`agenda:${accountId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "appointments" },
        () => {
          // Debounce bursts (a save can emit INSERT + several UPDATEs).
          if (refetchTimer) clearTimeout(refetchTimer);
          refetchTimer = setTimeout(() => void fetchAppointments(), 250);
        },
      )
      .subscribe();

    return () => {
      if (refetchTimer) clearTimeout(refetchTimer);
      void supabase.removeChannel(channel!);
    };
  }, [accountId, fetchAppointments]);

  // --- navigation -----------------------------------------------------
  const step = view === "week" ? 7 : view === "month" ? 30 : 1;
  function navigate(delta: number) {
    setDateKey((k) => addDaysToKey(k, delta * step));
  }
  function goToday() {
    setDateKey(utcToDateKey(new Date(), timezone));
  }

  const rangeLabel = useMemo(() => {
    if (view === "month") {
      return new Date(`${dateKey}T12:00:00Z`).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      });
    }
    if (view === "week") {
      const days = weekKeysFor(dateKey);
      return `${days[0]} — ${days[6]}`;
    }
    return new Date(`${dateKey}T12:00:00Z`).toLocaleDateString(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  }, [view, dateKey]);

  // --- dialog handlers -------------------------------------------------
  const canWrite = !!roleCtx && canCreateAppointments(roleCtx);

  function openCreate(memberId?: string | null, minutes?: number) {
    if (!canWrite) {
      toast.error(t("readOnly"));
      return;
    }
    // Default to the CURRENT time (snapped to the 30-minute grid)
    // when opened from the "Nueva cita" button; slot clicks pass
    // their own minutes.
    const nowMin = utcToMinutes(new Date(), timezone);
    const effective =
      minutes !== undefined
        ? minutes
        : Math.floor(nowMin / 30) * 30;
    setDialogAppointment(null);
    setDialogPreset({
      dateKey,
      minutes: effective,
      memberId: memberId || userId || undefined,
    });
    setDialogKey((k) => k + 1);
    setDialogOpen(true);
  }

  function openEdit(appointment: Appointment) {
    setDialogPreset(null);
    setDialogAppointment(appointment);
    setDialogKey((k) => k + 1);
    setDialogOpen(true);
  }

  const filteredByStatus = useMemo(() => {
    if (statusFilter.length === 0) return appointments;
    const set = new Set(statusFilter);
    return appointments.filter((a) => set.has(a.status));
  }, [appointments, statusFilter]);

  return (
    // Full-height column sized to the shell: header (3.5rem) +
    // main padding (1.5rem top + 1.5rem bottom) = 6.5rem. Getting
    // this exact removes the page-level scrollbar — the ONLY scroll
    // on this screen is the calendar's own.
    <div className="flex h-[calc(100dvh-6.5rem)] flex-col gap-3">
      {/* Header: title | filters | date navigation + view + new */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="shrink-0">
          <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
          <p className="text-sm capitalize text-muted-foreground">{rangeLabel}</p>
        </div>

        <div className="flex flex-1 flex-wrap items-center gap-2">
          {accountRole && canViewAllAgendas(accountRole) && (
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-border text-muted-foreground hover:bg-muted"
                  />
                }
              >
                <CalendarDays className="size-4" />
                {t("filters.members")}
                {memberFilter.length > 0 && (
                  <span className="ml-1 rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                    {memberFilter.length}
                  </span>
                )}
              </PopoverTrigger>
              <PopoverContent align="start" className="w-64 p-0">
                <div className="border-b border-border px-3 py-2 text-sm font-medium text-popover-foreground">
                  {t("filters.members")}
                </div>
                <div className="max-h-64 overflow-y-auto py-1">
                  {members
                    .filter((m) => m.show_in_agenda ?? true)
                    .map((m) => (
                      <label
                        key={m.user_id}
                        className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 hover:bg-muted/50"
                      >
                        <Checkbox
                          checked={memberFilter.includes(m.user_id)}
                          onCheckedChange={() =>
                            setMemberFilter((prev) =>
                              prev.includes(m.user_id)
                                ? prev.filter((id) => id !== m.user_id)
                                : [...prev, m.user_id],
                            )
                          }
                          aria-label={memberLabel(m)}
                        />
                        <span className="truncate text-sm text-popover-foreground">
                          {memberLabel(m)}
                        </span>
                      </label>
                    ))}
                </div>
                {memberFilter.length > 0 && (
                  <div className="border-t border-border px-3 py-2">
                    <button
                      onClick={() => setMemberFilter([])}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      {t("filters.clear")}
                    </button>
                  </div>
                )}
              </PopoverContent>
            </Popover>
          )}

          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  className="border-border text-muted-foreground hover:bg-muted"
                />
              }
            >
              {t("filters.statuses")}
              {statusFilter.length > 0 && (
                <span className="ml-1 rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                  {statusFilter.length}
                </span>
              )}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-56 p-0">
              <div className="max-h-64 overflow-y-auto py-1">
                {APPOINTMENT_STATUSES.map((s) => (
                  <label
                    key={s}
                    className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={statusFilter.includes(s)}
                      onCheckedChange={() =>
                        setStatusFilter((prev) =>
                          prev.includes(s)
                            ? prev.filter((x) => x !== s)
                            : [...prev, s],
                        )
                      }
                      aria-label={t(`statuses.${STATUS_META[s].labelKey}`)}
                    />
                    <span
                      className={cn(
                        "text-sm text-popover-foreground",
                        STATUS_META[s].textClass,
                      )}
                    >
                      {t(`statuses.${STATUS_META[s].labelKey}`)}
                    </span>
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          <Select
            value={serviceFilter || "all"}
            onValueChange={(v) => setServiceFilter(!v || v === "all" ? "" : v)}
          >
            <SelectTrigger className="w-48 bg-card border-border" aria-label={t("filters.service")}>
              <SelectValue placeholder={t("filters.service")}>
                {serviceFilter
                  ? services.find((s) => s.id === serviceFilter)?.name ??
                    t("filters.service")
                  : t("filters.allServices")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("filters.allServices")}</SelectItem>
              {services.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {loading && (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Date navigation */}
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => navigate(-1)}
              aria-label={t("previous")}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={goToday}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t("today")}
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => navigate(1)}
              aria-label={t("next")}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              <ChevronRight className="size-4" />
            </Button>
            <Input
              type="date"
              value={dateKey}
              onChange={(e) => e.target.value && setDateKey(e.target.value)}
              className="w-36 bg-card border-border"
              aria-label={t("selectDate")}
            />
          </div>

          {/* View mode */}
          <Select value={view} onValueChange={(v) => v && setView(v as ViewMode)}>
            <SelectTrigger className="w-36 bg-card border-border">
              <SelectValue>{t(`views.${view}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="day">{t("views.day")}</SelectItem>
              <SelectItem value="week">{t("views.week")}</SelectItem>
              <SelectItem value="month">{t("views.month")}</SelectItem>
              <SelectItem value="list">{t("views.list")}</SelectItem>
            </SelectContent>
          </Select>

          {/* New appointment */}
          {canWrite && (
            <Button
              onClick={() => openCreate()}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              <Plus className="size-4" />
              {t("newAppointment")}
            </Button>
          )}
        </div>
      </div>

      {/* Body — stretches to the bottom of the viewport */}
      <div className="min-h-0 flex-1">
        {view === "day" && (
          <MemberDayColumns
            members={dayViewMembers}
            appointments={filteredByStatus}
            dateKey={dateKey}
            timezone={timezone}
            schedules={schedules}
            exceptions={exceptions}
            onSlotClick={(memberId, minutes) => openCreate(memberId, minutes)}
            onAppointmentClick={openEdit}
            canWrite={canWrite}
          />
        )}
        {view === "week" && (
          <div className="h-full overflow-auto">
            <WeekView
              dateKey={dateKey}
              appointments={filteredByStatus}
              members={visibleMembers}
              timezone={timezone}
              onSlotClick={(_memberId, day) => {
                setDateKey(day);
                openCreate(userId);
              }}
              onAppointmentClick={openEdit}
              canWrite={canWrite}
            />
          </div>
        )}
        {view === "month" && (
          <div className="h-full overflow-auto">
            <MonthView
              dateKey={dateKey}
              appointments={filteredByStatus}
              timezone={timezone}
              onDaySelect={(day) => {
                setDateKey(day);
                setView("day");
              }}
            />
          </div>
        )}
        {view === "list" && (
          <div className="h-full overflow-auto">
            <ListView
              appointments={filteredByStatus}
              members={visibleMembers}
              timezone={timezone}
              onAppointmentClick={openEdit}
            />
          </div>
        )}
      </div>

      <AppointmentDialog
        key={dialogKey}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        appointment={dialogAppointment}
        preset={dialogPreset}
        services={services}
        members={members}
        onSaved={fetchAppointments}
      />
    </div>
  );
}
