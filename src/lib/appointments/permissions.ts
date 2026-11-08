// ============================================================
// Agenda permission matrix — single source of truth for what each
// role can do with services, appointments and schedules.
//
// Pure and unit-testable (no I/O), like `@/lib/auth/roles`. Both
// the UI gates and the API routes call these predicates; the
// database re-enforces the same rules via RLS + RPCs (migration
// 047), so a bypassed client still cannot escalate.
//
// Model (per the module spec):
//   owner  — everything in the account.
//   admin  — everything in the account (manage services, see and
//            edit every agenda, reassign, configure permissions).
//   agent  — sees ONLY their own agenda; writes (create / edit /
//            status changes on their own appointments) only when
//            the per-membership "Puede registrar citas" flag is on.
//   viewer — read-only across the whole account agenda; the flag
//            never grants them write access.
// ============================================================

import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import type {
  AgendaRoleContext,
  AppointmentStatus,
} from '@/types/appointments';

export type { AgendaRoleContext };

/** Can this role manage services (create / edit / activate)? */
export function canManageServices(role: AccountRole): boolean {
  return hasMinRole(role, 'admin');
}

/** Can this role see agendas of other members (or at least the
 *  whole-account view)? Agents see only their own column. */
export function canViewAllAgendas(role: AccountRole): boolean {
  return role !== 'agent';
}

/** Can this role book / edit appointments AT ALL (ignoring the
 *  agent flag)? Viewer is always no; agent depends on the flag;
 *  admin+ always yes. Used for the "Nueva cita" button. */
export function canCreateAppointments(ctx: AgendaRoleContext): boolean {
  if (hasMinRole(ctx.role, 'admin')) return true;
  if (ctx.role === 'agent') return ctx.canBookAppointments;
  return false;
}

/** Same as above, scoped to editing an existing appointment. */
export function canEditAppointment(
  ctx: AgendaRoleContext,
  appointment: { assigned_user_id: string }
): boolean {
  if (hasMinRole(ctx.role, 'admin')) return true;
  if (ctx.role === 'agent') {
    return (
      ctx.canBookAppointments && appointment.assigned_user_id === ctx.userId
    );
  }
  return false;
}

/** Can this role reassign an appointment to another specialist? */
export function canReassignAppointments(role: AccountRole): boolean {
  return hasMinRole(role, 'admin');
}

/** Can this role configure member schedules / exceptions? */
export function canManageSchedules(role: AccountRole): boolean {
  return hasMinRole(role, 'admin');
}

/** Can this role toggle the "Puede registrar citas" flag? */
export function canConfigureBookingPermissions(role: AccountRole): boolean {
  return hasMinRole(role, 'admin');
}

/** Members eligible to be a specialist (receive appointments). */
export function isEligibleSpecialist(role: AccountRole): boolean {
  return role === 'owner' || role === 'admin' || role === 'agent';
}

/** Can this role register or move appointments into PAST dates?
 *  Agents can only book from today forward; admin+ keep the
 *  correction path for backdating (late data entry, wrong-time
 *  fixes). The DB trigger (060) enforces the same split. */
export function canBookPastDates(role: AccountRole): boolean {
  return hasMinRole(role, 'admin');
}

/**
 * Status transitions an AGENT may apply to their own appointment.
 * SUPERSEDED: agents can no longer change appointment statuses at
 * all (owner/admin-only per account policy) — kept as the
 * historical matrix; `allowedTransitions` returns [] for agents and
 * the DB trigger (060) raises on any agent status change.
 */
export const AGENT_TRANSITIONS: Readonly<
  Record<AppointmentStatus, readonly AppointmentStatus[]>
> = {
  PENDIENTE: ['CONFIRMADA', 'LLEGA TARDE', 'NO LLEGA', 'CANCELADA'],
  CONFIRMADA: ['LLEGA TARDE', 'NO LLEGA', 'CANCELADA'],
  'LLEGA TARDE': ['NO LLEGA', 'CANCELADA'],
  'NO LLEGA': [],
  CANCELADA: [],
};

/** Terminal statuses — only admins can leave them. */
export const TERMINAL_STATUSES: readonly AppointmentStatus[] = [
  'CANCELADA',
] as const;

/** Allowed target statuses for this context (UI dropdown source).
 *  Owner/admin: any status except staying put (correction path,
 *  audit trail records it). Agents: none — status changes are
 *  owner/admin-only. Viewers: none. */
export function allowedTransitions(
  ctx: AgendaRoleContext,
  current: AppointmentStatus
): readonly AppointmentStatus[] {
  if (hasMinRole(ctx.role, 'admin')) {
    // Any status except staying put — corrections go through the
    // audit trail.
    return (Object.keys(AGENT_TRANSITIONS) as AppointmentStatus[]).filter(
      (s) => s !== current
    );
  }
  return [];
}
