import type { AccountRole } from "@/lib/auth/roles";

// ============================================================
// Appointments domain types (migration 047)
// ============================================================

/** DB enum `appointment_status_enum` (migration 050 removed
 *  FINALIZADA). Spanish on the wire — the UI translates through
 *  `Agenda.statuses.*` keys, never raw strings. */
export type AppointmentStatus =
  | "PENDIENTE"
  | "CONFIRMADA"
  | "LLEGA TARDE"
  | "NO LLEGA"
  | "CANCELADA";

/** All statuses, in display order. */
export const APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  "PENDIENTE",
  "CONFIRMADA",
  "LLEGA TARDE",
  "NO LLEGA",
  "CANCELADA",
] as const;

/** Statuses that occupy a slot (block availability). */
export const BLOCKING_STATUSES: readonly AppointmentStatus[] = [
  "PENDIENTE",
  "CONFIRMADA",
  "LLEGA TARDE",
] as const;

export type ScheduleExceptionType = "unavailable" | "available";

export interface AppointmentService {
  id: string;
  account_id: string;
  name: string;
  description?: string | null;
  duration_minutes: number;
  price?: number | null;
  color?: string | null;
  is_default: boolean;
  is_active: boolean;
  available_for_booking: boolean;
  /** How many simultaneous appointments this service allows on the
   *  same specialist at the same time (migration 049). */
  max_concurrent: number;
  /** Team members assigned to offer this service (migration 054).
   *  Empty/absent = the service applies to ALL members. */
  member_ids?: string[];
  created_at: string;
  updated_at: string;
}

export interface Appointment {
  id: string;
  account_id: string;
  contact_id: string;
  service_id: string | null;
  /** Snapshot of the service name at booking time (survives
   *  renames / deletion of the service row). */
  service_name: string | null;
  /** auth.users id of the member attending (specialist). */
  assigned_user_id: string;
  created_by?: string | null;
  /** UTC instants — convert with the account timezone for display. */
  starts_at: string;
  ends_at: string;
  duration_minutes: number;
  status: AppointmentStatus;
  notes?: string | null;
  created_at: string;
  updated_at: string;
  cancelled_at?: string | null;
  cancelled_by?: string | null;
  /** Hydrated by agenda queries (`contacts(*)` embed). */
  contact?: ContactSummary | null;
}

/** Minimal contact projection embedded in appointment rows. */
export interface ContactSummary {
  id: string;
  name?: string | null;
  last_name?: string | null;
  identification?: string | null;
  phone: string;
  avatar_url?: string | null;
}

/** One working window for a member on a weekday (0 = Sunday). */
export interface MemberSchedule {
  id: string;
  account_id: string;
  user_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  is_active: boolean;
}

export interface ScheduleException {
  id: string;
  account_id: string;
  user_id: string;
  date: string;
  start_time?: string | null;
  end_time?: string | null;
  exception_type: ScheduleExceptionType;
  notes?: string | null;
}

/** Audit trail row (written by the DB trigger, read-only). */
export interface AppointmentHistoryEntry {
  id: string;
  account_id: string;
  appointment_id: string;
  action: "created" | "updated" | "deleted";
  previous_values?: Record<string, unknown> | null;
  new_values?: Record<string, unknown> | null;
  changed_by?: string | null;
  created_at: string;
}

/** Role context the permission matrix needs. */
export type AgendaRoleContext = {
  role: AccountRole;
  /** profiles.can_book_appointments — "Puede registrar citas". */
  canBookAppointments: boolean;
  /** auth.uid() of the caller. */
  userId: string;
};
