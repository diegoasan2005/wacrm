"use client";

// ============================================================
// MemberDayColumns — the primary day view: one column per member,
// vertical timeline with 15-minute slots, appointment blocks sized
// by duration, working-hours shading, current-time indicator and
// click-to-book on empty slots (module spec §7.1/§7.3).
// ============================================================

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { STATUS_META } from "@/lib/appointments/statuses";
import {
  DAY_END_MINUTES,
  DAY_START_MINUTES,
  PX_PER_MINUTE,
  SLOT_MINUTES,
} from "@/lib/appointments/constants";
import {
  dateKeyToDow,
  utcToMinutes,
  hhmmToMinutes,
} from "@/lib/appointments/time";
import type {
  Appointment,
  MemberSchedule,
  ScheduleException,
} from "@/types/appointments";
import type { AccountMember } from "@/types";
import { cn } from "@/lib/utils";

const COLUMN_MIN_WIDTH = 210;

const DAY_MINUTES = DAY_END_MINUTES - DAY_START_MINUTES;
const BODY_HEIGHT = DAY_MINUTES * PX_PER_MINUTE;

interface MemberDayColumnsProps {
  members: AccountMember[];
  appointments: Appointment[];
  dateKey: string;
  timezone: string;
  schedules: MemberSchedule[];
  exceptions: ScheduleException[];
  /** Slot click (empty space) — creates with the picked time. */
  onSlotClick: (memberId: string, minutes: number) => void;
  onAppointmentClick: (appointment: Appointment) => void;
  canWrite: boolean;
}

interface PositionedBlock {
  appt: Appointment;
  top: number;
  height: number;
  left: number;
  width: number;
}

