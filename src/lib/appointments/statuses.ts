import type { AppointmentStatus } from "@/types/appointments";

// ============================================================
// Appointment status presentation — the ONE place that maps a
// status to colours / labels. Never inline hex or Tailwind status
// classes at call sites (module spec §9).
//
// Colours follow the reference design but use Tailwind utility
// strings so dark mode works. Each status also has a distinct
// badge/label so colour is never the only signal (a11y).
// ============================================================

export interface StatusMeta {
  /** i18n key under the `Agenda.statuses` namespace. */
  labelKey: string;
  /** Solid background used for calendar blocks. */
  blockClass: string;
  /** Badge / pill variant (border + tinted bg). */
  chipClass: string;
  /** Text colour used in selects (reference mockup style). */
  textClass: string;
  /** Tailwind-independent hex used for month-view dots when a
   *  service colour isn't set. */
  hex: string;
}

export const STATUS_META: Record<AppointmentStatus, StatusMeta> = {
  PENDIENTE: {
    labelKey: "pendiente",
    blockClass: "bg-pink-500/85 text-white border-pink-600",
    chipClass: "border-pink-500/40 bg-pink-500/10 text-pink-600 dark:text-pink-300",
    textClass: "text-pink-600 dark:text-pink-400",
    hex: "#ec4899",
  },
  CONFIRMADA: {
    labelKey: "confirmada",
    blockClass: "bg-emerald-500/85 text-white border-emerald-600",
    chipClass:
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
    textClass: "text-emerald-600 dark:text-emerald-400",
    hex: "#10b981",
  },
  "LLEGA TARDE": {
    labelKey: "llegaTarde",
    blockClass: "bg-amber-400/90 text-amber-950 border-amber-500",
    chipClass: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300",
    textClass: "text-amber-600 dark:text-amber-400",
    hex: "#f59e0b",
  },
  "NO LLEGA": {
    labelKey: "noLlega",
    blockClass: "bg-red-500/85 text-white border-red-600",
    chipClass: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300",
    textClass: "text-red-600 dark:text-red-400",
    hex: "#ef4444",
  },
  CANCELADA: {
    labelKey: "cancelada",
    blockClass: "bg-slate-400/70 text-slate-900 border-slate-500",
    chipClass:
      "border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-300",
    textClass: "text-slate-500 dark:text-slate-400",
    hex: "#94a3b8",
  },
};
