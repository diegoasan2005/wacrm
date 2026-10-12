"use client";

// ============================================================
// HistoryView — "Agenda Historial" (module spec: visits history).
//
// Per-contact rollup of appointments: last visit, days since,
// status, specialist, phone and next pending appointment. Clicking
// the phone opens a WhatsApp contact dialog pre-filled with a
// reminder (next appointment) or come-back invitation (no next
// appointment); sending records it so the table shows when each
// contact was last contacted.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Search } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { fetchAccountMembers, memberLabel } from "@/lib/account/members";
import { STATUS_META } from "@/lib/appointments/statuses";
import { FALLBACK_TIMEZONE } from "@/lib/appointments/constants";
import type { AppointmentService } from "@/types/appointments";
import type { AccountMember } from "@/types";
import { cn } from "@/lib/utils";
import type { AppointmentStatus } from "@/types/appointments";

interface HistoryRow {
  contact_id: string;
  identification: string | null;
  name: string;
  phone: string;
  last_visit: {
    starts_at: string;
    status: string;
    service_id: string | null;
    service_name: string | null;
    specialist: string;
  } | null;
  days_since: number | null;
  next: { starts_at: string; service_name: string | null; status: string } | null;
  last_reminder_at: string | null;
  last_invitation_at: string | null;
}

const MIN_DAYS_OPTIONS = [0, 7, 15, 30, 60, 90, 180, 365];

function formatVisitDate(iso: string, tz: string): string {
  const date = new Date(
    new Date(iso).toLocaleString("en-US", { timeZone: tz }),
  );
  const day = date.getDate();
  const month = date.toLocaleDateString(undefined, { month: "long" });
  const h24 = date.getHours();
  const m = String(date.getMinutes()).padStart(2, "0");
  const period = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${day} de ${month} ${h12}:${m} ${period}`;
}

function formatShortDate(iso: string, tz: string): string {
  const date = new Date(
    new Date(iso).toLocaleString("en-US", { timeZone: tz }),
  );
  const day = date.getDate();
  const month = date.toLocaleDateString(undefined, { month: "long" });
  const h24 = date.getHours();
  const m = String(date.getMinutes()).padStart(2, "0");
  const period = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${day} de ${month} ${h12}:${m} ${period}`;
}

function daysLabel(days: number, t: (k: string, v?: Record<string, number>) => string): string {
  if (days < 1) return t("daysToday");
  if (days === 1) return t("daysOne");
  if (days < 30) return t("daysCount", { count: days });
  const months = Math.round(days / 30);
  if (months < 12) return t("monthsCount", { count: months });
  const years = Math.max(1, Math.round(months / 12));
  return t("yearsCount", { count: years });
}

