// ============================================================
// Shared agenda constants.
// ============================================================

/** Quick-pick durations for the service form and booking modal.
 *  Free-typed values remain valid — this is only a shortcut row. */
export const DEFAULT_DURATIONS = [5, 15, 30, 45, 60, 90, 120] as const;

/** Visual slot granularity of the day view (minutes). */
export const SLOT_MINUTES = 15;

/** Day-view rendering bounds (minutes since midnight). Fixed
 *  8:00–24:00 window: the grid runs one hour past the last
 *  labelled line (11 p. m.) so that line sits comfortably inside
 *  the view instead of hugging the bottom edge. Appointments
 *  outside the window still exist (the booking dialog accepts any
 *  time); blocks pin to the edge. */
export const DAY_START_MINUTES = 8 * 60; // 8:00
export const DAY_END_MINUTES = 24 * 60; // 24:00

/** Pixels per minute in the day view. 0.8 keeps the whole workday
 *  (~13h ≈ 620px) compact enough that the afternoon is reachable
 *  without a page-long scroll. */
export const PX_PER_MINUTE = 0.8;

/** Fallback timezone until the account row resolves. */
export const FALLBACK_TIMEZONE = "America/Bogota";
