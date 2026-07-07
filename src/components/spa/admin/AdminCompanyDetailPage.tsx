'use client';

import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Building2,
  ArrowLeft,
  UserPlus,
  UserMinus,
  Loader2,
  Mail,
  Shield,
  Key,
  Calendar,
  Phone,
  MapPin,
  CheckCircle,
} from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
}

interface Member {
  id: string;
  role: string;
  joinedAt: string;
  user: User;
}

interface Company {
  id: string;
  legalName: string;
  taxId: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  isActive: boolean;
}

const LOCAL_TRANSLATIONS: Record<string, Record<string, string>> = {
  en: {
    loading: 'Loading company details...',
    errorNotFound: 'Company not found.',
    errorNetwork: 'Network error loading data.',
    backBtn: 'Back to Companies',
    statusActive: 'Active',
    statusInactive: 'Inactive',
    assignBtn: 'Assign User',
    identityCardTitle: 'Identity Record',
    fiscalYearLabel: 'Fiscal Year: January - December',
    authorizedAccessTitle: 'Authorized Accesses ({count})',
    thUser: 'User',
    thEmail: 'Email',
    thRole: 'Assigned Role',
    thActions: 'Actions',
    badgeSuperAdmin: 'Super Admin',
    badgeCompanyAdmin: 'Company Admin',
    revokeBtn: 'Revoke',
    noAssignedUsers: 'No users assigned to this company.',
    modalTitle: 'Assign User',
    selectUserLabel: 'Select User',
    chooseUserOption: '-- Choose a system user --',
    roleLabel: 'Company Role',
    cancelBtn: 'Cancel',
    assigningBtn: 'Assigning...',
    confirmBtn: 'Confirm Assignment',
  },
  es: {
    loading: 'Cargando detalles de la empresa...',
    errorNotFound: 'Empresa no encontrada.',
    errorNetwork: 'Error de red al cargar datos.',
    backBtn: 'Volver a Empresas',
    statusActive: 'Activa',
    statusInactive: 'Inactiva',
    assignBtn: 'Asignar Usuario',
    identityCardTitle: 'Ficha de Identidad',
    fiscalYearLabel: 'Año Fiscal: Enero - Diciembre',
    authorizedAccessTitle: 'Accesos Autorizados ({count})',
    thUser: 'Usuario',
    thEmail: 'Email',
    thRole: 'Rol Asignado',
    thActions: 'Acciones',
    badgeSuperAdmin: 'Super Admin',
    badgeCompanyAdmin: 'Admin de Empresa',
    revokeBtn: 'Revocar',
    noAssignedUsers: 'No hay usuarios asignados a esta empresa.',
    modalTitle: 'Asignar Usuario',
    selectUserLabel: 'Seleccionar Usuario',
    chooseUserOption: '-- Elige un usuario del sistema --',
    roleLabel: 'Rol de Empresa',
    cancelBtn: 'Cancelar',
    assigningBtn: 'Asignando...',
    confirmBtn: 'Confirmar Asignación',
  },
};

import { useLanguageStore } from '@/store/language-store';
import { logger } from '@/lib/logger';
import { toast } from 'sonner';

