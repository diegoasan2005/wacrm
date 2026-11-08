'use client';

// ============================================================
// AppointmentDialog — create / edit / view an appointment.
//
// Two sections, mirroring the reference design: client info
// (existing-contact search or inline creation) and appointment
// info (date, time, specialist, service, duration, status,
// notes). All authorisation is enforced server-side; the dialog
// only adapts which controls are enabled.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, Search, UserPlus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  isValidE164,
  normalizePhone,
  parseInternationalPhone,
  withColombiaPrefix,
} from '@/lib/whatsapp/phone-utils';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/hooks/use-auth';
import {
  allowedTransitions,
  canBookPastDates,
  canCreateAppointments,
  canEditAppointment,
  canReassignAppointments,
  type AgendaRoleContext,
} from '@/lib/appointments/permissions';
import { STATUS_META } from '@/lib/appointments/statuses';
import { cn } from '@/lib/utils';
import {
  wallTimeToUtc,
  utcToDateKey,
  utcToMinutes,
} from '@/lib/appointments/time';

/** 12-hour clock label ("9:30 a. m.") — matches the agenda's visual
 *  language on every device. */
function format12h(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const period = h24 < 12 ? 'a. m.' : 'p. m.';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${mm} ${period}`;
}
import { DEFAULT_DURATIONS } from '@/lib/appointments/constants';
import type {
  Appointment,
  AppointmentService,
  AppointmentStatus,
} from '@/types/appointments';
import type { AccountMember } from '@/types';

export interface DialogPreset {
  dateKey: string;
  minutes: number;
  memberId?: string;
  contactId?: string;
}

interface ContactHit {
  id: string;
  name: string | null;
  last_name: string | null;
  identification: string | null;
  phone: string;
}

interface AppointmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing appointment → edit mode. */
  appointment: Appointment | null;
  /** Slot preset → create mode. */
  preset: DialogPreset | null;
  services: AppointmentService[];
  members: AccountMember[];
  onSaved: () => void;
}

const MONTHS_I18N_NS = 'Agenda.months';
const MONTH_KEYS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

export function AppointmentDialog({
  open,
  onOpenChange,
  appointment,
  preset,
  services,
  members,
  onSaved,
}: AppointmentDialogProps) {
  const t = useTranslations('Agenda.dialog');
  const tMonths = useTranslations(MONTHS_I18N_NS);
  const { accountRole, userId, accountTimezone } = useAuth();

  const roleCtx: AgendaRoleContext | null = useMemo(
    () =>
      accountRole && userId
        ? {
            role: accountRole,
            // The live flag for agents — resolved from the profile in
            // useAuth (canBookAppointments already folds admin+ in).
            canBookAppointments: canCreateAppointments({
              role: accountRole,
              canBookAppointments: true,
              userId,
            }),
            userId,
          }
        : null,
    [accountRole, userId]
  );

  const isEdit = !!appointment;
  const canWrite =
    !!roleCtx && isEdit
      ? canEditAppointment(roleCtx, appointment)
      : !!roleCtx && canCreateAppointments(roleCtx);
  const canReassign = !!accountRole && canReassignAppointments(accountRole);
  // Read-only mode: viewers inspecting an appointment.
  const readOnly = isEdit && !canWrite;

  // --- client section state
  const [contactQuery, setContactQuery] = useState('');
  const [contactHits, setContactHits] = useState<ContactHit[]>([]);
  const [searchingContacts, setSearchingContacts] = useState(false);
  const [selectedContact, setSelectedContact] = useState<ContactHit | null>(
    null
  );
  const [creatingContact, setCreatingContact] = useState(false);
  // Registro de celular para un contacto existente que no lo tiene:
  // se ofrece en línea dentro de la tarjeta del contacto.
  const [phoneDraft, setPhoneDraft] = useState('');
  const [savingPhone, setSavingPhone] = useState(false);
  const [newContact, setNewContact] = useState({
    identification: '',
    name: '',
    last_name: '',
    phone: '',
    birth_month: '',
    birth_day: '',
  });

  // --- appointment section state
  const [dateKey, setDateKey] = useState(preset?.dateKey ?? '');
  const [timeMinutes, setTimeMinutes] = useState(preset?.minutes ?? 9 * 60);
  const [serviceId, setServiceId] = useState('');
  const [duration, setDuration] = useState('30');
  const [memberId, setMemberId] = useState(preset?.memberId ?? '');
  const [status, setStatus] = useState<AppointmentStatus>('PENDIENTE');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  // Migration 048: a member is offered as specialist iff their
  // "Visible en agenda" flag is on — any role.
  const eligibleMembers = useMemo(
    () => members.filter((m) => m.show_in_agenda ?? true),
    [members]
  );

  const bookableServices = useMemo(() => {
    // Migration 054 — a member sees the services assigned to them
    // PLUS the unassigned ones ("applies to all members"). Services
    // assigned exclusively to other members are not offered.
    return services.filter((s) => {
      if (!s.is_active || !s.available_for_booking) return false;
      if (!memberId) return true; // specialist not chosen yet
      const ids = s.member_ids ?? [];
      return ids.length === 0 || ids.includes(memberId);
    });
  }, [services, memberId]);

  // Reset state when the dialog opens.
  useEffect(() => {
    if (!open) return;
    if (appointment) {
      setDateKey(utcToDateKey(appointment.starts_at, accountTimezone));
      setTimeMinutes(utcToMinutes(appointment.starts_at, accountTimezone));
      setServiceId(appointment.service_id ?? '');
      setDuration(String(appointment.duration_minutes));
      setMemberId(appointment.assigned_user_id);
      setStatus(appointment.status);
      setNotes(appointment.notes ?? '');
      setSelectedContact(
        appointment.contact
          ? {
              id: appointment.contact.id,
              name: appointment.contact.name ?? null,
              last_name: appointment.contact.last_name ?? null,
              identification: appointment.contact.identification ?? null,
              phone: appointment.contact.phone,
            }
          : null
      );
      setCreatingContact(false);
      setContactQuery('');
      setContactHits([]);
      setPhoneDraft('');
    } else if (preset) {
      setDateKey(preset.dateKey);
      setTimeMinutes(preset.minutes);
      setMemberId(preset.memberId ?? userId ?? '');
      setStatus('PENDIENTE');
      setNotes('');
      setSelectedContact(null);
      setCreatingContact(false);
      setContactQuery('');
      setContactHits([]);
      setPhoneDraft('');
      // Preload the account's default service — only if the chosen
      // specialist may use it (054 member assignment rule).
      const mayUse = (s: AppointmentService) =>
        !s.member_ids ||
        s.member_ids.length === 0 ||
        s.member_ids.includes(memberId || '');
      const def =
        services.find((s) => s.is_default && s.is_active && mayUse(s)) ??
        services.find(
          (s) => s.is_active && s.available_for_booking && mayUse(s)
        );
      if (def) {
        setServiceId(def.id);
        setDuration(String(def.duration_minutes));
      } else {
        setServiceId('');
        setDuration('30');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, appointment, preset, accountTimezone]);

  // Service → duration autoload (spec §5.3).
  const handleServiceChange = useCallback(
    (id: string) => {
      setServiceId(id);
      const svc = services.find((s) => s.id === id);
      if (svc) setDuration(String(svc.duration_minutes));
    },
    [services]
  );

  // When the specialist changes, drop a selected service they don't
  // offer (054 member assignment) so the save can't carry an invalid
  // pair.
  useEffect(() => {
    if (!open || isEdit || !serviceId) return;
    if (!bookableServices.some((s) => s.id === serviceId)) {
      setServiceId('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);

  // --- contact search (debounced) — runs while the search box is
  // visible (NOT in inline-creation mode; the condition was
  // inverted, which made results only appear after toggling to the
  // create form and back).
  const searchSeq = useRef(0);
  useEffect(() => {
    if (!open || creatingContact) return;
    const term = contactQuery.trim();
    if (term.length < 2) {
      setContactHits([]);
      return;
    }
    const timer = setTimeout(async () => {
      const seq = ++searchSeq.current;
      setSearchingContacts(true);
      const supabase = createClient();
      const like = `%${term}%`;
      const digits = term.replace(/\D/g, '');
      const parts = [`name.ilike.${like}`, `identification.ilike.${like}`];
      if (digits.length >= 3) parts.push(`phone.ilike.%${digits}%`);
      const { data } = await supabase
        .from('contacts')
        .select('id, name, last_name, identification, phone')
        .or(parts.join(','))
        .limit(8);
      if (seq === searchSeq.current) {
        setContactHits((data ?? []) as ContactHit[]);
        setSearchingContacts(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [contactQuery, creatingContact, open]);

  // Guarda el celular que falta en el contacto existente. Misma
  // normalización que el formulario de contactos: dígitos puros,
  // prefijo 57 automático salvo "+" explícito, validación E.164.
  async function handleSavePhone() {
    if (!selectedContact) return;
    const raw = phoneDraft.trim();
    if (!raw) return;
    let finalPhone: string;
    if (raw.startsWith('+')) {
      if (!parseInternationalPhone(raw)) {
        toast.error(t('phoneInvalid'));
        return;
      }
      finalPhone = normalizePhone(raw);
    } else {
      finalPhone = withColombiaPrefix(raw);
    }
    if (!isValidE164(finalPhone)) {
      toast.error(t('phoneInvalid'));
      return;
    }
    setSavingPhone(true);
    const supabase = createClient();
    const { error } = await supabase
      .from('contacts')
      .update({ phone: finalPhone })
      .eq('id', selectedContact.id);
    setSavingPhone(false);
    if (error) {
      // La más común: (account_id, phone_normalized) único (migración
      // 022) — otro contacto ya tiene ese número.
      toast.error(t('phoneSaveFailed'));
      return;
    }
    setSelectedContact({ ...selectedContact, phone: finalPhone });
    setPhoneDraft('');
    toast.success(t('phoneSavedToast'));
  }

  async function handleSave() {
    if (!dateKey || !serviceId || !memberId) {
      toast.error(t('missingFields'));
      return;
    }

    // Los agentes no registran ni mueven citas a fechas anteriores a
    // hoy (en la zona horaria de la cuenta); propietario/admin sí.
    if (
      roleCtx &&
      !canBookPastDates(roleCtx.role) &&
      dateKey < utcToDateKey(new Date().toISOString(), accountTimezone)
    ) {
      toast.error(t('pastDateForbidden'));
      return;
    }

    setSaving(true);
    try {
      const startsAt = wallTimeToUtc(dateKey, timeMinutes, accountTimezone);
      const payload: Record<string, unknown> = {
        service_id: serviceId,
        assigned_user_id: memberId,
        starts_at: startsAt.toISOString(),
        duration_minutes: Number(duration),
      };
      // Only send notes when there is content — an empty string
      // would otherwise route every status-only edit through the
      // field-update path.
      if (notes.trim()) payload.notes = notes;

      let res: Response;
      if (isEdit && appointment) {
        payload.status = status;
        res = await fetch(`/api/appointments/${appointment.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } else {
        if (selectedContact) {
          payload.contact_id = selectedContact.id;
        } else {
          payload.contact = {
            identification: newContact.identification,
            name: newContact.name,
            last_name: newContact.last_name,
            phone: newContact.phone,
            birth_month:
              newContact.birth_month === '' ? null : newContact.birth_month,
            birth_day:
              newContact.birth_day === '' ? null : newContact.birth_day,
          };
        }
        res = await fetch('/api/appointments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }

      const resp = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(resp.error || t('saveFailed'));
        return;
      }
      toast.success(isEdit ? t('updatedToast') : t('createdToast'));
      onSaved();
      onOpenChange(false);
    } catch (err) {
      console.error('[AppointmentDialog] save error:', err);
      toast.error(t('networkError'));
    } finally {
      setSaving(false);
    }
  }

  const statusOptions = useMemo(() => {
    if (!roleCtx || !isEdit) return ['PENDIENTE'] as const;
    return allowedTransitions(roleCtx, appointment.status);
  }, [roleCtx, isEdit, appointment]);

  // Agente editando: sin transiciones — el estado queda bloqueado en
  // su valor actual (solo propietario/admin pueden cambiarlo).
  const statusLocked = isEdit && !readOnly && statusOptions.length === 0;

  const endTime = useMemo(
    () => format12h(timeMinutes + Number(duration || 0)),
    [timeMinutes, duration]
  );

  // Contacto existente sin celular: aviso + registro en línea. Se
  // muestra tanto al crear como al editar; al guardar se actualiza el
  // contacto y el bloque desaparece. El texto "NULL" (artefacto de
  // importaciones; lo limpia la migración 059) cuenta como vacío.
  const contactPhone =
    selectedContact?.phone?.trim() &&
    !/^null$/i.test(selectedContact.phone.trim())
      ? selectedContact.phone
      : '';
  const noPhoneBlock =
    !selectedContact || contactPhone ? null : (
      <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
        <p className="flex items-start gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t('noPhoneWarning')}
        </p>
        <div className="flex gap-2">
          <Input
            value={phoneDraft}
            onChange={(e) => setPhoneDraft(e.target.value)}
            placeholder={t('phonePlaceholder')}
            inputMode="tel"
            aria-label={t('phone')}
            className="bg-background border-border"
          />
          <Button
            size="sm"
            onClick={handleSavePhone}
            disabled={savingPhone || !phoneDraft.trim()}
            className="bg-primary text-primary-foreground hover:bg-primary/90 shrink-0"
          >
            {savingPhone ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              t('savePhoneButton')
            )}
          </Button>
        </div>
      </div>
    );

  // 12-hour AM/PM parts of the selected time — the native time input
  // follows the device locale (often 24h on phones), so the dialog
  // renders its own AM/PM picker instead: same look everywhere.
  const hour12 = (() => {
    const h24 = Math.floor(timeMinutes / 60) % 24;
    return h24 % 12 === 0 ? 12 : h24 % 12;
  })();
  const minutePart = String(timeMinutes % 60).padStart(2, '0');
  const period: 'AM' | 'PM' = timeMinutes >= 720 ? 'PM' : 'AM';

  function setTimeParts(h12: number, m: number, p: 'AM' | 'PM') {
    const h24 = (p === 'PM' ? 12 : 0) + (h12 % 12);
    setTimeMinutes(h24 * 60 + m);
  }

  // Contact search box visibility: editing shows the linked contact;
  // creating offers search + inline creation.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border text-popover-foreground max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('editTitle') : t('createTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <h3 className="text-primary text-sm font-semibold">
            {t('clientSection')}
          </h3>

          {isEdit ? (
            <>
              <div className="border-border bg-muted/40 rounded-md border px-3 py-2 text-sm">
                <p className="text-foreground font-medium">
                  {[selectedContact?.name, selectedContact?.last_name]
                    .filter(Boolean)
                    .join(' ') || t('unnamedContact')}
                </p>
                <p className="text-muted-foreground text-xs">
                  {contactPhone || '—'}
                  {selectedContact?.identification
                    ? ` · ${selectedContact.identification}`
                    : ''}
                </p>
              </div>
              {noPhoneBlock}
            </>
          ) : selectedContact ? (
            <>
              <div className="flex items-center justify-between rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm">
                <div>
                  <p className="text-foreground font-medium">
                    {[selectedContact.name, selectedContact.last_name]
                      .filter(Boolean)
                      .join(' ')}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {contactPhone || '—'}
                    {selectedContact.identification
                      ? ` · ${selectedContact.identification}`
                      : ''}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setSelectedContact(null)}
                  aria-label={t('changeContact')}
                >
                  <X className="size-4" />
                </Button>
              </div>
              {noPhoneBlock}
            </>
          ) : creatingContact ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="appt-id">{t('identification')} *</Label>
                  <Input
                    id="appt-id"
                    value={newContact.identification}
                    onChange={(e) =>
                      setNewContact((c) => ({
                        ...c,
                        identification: e.target.value,
                      }))
                    }
                    maxLength={60}
                    className="bg-background border-border"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="appt-name">{t('firstName')} *</Label>
                  <Input
                    id="appt-name"
                    value={newContact.name}
                    onChange={(e) =>
                      setNewContact((c) => ({ ...c, name: e.target.value }))
                    }
                    className="bg-background border-border"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="appt-last">{t('lastName')} *</Label>
                  <Input
                    id="appt-last"
                    value={newContact.last_name}
                    onChange={(e) =>
                      setNewContact((c) => ({
                        ...c,
                        last_name: e.target.value,
                      }))
                    }
                    className="bg-background border-border"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="appt-phone">{t('phone')}</Label>
                  <Input
                    id="appt-phone"
                    value={newContact.phone}
                    onChange={(e) =>
                      setNewContact((c) => ({ ...c, phone: e.target.value }))
                    }
                    inputMode="tel"
                    className="bg-background border-border"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t('birthMonth')}</Label>
                  <Select
                    value={newContact.birth_month}
                    onValueChange={(v) =>
                      setNewContact((c) => ({ ...c, birth_month: v ?? '' }))
                    }
                  >
                    <SelectTrigger className="bg-background border-border">
                      <SelectValue placeholder={t('select')}>
                        {newContact.birth_month
                          ? tMonths(
                              MONTH_KEYS[Number(newContact.birth_month) - 1]
                            )
                          : t('select')}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {MONTH_KEYS.map((key, i) => (
                        <SelectItem key={key} value={String(i + 1)}>
                          {tMonths(key)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>{t('birthDay')}</Label>
                  <Select
                    value={newContact.birth_day}
                    onValueChange={(v) =>
                      setNewContact((c) => ({ ...c, birth_day: v ?? '' }))
                    }
                  >
                    <SelectTrigger className="bg-background border-border">
                      <SelectValue placeholder={t('select')} />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                        <SelectItem key={d} value={String(d)}>
                          {d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setCreatingContact(false)}
                className="text-muted-foreground hover:text-foreground text-xs"
              >
                ← {t('searchExistingInstead')}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="relative">
                <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
                <Input
                  value={contactQuery}
                  onChange={(e) => setContactQuery(e.target.value)}
                  placeholder={t('contactSearchPlaceholder')}
                  className="bg-background border-border pl-8"
                />
                {searchingContacts && (
                  <Loader2 className="text-muted-foreground absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin" />
                )}
              </div>
              {contactHits.length > 0 && (
                <ul className="border-border divide-border max-h-40 divide-y overflow-y-auto rounded-md border">
                  {contactHits.map((hit) => (
                    <li key={hit.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedContact(hit);
                          setContactQuery('');
                          setContactHits([]);
                        }}
                        className="hover:bg-muted/60 w-full px-3 py-2 text-left text-sm"
                      >
                        <span className="text-foreground font-medium">
                          {[hit.name, hit.last_name]
                            .filter(Boolean)
                            .join(' ') || t('unnamedContact')}
                        </span>
                        <span className="text-muted-foreground ml-2 text-xs">
                          {hit.phone}
                          {hit.identification ? ` · ${hit.identification}` : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                onClick={() => {
                  // Prefill from the search term: digits → ID
                  // number, text → first name.
                  const term = contactQuery.trim();
                  if (term) {
                    if (/^[\d\s.\-()]+$/.test(term)) {
                      setNewContact((c) => ({
                        ...c,
                        identification: term,
                      }));
                    } else {
                      setNewContact((c) => ({ ...c, name: term }));
                    }
                  }
                  setCreatingContact(true);
                }}
                className="text-primary inline-flex items-center gap-1 text-xs hover:underline"
              >
                <UserPlus className="size-3.5" />
                {t('createNewContact')}
              </button>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <h3 className="text-primary text-sm font-semibold">
            {t('appointmentSection')}
          </h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="appt-date">{t('date')} *</Label>
              <Input
                id="appt-date"
                type="date"
                value={dateKey}
                onChange={(e) => setDateKey(e.target.value)}
                disabled={readOnly}
                min={
                  roleCtx && !canBookPastDates(roleCtx.role)
                    ? utcToDateKey(new Date().toISOString(), accountTimezone)
                    : undefined
                }
                className="bg-background border-border"
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('time')} *</Label>
              {/* Custom AM/PM picker — the native time input follows
                  the device locale (often 24h on phones); this looks
                  the same everywhere. 15-minute steps. */}
              <div className="flex items-center gap-1.5">
                <Select
                  value={String(hour12)}
                  onValueChange={(v) =>
                    v && setTimeParts(Number(v), Number(minutePart), period)
                  }
                  disabled={readOnly}
                >
                  <SelectTrigger className="bg-background border-border w-[4.5rem]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
                      <SelectItem key={h} value={String(h)}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={minutePart}
                  onValueChange={(v) =>
                    v && setTimeParts(hour12, Number(v), period)
                  }
                  disabled={readOnly}
                >
                  <SelectTrigger className="bg-background border-border w-[4.5rem]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* 5-minute steps across the hour. */}
                    {Array.from({ length: 12 }, (_, i) =>
                      String(i * 5).padStart(2, '0')
                    ).map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex flex-1 items-center gap-1">
                  {(['AM', 'PM'] as const).map((p) => {
                    const active = period === p;
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() =>
                          setTimeParts(hour12, Number(minutePart), p)
                        }
                        disabled={readOnly}
                        aria-pressed={active}
                        className={cn(
                          'h-9 flex-1 rounded-md border text-xs font-semibold transition-colors disabled:opacity-50',
                          active
                            ? 'border-transparent text-white'
                            : 'border-border bg-background text-muted-foreground hover:bg-muted'
                        )}
                        style={
                          active ? { backgroundColor: '#FC0178' } : undefined
                        }
                      >
                        {p}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t('specialist')} *</Label>
              {isEdit && !canReassign ? (
                <Input
                  value={
                    eligibleMembers.find((m) => m.user_id === memberId)
                      ?.full_name ?? '—'
                  }
                  readOnly
                  disabled
                  className="bg-muted border-border"
                />
              ) : (
                <Select
                  value={memberId}
                  onValueChange={(v) => v && setMemberId(v)}
                  disabled={
                    readOnly || (!!accountRole && accountRole === 'agent')
                  }
                >
                  <SelectTrigger className="bg-background border-border">
                    <SelectValue placeholder={t('select')}>
                      {eligibleMembers.find((m) => m.user_id === memberId)
                        ?.full_name ?? t('select')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {eligibleMembers.map((m) => (
                      <SelectItem key={m.user_id} value={m.user_id}>
                        {m.full_name || m.user_id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>{t('service')} *</Label>
              <Select
                value={serviceId}
                onValueChange={(v) => v && handleServiceChange(v)}
                disabled={readOnly}
              >
                <SelectTrigger className="bg-background border-border">
                  <SelectValue placeholder={t('select')}>
                    {bookableServices.find((s) => s.id === serviceId)?.name ??
                      t('select')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {bookableServices.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="appt-duration">{t('duration')} *</Label>
              <Select
                value={duration}
                onValueChange={(v) => v && setDuration(v)}
                disabled={readOnly}
              >
                <SelectTrigger className="bg-background border-border">
                  <SelectValue>
                    {t('minutes', { count: Number(duration) || 30 })}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Array.from(
                    new Set([...DEFAULT_DURATIONS, Number(duration) || 30])
                  )
                    .sort((a, b) => a - b)
                    .map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {t('minutes', { count: m })}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('status')}</Label>
              <Select
                value={status}
                onValueChange={(v) => v && setStatus(v as AppointmentStatus)}
                disabled={readOnly || statusOptions.length === 0}
              >
                <SelectTrigger className="bg-background border-border">
                  <SelectValue>
                    <span className={STATUS_META[status].textClass}>
                      {t(`statuses.${STATUS_META[status].labelKey}`)}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(statusOptions as readonly AppointmentStatus[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      <span className={STATUS_META[s].textClass}>
                        {t(`statuses.${STATUS_META[s].labelKey}`)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {statusLocked && (
                <p className="text-muted-foreground text-xs">
                  {t('statusAgentLocked')}
                </p>
              )}
            </div>
            <div className="space-y-1.5 sm:col-span-3">
              <Label htmlFor="appt-notes">{t('notes')}</Label>
              <Input
                id="appt-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={readOnly}
                maxLength={2000}
                placeholder={t('notesPlaceholder')}
                className="bg-background border-border"
              />
            </div>
          </div>
          <p className="text-muted-foreground text-xs">
            {t('endTimeLabel', { time: endTime })}
          </p>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t('cancel')}
          </Button>
          {!readOnly && (
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-emerald-600 text-white hover:bg-emerald-700"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {t('accept')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
