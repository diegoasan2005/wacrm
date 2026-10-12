import { TZDate } from "@date-fns/tz";

// ============================================================
// Appointment time helpers.
//
// Business rule (module spec §11.1): wall-clock times (the date +
// hour the user picks) belong to the ACCOUNT's timezone, never to
// the browser's. We convert wall time → UTC instant when saving
// and UTC instant → wall time when rendering. Everything on the
// wire (Supabase `timestamptz`) is a UTC instant.
// ============================================================

/** "HH:mm" from minutes since midnight. */
export function minutesToHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Minutes since midnight from "HH:mm" (or "HH:mm:ss"). */
export function hhmmToMinutes(value: string): number {
  const [h = "0", m = "0"] = value.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * Convert wall-clock components in `timeZone` to a UTC `Date`.
 * `dateKey` is `YYYY-MM-DD` in the account timezone; `minutes` is
 * minutes since local midnight. DST-safe: TZDate resolves the
 * instant for that wall time in the zone itself.
 */
export function wallTimeToUtc(
  dateKey: string,
  minutes: number,
  timeZone: string,
): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  const tzDate = new TZDate(y, m - 1, d, Math.floor(minutes / 60), minutes % 60, 0, timeZone);
  return new Date(tzDate.getTime());
}

/**
 * Format an instant as `YYYY-MM-DD` in `timeZone`.
 */
export function utcToDateKey(instant: Date | string, timeZone: string): string {
  const tz = new TZDate(instant instanceof Date ? instant.getTime() : new Date(instant).getTime(), timeZone);
  const y = tz.getFullYear();
  const m = String(tz.getMonth() + 1).padStart(2, "0");
  const d = String(tz.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Minutes since midnight in `timeZone` for an instant.
 */
export function utcToMinutes(instant: Date | string, timeZone: string): number {
  const tz = new TZDate(instant instanceof Date ? instant.getTime() : new Date(instant).getTime(), timeZone);
  return tz.getHours() * 60 + tz.getMinutes();
}

/**
 * `YYYY-MM-DD` for a given day, offset by `days`.
 */
export function addDaysToKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** Weekday index (0 = Sunday) of a `YYYY-MM-DD` key. */
export function dateKeyToDow(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * All the `YYYY-MM-DD` keys in the week containing `dateKey`
 * (weeks start on Monday — matches standard agendas).
 */
export function weekKeysFor(dateKey: string): string[] {
  const [y, m, d] = dateKey.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const dow = base.getUTCDay(); // 0 = Sunday
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const keys: string[] = [];
  for (let i = 0; i < 7; i++) {
    keys.push(addDaysToKey(dateKey, mondayOffset + i));
  }
  return keys;
}

/**
 * All date keys of the month grid containing `dateKey` — always
 * 6 weeks (42 cells) starting Monday, so the grid height is stable.
 */
export function monthGridKeysFor(dateKey: string): string[] {
  const [y, m] = dateKey.split("-").map(Number);
  const firstKey = `${y}-${String(m).padStart(2, "0")}-01`;
  const dow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const keys: string[] = [];
  for (let i = 0; i < 42; i++) {
    keys.push(addDaysToKey(firstKey, mondayOffset + i));
  }
  return keys;
}

/** True when both keys are the same day. */
export function isSameDateKey(a: string, b: string): boolean {
  return a === b;
}

/**
 * Overlap test for two [start, end) windows, in minutes since any
 * common origin. Used by UI optimistic checks; the DB EXCLUDE
 * index is the enforcing backstop.
 */
export function intervalsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && aEnd > bStart;
}
