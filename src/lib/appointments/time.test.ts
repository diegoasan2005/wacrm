import { describe, expect, it } from "vitest";

import {
  addDaysToKey,
  dateKeyToDow,
  hhmmToMinutes,
  intervalsOverlap,
  minutesToHHMM,
  monthGridKeysFor,
  utcToDateKey,
  utcToMinutes,
  wallTimeToUtc,
  weekKeysFor,
} from "./time";

describe("wall time ⇄ UTC conversions", () => {
  it("round-trips a wall time through the account timezone", () => {
    const tz = "America/Bogota"; // UTC-5 all year (no DST)
    const instant = wallTimeToUtc("2026-10-11", 10 * 60, tz);
    expect(instant.toISOString()).toBe("2026-10-11T15:00:00.000Z");
    expect(utcToDateKey(instant, tz)).toBe("2026-10-11");
    expect(utcToMinutes(instant, tz)).toBe(600);
  });

  it("respects a DST-observing timezone (Madrid)", () => {
    // 2026-07-01 is CEST (UTC+2); 2026-01-15 is CET (UTC+1).
    expect(wallTimeToUtc("2026-07-01", 9 * 60, "Europe/Madrid").toISOString()).toBe(
      "2026-07-01T07:00:00.000Z",
    );
    expect(wallTimeToUtc("2026-01-15", 9 * 60, "Europe/Madrid").toISOString()).toBe(
      "2026-01-15T08:00:00.000Z",
    );
  });
});

describe("date-key helpers", () => {
  it("adds days across month boundaries", () => {
    expect(addDaysToKey("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDaysToKey("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("computes the weekday (0 = Sunday)", () => {
    // 2026-10-11 is a Sunday.
    expect(dateKeyToDow("2026-10-11")).toBe(0);
    expect(dateKeyToDow("2026-10-12")).toBe(1);
  });

  it("weeks start on Monday", () => {
    const days = weekKeysFor("2026-10-11"); // Sunday
    expect(days[0]).toBe("2026-10-05"); // Monday
    expect(days[6]).toBe("2026-10-11");
    expect(days).toHaveLength(7);
  });

  it("month grids are 6 stable weeks starting Monday", () => {
    const grid = monthGridKeysFor("2026-10-11");
    expect(grid).toHaveLength(42);
    expect(dateKeyToDow(grid[0])).toBe(1); // Monday
    expect(grid.every((d, i) => addDaysToKey(grid[0], i) === d)).toBe(true);
  });
});

describe("minute helpers", () => {
  it("converts HH:mm ⇄ minutes", () => {
    expect(minutesToHHMM(600)).toBe("10:00");
    expect(minutesToHHMM(0)).toBe("00:00");
    expect(hhmmToMinutes("10:30")).toBe(630);
    expect(hhmmToMinutes("09:05")).toBe(545);
  });
});

describe("interval overlap ([start, end) semantics)", () => {
  it("detects overlapping windows", () => {
    expect(intervalsOverlap(600, 660, 630, 690)).toBe(true);
  });

  it("allows consecutive appointments (end == start)", () => {
    expect(intervalsOverlap(600, 660, 660, 720)).toBe(false);
  });

  it("detects containment and disjoint windows correctly", () => {
    expect(intervalsOverlap(600, 720, 630, 660)).toBe(true);
    expect(intervalsOverlap(600, 660, 700, 720)).toBe(false);
  });
});
