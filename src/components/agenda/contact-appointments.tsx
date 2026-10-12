"use client";

// ============================================================
// ContactAppointments — read-only appointment history embedded in
// the contact detail sheet (module spec §16.1).
// ============================================================

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/use-auth";
import { STATUS_META } from "@/lib/appointments/statuses";
import { utcToDateKey, utcToMinutes } from "@/lib/appointments/time";
import type { Appointment } from "@/types/appointments";

const RANGE_DAYS = 365; // ±1 year around today

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export function ContactAppointments({ contactId }: { contactId: string }) {
  const t = useTranslations("Agenda");
  const { accountTimezone } = useAuth();
  const [rows, setRows] = useState<Appointment[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams({
          from: isoDaysAgo(RANGE_DAYS),
          to: new Date(Date.now() + RANGE_DAYS * 86_400_000).toISOString(),
          contact: contactId,
        });
        const res = await fetch(`/api/appointments?${params}`, {
          cache: "no-store",
        });
        const payload = (await res.json().catch(() => ({}))) as {
          appointments?: Appointment[];
        };
        if (cancelled) return;
        if (!res.ok) {
          setError(true);
          setRows([]);
          return;
        }
        setRows(payload.appointments ?? []);
      } catch {
        if (!cancelled) {
          setError(true);
          setRows([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  if (rows === null) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-5 animate-spin text-primary" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {error ? t("loadFailed") : t("noAppointmentsInRange")}
      </p>
    );
  }

  return (
    <ul className="space-y-2 py-1">
      {rows.map((appt) => {
        const meta = STATUS_META[appt.status];
        return (
          <li
            key={appt.id}
            className="flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                {appt.service_name ?? t("unnamedContact")}
              </p>
              <p className="text-xs text-muted-foreground">
                {utcToDateKey(appt.starts_at, accountTimezone)} ·{" "}
                {formatMinute(utcToMinutes(appt.starts_at, accountTimezone))} –{" "}
                {formatMinute(
                  utcToMinutes(appt.starts_at, accountTimezone) +
                    appt.duration_minutes,
                )}
              </p>
            </div>
            <Badge className={meta.chipClass}>
              {t(`statuses.${meta.labelKey}`)}
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}

function formatMinute(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const period = h24 < 12 ? "am" : "pm";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")}${period}`;
}