export function HistoryView() {
  const t = useTranslations("AgendaHistory");
  const { accountRole, userId, accountTimezone, account } = useAuth();
  const timezone = accountTimezone || FALLBACK_TIMEZONE;
  const canSend = accountRole !== "viewer";

  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [services, setServices] = useState<AppointmentService[]>([]);
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [serviceFilter, setServiceFilter] = useState("");
  const [minDays, setMinDays] = useState("0");

  // Contact dialog state.
  const [dialogRow, setDialogRow] = useState<HistoryRow | null>(null);
  const [dialogMode, setDialogMode] = useState<"reminder" | "invitation">("reminder");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (serviceFilter) params.set("service", serviceFilter);
      if (Number(minDays) > 0) params.set("minDays", minDays);
      if (search.trim()) params.set("search", search.trim());
      const res = await fetch(`/api/appointments/history?${params}`, {
        cache: "no-store",
      });
      const payload = (await res.json().catch(() => ({}))) as {
        rows?: HistoryRow[];
        error?: string;
      };
      if (!res.ok) {
        toast.error(payload.error || t("loadFailed"));
        return;
      }
      setRows(payload.rows ?? []);
    } catch (err) {
      console.error("[HistoryView] load error:", err);
      toast.error(t("networkError"));
    } finally {
      setLoading(false);
    }
  }, [serviceFilter, minDays, search, t]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // Team roster + services for the filter (role/member aware).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [svcRes, memberList] = await Promise.all([
        fetch("/api/services", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : { services: [] }))
          .catch(() => ({ services: [] })) as Promise<{
          services?: AppointmentService[];
        }>,
        fetchAccountMembers(),
      ]);
      if (cancelled) return;
      // Migration 054 — each member filters by the services assigned
      // to them PLUS the unassigned ("applies to all") ones.
      const all = svcRes.services ?? [];
      setServices(
        all.filter((s) => {
          const ids = s.member_ids ?? [];
          return ids.length === 0 || (!!userId && ids.includes(userId));
        }),
      );
      setMembers(memberList);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const specialistName = useCallback(
    (userId: string) => {
      const m = members.find((x) => x.user_id === userId);
      return m ? memberLabel(m) : userId.slice(0, 8);
    },
    [members],
  );

  function buildMessage(row: HistoryRow, mode: "reminder" | "invitation"): string {
    const accountName = account?.name ?? "";
    const firstName = (row.name || row.phone).split(" ")[0];
    const serviceName =
      (mode === "reminder" ? row.next?.service_name : row.last_visit?.service_name) ??
      "";
    if (mode === "reminder" && row.next) {
      return t("reminderTemplate", {
        name: firstName,
        account: accountName,
        service: serviceName,
        date: formatShortDate(row.next.starts_at, timezone),
      });
    }
    return t("invitationTemplate", {
      name: firstName,
      account: accountName,
      service: serviceName,
      date: row.last_visit
        ? formatShortDate(row.last_visit.starts_at, timezone)
        : "",
    });
  }

  function openDialog(row: HistoryRow) {
    setDialogRow(row);
    setDialogMode(row.next ? "reminder" : "invitation");
    setMessage(buildMessage(row, row.next ? "reminder" : "invitation"));
  }

  function switchMode(mode: "reminder" | "invitation") {
    if (!dialogRow) return;
    setDialogMode(mode);
    setMessage(buildMessage(dialogRow, mode));
  }

  async function handleSend() {
    if (!dialogRow) return;
    setSending(true);
    try {
      // 1. Deliver the WhatsApp message (free text via the shared
      // send endpoint — find-or-creates the conversation).
      const sendRes = await fetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: dialogRow.contact_id,
          message_type: "text",
          content_text: message,
        }),
      });
      if (!sendRes.ok) {
        const payload = (await sendRes.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(payload.error || t("sendFailed"));
        return;
      }

      // 2. Record it so the table shows the contact was reached.
      const logRes = await fetch("/api/appointments/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: dialogRow.contact_id,
          type: dialogMode,
        }),
      });
      if (!logRes.ok) {
        // Message delivered but not logged — tell the user; a
        // reload will still show the message in the conversation.
        toast.error(t("logFailed"));
        return;
      }

      toast.success(
        dialogMode === "reminder" ? t("reminderSent") : t("invitationSent"),
      );
      setDialogRow(null);
      await loadHistory();
    } catch (err) {
      console.error("[HistoryView] send error:", err);
      toast.error(t("networkError"));
    } finally {
      setSending(false);
    }
  }

  const statusChip = (status: string) => {
    const meta = STATUS_META[status as AppointmentStatus];
    if (!meta) return <span className="text-xs">{status}</span>;
    return (
      <span
        className={cn(
          "inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold",
          meta.chipClass,
        )}
      >
        {t(`statuses.${meta.labelKey}`)}
      </span>
    );
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t("subtitle")}</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="pl-8 bg-card border-border"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">{t("filters.service")}</Label>
          <Select
            value={serviceFilter || "all"}
            onValueChange={(v) => setServiceFilter(!v || v === "all" ? "" : v)}
          >
            <SelectTrigger className="w-52 bg-card border-border">
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
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">{t("filters.minDays")}</Label>
          <Select value={minDays} onValueChange={(v) => v && setMinDays(v)}>
            <SelectTrigger className="w-40 bg-card border-border">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MIN_DAYS_OPTIONS.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {d === 0 ? t("filters.noMin") : t("filters.minDaysValue", { count: d })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {loading && <Loader2 className="size-4 animate-spin text-muted-foreground mb-2" />}
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="text-muted-foreground">{t("table.identification")}</TableHead>
              <TableHead className="text-muted-foreground">{t("table.client")}</TableHead>
              <TableHead className="text-muted-foreground">{t("table.lastVisit")}</TableHead>
              <TableHead className="text-muted-foreground">{t("table.days")}</TableHead>
              <TableHead className="text-muted-foreground">{t("table.status")}</TableHead>
              <TableHead className="text-muted-foreground hidden md:table-cell">{t("table.specialist")}</TableHead>
              <TableHead className="text-muted-foreground">{t("table.phone")}</TableHead>
              <TableHead className="text-muted-foreground">{t("table.next")}</TableHead>
              <TableHead className="text-muted-foreground hidden lg:table-cell">{t("table.sent")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow className="border-border">
                <TableCell colSpan={9} className="text-center py-12">
                  <Loader2 className="size-6 animate-spin text-primary mx-auto" />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={9} className="text-center py-12 text-sm text-muted-foreground">
                  {t("empty")}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.contact_id} className="border-border hover:bg-muted/50">
                  <TableCell className="text-foreground text-xs font-mono">
                    {row.identification || "—"}
                  </TableCell>
                  <TableCell className="text-foreground text-sm font-medium">
                    {row.name || t("unnamedContact")}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {row.last_visit
                      ? formatVisitDate(row.last_visit.starts_at, timezone)
                      : "—"}
                    {row.last_visit?.service_name && (
                      <span className="block text-[10px]">{row.last_visit.service_name}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {row.days_since != null ? daysLabel(row.days_since, t) : "—"}
                    <span className="block text-[10px]">
                      {row.days_since != null ? t("daysShort", { count: row.days_since }) : ""}
                    </span>
                  </TableCell>
                  <TableCell>{row.last_visit ? statusChip(row.last_visit.status) : "—"}</TableCell>
                  <TableCell className="text-muted-foreground text-xs hidden md:table-cell">
                    {row.last_visit ? specialistName(row.last_visit.specialist) : "—"}
                  </TableCell>
                  <TableCell>
                    {canSend ? (
                      <button
                        type="button"
                        onClick={() => openDialog(row)}
                        className="text-sm font-medium text-pink-600 hover:underline dark:text-pink-400"
                      >
                        {row.phone || "—"}
                      </button>
                    ) : (
                      <span className="text-muted-foreground text-sm">{row.phone || "—"}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {row.next ? (
                      <div className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-pink-600 dark:text-pink-400">
                          {formatShortDate(row.next.starts_at, timezone)}
                        </span>
                        {statusChip(row.next.status)}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t("noNext")}</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <div className="flex flex-col gap-1">
                      {row.last_reminder_at && (
                        <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 w-fit">
                          {t("reminderSentBadge")} · {formatShortDate(row.last_reminder_at, timezone)}
                        </Badge>
                      )}
                      {row.last_invitation_at && (
                        <Badge className="border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300 w-fit">
                          {t("invitationSentBadge")} · {formatShortDate(row.last_invitation_at, timezone)}
                        </Badge>
                      )}
                      {!row.last_reminder_at && !row.last_invitation_at && (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* WhatsApp contact dialog */}
      <Dialog open={dialogRow !== null} onOpenChange={(o) => !o && setDialogRow(null)}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("dialog.title")}</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            {dialogRow && (
              <div className="flex items-center gap-2">
                {dialogRow.next && (
                  <Button
                    variant={dialogMode === "reminder" ? "default" : "outline"}
                    size="sm"
                    onClick={() => switchMode("reminder")}
                    className={
                      dialogMode === "reminder"
                        ? "bg-primary text-primary-foreground"
                        : "border-border text-muted-foreground hover:bg-muted"
                    }
                  >
                    {t("dialog.reminderMode")}
                  </Button>
                )}
                <Button
                  variant={dialogMode === "invitation" ? "default" : "outline"}
                  size="sm"
                  onClick={() => switchMode("invitation")}
                  className={
                    dialogMode === "invitation"
                      ? "bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:bg-muted"
                  }
                >
                  {t("dialog.invitationMode")}
                </Button>
              </div>
            )}
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={5}
              className="bg-background border-border text-sm"
            />
            <p className="text-xs text-muted-foreground">{t("dialog.editHint")}</p>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogRow(null)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t("dialog.cancel")}
            </Button>
            <Button
              onClick={handleSend}
              disabled={sending || !message.trim()}
              className="bg-pink-600 hover:bg-pink-700 text-white"
            >
              {sending && <Loader2 className="size-4 animate-spin" />}
              {t("dialog.accept")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
