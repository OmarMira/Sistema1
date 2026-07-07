'use client';

import { useState, useEffect } from 'react';
import {
  Building2,
  Save,
  Loader2,
  CheckCircle2,
  Plus,
  MoreVertical,
  Pencil,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { AddressAutocomplete } from '@/components/ui/address-autocomplete';
import { usAddressClientSchema } from '@/lib/validations/us-address-client';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';

/* ─── Animation Variants ──────────────────────────────────────── */

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

/* ─── Types ───────────────────────────────────────────────────── */

interface CompanyRow {
  id: string;
  legalName: string;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  isActive: boolean;
}

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

/* ─── CompanyDataTab ─────────────────────────────────────────── */

export function CompanyDataTab() {
  const t = useLanguageStore((s) => s.t);
  const user = useAuthStore((s) => s.user);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const companyId = activeCompany?.id;

  const [companyData, setCompanyData] = useState({
    legalName: '',
    taxId: '',
    address: '',
    streetLine1: '',
    streetLine2: '',
    city: '',
    state: '',
    zipCode: '',
    phone: '',
    email: '',
    logo: '',
    entityFirstMode: false,
  });
  const [logoPreview, setLogoPreview] = useState('');
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [editingCompany, setEditingCompany] = useState(false);
  const [savingCompany, setSavingCompany] = useState(false);
  const [loading, setLoading] = useState(true);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  // Companies list (super_admin only)
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [loadingCompanies, setLoadingCompanies] = useState(true);
  const isSuperAdmin = user?.role === 'super_admin';

  // New company dialog
  const [newCompanyOpen, setNewCompanyOpen] = useState(false);
  const [newCompany, setNewCompany] = useState({
    legalName: '',
    taxId: '',
    email: '',
  });
  const [creatingCompany, setCreatingCompany] = useState(false);

  // Fetch current company settings
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/settings?companyId=${companyId}`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          if (data.company) {
            setCompanyData({
              legalName: data.company.legalName || '',
              taxId: data.company.taxId || '',
              address: data.company.address || '',
              streetLine1: data.company.streetLine1 || '',
              streetLine2: data.company.streetLine2 || '',
              city: data.company.city || '',
              state: data.company.state || '',
              zipCode: data.company.zipCode || '',
              phone: data.company.phone || '',
              email: data.company.email || '',
              logo: data.company.logo || '',
              entityFirstMode: data.company.entityFirstMode ?? false,
            });
            setLogoPreview(data.company.logo || '');
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

  // Fetch all companies (super_admin)
  useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/companies');
        if (res.ok && !cancelled) {
          const data = await res.json();
          setCompanies(data.companies || []);
        }
      } catch {
        /* ignore */
      }
      if (!cancelled) setLoadingCompanies(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [isSuperAdmin]);

  async function handleSaveCompany() {
    if (!companyId) return;
    setFormErrors({});

    // Zod validation on submit
    const addressParse = usAddressClientSchema.safeParse({
      streetLine1: companyData.streetLine1,
      streetLine2: companyData.streetLine2 || '',
      city: companyData.city,
      state: companyData.state,
      zipCode: companyData.zipCode,
      phone: companyData.phone || '',
    });

    if (!addressParse.success) {
      logger.error('[COMPANY PROFILE VALIDATION ERROR]', { error: String(addressParse.error) });

      const errors: Record<string, string> = {};
      let firstInvalidField: string | null = null;

      addressParse.error.issues.forEach((issue) => {
        const path = issue.path[0] as string;
        if (!errors[path]) {
          errors[path] = t(`settings.companyProfile.errors.${path as any}`) || issue.message;
        }
        if (!firstInvalidField) {
          firstInvalidField = path;
        }
      });

      setFormErrors(errors);

      const firstIssue = addressParse.error.issues[0];
      const errorMsg = firstIssue
        ? t(`settings.companyProfile.errors.${firstIssue.path[0] as any}`) || firstIssue.message
        : t('settings.companyProfile.invalidAddress');

      toast.error(errorMsg);

      if (firstInvalidField) {
        setTimeout(() => {
          const element = document.getElementById(firstInvalidField!);
          if (element) {
            element.focus();
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 50);
      }
      return;
    }

    setSavingCompany(true);
    try {
      const formData = new FormData();
      formData.append('companyId', companyId);
      formData.append('email', companyData.email);
      formData.append('phone', companyData.phone);
      formData.append('entityFirstMode', String(companyData.entityFirstMode));

      formData.append('address', JSON.stringify(addressParse.data));

      if (logoFile) {
        formData.append('logo', logoFile);
      } else if (!logoPreview) {
        // If logo was cleared
        formData.append('logoCleared', 'true');
      }

      const res = await fetch('/api/company/profile', {
        method: 'PATCH',
        body: formData,
      });

      if (res.ok) {
        const data = await res.json();

        // Update auth-store active company logo & info
        useAuthStore.getState().setActiveCompany({
          ...activeCompany!,
          legalName: companyData.legalName,
          logo: data.logo || null,
        });

        // Update state
        setCompanyData((prev) => ({
          ...prev,
          logo: data.logo || '',
        }));
        setLogoPreview(data.logo || '');
        setLogoFile(null);

        setEditingCompany(false);
        toast.success('Información de la empresa actualizada.');
      } else {
        const err = await res.json();
        toast.error(err.error || 'Ocurrió un error al guardar.');
      }
    } catch (err) {
      logger.error(String(err));
      toast.error('Ocurrió un error al guardar.');
    }
    setSavingCompany(false);
  }

  async function handleCreateCompany() {
    if (!newCompany.legalName.trim()) return;
    setCreatingCompany(true);
    try {
      const res = await fetch('/api/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newCompany),
      });
      if (res.ok) {
        const data = await res.json();
        setCompanies((prev) => [...prev, data.company]);
        setNewCompany({ legalName: '', taxId: '', email: '' });
        setNewCompanyOpen(false);
        toast.success(t('settings.companies.companyCreated'));
      }
    } catch {
      /* ignore */
    }
    setCreatingCompany(false);
  }

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="space-y-6"
    >
      {/* Company Data Form */}
      <motion.div variants={itemVariants}>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Building2 className="size-4" />
                  {activeCompany?.legalName || t('settings.companyData')}
                </CardTitle>
                <CardDescription className="mt-1">{t('settings.companyInfo')}</CardDescription>
              </div>
              {!editingCompany && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditingCompany(true);
                    setFormErrors({});
                  }}
                >
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
            ) : editingCompany ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {/* Logo upload */}
                <div className="flex flex-col items-center justify-center gap-2 sm:col-span-2 py-4 border border-dashed rounded-lg bg-muted/20">
                  <Label className="text-sm font-semibold">Logo Corporativo</Label>
                  <div className="relative group size-20 rounded-full overflow-hidden border bg-background flex items-center justify-center">
                    {logoPreview ? (
                      <img
                        src={logoPreview}
                        alt="Logo Preview"
                        className="size-full object-cover"
                      />
                    ) : (
                      <Building2 className="size-8 text-muted-foreground" />
                    )}
                    <label className="absolute inset-0 flex items-center justify-center bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer text-white text-xs font-semibold">
                      Cambiar
                      <input
                        type="file"
                        accept="image/png, image/jpeg, image/svg+xml"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            setLogoFile(file);
                            setLogoPreview(URL.createObjectURL(file));
                          }
                        }}
                      />
                    </label>
                  </div>
                  {logoPreview && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-destructive text-xs"
                      onClick={() => {
                        setLogoFile(null);
                        setLogoPreview('');
                      }}
                    >
                      Eliminar logo
                    </Button>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    Formatos: PNG, JPG, SVG. Máximo 1MB.
                  </p>
                </div>

                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="legalName">{t('settings.legalName')}</Label>
                  <Input
                    id="legalName"
                    value={companyData.legalName}
                    onChange={(e) =>
                      setCompanyData((prev) => ({ ...prev, legalName: e.target.value }))
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="taxId">{t('settings.taxId')}</Label>
                  <Input
                    id="taxId"
                    value={companyData.taxId}
                    onChange={(e) => setCompanyData((prev) => ({ ...prev, taxId: e.target.value }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="companyEmail">{t('settings.email')}</Label>
                  <Input
                    id="companyEmail"
                    type="email"
                    value={companyData.email}
                    onChange={(e) => setCompanyData((prev) => ({ ...prev, email: e.target.value }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="phone">{t('settings.phone')}</Label>
                  <Input
                    id="phone"
                    value={companyData.phone}
                    aria-invalid={!!formErrors.phone}
                    onChange={(e) => setCompanyData((prev) => ({ ...prev, phone: e.target.value }))}
                  />
                  {formErrors.phone && (
                    <p className="text-xs text-destructive font-medium mt-1">{formErrors.phone}</p>
                  )}
                </div>

                <div className="flex items-center gap-3 sm:col-span-2 py-1">
                  <Switch
                    id="entityFirstMode"
                    checked={companyData.entityFirstMode}
                    onCheckedChange={(checked) =>
                      setCompanyData((prev) => ({ ...prev, entityFirstMode: checked }))
                    }
                  />
                  <Label htmlFor="entityFirstMode" className="cursor-pointer">
                    <div className="font-medium text-sm">{t('settings.entityFirstMode')}</div>
                    <p className="text-xs text-muted-foreground">{t('settings.entityFirstDesc')}</p>
                  </Label>
                </div>

                {/* Localized US Address fields */}
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="streetLine1">{t('settings.companyProfile.streetAddress')}</Label>
                  <AddressAutocomplete
                    id="streetLine1"
                    aria-invalid={!!formErrors.streetLine1}
                    defaultValue={companyData.streetLine1}
                    onSelect={(addr) => {
                      setCompanyData((prev) => {
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
                    placeholder="Buscar dirección en EE.UU..."
                  />
                  {formErrors.streetLine1 && (
                    <p className="text-xs text-destructive font-medium mt-1">
                      {formErrors.streetLine1}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="streetLine2">{t('settings.companyProfile.suiteUnit')}</Label>
                  <Input
                    id="streetLine2"
                    value={companyData.streetLine2}
                    aria-invalid={!!formErrors.streetLine2}
                    onChange={(e) =>
                      setCompanyData((prev) => ({ ...prev, streetLine2: e.target.value }))
                    }
                    placeholder={t('settings.companyProfile.suitePlaceholder')}
                  />
                  {formErrors.streetLine2 && (
                    <p className="text-xs text-destructive font-medium mt-1">
                      {formErrors.streetLine2}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="city">{t('settings.companyProfile.city')}</Label>
                  <Input
                    id="city"
                    value={companyData.city}
                    aria-invalid={!!formErrors.city}
                    onChange={(e) => setCompanyData((prev) => ({ ...prev, city: e.target.value }))}
                    placeholder={t('settings.companyProfile.cityPlaceholder')}
                  />
                  {formErrors.city && (
                    <p className="text-xs text-destructive font-medium mt-1">{formErrors.city}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="state">{t('settings.companyProfile.state')}</Label>
                  <select
                    id="state"
                    value={companyData.state}
                    aria-invalid={!!formErrors.state}
                    onChange={(e) => setCompanyData((prev) => ({ ...prev, state: e.target.value }))}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-950 aria-invalid:border-destructive aria-invalid:ring-destructive"
                  >
                    <option value="">{t('settings.companyProfile.selectState')}</option>
                    {US_STATES.map((st) => (
                      <option key={st} value={st}>
                        {st}
                      </option>
                    ))}
                  </select>
                  {formErrors.state && (
                    <p className="text-xs text-destructive font-medium mt-1">{formErrors.state}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="zipCode">{t('settings.companyProfile.zipCode')}</Label>
                  <Input
                    id="zipCode"
                    value={companyData.zipCode}
                    aria-invalid={!!formErrors.zipCode}
                    onChange={(e) =>
                      setCompanyData((prev) => ({ ...prev, zipCode: e.target.value }))
                    }
                    placeholder={t('settings.companyProfile.zipPlaceholder')}
                  />
                  {formErrors.zipCode && (
                    <p className="text-xs text-destructive font-medium mt-1">
                      {formErrors.zipCode}
                    </p>
                  )}
                </div>

                <div className="flex gap-2 sm:col-span-2 pt-2">
                  <Button onClick={handleSaveCompany} disabled={savingCompany}>
                    {savingCompany ? (
                      <>
                        <Loader2 className="size-4 mr-1 animate-spin" /> {t('settings.saving')}
                      </>
                    ) : (
                      <>
                        <Save className="size-4 mr-1" /> {t('common.save')}
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setEditingCompany(false);
                      setFormErrors({});
                    }}
                  >
                    {t('common.cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col md:flex-row gap-6 items-start">
                {/* Logo Display */}
                <div className="shrink-0 size-24 rounded-full border bg-muted/30 flex items-center justify-center overflow-hidden">
                  {companyData.logo ? (
                    <img src={companyData.logo} alt="Logo" className="size-full object-cover" />
                  ) : (
                    <Building2 className="size-10 text-muted-foreground" />
                  )}
                </div>

                {/* Company Info */}
                <div className="grid gap-3 sm:grid-cols-2 flex-1 w-full">
                  <InfoRow label={t('settings.legalName')} value={companyData.legalName} />
                  <InfoRow label={t('settings.taxId')} value={companyData.taxId || '—'} />
                  <InfoRow label={t('settings.email')} value={companyData.email || '—'} />
                  <InfoRow label={t('settings.phone')} value={companyData.phone || '—'} />

                  {/* Detailed US Address Display */}
                  <div className="sm:col-span-2 pt-2 border-t mt-1">
                    <p className="text-xs font-semibold text-primary mb-1">
                      Dirección Fiscal Registrada (EE.UU.)
                    </p>
                    {companyData.streetLine1 ? (
                      <div className="space-y-0.5 text-sm font-medium">
                        <p>
                          {companyData.streetLine1}{' '}
                          {companyData.streetLine2 && `, ${companyData.streetLine2}`}
                        </p>
                        <p>
                          {companyData.city}, {companyData.state} {companyData.zipCode}
                        </p>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">
                        Ninguna dirección registrada
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Companies Management Table (super_admin only) */}
      {isSuperAdmin && (
        <motion.div variants={itemVariants}>
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">{t('settings.companies.title')}</CardTitle>
                </div>
                <Dialog open={newCompanyOpen} onOpenChange={setNewCompanyOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm">
                      <Plus className="size-3.5 mr-1" />
                      {t('settings.companies.newCompany')}
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>{t('settings.companies.createCompany')}</DialogTitle>
                      <DialogDescription>{t('settings.companyInfo')}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-1.5">
                        <Label>{t('settings.legalName')}</Label>
                        <Input
                          value={newCompany.legalName}
                          onChange={(e) =>
                            setNewCompany((prev) => ({ ...prev, legalName: e.target.value }))
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t('settings.companies.ein')}</Label>
                        <Input
                          value={newCompany.taxId}
                          onChange={(e) =>
                            setNewCompany((prev) => ({ ...prev, taxId: e.target.value }))
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t('settings.email')}</Label>
                        <Input
                          type="email"
                          value={newCompany.email}
                          onChange={(e) =>
                            setNewCompany((prev) => ({ ...prev, email: e.target.value }))
                          }
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setNewCompanyOpen(false)}>
                        {t('common.cancel')}
                      </Button>
                      <Button
                        onClick={handleCreateCompany}
                        disabled={creatingCompany || !newCompany.legalName.trim()}
                      >
                        {creatingCompany ? (
                          <>
                            <Loader2 className="size-4 mr-1 animate-spin" /> {t('settings.saving')}
                          </>
                        ) : (
                          <>
                            <Plus className="size-4 mr-1" /> {t('common.create')}
                          </>
                        )}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent>
              {loadingCompanies ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : companies.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  {t('common.noData')}
                </p>
              ) : (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="font-semibold">{t('settings.company')}</TableHead>
                        <TableHead className="font-semibold">
                          {t('settings.companies.ein')}
                        </TableHead>
                        <TableHead className="font-semibold">
                          {t('settings.companies.contact')}
                        </TableHead>
                        <TableHead className="font-semibold">
                          {t('settings.companies.status')}
                        </TableHead>
                        <TableHead className="font-semibold w-12"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {companies.map((company) => (
                        <TableRow key={company.id}>
                          <TableCell className="font-medium">{company.legalName}</TableCell>
                          <TableCell>{company.taxId || '—'}</TableCell>
                          <TableCell>{company.email || '—'}</TableCell>
                          <TableCell>
                            <Badge
                              variant={company.isActive ? 'default' : 'secondary'}
                              className="text-xs"
                            >
                              {company.isActive
                                ? t('settings.companies.active')
                                : t('settings.companies.inactive')}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="size-8">
                                  <MoreVertical className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem>
                                  <Pencil className="size-3.5 mr-2" />
                                  {t('common.edit')}
                                </DropdownMenuItem>
                                <DropdownMenuItem className="text-destructive">
                                  <Trash2 className="size-3.5 mr-2" />
                                  {t('common.delete')}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      )}
    </motion.div>
  );
}

/* ─── Helper Component ────────────────────────────────────────── */

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
