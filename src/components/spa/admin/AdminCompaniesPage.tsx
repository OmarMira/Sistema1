'use client';

import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Building2,
  Plus,
  Search,
  Pencil,
  Trash2,
  Users,
  ShieldAlert,
  Loader2,
  Globe,
  Phone,
  Mail,
  MapPin,
  Calendar,
  DollarSign,
  Upload,
  Save,
} from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { useLanguageStore } from '@/store/language-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { AddressAutocomplete } from '@/components/ui/address-autocomplete';
import { logger } from '@/lib/logger';
import { toast } from 'sonner';

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

interface Company {
  id: string;
  legalName: string;
  taxId: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  streetLine1?: string;
  streetLine2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  logo?: string | null;
  isActive: boolean;
  createdAt: string;
}

export default function AdminCompaniesPage() {
  const t = useLanguageStore((s) => s.t);
  const { setCurrentView, setAdminSelectedCompanyId } = useAuthStore();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCompany, setEditingCompany] = useState<Company | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Delete Dialog state
  const [deleteTarget, setDeleteTarget] = useState<Company | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Form State
  const [formData, setFormData] = useState({
    legalName: '',
    taxId: '',
    phone: '',
    email: '',
    streetLine1: '',
    streetLine2: '',
    city: '',
    state: '',
    zipCode: '',
    isActive: true,
  });

  const [logoPreview, setLogoPreview] = useState('');
  const [logoFile, setLogoFile] = useState<File | null>(null);

  const loadCompanies = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/companies');
      if (res.ok) {
        const data = await res.json();
        setCompanies(data.companies || []);
      }
    } catch (err) {
      logger.error(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCompanies();
  }, [loadCompanies]);

  const handleOpenCreate = () => {
    setEditingCompany(null);
    setFormData({
      legalName: '',
      taxId: '',
      phone: '',
      email: '',
      streetLine1: '',
      streetLine2: '',
      city: '',
      state: '',
      zipCode: '',
      isActive: true,
    });
    setLogoPreview('');
    setLogoFile(null);
    setModalOpen(true);
  };

  const handleOpenEdit = (company: Company) => {
    setEditingCompany(company);
    setFormData({
      legalName: company.legalName,
      taxId: company.taxId || '',
      phone: company.phone || '',
      email: company.email || '',
      streetLine1: company.streetLine1 || '',
      streetLine2: company.streetLine2 || '',
      city: company.city || '',
      state: company.state || '',
      zipCode: company.zipCode || '',
      isActive: company.isActive,
    });
    setLogoPreview(company.logo || '');
    setLogoFile(null);
    setModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.legalName) return;

    setSubmitting(true);
    try {
      const url = editingCompany
        ? `/api/admin/companies/${editingCompany.id}`
        : '/api/admin/companies';
      const method = editingCompany ? 'PUT' : 'POST';

      const data = new FormData();
      data.append('legalName', formData.legalName);
      data.append('taxId', formData.taxId);
      data.append('phone', formData.phone);
      data.append('email', formData.email);
      data.append('streetLine1', formData.streetLine1);
      data.append('streetLine2', formData.streetLine2);
      data.append('city', formData.city);
      data.append('state', formData.state);
      data.append('zipCode', formData.zipCode);
      data.append('isActive', String(formData.isActive));

      if (logoFile) {
        data.append('logo', logoFile);
      } else if (!logoPreview && editingCompany) {
        data.append('logoCleared', 'true');
      }

      const res = await fetch(url, {
        method,
        body: data,
      });

      if (res.ok) {
        setModalOpen(false);
        loadCompanies();
      } else {
        const err = await res.json();
        toast.error(err.error || 'Error al guardar la empresa');
      }
    } catch (err) {
      logger.error(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const executeDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/companies/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setDeleteTarget(null);
        loadCompanies();
      }
    } catch (err) {
      logger.error(String(err));
    } finally {
      setDeleting(false);
    }
  };

  const filteredCompanies = companies.filter(
    (c) =>
      c.legalName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (c.taxId && c.taxId.toLowerCase().includes(searchQuery.toLowerCase())),
  );

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between p-6 bg-card text-card-foreground rounded-2xl border shadow-sm">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground flex items-center gap-3">
            <Building2 className="size-8 text-indigo-600 animate-pulse" />
            {t('adminCompanies.title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t('adminCompanies.subtitle')}</p>
        </div>
        <Button
          onClick={handleOpenCreate}
          className="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold shadow-lg shadow-indigo-500/20 transition-all gap-2 self-start sm:self-center"
        >
          <Plus className="size-5" />
          {t('adminCompanies.createBtn')}
        </Button>
      </div>

      {/* Search Filter */}
      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-5 text-muted-foreground" />
        <Input
          placeholder={t('adminCompanies.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-11 rounded-xl bg-card border-input text-foreground placeholder-muted-foreground focus:ring-2 focus:ring-indigo-500"
        />
      </div>

      {/* Grid of Companies */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <Loader2 className="size-10 text-indigo-500 animate-spin" />
          <p className="text-muted-foreground text-sm">{t('adminCompanies.loading')}</p>
        </div>
      ) : filteredCompanies.length > 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
        >
          <AnimatePresence mode="popLayout">
            {filteredCompanies.map((company) => (
              <motion.div
                key={company.id}
                layout
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="group relative bg-card text-card-foreground rounded-2xl border hover:border-indigo-500/30 hover:shadow-lg shadow-sm transition-all duration-300 overflow-hidden flex flex-col justify-between"
              >
                <div className="p-6 space-y-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="p-1 bg-indigo-500/10 rounded-xl group-hover:bg-indigo-500/20 transition-all size-12 flex items-center justify-center overflow-hidden shrink-0">
                        {company.logo ? (
                          <img src={company.logo} alt="Logo" className="size-full object-contain" />
                        ) : (
                          <Building2 className="size-6 text-indigo-600 dark:text-indigo-400" />
                        )}
                      </div>
                      <div>
                        <h3 className="font-bold text-lg text-foreground group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors leading-snug">
                          {company.legalName}
                        </h3>
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
                          <Globe className="size-3.5" />
                          <span>ID: {company.id.substring(0, 8)}...</span>
                        </div>
                      </div>
                    </div>
                    <Badge
                      className={
                        company.isActive
                          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/20'
                          : 'bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/20'
                      }
                    >
                      {company.isActive ? t('adminCompanies.statusActive') : t('adminCompanies.statusInactive')}
                    </Badge>
                  </div>

                  <div className="space-y-2 pt-2 text-sm border-t border-border">
                    {company.taxId && (
                      <div className="flex items-center gap-2 text-foreground/80">
                        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider w-16">
                          Tax ID:
                        </span>
                        <span className="font-mono text-foreground font-medium">
                          {company.taxId}
                        </span>
                      </div>
                    )}
                    {company.email && (
                      <div className="flex items-center gap-2 text-foreground/80">
                        <Mail className="size-4 text-muted-foreground" />
                        <span className="truncate">{company.email}</span>
                      </div>
                    )}
                    {company.phone && (
                      <div className="flex items-center gap-2 text-foreground/80">
                        <Phone className="size-4 text-muted-foreground" />
                        <span>{company.phone}</span>
                      </div>
                    )}
                    {company.address && (
                      <div className="flex items-center gap-2 text-foreground/80">
                        <MapPin className="size-4 text-muted-foreground shrink-0" />
                        <span className="truncate">{company.address}</span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="px-6 py-4 bg-muted/40 border-t border-border flex items-center justify-between">
                  <div className="text-xs text-muted-foreground flex items-center gap-1">
                    <Calendar className="size-3.5" />
                    <span>
                      {t('adminCompanies.createdDate')} {new Date(company.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-9 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 rounded-lg transition-colors"
                      onClick={() => handleOpenEdit(company)}
                      title="Editar"
                    >
                      <Pencil className="size-4.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-9 text-slate-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition-colors"
                      onClick={() => setDeleteTarget(company)}
                      title="Eliminar"
                    >
                      <Trash2 className="size-4.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-9 text-indigo-600 dark:text-indigo-400 hover:text-white hover:bg-indigo-600 rounded-lg transition-colors"
                      onClick={() => {
                        setAdminSelectedCompanyId(company.id);
                        setCurrentView('admin-company-detail');
                      }}
                    >
                      <Users className="size-4.5" />
                    </Button>
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      ) : (
        <div className="flex flex-col items-center justify-center py-20 bg-muted/20 rounded-2xl border border-border">
          <Building2 className="size-16 text-muted-foreground/60 mb-4" />
          <p className="text-muted-foreground">{t('adminCompanies.noCompanies')}</p>
        </div>
      )}

      {/* Creation/Editing Modal */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="bg-card text-card-foreground border border-border rounded-2xl max-w-xl shadow-2xl overflow-y-auto max-h-[90vh]">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold flex items-center gap-2 text-indigo-600 dark:text-indigo-400">
              <Building2 className="size-6" />
              {editingCompany ? t('adminCompanies.editTitle') : t('adminCompanies.newTitle')}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4 py-2">
            {/* Logo upload */}
            <div className="flex flex-col items-center justify-center gap-2 py-3 border border-dashed rounded-xl bg-muted/20">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Logotipo de la Empresa
              </Label>
              <div className="relative group size-20 rounded-xl overflow-hidden border bg-background flex items-center justify-center shadow-sm">
                {logoPreview ? (
                  <img src={logoPreview} alt="Logo" className="size-full object-contain p-1" />
                ) : (
                  <Building2 className="size-10 text-muted-foreground/50" />
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
                        if (file.size > 10 * 1024 * 1024) {
                          toast.error('El archivo excede el límite de 10MB');
                          return;
                        }
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
                  className="h-7 text-rose-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/20 text-xs"
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

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
                  {t('adminCompanies.labelLegalName')}
                </Label>
                <Input
                  required
                  value={formData.legalName}
                  onChange={(e) => setFormData({ ...formData, legalName: e.target.value })}
                  placeholder={t('adminCompanies.placeholderLegalName')}
                  className="bg-card border-input text-foreground placeholder-muted-foreground rounded-xl focus:ring-indigo-500"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
                  {t('adminCompanies.labelTaxId')}
                </Label>
                <Input
                  value={formData.taxId}
                  onChange={(e) => setFormData({ ...formData, taxId: e.target.value })}
                  placeholder={t('adminCompanies.placeholderTaxId')}
                  className="bg-card border-input text-foreground placeholder-muted-foreground rounded-xl focus:ring-indigo-500"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
                  {t('adminCompanies.labelEmail')}
                </Label>
                <Input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder={t('adminCompanies.placeholderEmail')}
                  className="bg-card border-input text-foreground placeholder-muted-foreground rounded-xl focus:ring-indigo-500"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
                  {t('adminCompanies.labelPhone')}
                </Label>
                <Input
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  placeholder={t('adminCompanies.placeholderPhone')}
                  className="bg-card border-input text-foreground placeholder-muted-foreground rounded-xl focus:ring-indigo-500"
                />
              </div>

              {/* Localized US Address fields */}
              <div className="space-y-1.5 md:col-span-2">
                <Label className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
                  Dirección (Calle y Número)
                </Label>
                <AddressAutocomplete
                  defaultValue={formData.streetLine1}
                  onSelect={(addr) => {
                    setFormData((prev) => {
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
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
                  Suite / Oficina / Unidad (Opcional)
                </Label>
                <Input
                  value={formData.streetLine2}
                  onChange={(e) => setFormData({ ...formData, streetLine2: e.target.value })}
                  placeholder="Apt 2B"
                  className="bg-card border-input text-foreground placeholder-muted-foreground rounded-xl focus:ring-indigo-500"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
                  Ciudad / Localidad
                </Label>
                <Input
                  value={formData.city}
                  onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                  placeholder="Miami"
                  className="bg-card border-input text-foreground placeholder-muted-foreground rounded-xl focus:ring-indigo-500"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
                  Estado
                </Label>
                <select
                  value={formData.state}
                  onChange={(e) => setFormData({ ...formData, state: e.target.value })}
                  className="flex h-9 w-full rounded-xl border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-950"
                >
                  <option value="">Seleccione Estado</option>
                  {US_STATES.map((st) => (
                    <option key={st} value={st}>
                      {st}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
                  Código Postal (ZIP Code)
                </Label>
                <Input
                  value={formData.zipCode}
                  onChange={(e) => setFormData({ ...formData, zipCode: e.target.value })}
                  placeholder="33101"
                  className="bg-card border-input text-foreground placeholder-muted-foreground rounded-xl focus:ring-indigo-500"
                />
              </div>
            </div>

            {editingCompany && (
              <div className="flex items-center gap-3 pt-2">
                <input
                  type="checkbox"
                  id="isActiveCheck"
                  checked={formData.isActive}
                  onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                  className="size-4 rounded border-input bg-card text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                />
                <Label
                  htmlFor="isActiveCheck"
                  className="text-foreground/90 text-sm font-semibold select-none cursor-pointer"
                >
                  {t('adminCompanies.labelActive')}
                </Label>
              </div>
            )}
            <DialogFooter className="pt-4 border-t border-border">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setModalOpen(false)}
                className="text-slate-500 hover:text-foreground hover:bg-muted rounded-xl"
              >
                {t('adminCompanies.cancelBtn')}
              </Button>
              <Button
                type="submit"
                disabled={submitting}
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-xl shadow-lg shadow-indigo-500/20"
              >
                {submitting ? t('adminCompanies.savingBtn') : t('adminCompanies.saveBtn')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <DialogContent className="bg-card text-card-foreground border border-border rounded-2xl max-w-md shadow-2xl">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold flex items-center gap-2 text-rose-600 dark:text-rose-400">
              <ShieldAlert className="size-6 text-rose-600 animate-bounce" />
              {t('adminCompanies.deleteTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="py-2 text-sm text-foreground/80">
            {t('adminCompanies.deleteConfirm').replace('{name}', deleteTarget?.legalName || '')}
            <br />
            <br />
            {t('adminCompanies.deleteWarning')}
          </div>
          <DialogFooter className="pt-4 border-t border-border">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              className="text-slate-500 hover:text-foreground hover:bg-muted rounded-xl"
            >
              {t('adminCompanies.cancelBtn')}
            </Button>
            <Button
              type="button"
              disabled={deleting}
              onClick={executeDelete}
              className="bg-rose-600 hover:bg-rose-700 text-white font-semibold rounded-xl shadow-lg shadow-rose-500/20"
            >
              {deleting ? t('adminCompanies.deletingBtn') : t('adminCompanies.deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
