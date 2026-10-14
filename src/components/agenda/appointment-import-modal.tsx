"use client";

// ============================================================
// AppointmentImportModal — bulk CSV import for the agenda.
//
// CSV columns (Spanish headers, English aliases accepted):
//   identificacion*  — the contact's ID number (links the row to an
//                      existing contact; missing contacts are errors)
//   fecha*           — YYYY-MM-DD
//   hora*            — HH:MM (24h)
//   servicio*        — exact service name
//   duracion         — minutes (falls back to the service's)
//   notas            — free text
//
// Every row goes through POST /api/appointments, so permission,
// working-window, capacity and service rules apply per row. The
// specialist is the member chosen in the dialog (defaults to the
// current user).
// ============================================================

import { useRef, useState } from "react";
import { toast } from "sonner";
import { CheckCircle, Loader2, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";

import { createClient } from "@/lib/supabase/client";
import {
  detectDelimiter,
} from "@/lib/contacts/parse-contact-csv";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { memberLabel } from "@/lib/account/members";
import {
  hhmmToMinutes,
  wallTimeToUtc,
} from "@/lib/appointments/time";
import type { AppointmentService } from "@/types/appointments";
import type { AccountMember } from "@/types";

interface ParsedAppointmentRow {
  identification: string;
  fecha: string;
  hora: string;
  serviceName: string;
  duration?: number;
  notes?: string;
  lineNumber: number;
}

interface ImportResult {
  created: number;
  failed: { line: number; identification: string; reason: string }[];
}

interface AppointmentImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  services: AppointmentService[];
  members: AccountMember[];
  defaultSpecialistId: string;
  onImported: () => void;
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

function pick(values: string[], idx: number): string {
  return (values[idx]?.replace(/["']/g, "") ?? "").trim();
}

export function AppointmentImportModal({
  open,
  onOpenChange,
  services,
  members,
  defaultSpecialistId,
  onImported,
}: AppointmentImportModalProps) {
  const t = useTranslations("Agenda.importModal");
  const { accountId, accountTimezone } = useAuth();
  const timezone = accountTimezone || "America/Bogota";

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ParsedAppointmentRow[] | null>(null);
  const [specialistId, setSpecialistId] = useState(defaultSpecialistId);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<ImportResult | null>(null);

  // Import combo (migration 056): owner/admin always; agents listed
  // with the booking permission EVEN if "En agenda" is off — the
  // owner explicitly assigns the import to them. Viewers excluded.
  const eligibleMembers = members.filter((m) => {
    if (m.role === "viewer") return false;
    if (m.role === "owner" || m.role === "admin") return true;
    return (m.show_in_agenda ?? true) || !!m.can_book_appointments;
  });
  const selectedSpecialist =
    eligibleMembers.find(
      (m) => m.user_id === (specialistId || defaultSpecialistId),
    ) ?? eligibleMembers[0];

  function reset() {
    setRows(null);
    setResult(null);
    setProgress({ done: 0, total: 0 });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setResult(null);

    const text = await selected.text();
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) {
      toast.error(t("noRows"));
      setRows(null);
      return;
    }

    // Same tolerance as the contacts importer: `,` `;` or tab
    // delimiters, headers with accents/markers/parentheticals.
    const delimiter = detectDelimiter(lines[0]);
    const headers = lines[0]
      .split(delimiter)
      .map((h) =>
        h
          .replace(/["']/g, "")
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .replace(/\*/g, "")
          .replace(/\([^)]*\)/g, "")
          .trim()
          .toLowerCase(),
      );
    const idx = (names: string[]) =>
      headers.findIndex((h) => names.includes(h));

    const idIdx = idx(["identificacion", "identification"]);
    const fechaIdx = idx(["fecha", "date"]);
    const horaIdx = idx(["hora", "time"]);
    const servicioIdx = idx(["servicio", "service"]);
    const duracionIdx = idx(["duracion", "duration"]);
    const notasIdx = idx(["notas", "notes"]);

    if (idIdx === -1 || fechaIdx === -1 || horaIdx === -1 || servicioIdx === -1) {
      toast.error(t("missingColumns"));
      setRows(null);
      return;
    }

    const parsed: ParsedAppointmentRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const values = parseCsvLine(line, delimiter);
      parsed.push({
        identification: pick(values, idIdx),
        fecha: pick(values, fechaIdx),
        hora: pick(values, horaIdx),
        serviceName: pick(values, servicioIdx),
        duration: Number(pick(values, duracionIdx)) || undefined,
        notes: pick(values, notasIdx) || undefined,
        lineNumber: i + 1,
      });
    }

    if (parsed.length === 0) {
      toast.error(t("noRows"));
      setRows(null);
      return;
    }
    setRows(parsed);
  }

  async function handleImport() {
    if (!rows || rows.length === 0) return;
    const specialist = specialistId || defaultSpecialistId;
    if (!specialist) {
      toast.error(t("specialistRequired"));
      return;
    }

    // Prefetch the identification → contact map once (RLS scopes it).
    setImporting(true);
    setProgress({ done: 0, total: rows.length });
    const supabase = createClient();

    try {
      const contactMap = new Map<string, string>();
      let page = 0;
      for (;;) {
        const { data, error } = await supabase
          .from("contacts")
          .select("id, identification")
          .eq("account_id", accountId)
          .range(page * 1000, (page + 1) * 1000 - 1);
        if (error) throw error;
        for (const c of data ?? []) {
          if (c.identification) {
            contactMap.set(c.identification.toLowerCase(), c.id);
          }
        }
        if ((data ?? []).length < 1000) break;
        page += 1;
      }

      const result: ImportResult = { created: 0, failed: [] };
      let done = 0;

      for (const row of rows) {
        try {
          const contactId = contactMap.get(row.identification.toLowerCase());
          if (!contactId) {
            result.failed.push({
              line: row.lineNumber,
              identification: row.identification,
              reason: t("contactNotFound", { id: row.identification }),
            });
            continue;
          }

          const service = services.find((s) => s.name === row.serviceName);
          if (!service) {
            result.failed.push({
              line: row.lineNumber,
              identification: row.identification,
              reason: t("serviceNotFoundRow", { name: row.serviceName }),
            });
            continue;
          }

          if (!/^\d{4}-\d{2}-\d{2}$/.test(row.fecha) || !/^\d{1,2}:\d{2}$/.test(row.hora)) {
            result.failed.push({
              line: row.lineNumber,
              identification: row.identification,
              reason: t("badDateTime"),
            });
            continue;
          }

          const minutes = hhmmToMinutes(row.hora);
          const startsAt = wallTimeToUtc(row.fecha, minutes, timezone);

          const res = await fetch("/api/appointments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contact_id: contactId,
              service_id: service.id,
              assigned_user_id: specialist,
              starts_at: startsAt.toISOString(),
              duration_minutes: row.duration ?? service.duration_minutes,
              notes: row.notes ?? null,
            }),
          });
          const payload = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          if (!res.ok) {
            result.failed.push({
              line: row.lineNumber,
              identification: row.identification,
              reason: payload.error || t("rowFailed"),
            });
          } else {
            result.created += 1;
          }
        } catch (err) {
          console.error("[appointments import] row error:", err);
          result.failed.push({
            line: row.lineNumber,
            identification: row.identification,
            reason: t("rowFailed"),
          });
        } finally {
          done += 1;
          setProgress({ done, total: rows.length });
        }
      }

      setResult(result);
      if (result.created > 0) {
        toast.success(t("importedToast", { count: result.created }));
        onImported();
      }
      if (result.failed.length > 0) {
        toast.error(t("failedToast", { count: result.failed.length }));
      }
    } catch (err) {
      console.error("[appointments import] error:", err);
      toast.error(t("rowFailed"));
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t("specialistLabel")}</Label>
            <Select
              value={specialistId || defaultSpecialistId}
              onValueChange={(v) => v && setSpecialistId(v)}
            >
              <SelectTrigger className="w-full bg-background border-border">
                {/* SelectValue renders the raw item value without a
                    child label — pass the member's name. Guarded: the
                    roster may not have loaded yet. */}
                <SelectValue>
                  {selectedSpecialist
                    ? memberLabel(selectedSpecialist)
                    : t("specialistLabel")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {eligibleMembers.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {memberLabel(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("specialistHint")}</p>
          </div>

          <div className="space-y-1.5">
            <Label>{t("fileLabel")}</Label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileChange}
              className="w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-2 file:text-sm file:font-medium file:text-primary-foreground"
            />
            <p className="text-xs text-muted-foreground">{t("columnsHint")}</p>
          </div>

          {rows && (
            <p className="text-sm text-muted-foreground">
              {t("rowsDetected", { count: rows.length })}
            </p>
          )}

          {importing && (
            <p className="text-sm text-muted-foreground">
              {t("progress", { done: progress.done, total: progress.total })}
            </p>
          )}

          {result && (
            <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3">
              <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-300">
                <CheckCircle className="size-4" />
                {t("resultCreated", { count: result.created })}
              </p>
              {result.failed.length > 0 && (
                <div className="space-y-1">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-red-500 dark:text-red-300">
                    <XCircle className="size-4" />
                    {t("resultFailed", { count: result.failed.length })}
                  </p>
                  <ul className="max-h-32 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                    {result.failed.map((f, i) => (
                      <li key={`${f.line}-${i}`}>
                        {t("failedRow", { line: f.line, id: f.identification })}: {f.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t("close")}
          </Button>
          <Button
            onClick={handleImport}
            disabled={!rows || importing}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {importing && <Loader2 className="size-4 animate-spin" />}
            {t("import")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
