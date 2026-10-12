/**
 * CSV parsing for the contacts import modal. Shared + unit-tested.
 *
 * Columns mirror the agenda's "Información del Cliente" block
 * (migration 047 extensions):
 *   identificacion* · nombre* · apellido* · celular ·
 *   cumpleanos_mes · cumpleanos_dia   (+ legacy email/company/tags)
 * English aliases accepted for every header.
 */

export interface ParsedContactRow {
  /** Celular — optional in the agenda modal. */
  phone: string;
  /** Nombre — required. */
  name?: string;
  /** Apellido — required. */
  lastName?: string;
  /** Identificación — required + the dedup key. */
  identification?: string;
  email?: string;
  company?: string;
  birthMonth?: number;
  birthDay?: number;
  /** Tag names from the optional `tags` column (comma/semicolon separated). */
  tagNames: string[];
}

/** Split a CSV cell into unique tag names (case-insensitive de-dupe). */
export function parseTagCell(value: string | undefined): string[] {
  if (!value?.trim()) return [];

  const seen = new Set<string>();
  const names: string[] = [];

  for (const part of value.split(/[,;]/)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return names;
}

export interface ParseContactCsvResult {
  rows: ParsedContactRow[];
  /** Derived: the `phone`/`celular` column is present (broadcasts
   *  still require it; the contact import treats it as optional). */
  hasPhoneColumn: boolean;
  hasIdentificationColumn: boolean;
  hasNameColumn: boolean;
  hasLastNameColumn: boolean;
  hasTagsColumn: boolean;
  hasCompanyColumn: boolean;
}

/** All accepted header aliases per logical column. */
const COLUMN_ALIASES: Record<string, string[]> = {
  identification: ['identification', 'identificacion'],
  name: ['name', 'nombre'],
  lastName: ['lastname', 'last_name', 'apellido'],
  phone: ['phone', 'celular'],
  birthMonth: ['birth_month', 'birthmonth', 'cumpleanos_mes', 'cumpleanosmes', 'mes'],
  birthDay: ['birth_day', 'birthday', 'cumpleanos_dia', 'cumpleanosdia', 'dia'],
  email: ['email', 'correo'],
  company: ['company', 'empresa'],
  tags: ['tags', 'etiquetas'],
};

export function parseContactCsv(text: string): ParseContactCsvResult {
  const empty: ParseContactCsvResult = {
    rows: [],
    hasPhoneColumn: false,
    hasIdentificationColumn: false,
    hasNameColumn: false,
    hasLastNameColumn: false,
    hasTagsColumn: false,
    hasCompanyColumn: false,
  };

  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return empty;

  const headers = lines[0]
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/["']/g, ''));

  const find = (logical: string) => {
    const aliases = COLUMN_ALIASES[logical];
    return headers.findIndex((h) => aliases.includes(h));
  };

  const identificationIdx = find('identification');
  const nameIdx = find('name');
  const lastNameIdx = find('lastName');
  const phoneIdx = find('phone');
  const birthMonthIdx = find('birthMonth');
  const birthDayIdx = find('birthDay');
  const emailIdx = find('email');
  const companyIdx = find('company');
  const tagsIdx = find('tags');

  // NOTE: missing agenda-required columns (identificacion/nombre/
  // apellido) do NOT bail out here — the broadcast importer only
  // needs `phone`. The contact-import modal validates the required
  // trio against the parsed rows instead.

  const rows: ParsedContactRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCsvLine(line);
    const cell = (idx: number) =>
      idx >= 0 ? values[idx]?.replace(/["']/g, '').trim() || undefined : undefined;

    const birthMonthRaw = cell(birthMonthIdx);
    const birthDayRaw = cell(birthDayIdx);
    const birthMonth = birthMonthRaw ? Number(birthMonthRaw) : undefined;
    const birthDay = birthDayRaw ? Number(birthDayRaw) : undefined;

    rows.push({
      phone: cell(phoneIdx) ?? '',
      name: cell(nameIdx),
      lastName: cell(lastNameIdx),
      identification: cell(identificationIdx),
      email: cell(emailIdx),
      company: cell(companyIdx),
      birthMonth:
        birthMonth && Number.isInteger(birthMonth) && birthMonth >= 1 && birthMonth <= 12
          ? birthMonth
          : undefined,
      birthDay:
        birthDay && Number.isInteger(birthDay) && birthDay >= 1 && birthDay <= 31
          ? birthDay
          : undefined,
      tagNames: tagsIdx >= 0 ? parseTagCell(cell(tagsIdx)) : [],
    });
  }

  return {
    rows,
    hasPhoneColumn: phoneIdx !== -1,
    hasIdentificationColumn: identificationIdx !== -1,
    hasNameColumn: nameIdx !== -1,
    hasLastNameColumn: lastNameIdx !== -1,
    hasTagsColumn: tagsIdx >= 0,
    hasCompanyColumn: companyIdx >= 0,
  };
}

/** Simple CSV line parse (handles quoted fields). */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}
