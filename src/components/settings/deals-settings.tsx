'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Coins, Loader2, Store } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { CURRENCIES } from '@/lib/currency';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { useTranslations } from 'next-intl';
import { SettingsPanelHead } from './settings-panel-head';

/**
 * Deals settings — account-wide default currency.
 *
 * One currency per account (issue #218): the chosen code seeds new
 * deals and formats every aggregated total. Existing deals keep their
 * own saved currency. Writes go straight to `accounts.default_currency`;
 * the `accounts_update` RLS policy (017) already restricts that to
 * admins+, so non-admins see a disabled, read-only control.
 */
export function DealsSettings() {
  const supabase = createClient();
  const {
    accountId,
    defaultCurrency,
    account,
    canEditSettings,
    profileLoading,
    refreshProfile,
  } = useAuth();

  const [selected, setSelected] = useState(defaultCurrency);
  const [saving, setSaving] = useState(false);
  // Identidad del negocio (migration 057) — se guarda en accounts y
  // alimenta los mensajes de WhatsApp del historial de agenda.
  const [bizTitle, setBizTitle] = useState('');
  const [bizSubtitle, setBizSubtitle] = useState('');
  const [identitySaving, setIdentitySaving] = useState(false);
  const t = useTranslations('Settings.deals');

  // Keep the select in sync once the profile (and its account default)
  // resolves, and after a save round-trips through refreshProfile.
  useEffect(() => {
    setSelected(defaultCurrency);
  }, [defaultCurrency]);

  // Igual para la identidad: sincroniza cuando la cuenta resuelve o
  // vuelve del refreshProfile posterior al guardado.
  useEffect(() => {
    setBizTitle(account?.business_title ?? '');
    setBizSubtitle(account?.business_subtitle ?? '');
  }, [account?.business_title, account?.business_subtitle]);

  const dirty = selected !== defaultCurrency;

  async function handleSave() {
    if (!accountId || !dirty) return;
    setSaving(true);
    const { error } = await supabase
      .from('accounts')
      .update({ default_currency: selected })
      .eq('id', accountId);
    if (error) {
      toast.error(t('saveFailed'));
      setSaving(false);
      return;
    }
    // Pull the new value back into the auth context so the deal form
    // and every total pick it up without a full reload.
    await refreshProfile();
    setSaving(false);
    toast.success(t('saveSuccess'));
  }

  const identityDirty =
    bizTitle.trim() !== (account?.business_title ?? '') ||
    bizSubtitle.trim() !== (account?.business_subtitle ?? '');

  async function handleIdentitySave() {
    if (!accountId || !identityDirty) return;
    setIdentitySaving(true);
    const title = bizTitle.trim();
    const { error } = await supabase
      .from('accounts')
      .update({
        business_title: title === '' ? null : title,
        business_subtitle:
          bizSubtitle.trim() === '' ? null : bizSubtitle.trim(),
      })
      .eq('id', accountId);
    if (error) {
      toast.error(t('identitySaveFailed'));
      setIdentitySaving(false);
      return;
    }
    await refreshProfile();
    setIdentitySaving(false);
    toast.success(t('identitySaveSuccess'));
  }

  return (
    <section className="animate-in fade-in-50 max-w-2xl duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground flex items-center gap-2">
            <Coins className="text-primary size-4" />
            {t('defaultCurrency')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('defaultCurrencyDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:max-w-xs">
            <Label className="text-muted-foreground">
              {t('currencyLabel')}
            </Label>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={!canEditSettings || profileLoading}
              className="border-border bg-muted text-foreground focus:border-primary focus:ring-primary h-9 w-full rounded-lg border px-2.5 text-sm outline-none focus:ring-1 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.label}
                </option>
              ))}
            </select>
            {!canEditSettings && (
              <p className="text-muted-foreground text-xs">
                {t('adminOnlyHint')}
              </p>
            )}
          </div>

          {canEditSettings && (
            <Button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('saving')}
                </>
              ) : (
                t('save')
              )}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-foreground flex items-center gap-2">
            <Store className="text-primary size-4" />
            {t('identityTitle')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('identityDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label className="text-muted-foreground" htmlFor="business-title">
              {t('titleLabel')}
            </Label>
            <Input
              id="business-title"
              value={bizTitle}
              onChange={(e) => setBizTitle(e.target.value)}
              placeholder={t('titlePlaceholder')}
              maxLength={80}
              disabled={!canEditSettings || profileLoading}
              className="bg-muted max-w-md"
            />
          </div>
          <div className="grid gap-2">
            <Label
              className="text-muted-foreground"
              htmlFor="business-subtitle"
            >
              {t('subtitleLabel')}
            </Label>
            <Input
              id="business-subtitle"
              value={bizSubtitle}
              onChange={(e) => setBizSubtitle(e.target.value)}
              placeholder={t('subtitlePlaceholder')}
              maxLength={120}
              disabled={!canEditSettings || profileLoading}
              className="bg-muted max-w-md"
            />
          </div>

          {canEditSettings && (
            <Button
              onClick={handleIdentitySave}
              disabled={identitySaving || !identityDirty}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {identitySaving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('saving')}
                </>
              ) : (
                t('save')
              )}
            </Button>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
