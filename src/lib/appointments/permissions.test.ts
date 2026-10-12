import { describe, expect, it } from "vitest";

import {
  AGENT_TRANSITIONS,
  allowedTransitions,
  canConfigureBookingPermissions,
  canCreateAppointments,
  canEditAppointment,
  canManageSchedules,
  canManageServices,
  canReassignAppointments,
  canViewAllAgendas,
  isEligibleSpecialist,
} from "./permissions";
import type { AgendaRoleContext } from "@/types/appointments";

function ctx(
  role: AgendaRoleContext["role"],
  canBook = false,
): AgendaRoleContext {
  return { role, canBookAppointments: canBook, userId: "user-1" };
}

describe("agenda permission matrix", () => {
  it("manages services: admin+ only", () => {
    expect(canManageServices("owner")).toBe(true);
    expect(canManageServices("admin")).toBe(true);
    expect(canManageServices("agent")).toBe(false);
    expect(canManageServices("viewer")).toBe(false);
  });

  it("views all agendas: everyone except agents", () => {
    expect(canViewAllAgendas("owner")).toBe(true);
    expect(canViewAllAgendas("admin")).toBe(true);
    expect(canViewAllAgendas("viewer")).toBe(true);
    expect(canViewAllAgendas("agent")).toBe(false);
  });

  it("creates appointments: admin+ always, agent with flag, viewer never", () => {
    expect(canCreateAppointments(ctx("owner"))).toBe(true);
    expect(canCreateAppointments(ctx("admin"))).toBe(true);
    expect(canCreateAppointments(ctx("agent", true))).toBe(true);
    // The flag alone must not grant a viewer write access (spec §6.2).
    expect(canCreateAppointments(ctx("viewer", true))).toBe(false);
    expect(canCreateAppointments(ctx("agent", false))).toBe(false);
    expect(canCreateAppointments(ctx("viewer", false))).toBe(false);
  });

  it("edits appointments: admin+ any, agent own+flag only", () => {
    const own = { assigned_user_id: "user-1" };
    const other = { assigned_user_id: "user-2" };
    expect(canEditAppointment(ctx("agent", true), own)).toBe(true);
    expect(canEditAppointment(ctx("agent", true), other)).toBe(false);
    expect(canEditAppointment(ctx("agent", false), own)).toBe(false);
    expect(canEditAppointment(ctx("admin"), other)).toBe(true);
    expect(canEditAppointment(ctx("viewer", true), own)).toBe(false);
  });

  it("reassigning / schedules / permission config are admin+ operations", () => {
    for (const predicate of [
      canReassignAppointments,
      canManageSchedules,
      canConfigureBookingPermissions,
    ]) {
      expect(predicate("owner")).toBe(true);
      expect(predicate("admin")).toBe(true);
      expect(predicate("agent")).toBe(false);
      expect(predicate("viewer")).toBe(false);
    }
  });

  it("eligible specialists are owner/admin/agent", () => {
    expect(isEligibleSpecialist("owner")).toBe(true);
    expect(isEligibleSpecialist("admin")).toBe(true);
    expect(isEligibleSpecialist("agent")).toBe(true);
    expect(isEligibleSpecialist("viewer")).toBe(false);
  });
});

describe("status transitions", () => {
  it("agents follow the operational map", () => {
    expect(allowedTransitions(ctx("agent", true), "PENDIENTE")).toEqual([
      "CONFIRMADA",
      "LLEGA TARDE",
      "NO LLEGA",
      "CANCELADA",
    ]);
    expect(allowedTransitions(ctx("agent", true), "CONFIRMADA")).toContain(
      "CANCELADA",
    );
    // Terminal states are dead ends for agents.
    expect(allowedTransitions(ctx("agent", true), "CANCELADA")).toEqual([]);
    expect(allowedTransitions(ctx("agent", true), "NO LLEGA")).toEqual([]);
  });

  it("admins can apply any correction (audit trail records it)", () => {
    const from = allowedTransitions(ctx("admin"), "CANCELADA");
    expect(from).toContain("PENDIENTE");
    expect(from).not.toContain("CANCELADA");
  });

  it("viewers get no transitions", () => {
    expect(allowedTransitions(ctx("viewer"), "PENDIENTE")).toEqual([]);
  });

  it("agent map never leaves terminal states", () => {
    for (const terminal of ["CANCELADA"] as const) {
      expect(AGENT_TRANSITIONS[terminal]).toEqual([]);
    }
  });
});
