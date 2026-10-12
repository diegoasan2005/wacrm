import { describe, expect, it } from "vitest";

import { normalizeServiceInput } from "./service-input";

describe("normalizeServiceInput", () => {
  it("accepts a full valid payload", () => {
    const result = normalizeServiceInput({
      name: "  Manicure  ",
      duration_minutes: 60,
      price: "25.5",
      color: "#FF00AA",
      is_default: true,
      is_active: true,
      available_for_booking: true,
      description: "  classic  ",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("Manicure");
      expect(result.value.duration_minutes).toBe(60);
      expect(result.value.price).toBe(25.5);
      expect(result.value.color).toBe("#ff00aa");
      expect(result.value.description).toBe("classic");
    }
  });

  it("rejects invalid durations", () => {
    for (const dur of [0, -5, 2.5, "abc", 24 * 60 + 1]) {
      const result = normalizeServiceInput({
        name: "x",
        duration_minutes: dur,
      });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects negative or NaN prices", () => {
    expect(normalizeServiceInput({ name: "x", duration_minutes: 30, price: -1 }).ok).toBe(false);
    expect(
      normalizeServiceInput({ name: "x", duration_minutes: 30, price: "abc" }).ok,
    ).toBe(false);
  });

  it("rejects invalid colors", () => {
    expect(
      normalizeServiceInput({ name: "x", duration_minutes: 30, color: "red" }).ok,
    ).toBe(false);
    expect(
      normalizeServiceInput({ name: "x", duration_minutes: 30, color: "#12345" }).ok,
    ).toBe(false);
  });

  it("rejects empty or oversized names", () => {
    expect(normalizeServiceInput({ name: "   ", duration_minutes: 30 }).ok).toBe(false);
    expect(normalizeServiceInput({ name: "x".repeat(121), duration_minutes: 30 }).ok).toBe(false);
  });

  it("partial mode (PATCH): validates only the present keys", () => {
    const result = normalizeServiceInput({ duration_minutes: 45 }, true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ duration_minutes: 45 });
    }
    // But a present key is fully validated even in partial mode.
    expect(normalizeServiceInput({ duration_minutes: -1 }, true).ok).toBe(false);
  });

  it("defaults the boolean flags on create", () => {
    const result = normalizeServiceInput({ name: "x", duration_minutes: 30 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.is_default).toBe(false);
      expect(result.value.is_active).toBe(true);
      expect(result.value.available_for_booking).toBe(true);
    }
  });
});
