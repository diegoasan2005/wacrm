"use client";

// ============================================================
// Week / Month / List agenda views (module spec §7.2). The day
// view lives in member-day-columns; these share its filters and
// click handlers through props.
// ============================================================

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { STATUS_META } from "@/lib/appointments/statuses";
import {
  monthGridKeysFor,
  utcToMinutes,
  weekKeysFor,
} from "@/lib/appointments/time";
import type { Appointment } from "@/types/appointments";
import type { AccountMember } from "@/types";

const WEEKDAY_KEYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;

export const WEEKDAY_KEYS_ORDER = WEEKDAY_KEYS;

function memberName(
  members: AccountMember[],
  userId: string,
): string {
  return (
    members.find((m) => m.user_id === userId)?.full_name ?? userId.slice(0, 8)
  );
}

// ============================================================
// Week view — 7 day columns; every visible member's appointments
// in the day cell, colored by status, stacked in time order.
// ============================================================
export function WeekView({
  dateKey,
  appointments,
  members,
  timezone,
  onSlotClick,
  onAppointmentClick,
  canWrite,
}: {
  dateKey: string;
  appointments: Appointment[];
  members: AccountMember[];
  timezone: string;
  onSlotClick: (memberId: string, dateKey: string, minutes: number) => void;
  onAppointmentClick: (appointment: Appointment) => void;
  canWrite: boolean;
}) {
  const t = useTranslations("Agenda");
  const days = useMemo(() => weekKeysFor(dateKey), [dateKey]);

  const byDay = useMemo(() => {
    const map = new Map<string, Appointment[]>();
    for (const appt of appointments) {
      const key = new Date(appt.starts_at).toLocaleDateString("en-CA", {
        timeZone: timezone,
      });
      const list = map.get(key) ?? [];
      list.push(appt);
      map.set(key, list);
    }
    return map;
  }, [appointments, timezone]);

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {days.map((day, i) => {
        const list = (byDay.get(day) ?? []).sort(
          (a, b) =>
            utcToMinutes(a.starts_at, timezone) -
            utcToMinutes(b.starts_at, timezone),
        );
        return (
          <div
            key={day}
            className="min-h-40 rounded-lg border border-border bg-card p-1.5"
          >
            <p className="px-1 pb-1 text-xs font-semibold text-muted-foreground">
              {t(`weekdays.${WEEKDAY_KEYS[i]}`)}
            </p>
            <div className="space-y-1">
              {list.map((appt) => {
                const meta = STATUS_META[appt.status];
                return (
                  <button
                    key={appt.id}
                    type="button"
                    onClick={() => onAppointmentClick(appt)}
                    className={cn(
                      "block w-full truncate rounded border px-1.5 py-1 text-left text-[11px]",
                      meta.blockClass,
                    )}
                    title={`${memberName(members, appt.assigned_user_id)} · ${appt.service_name ?? ""}`}
                  >
                    <span className="block truncate font-semibold">
                      {formatHourShort(utcToMinutes(appt.starts_at, timezone))}
                      {" · "}
                      {[
                        appt.contact?.name,
                        appt.contact?.last_name,
                      ]
                        .filter(Boolean)
                        .join(" ") || t("unnamedContact")}
                    </span>
                    <span className="block truncate opacity-85">
                      {memberName(members, appt.assigned_user_id)}
                    </span>
                  </button>
                );
              })}
              {list.length === 0 && canWrite && (
                <button
                  type="button"
                  onClick={() => onSlotClick("", day, 9 * 60)}
                  className="w-full rounded border border-dashed border-border py-2 text-[11px] text-muted-foreground hover:bg-muted/50"
                >
                  + {t("add")}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// Month view — 6×7 grid; cells show status dots + count.
// Clicking a day switches the agenda to that day's view.
// ============================================================
export function MonthView({
  dateKey,
  appointments,
  timezone,
  onDaySelect,
}: {
  dateKey: string;
  appointments: Appointment[];
  timezone: string;
  onDaySelect: (dateKey: string) => void;
}) {
  const t = useTranslations("Agenda");
  const cells = useMemo(() => monthGridKeysFor(dateKey), [dateKey]);
  const todayKey = new Date().toLocaleDateString("en-CA", { timeZone: timezone });

  const countByDay = useMemo(() => {
    const map = new Map<string, { total: number; blocking: number; dot: string | null }>();
    for (const appt of appointments) {
      const key = new Date(appt.starts_at).toLocaleDateString("en-CA", {
        timeZone: timezone,
      });
      const entry = map.get(key) ?? {
        total: 0,
        blocking: 0,
        dot: null as string | null,
      };
      entry.total += 1;
      if (
        appt.status === "PENDIENTE" ||
        appt.status === "CONFIRMADA" ||
        appt.status === "LLEGA TARDE"
      ) {
        entry.blocking += 1;
        entry.dot = entry.dot ?? STATUS_META[appt.status].hex;
      }
      map.set(key, entry);
    }
    return map;
  }, [appointments, timezone]);

  const monthOf = dateKey.slice(0, 7);

  return (
    <div>
      <div className="mb-1 grid grid-cols-7 gap-1">
        {WEEKDAY_KEYS.map((key) => (
          <p
            key={key}
            className="px-1 text-center text-[11px] font-semibold text-muted-foreground"
          >
            {t(`weekdays.${key}`)}
          </p>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((day) => {
          const info = countByDay.get(day);
          const inMonth = day.startsWith(monthOf);
          const isToday = day === todayKey;
          return (
            <button
              key={day}
              type="button"
              onClick={() => onDaySelect(day)}
              className={cn(
                "min-h-16 rounded-md border p-1 text-left transition-colors hover:bg-muted/60",
                inMonth ? "border-border bg-card" : "border-transparent bg-transparent opacity-45",
                isToday && "ring-1 ring-primary",
              )}
            >
              <span className="text-[11px] font-medium text-muted-foreground">
                {Number(day.slice(8, 10))}
              </span>
              {info && (
                <span className="mt-0.5 flex items-center gap-1">
                  {info.dot && (
                    <span
                      aria-hidden
                      className="size-2 rounded-full"
                      style={{ backgroundColor: info.dot }}
                    />
                  )}
                  <span className="text-[10px] text-muted-foreground">
                    {info.total}
                  </span>
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// List view — flat table of the range's appointments.
// ============================================================
export function ListView({
  appointments,
  members,
  timezone,
  onAppointmentClick,
}: {
  appointments: Appointment[];
  members: AccountMember[];
  timezone: string;
  onAppointmentClick: (appointment: Appointment) => void;
}) {
  const t = useTranslations("Agenda");

  const sorted = useMemo(
    () =>
      [...appointments].sort(
        (a, b) =>
          new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(),
      ),
    [appointments],
  );

  if (sorted.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card py-16 text-center text-sm text-muted-foreground">
        {t("noAppointmentsInRange")}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="border-border hover:bg-transparent">
            <TableHead className="text-muted-foreground">{t("list.date")}</TableHead>
            <TableHead className="text-muted-foreground">{t("list.time")}</TableHead>
            <TableHead className="text-muted-foreground">{t("list.client")}</TableHead>
            <TableHead className="text-muted-foreground">{t("list.service")}</TableHead>
            <TableHead className="text-muted-foreground">{t("list.specialist")}</TableHead>
            <TableHead className="text-muted-foreground">{t("list.status")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((appt) => {
            const meta = STATUS_META[appt.status];
            const day = new Date(appt.starts_at).toLocaleDateString("en-CA", {
              timeZone: timezone,
            });
            return (
              <TableRow
                key={appt.id}
                className="border-border hover:bg-muted/50 cursor-pointer"
                onClick={() => onAppointmentClick(appt)}
              >
                <TableCell className="text-foreground text-xs">{day}</TableCell>
                <TableCell className="text-foreground text-xs">
                  {formatHourShort(utcToMinutes(appt.starts_at, timezone))}
                  {" – "}
                  {formatHourShort(
                    utcToMinutes(appt.starts_at, timezone) + appt.duration_minutes,
                  )}
                </TableCell>
                <TableCell className="text-foreground text-sm font-medium">
                  {[
                    appt.contact?.name,
                    appt.contact?.last_name,
                  ]
                    .filter(Boolean)
                    .join(" ") || t("unnamedContact")}
                  <span className="block text-xs text-muted-foreground">
                    {appt.contact?.phone}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {appt.service_name ?? "—"}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {memberName(members, appt.assigned_user_id)}
                </TableCell>
                <TableCell>
                  <span
                    className={cn(
                      "inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                      meta.chipClass,
                    )}
                  >
                    {t(`statuses.${meta.labelKey}`)}
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function formatHourShort(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const period = h24 < 12 ? "am" : "pm";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0
    ? `${h12}${period}`
    : `${h12}:${String(m).padStart(2, "0")}${period}`;
}