/** Split overlapping appointments into side-by-side sub-columns. */
function layoutBlocks(
  memberAppointments: Appointment[],
  timezone: string,
): PositionedBlock[] {
  const items = memberAppointments
    .map((appt) => {
      // Clamp to the rendered window: appointments booked outside
      // 9:00–20:00 (via the button / time picker) pin to the edge
      // instead of drawing at negative coordinates.
      const start = Math.max(utcToMinutes(appt.starts_at, timezone), DAY_START_MINUTES);
      const end = Math.min(
        utcToMinutes(appt.starts_at, timezone) + appt.duration_minutes,
        DAY_END_MINUTES,
      );
      return { appt, start, end, lane: 0 };
    })
    .filter((item) => item.end > DAY_START_MINUTES)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  // Greedy cluster: chain items whose windows overlap.
  const out: PositionedBlock[] = [];
  let cluster: typeof items = [];
  let clusterEnd = 0;

  const flush = () => {
    if (cluster.length === 0) return;
    const columns: number[] = []; // column end-minute per lane
    for (const item of cluster) {
      let lane = columns.findIndex((end) => end <= item.start);
      if (lane === -1) {
        columns.push(item.end);
        lane = columns.length - 1;
      } else {
        columns[lane] = item.end;
      }
      item.lane = lane;
    }
    const lanes = columns.length;
    for (const item of cluster) {
      out.push({
        appt: item.appt,
        top: (item.start - DAY_START_MINUTES) * PX_PER_MINUTE,
        height: Math.max(
          (item.end - item.start) * PX_PER_MINUTE - 2,
          18,
        ),
        left: (item.lane / lanes) * 100,
        width: (1 / lanes) * 100,
      });
    }
    cluster = [];
  };

  for (const item of items) {
    if (cluster.length > 0 && item.start >= clusterEnd) {
      flush();
    }
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  flush();

  return out;
}

export function MemberDayColumns({
  members,
  appointments,
  dateKey,
  timezone,
  schedules,
  exceptions,
  onSlotClick,
  onAppointmentClick,
  canWrite,
}: MemberDayColumnsProps) {
  const t = useTranslations("Agenda");
  const dow = dateKeyToDow(dateKey);

  // Current-time indicator, refreshed every 30s while mounted.
  const [nowMinutes, setNowMinutes] = useState(() =>
    utcToMinutes(new Date(), timezone),
  );
  const todayKey = useMemo(
    () => {
      const tz = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
      return tz;
    },
    [timezone],
  );
  useEffect(() => {
    const timer = setInterval(
      () => setNowMinutes(utcToMinutes(new Date(), timezone)),
      30_000,
    );
    return () => clearInterval(timer);
  }, [timezone]);

  const hours = useMemo(() => {
    const list: { minutes: number }[] = [];
    for (
      let m = DAY_START_MINUTES;
      m < DAY_END_MINUTES; // the 24:00 edge line would duplicate 0:00
      m += 60
    ) {
      list.push({ minutes: m });
    }
    return list;
  }, []);

  const byMember = useMemo(() => {
    const map = new Map<string, Appointment[]>();
    for (const appt of appointments) {
      const list = map.get(appt.assigned_user_id) ?? [];
      list.push(appt);
      map.set(appt.assigned_user_id, list);
    }
    return map;
  }, [appointments]);

  // Working-hours overlay segments per member: muted stripes outside
  // open windows. Only rendered when the member has schedule rows
  // (no schedule = always bookable, the documented default).
  const closedSegmentsByMember = useMemo(() => {
    const map = new Map<string, { start: number; end: number }[]>();
    const exceptionByMember = new Map(
      exceptions
        .filter(
          (e) =>
            e.date === dateKey &&
            e.exception_type === "unavailable",
        )
        .map((e) => [e.user_id, e]),
    );
    for (const member of members) {
      const segments: { start: number; end: number }[] = [];
      const exception = exceptionByMember.get(member.user_id);
      if (exception) {
        if (exception.start_time && exception.end_time) {
          const s = Math.max(hhmmToMinutes(exception.start_time), DAY_START_MINUTES);
          const e2 = Math.min(hhmmToMinutes(exception.end_time), DAY_END_MINUTES);
          if (s < e2) {
            segments.push({ start: DAY_START_MINUTES, end: s }, { start: e2, end: DAY_END_MINUTES });
          } else {
            segments.push({ start: DAY_START_MINUTES, end: DAY_END_MINUTES });
          }
        } else {
          segments.push({ start: DAY_START_MINUTES, end: DAY_END_MINUTES });
        }
      } else {
        const windows = schedules.filter(
          (s) =>
            s.user_id === member.user_id &&
            s.is_active &&
            s.day_of_week === dow,
        );
        if (windows.length > 0) {
          const open: { start: number; end: number }[] = windows.map((w) => ({
            start: hhmmToMinutes(w.start_time),
            end: hhmmToMinutes(w.end_time),
          }));
          open.sort((a, b) => a.start - b.start);
          let cursor = DAY_START_MINUTES;
          for (const w of open) {
            const s = Math.max(w.start, DAY_START_MINUTES);
            const e2 = Math.min(w.end, DAY_END_MINUTES);
            if (s > cursor) segments.push({ start: cursor, end: s });
            cursor = Math.max(cursor, e2);
          }
          if (cursor < DAY_END_MINUTES) {
            segments.push({ start: cursor, end: DAY_END_MINUTES });
          }
        }
      }
      map.set(member.user_id, segments);
    }
    return map;
  }, [members, schedules, exceptions, dateKey, dow]);

  function slotClick(memberId: string, event: React.MouseEvent<HTMLDivElement>) {
    if (!canWrite) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const raw = DAY_START_MINUTES + y / PX_PER_MINUTE;
    // Snap to the slot grid.
    const minutes =
      Math.floor(raw / SLOT_MINUTES) * SLOT_MINUTES;
    if (minutes < DAY_START_MINUTES || minutes >= DAY_END_MINUTES) return;
    onSlotClick(memberId, minutes);
  }

  if (members.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card py-16 text-center text-sm text-muted-foreground">
        {t("noMembersToShow")}
      </div>
    );
  }

  return (
    // Scroll container: fills the height the page gives it (the body
    // wrapper is flex-1) and scrolls internally, so the page never
    // stretches and the column headers stay pinned via sticky top-0.
    // (The auto-scroll targets the 9:00 line via scrollIntoView, so
    // it works even if this isn't the element that ends up
    // scrolling.)
    <div className="h-full overflow-auto rounded-lg border border-border bg-card">
      <div
        className="flex min-w-full"
        style={{ width: Math.max(members.length * COLUMN_MIN_WIDTH, 0) || undefined }}
      >
        {members.map((member) => {
          const blocks = layoutBlocks(byMember.get(member.user_id) ?? [], timezone);
          const closed = closedSegmentsByMember.get(member.user_id) ?? [];
          const showNowLine = todayKey === dateKey;
          return (
            <div
              key={member.user_id}
              className="flex-1 shrink-0 grow-0 basis-full sm:basis-auto"
              style={{ minWidth: COLUMN_MIN_WIDTH }}
            >
              {/* Column header */}
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-muted/80 px-3 py-2 backdrop-blur">
                <Avatar className="size-7 shrink-0">
                  {member.avatar_url ? (
                    <AvatarImage src={member.avatar_url} alt={member.full_name} />
                  ) : null}
                  <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
                    {(member.full_name || "U").charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span
                  className="truncate text-sm font-semibold text-foreground"
                  title={member.full_name}
                >
                  {member.full_name || member.user_id}
                </span>
              </div>

              {/* Timeline */}
              <div
                className="relative"
                style={{ height: BODY_HEIGHT }}
              >
                {/* Hour lines + labels. The FIRST hour renders its
                    label BELOW the line — above it, the sticky
                    member header would clip it. */}
                {hours.map(({ minutes }) => (
                  <div
                    key={minutes}
                    className="absolute inset-x-0 border-t border-border/60"
                    style={{
                      top: (minutes - DAY_START_MINUTES) * PX_PER_MINUTE,
                    }}
                  >
                    <span
                      className={cn(
                        "absolute left-1 bg-card px-1 text-[10px] text-muted-foreground",
                        minutes === DAY_START_MINUTES ? "top-1" : "-top-2",
                      )}
                    >
                      {formatHour(minutes)}
                    </span>
                  </div>
                ))}

                {/* Slot guides — every :30 only. Quarter-hour lines
                    made the grid visually noisy and stretched the
                    scroll; the click grid is still 15 minutes. */}
                {Array.from(
                  { length: Math.floor(DAY_MINUTES / SLOT_MINUTES) },
                  (_, i) => {
                    // i*15 minutes after day start; render only the
                    // half-hour lines (i ≡ 2 mod 4 → :30, :90, …).
                    return i % 4 === 2 ? (
                      <div
                        key={i}
                        aria-hidden
                        className="absolute inset-x-0 border-t border-border/30"
                        style={{ top: i * SLOT_MINUTES * PX_PER_MINUTE }}
                      />
                    ) : null;
                  },
                )}

                {/* Closed (non-working) shading */}
                {closed.map((seg, i) => (
                  <div
                    key={i}
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0"
                    style={{
                      top: (seg.start - DAY_START_MINUTES) * PX_PER_MINUTE,
                      height: (seg.end - seg.start) * PX_PER_MINUTE,
                      backgroundImage:
                        "repeating-linear-gradient(45deg, transparent 0 6px, rgba(128,128,128,0.18) 6px 12px)",
                    }}
                  />
                ))}

                {/* Click-catcher for empty slots */}
                {canWrite && (
                  <div
                    className="absolute inset-0 cursor-copy"
                    onClick={(e) => slotClick(member.user_id, e)}
                    aria-label={t("newAppointmentAt", {
                      member: member.full_name,
                    })}
                  />
                )}

                {/* Appointment blocks */}
                {blocks.map(({ appt, top, height, left, width }) => {
                  const meta = STATUS_META[appt.status];
                  return (
                    <button
                      key={appt.id}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onAppointmentClick(appt);
                      }}
                      className={cn(
                        "absolute z-[5] overflow-hidden rounded-md border px-1.5 py-0.5 text-left text-[11px] leading-tight shadow-sm transition-transform hover:z-20 hover:scale-[1.02] focus:outline-none focus:ring-2 focus:ring-primary",
                        meta.blockClass,
                      )}
                      style={{
                        top,
                        height,
                        left: `${left}%`,
                        width: `calc(${width}% - 4px)`,
                      }}
                      title={`${appt.contact?.name ?? ""} ${appt.contact?.last_name ?? ""} · ${appt.service_name ?? ""} · ${t(
                        `statuses.${meta.labelKey}`,
                      )}`}
                    >
                      <span className="block truncate font-semibold">
                        {[
                          appt.contact?.name,
                          appt.contact?.last_name,
                        ]
                          .filter(Boolean)
                          .join(" ") || t("unnamedContact")}
                      </span>
                      {height > 34 && (
                        <span className="block truncate opacity-90">
                          {appt.service_name ?? "—"}
                        </span>
                      )}
                      {height > 52 && (
                        <span className="block truncate opacity-75">
                          {formatHour(utcToMinutes(appt.starts_at, timezone))}
                        </span>
                      )}
                    </button>
                  );
                })}

                {/* Current-time indicator */}
                {showNowLine && nowMinutes >= DAY_START_MINUTES && nowMinutes <= DAY_END_MINUTES && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-red-500"
                    style={{
                      top: (nowMinutes - DAY_START_MINUTES) * PX_PER_MINUTE,
                    }}
                  >
                    <span className="absolute -left-0.5 -top-1 size-2 rounded-full bg-red-500" />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatHour(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const period = h24 < 12 ? "a. m." : "p. m.";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0
    ? `${h12} ${period}`
    : `${h12}:${String(m).padStart(2, "0")} ${period}`;
}
