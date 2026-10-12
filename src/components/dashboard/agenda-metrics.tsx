"use client";

// ============================================================
// AgendaMetrics — dashboard cards for the Services/Agenda modules
// (owner-approved selection):
//   Citas de hoy (+ desglose) · Próximos 7 días · NO LLEGA 30d ·
//   Cancelaciones 30d · Clientes con próxima cita · Hoy por miembro ·
//   Carga por miembro (7d) · Top 3 servicios (30d)
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { CalendarCheck, CalendarDays, Users, AlertTriangle, Ban } from "lucide-react";
import { useTranslations } from "next-intl";

import { Card, CardContent } from "@/components/ui/card";
import { MetricCard } from "@/components/dashboard/metric-card";
import { SkeletonCard } from "@/components/dashboard/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { utcToDateKey } from "@/lib/appointments/time";
import { FALLBACK_TIMEZONE } from "@/lib/appointments/constants";

interface Metrics {
  today: { total: number; PENDIENTE: number; CONFIRMADA: number; "LLEGA TARDE": number };
  memberToday: {
    userId: string;
    name: string;
    total: number;
    pending: number;
    confirmed: number;
    late: number;
  }[];
  next7: number;
  memberLoad7: { userId: string; name: string; count: number }[];
  clientsWithNext: number;
  furthestNext: string | null;
  noShow30: number;
  cancelled30: number;
  topServices: { name: string; count: number }[];
}

/** Small list-style card used for per-member / top-3 breakdowns. */
function ListCard({
  title,
  rows,
  emptyText,
}: {
  title: string;
  rows: { label: string; value: string }[];
  emptyText: string;
}) {
  return (
    <Card className="border-border">
      <CardContent className="p-4">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {rows.map((row) => (
              <li
                key={row.label}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span className="truncate text-foreground">{row.label}</span>
                <span className="shrink-0 font-semibold text-foreground">
                  {row.value}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function AgendaMetrics() {
  const t = useTranslations("Dashboard.agenda");
  const { accountTimezone } = useAuth();
  const timezone = accountTimezone || FALLBACK_TIMEZONE;

  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/appointments/metrics", { cache: "no-store" });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
      } & Partial<Metrics>;
      if (!res.ok) {
        setMetrics(null);
        return;
      }
      setMetrics(payload as Metrics);
    } catch {
      setMetrics(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading || !metrics) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  const dayCount = metrics.today.total;

  return (
    <div className="space-y-4">
      {/* Simple counters */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title={t("todayTitle")}
          value={metrics.today.total.toLocaleString()}
          icon={CalendarCheck}
          subtitle={t("todayBreakdown", {
            pending: metrics.today.PENDIENTE,
            confirmed: metrics.today.CONFIRMADA,
            late: metrics.today["LLEGA TARDE"],
          })}
        />
        <MetricCard
          title={t("next7Title")}
          value={metrics.next7.toLocaleString()}
          icon={CalendarDays}
        />
        <MetricCard
          title={t("noShowTitle")}
          value={metrics.noShow30.toLocaleString()}
          icon={AlertTriangle}
        />
        <MetricCard
          title={t("cancelledTitle")}
          value={metrics.cancelled30.toLocaleString()}
          icon={Ban}
        />
      </div>

      {/* Breakdown cards */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ListCard
          title={t("perMemberTodayTitle", { count: dayCount })}
          emptyText={t("noData")}
          rows={(metrics.memberToday ?? []).map((m) => ({
            label: `${m.name} — ${t("todayBreakdown", {
              pending: m.pending,
              confirmed: m.confirmed,
              late: m.late,
            })}`,
            value: String(m.total),
          }))}
        />
        <ListCard
          title={t("load7Title")}
          emptyText={t("noData")}
          rows={(metrics.memberLoad7 ?? []).map((m) => ({
            label: m.name,
            value: t("appointmentsCount", { count: m.count }),
          }))}
        />
        <ListCard
          title={t("topServicesTitle")}
          emptyText={t("noData")}
          rows={(metrics.topServices ?? []).map((s, i) => ({
            label: `${i + 1}. ${s.name}`,
            value: t("appointmentsCount", { count: s.count }),
          }))}
        />
      </div>

      {/* Clients with a future booking */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title={t("clientsWithNextTitle")}
          value={metrics.clientsWithNext.toLocaleString()}
          icon={Users}
          subtitle={
            metrics.furthestNext
              ? t("furthest", {
                  date: utcToDateKey(metrics.furthestNext, timezone),
                })
              : undefined
          }
        />
      </div>
    </div>
  );
}