export default function AdminCompanyDetailPage() {
  const language = useLanguageStore((s) => s.language) || 'es';
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const activeLang = mounted ? language : 'es';
  const dt = LOCAL_TRANSLATIONS[activeLang] || LOCAL_TRANSLATIONS.es;
  const { setCurrentView, adminSelectedCompanyId } = useAuthStore();
  const [company, setCompany] = useState<Company | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Assign modal state
  const [assignOpen, setAssignOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedRole, setSelectedRole] = useState('company_admin');
  const [assigning, setAssigning] = useState(false);

  // Revoke state
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!adminSelectedCompanyId) return;
    setLoading(true);
    setError(null);
    try {
      // Get company detail from catalog
      const compRes = await fetch('/api/admin/companies');
      if (compRes.ok) {
        const compData = await compRes.json();
        const found = (compData.companies || []).find(
          (c: Company) => c.id === adminSelectedCompanyId,
        );
        if (found) {
          setCompany(found);
        } else {
          setError('Empresa no encontrada.');
        }
      }

      // Get members and all available users
      const memRes = await fetch(`/api/admin/companies/${adminSelectedCompanyId}/users`);
      if (memRes.ok) {
        const memData = await memRes.json();
        setMembers(memData.members || []);
        setAllUsers(memData.allUsers || []);
      }
    } catch (err) {
      logger.error(String(err));
      setError('Error de red al cargar datos.');
    } finally {
      setLoading(false);
    }
  }, [adminSelectedCompanyId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleAssign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUserId || !adminSelectedCompanyId) return;

    setAssigning(true);
    try {
      const res = await fetch(`/api/admin/companies/${adminSelectedCompanyId}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: selectedUserId, role: selectedRole }),
      });

      if (res.ok) {
        setAssignOpen(false);
        setSelectedUserId('');
        loadData();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Error al asignar usuario.');
      }
    } catch (err) {
      logger.error(String(err));
    } finally {
      setAssigning(false);
    }
  };

  const handleRevoke = async (memberUserId: string) => {
    if (!adminSelectedCompanyId) return;
    setRevokingId(memberUserId);
    try {
      const res = await fetch(
        `/api/admin/companies/${adminSelectedCompanyId}/users/${memberUserId}`,
        {
          method: 'DELETE',
        },
      );
      if (res.ok) {
        loadData();
      }
    } catch (err) {
      logger.error(String(err));
    } finally {
      setRevokingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-40 gap-4">
        <Loader2 className="size-10 text-indigo-500 animate-spin" />
        <p className="text-muted-foreground text-sm">{dt.loading}</p>
      </div>
    );
  }

  if (error || !company) {
    return (
      <div className="flex flex-col items-center justify-center py-20 bg-card text-card-foreground rounded-2xl border shadow-sm max-w-lg mx-auto">
        <Shield className="size-16 text-rose-500/80 mb-4" />
        <p className="text-rose-600 dark:text-rose-400 font-bold">
          {error
            ? error === 'Empresa no encontrada.'
              ? dt.errorNotFound
              : error
            : dt.errorNotFound}
        </p>
        <Button
          onClick={() => setCurrentView('admin-companies')}
          className="mt-6 bg-indigo-600 hover:bg-indigo-700 text-white shadow-md"
        >
          {dt.backBtn}
        </Button>
      </div>
    );
  }

  // Filter out users that are already members
  const unassignedUsers = allUsers.filter((u) => !members.some((m) => m.user.id === u.id));

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Back button */}
      <button
        onClick={() => setCurrentView('admin-companies')}
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        <ArrowLeft className="size-4" />
        {dt.backBtn}
      </button>

      {/* Main Info Header */}
      <div className="p-6 bg-card text-card-foreground rounded-2xl border shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-indigo-500/10 rounded-xl">
            <Building2 className="size-8 text-indigo-600 dark:text-indigo-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground leading-snug">{company.legalName}</h1>
            <div className="flex items-center gap-2 mt-1">
              <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
                {company.isActive ? dt.statusActive : dt.statusInactive}
              </Badge>
              {company.taxId && (
                <span className="text-xs font-mono text-muted-foreground">
                  Tax ID: {company.taxId}
                </span>
              )}
            </div>
          </div>
        </div>
        <Button
          onClick={() => setAssignOpen(true)}
          className="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold shadow-lg shadow-indigo-500/20 gap-2"
        >
          <UserPlus className="size-4.5" />
          {dt.assignBtn}
        </Button>
      </div>

      {/* Grid: Company Details & Users list */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: Card details */}
        <div className="space-y-6 lg:col-span-1">
          <div className="p-6 bg-card text-card-foreground rounded-2xl border shadow-sm space-y-4">
            <h2 className="text-sm font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">
              {dt.identityCardTitle}
            </h2>
            <div className="space-y-3.5 text-sm">
              {company.email && (
                <div className="flex items-center gap-3 text-foreground/80">
                  <Mail className="size-4.5 text-muted-foreground shrink-0" />
                  <span className="truncate">{company.email}</span>
                </div>
              )}
              {company.phone && (
                <div className="flex items-center gap-3 text-foreground/80">
                  <Phone className="size-4.5 text-muted-foreground shrink-0" />
                  <span>{company.phone}</span>
                </div>
              )}
              {company.address && (
                <div className="flex items-start gap-3 text-foreground/80">
                  <MapPin className="size-4.5 text-muted-foreground shrink-0 mt-0.5" />
                  <span className="leading-snug">{company.address}</span>
                </div>
              )}
              <div className="flex items-center gap-3 text-foreground/80">
                <Calendar className="size-4.5 text-muted-foreground shrink-0" />
                <span>{dt.fiscalYearLabel}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right column: Assigned Users Table */}
        <div className="lg:col-span-2 space-y-4">
          <div className="p-6 bg-card text-card-foreground rounded-2xl border shadow-sm">
            <h2 className="text-lg font-bold text-foreground mb-4 flex items-center gap-2">
              <Key className="size-5.5 text-indigo-600 dark:text-indigo-400" />
              {dt.authorizedAccessTitle.replace('{count}', members.length.toString())}
            </h2>

            {members.length > 0 ? (
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="min-w-full divide-y divide-border">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="px-6 py-3.5 text-left text-xs font-bold text-muted-foreground uppercase tracking-wider">
                        {dt.thUser}
                      </th>
                      <th className="px-6 py-3.5 text-left text-xs font-bold text-muted-foreground uppercase tracking-wider">
                        {dt.thEmail}
                      </th>
                      <th className="px-6 py-3.5 text-left text-xs font-bold text-muted-foreground uppercase tracking-wider">
                        {dt.thRole}
                      </th>
                      <th className="px-6 py-3.5 text-right text-xs font-bold text-muted-foreground uppercase tracking-wider">
                        {dt.thActions}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border bg-card">
                    {members.map((member) => (
                      <tr key={member.id} className="hover:bg-muted/20 transition-all">
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-foreground">
                          {member.user.firstName} {member.user.lastName}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-foreground/80">
                          {member.user.email}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          <Badge className="bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border border-indigo-500/20">
                            {member.role === 'super_admin'
                              ? dt.badgeSuperAdmin
                              : dt.badgeCompanyAdmin}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={revokingId === member.user.id}
                            className="text-rose-600 hover:text-white hover:bg-rose-600 rounded-lg gap-1.5 transition-colors"
                            onClick={() => handleRevoke(member.user.id)}
                          >
                            {revokingId === member.user.id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <UserMinus className="size-3.5" />
                            )}
                            {dt.revokeBtn}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
                <Shield className="size-12 opacity-40" />
                <p className="text-sm">{dt.noAssignedUsers}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Assign User Modal */}
      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="bg-slate-900 text-white border border-white/10 rounded-2xl max-w-md shadow-2xl">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold flex items-center gap-2 text-indigo-400">
              <UserPlus className="size-6" />
              {dt.modalTitle}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAssign} className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
                {dt.selectUserLabel}
              </Label>
              <select
                required
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="block w-full rounded-xl border border-white/10 bg-slate-950 text-white px-4 py-2.5 text-sm focus:ring-indigo-500 outline-none cursor-pointer"
              >
                <option value="">{dt.chooseUserOption}</option>
                {unassignedUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.firstName} {u.lastName} ({u.email})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
                {dt.roleLabel}
              </Label>
              <select
                required
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value)}
                className="block w-full rounded-xl border border-white/10 bg-slate-950 text-white px-4 py-2.5 text-sm focus:ring-indigo-500 outline-none cursor-pointer"
              >
                <option value="company_admin">{dt.badgeCompanyAdmin}</option>
                <option value="super_admin">{dt.badgeSuperAdmin}</option>
              </select>
            </div>
            <DialogFooter className="pt-4 border-t border-white/5">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setAssignOpen(false)}
                className="text-slate-400 hover:text-white rounded-xl"
              >
                {dt.cancelBtn}
              </Button>
              <Button
                type="submit"
                disabled={assigning || !selectedUserId}
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-xl shadow-lg shadow-indigo-500/20"
              >
                {assigning ? dt.assigningBtn : dt.confirmBtn}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
