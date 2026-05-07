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
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
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
    phone: '',
    email: '',
  });
  const [editingCompany, setEditingCompany] = useState(false);
  const [savingCompany, setSavingCompany] = useState(false);
  const [loading, setLoading] = useState(true);

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
        const res = await fetch(`/api/settings?companyId=${companyId}`, { credentials: 'include' });
        if (res.ok && !cancelled) {
          const data = await res.json();
          if (data.company) {
            setCompanyData({
              legalName: data.company.legalName || '',
              taxId: data.company.taxId || '',
              address: data.company.address || '',
              phone: data.company.phone || '',
              email: data.company.email || '',
            });
          }
        }
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [companyId]);

  // Fetch all companies (super_admin)
  useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/companies', { credentials: 'include' });
        if (res.ok && !cancelled) {
          const data = await res.json();
          setCompanies(data.companies || []);
        }
      } catch { /* ignore */ }
      if (!cancelled) setLoadingCompanies(false);
    })();
    return () => { cancelled = true; };
  }, [isSuperAdmin]);

  async function handleSaveCompany() {
    if (!companyId) return;
    setSavingCompany(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, ...companyData }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.company?.legalName) {
          useAuthStore.getState().setActiveCompany({
            ...activeCompany!,
            legalName: data.company.legalName,
          });
        }
        setEditingCompany(false);
        toast.success(t('settings.companyUpdated'));
      }
    } catch { /* ignore */ }
    setSavingCompany(false);
  }

  async function handleCreateCompany() {
    if (!newCompany.legalName.trim()) return;
    setCreatingCompany(true);
    try {
      const res = await fetch('/api/companies', {
        method: 'POST',
        credentials: 'include',
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
    } catch { /* ignore */ }
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
                <CardDescription className="mt-1">
                  {t('settings.companyInfo')}
                </CardDescription>
              </div>
              {!editingCompany && (
                <Button variant="outline" size="sm" onClick={() => setEditingCompany(true)}>
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
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="legalName">{t('settings.legalName')}</Label>
                  <Input
                    id="legalName"
                    value={companyData.legalName}
                    onChange={(e) => setCompanyData((prev) => ({ ...prev, legalName: e.target.value }))}
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
                    onChange={(e) => setCompanyData((prev) => ({ ...prev, phone: e.target.value }))}
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="address">{t('settings.address')}</Label>
                  <Input
                    id="address"
                    value={companyData.address}
                    onChange={(e) => setCompanyData((prev) => ({ ...prev, address: e.target.value }))}
                  />
                </div>
                <div className="flex gap-2 sm:col-span-2">
                  <Button onClick={handleSaveCompany} disabled={savingCompany}>
                    {savingCompany ? (
                      <><Loader2 className="size-4 mr-1 animate-spin" /> {t('settings.saving')}</>
                    ) : (
                      <><Save className="size-4 mr-1" /> {t('common.save')}</>
                    )}
                  </Button>
                  <Button variant="outline" onClick={() => setEditingCompany(false)}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <InfoRow label={t('settings.legalName')} value={companyData.legalName} />
                <InfoRow label={t('settings.taxId')} value={companyData.taxId || '—'} />
                <InfoRow label={t('settings.email')} value={companyData.email || '—'} />
                <InfoRow label={t('settings.phone')} value={companyData.phone || '—'} />
                <InfoRow label={t('settings.address')} value={companyData.address || '—'} fullWidth />
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
                      <DialogDescription>
                        {t('settings.companyInfo')}
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-1.5">
                        <Label>{t('settings.legalName')}</Label>
                        <Input
                          value={newCompany.legalName}
                          onChange={(e) => setNewCompany((prev) => ({ ...prev, legalName: e.target.value }))}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t('settings.companies.ein')}</Label>
                        <Input
                          value={newCompany.taxId}
                          onChange={(e) => setNewCompany((prev) => ({ ...prev, taxId: e.target.value }))}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t('settings.email')}</Label>
                        <Input
                          type="email"
                          value={newCompany.email}
                          onChange={(e) => setNewCompany((prev) => ({ ...prev, email: e.target.value }))}
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setNewCompanyOpen(false)}>
                        {t('common.cancel')}
                      </Button>
                      <Button onClick={handleCreateCompany} disabled={creatingCompany || !newCompany.legalName.trim()}>
                        {creatingCompany ? (
                          <><Loader2 className="size-4 mr-1 animate-spin" /> {t('settings.saving')}</>
                        ) : (
                          <><Plus className="size-4 mr-1" /> {t('common.create')}</>
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
                        <TableHead className="font-semibold">EMPRESA</TableHead>
                        <TableHead className="font-semibold">EIN</TableHead>
                        <TableHead className="font-semibold">{t('settings.companies.contact')}</TableHead>
                        <TableHead className="font-semibold">{t('settings.companies.status')}</TableHead>
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
                            <Badge variant={company.isActive ? 'default' : 'secondary'} className="text-xs">
                              {company.isActive ? t('settings.companies.active') : t('settings.companies.inactive')}
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

function InfoRow({ label, value, fullWidth = false }: { label: string; value: string; fullWidth?: boolean }) {
  return (
    <div className={fullWidth ? 'sm:col-span-2' : ''}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}
