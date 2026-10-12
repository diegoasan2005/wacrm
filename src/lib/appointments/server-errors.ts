// ============================================================
// Localisation for DB-raised appointment errors.
//
// The RPCs / triggers (migrations 047-051) raise human-readable but
// ENGLISH messages ("That time slot is already taken…"). PostgREST
// surfaces them verbatim, so the API maps each known message to an
// i18n key under `Api.agenda` and returns the localized text.
// Unknown messages pass through unchanged (never shown raw unless
// a future migration adds a new one).
// ============================================================

import { getT } from "@/lib/i18n/translate";

const t = getT("Api.agenda");

type Rule = {
  re: RegExp;
  key: string;
  /** Interpolated {from}/{to} for the transition-guard message. */
  withArgs?: boolean;
};

const RULES: Rule[] = [
  { re: /That time slot is already taken/i, key: "slotTaken" },
  { re: /outside the specialist working hours/i, key: "outsideWorkingHours" },
  {
    re: /specialist is not available on that date/i,
    key: "specialistUnavailableDate",
  },
  {
    re: /permission to register appointments/i,
    key: "bookingPermissionRequired",
  },
  { re: /permission to edit appointments/i, key: "editPermissionRequired" },
  {
    re: /Agents can only create appointments for themselves/i,
    key: "agentSelfCreateOnly",
  },
  {
    re: /Agents can only edit their own appointments/i,
    key: "agentSelfEditOnly",
  },
  {
    re: /Only administrators can reassign/i,
    key: "reassignAdminOnly",
  },
  { re: /service is not available for booking/i, key: "serviceUnavailable" },
  { re: /specialist is not eligible/i, key: "specialistNotEligible" },
  { re: /Contact not found in your account/i, key: "contactNotFound" },
  { re: /Service not found in your account/i, key: "serviceNotFound" },
  {
    re: /can only change the status of their own appointments/i,
    key: "agentOwnStatusOnly",
  },
  {
    re: /appointments can only be corrected by an administrator/i,
    key: "cancelledAdminOnly",
  },
  {
    re: /Viewers cannot change appointment statuses/i,
    key: "viewerNoStatus",
  },
  { re: /Viewers cannot (create|edit) appointments/i, key: "viewerNoWrite" },
  {
    re: /Status transition (.+?) → (.+?) is not allowed for agents/,
    key: "agentTransition",
    withArgs: true,
  },
];

/** Translate a DB error message if it's a known one; passthrough otherwise. */
export function localizeAppointmentDbError(message: string): string {
  for (const rule of RULES) {
    const match = message.match(rule.re);
    if (match) {
      if (rule.withArgs) {
        return t(rule.key, { from: match[1], to: match[2] });
      }
      return t(rule.key);
    }
  }
  return message;
}
