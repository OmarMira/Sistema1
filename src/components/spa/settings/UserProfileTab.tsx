'use client';

import { useState, useEffect } from 'react';
import { User, Save, Loader2, CheckCircle2, Pencil, Upload } from 'lucide-react';
import { motion } from 'framer-motion';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { AddressAutocomplete } from '@/components/ui/address-autocomplete';
import { usAddressClientSchema } from '@/lib/validations/us-address-client';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';

const US_STATES = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
];

export function UserProfileTab() {
  const t = useLanguageStore((s) => s.t);
  const authUser = useAuthStore((s) => s.user);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const companyId = activeCompany?.id;

  const [userData, setUserData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    streetLine1: '',
    streetLine2: '',
    city: '',
    state: '',
    zipCode: '',
    avatar: '',
  });

  const [avatarPreview, setAvatarPreview] = useState('');
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [editingUser, setEditingUser] = useState(false);
  const [savingUser, setSavingUser] = useState(false);
  const [loading, setLoading] = useState(true);

  // Fetch current user settings details
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/settings?companyId=${companyId}`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          if (data.user) {
            setUserData({
              firstName: data.user.firstName || '',
              lastName: data.user.lastName || '',
              email: data.user.email || '',
              phone: data.user.phone || '',
              streetLine1: data.user.streetLine1 || '',
              streetLine2: data.user.streetLine2 || '',
              city: data.user.city || '',
              state: data.user.state || '',
              zipCode: data.user.zipCode || '',
              avatar: data.user.avatar || '',
            });
            setAvatarPreview(data.user.avatar || '');
          }
        }
      } catch {
        /* ignore */
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  async function handleSaveUser() {
    if (!userData.firstName.trim() || !userData.lastName.trim()) {
      toast.error(t('settings.nameRequired'));
      return;
    }

    // Zod validation on submit
    const addressParse = usAddressClientSchema.safeParse({
      streetLine1: userData.streetLine1,
      streetLine2: userData.streetLine2 || '',
      city: userData.city,
      state: userData.state,
      zipCode: userData.zipCode,
      phone: userData.phone || '',
    });

    if (!addressParse.success) {
      logger.error('[USER PROFILE VALIDATION ERROR]', { error: String(addressParse.error) });
      const errorMsg = addressParse.error.issues[0]?.message || t('userProfile.invalidAddress');
      toast.error(errorMsg);
      return;
    }

    setSavingUser(true);
    try {
      const formData = new FormData();
      formData.append('firstName', userData.firstName);
      formData.append('lastName', userData.lastName);
      formData.append('phone', userData.phone);

      formData.append('address', JSON.stringify(addressParse.data));

      if (avatarFile) {
        formData.append('avatar', avatarFile);
      } else if (!avatarPreview) {
        formData.append('avatarCleared', 'true');
      }

      const res = await fetch('/api/users/profile', {
        method: 'PATCH',
        body: formData,
      });

      if (res.ok) {
        const data = await res.json();

        // Update user state globally in auth store
        useAuthStore.getState().setUser({
          ...authUser!,
          firstName: data.user.firstName,
          lastName: data.user.lastName,
          avatar: data.user.avatar || null,
        });

        // Update local state
        setUserData((prev) => ({
          ...prev,
          firstName: data.user.firstName || '',
          lastName: data.user.lastName || '',
          avatar: data.user.avatar || '',
        }));
        setAvatarPreview(data.user.avatar || '');
        setAvatarFile(null);

        setEditingUser(false);
        toast.success(t('settings.profileUpdated'));
      } else {
        const err = await res.json();
        toast.error(err.error || t('settings.saveError'));
      }
    } catch (err) {
      logger.error(String(err));
      toast.error(t('settings.saveError'));
    }
    setSavingUser(false);
  }

  function getInitials(firstName: string, lastName: string) {
    return `${firstName?.[0] ?? ''}${lastName?.[0] ?? ''}`.toUpperCase();
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <User className="size-4" />
              {t('userProfile.title')}
            </CardTitle>
            <CardDescription className="mt-1">
              {t('userProfile.description')}
            </CardDescription>
          </div>
          {!editingUser && !loading && (
            <Button variant="outline" size="sm" onClick={() => setEditingUser(true)}>
              <Pencil className="size-3.5 mr-1" />
              {t('common.edit')}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : editingUser ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {/* Avatar upload */}
            <div className="flex flex-col items-center justify-center gap-2 sm:col-span-2 py-4 border border-dashed rounded-lg bg-muted/20">
              <Label className="text-sm font-semibold">{t('userProfile.profilePhoto')}</Label>
              <div className="relative group size-20 rounded-full overflow-hidden border bg-background flex items-center justify-center">
                {avatarPreview ? (
                  <img src={avatarPreview} alt="Avatar" className="size-full object-cover" />
                ) : (
                  <span className="text-xl font-bold text-muted-foreground">
                    {getInitials(userData.firstName, userData.lastName)}
                  </span>
                )}
                <label className="absolute inset-0 flex items-center justify-center bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer text-white text-xs font-semibold">
                  {t('userProfile.changePhoto')}
                  <input
                    type="file"
                    accept="image/png, image/jpeg, image/svg+xml"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        setAvatarFile(file);
                        setAvatarPreview(URL.createObjectURL(file));
                      }
                    }}
                  />
                </label>
              </div>
              {avatarPreview && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-destructive text-xs"
                  onClick={() => {
                    setAvatarFile(null);
                    setAvatarPreview('');
                  }}
                >
                  {t('userProfile.deletePhoto')}
                </Button>
              )}
              <p className="text-[10px] text-muted-foreground">{t('userProfile.photoFormats')}</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="firstName">{t('userProfile.firstName')}</Label>
              <Input
                id="firstName"
                value={userData.firstName}
                onChange={(e) => setUserData((prev) => ({ ...prev, firstName: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lastName">{t('userProfile.lastName')}</Label>
              <Input
                id="lastName"
                value={userData.lastName}
                onChange={(e) => setUserData((prev) => ({ ...prev, lastName: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="userEmail">{t('userProfile.emailNotEditable')}</Label>
              <Input
                id="userEmail"
                type="email"
                value={userData.email}
                disabled
                className="bg-muted/40 cursor-not-allowed"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="userPhone">{t('userProfile.phone')}</Label>
              <Input
                id="userPhone"
                value={userData.phone}
                onChange={(e) => setUserData((prev) => ({ ...prev, phone: e.target.value }))}
                placeholder="+1 (555) 019-2834"
              />
            </div>

            {/* Localized US Address fields */}
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="userStreetLine1">{t('userProfile.addressStreet')}</Label>
              <AddressAutocomplete
                defaultValue={userData.streetLine1}
                onSelect={(addr) => {
                  setUserData((prev) => {
                    // If address was cleared, clear all fields
                    if (addr.streetLine1 === '') {
                      return {
                        ...prev,
                        streetLine1: '',
                        streetLine2: '',
                        city: '',
                        state: '',
                        zipCode: '',
                      };
                    }
                    // If typing manually, preserve other fields, otherwise overwrite with suggestion values
                    return {
                      ...prev,
                      streetLine1: addr.streetLine1,
                      streetLine2: addr.isManual
                        ? prev.streetLine2
                        : addr.streetLine2 || prev.streetLine2,
                      city: addr.isManual ? prev.city : addr.city || prev.city,
                      state: addr.isManual ? prev.state : addr.state || prev.state,
                      zipCode: addr.isManual ? prev.zipCode : addr.zipCode || prev.zipCode,
                    };
                  });
                }}
                placeholder={t('userProfile.addressSearchPlaceholder')}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="userStreetLine2">{t('userProfile.addressSuite')}</Label>
              <Input
                id="userStreetLine2"
                value={userData.streetLine2}
                onChange={(e) => setUserData((prev) => ({ ...prev, streetLine2: e.target.value }))}
                placeholder="Apt 4C"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="userCity">{t('userProfile.city')}</Label>
              <Input
                id="userCity"
                value={userData.city}
                onChange={(e) => setUserData((prev) => ({ ...prev, city: e.target.value }))}
                placeholder="Austin"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="userState">{t('userProfile.state')}</Label>
              <select
                id="userState"
                value={userData.state}
                onChange={(e) => setUserData((prev) => ({ ...prev, state: e.target.value }))}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-950"
              >
                <option value="">{t('userProfile.selectState')}</option>
                {US_STATES.map((st) => (
                  <option key={st} value={st}>
                    {st}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="userZipCode">{t('userProfile.zipCode')}</Label>
              <Input
                id="userZipCode"
                value={userData.zipCode}
                onChange={(e) => setUserData((prev) => ({ ...prev, zipCode: e.target.value }))}
                placeholder="78701"
              />
            </div>

            <div className="flex gap-2 sm:col-span-2 pt-2">
              <Button onClick={handleSaveUser} disabled={savingUser}>
                {savingUser ? (
                  <>
                    <Loader2 className="size-4 mr-1 animate-spin" /> {t('settings.saving')}
                  </>
                ) : (
                  <>
                    <Save className="size-4 mr-1" /> {t('common.save')}
                  </>
                )}
              </Button>
              <Button variant="outline" onClick={() => setEditingUser(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col md:flex-row gap-6 items-start">
            {/* Avatar Display */}
            <div className="shrink-0 size-24 rounded-full border bg-muted/30 flex items-center justify-center overflow-hidden">
              {userData.avatar ? (
                <img src={userData.avatar} alt="Avatar" className="size-full object-cover" />
              ) : (
                <span className="text-2xl font-bold text-muted-foreground">
                  {getInitials(userData.firstName, userData.lastName)}
                </span>
              )}
            </div>

            {/* Profile Info */}
            <div className="grid gap-3 sm:grid-cols-2 flex-1 w-full">
              <InfoRow
                label={t('userProfile.fullName')}
                value={`${userData.firstName} ${userData.lastName}`}
              />
              <InfoRow label={t('userProfile.email')} value={userData.email} />
              <InfoRow label={t('userProfile.phone')} value={userData.phone || '—'} />

              {/* Detailed US Address Display */}
              <div className="sm:col-span-2 pt-2 border-t mt-1">
                <p className="text-xs font-semibold text-primary mb-1">
                  {t('userProfile.registeredTaxAddress')}
                </p>
                {userData.streetLine1 ? (
                  <div className="space-y-0.5 text-sm font-medium">
                    <p>
                      {userData.streetLine1} {userData.streetLine2 && `, ${userData.streetLine2}`}
                    </p>
                    <p>
                      {userData.city}, {userData.state} {userData.zipCode}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground italic">
                    {t('userProfile.noAddressRegistered')}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function InfoRow({
  label,
  value,
  fullWidth = false,
}: {
  label: string;
  value: string;
  fullWidth?: boolean;
}) {
  return (
    <div className={fullWidth ? 'sm:col-span-2' : ''}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}
