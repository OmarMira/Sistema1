'use client';

import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Users,
  UserPlus,
  Search,
  Pencil,
  Trash2,
  ShieldAlert,
  Loader2,
  Mail,
  ShieldCheck,
  Calendar,
  Lock,
  CheckCircle,
  Upload,
  Save,
  Phone,
  MapPin,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  isActive: boolean;
  phone?: string;
  streetLine1?: string;
  streetLine2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  avatar?: string;
  createdAt: string;
}

import { useLanguageStore } from '@/store/language-store';
import { logger } from '@/lib/logger';
import { toast } from 'sonner';

export default function AdminUsersPage() {
  const t = useLanguageStore((s) => s.t);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // Modals state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Delete modal state
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Form State
  const [formData, setFormData] = useState({
    email: '',
    firstName: '',
    lastName: '',
    password: '',
    role: 'company_admin',
    phone: '',
    streetLine1: '',
    streetLine2: '',
    city: '',
    state: '',
    zipCode: '',
    isActive: true,
  });

  const [avatarPreview, setAvatarPreview] = useState('');
  const [avatarFile, setAvatarFile] = useState<File | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/users');
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users || []);
      }
    } catch (err) {
      logger.error(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleOpenCreate = () => {
    setEditingUser(null);
    setFormData({
      email: '',
      firstName: '',
      lastName: '',
      password: '',
      role: 'company_admin',
      phone: '',
      streetLine1: '',
      streetLine2: '',
      city: '',
      state: '',
      zipCode: '',
      isActive: true,
    });
    setAvatarPreview('');
    setAvatarFile(null);
    setModalOpen(true);
  };

  const handleOpenEdit = (user: User) => {
    setEditingUser(user);
    setFormData({
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      password: '', // Leave empty to keep unchanged
      role: user.role,
      phone: user.phone || '',
      streetLine1: user.streetLine1 || '',
      streetLine2: user.streetLine2 || '',
      city: user.city || '',
      state: user.state || '',
      zipCode: user.zipCode || '',
      isActive: user.isActive,
    });
    setAvatarPreview(user.avatar || '');
    setAvatarFile(null);
    setModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.email || !formData.firstName || !formData.lastName) return;

    setSubmitting(true);
    try {
      const url = editingUser ? `/api/admin/users/${editingUser.id}` : '/api/admin/users';
      const method = editingUser ? 'PATCH' : 'POST';

      const data = new FormData();
      data.append('email', formData.email);
      data.append('firstName', formData.firstName);
      data.append('lastName', formData.lastName);
      data.append('role', formData.role);
      data.append('isActive', String(formData.isActive));

      if (formData.password) {
        data.append('password', formData.password);
      }
      data.append('phone', formData.phone);
      data.append('streetLine1', formData.streetLine1);
      data.append('streetLine2', formData.streetLine2);
      data.append('city', formData.city);
      data.append('state', formData.state);
      data.append('zipCode', formData.zipCode);

      if (avatarFile) {
        data.append('avatar', avatarFile);
      } else if (!avatarPreview && editingUser) {
        data.append('avatarCleared', 'true');
      }

      const res = await fetch(url, {
        method,
        body: data,
      });

      if (res.ok) {
        setModalOpen(false);
        loadUsers();
      } else {
        const err = await res.json();
        toast.error(err.error || 'Ocurrió un error al guardar.');
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
      const res = await fetch(`/api/admin/users/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setDeleteTarget(null);
        loadUsers();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Error al eliminar usuario.');
      }
    } catch (err) {
      logger.error(String(err));
    } finally {
      setDeleting(false);
    }
  };

  const filteredUsers = users.filter(
    (u) =>
      `${u.firstName} ${u.lastName}`.toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.email.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between p-6 bg-card text-card-foreground rounded-2xl border shadow-sm">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground flex items-center gap-3">
            <Users className="size-8 text-indigo-600 animate-pulse" />
            {t('adminUsers.title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t('adminUsers.subtitle')}</p>
        </div>
        <Button
          onClick={handleOpenCreate}
          className="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold shadow-lg shadow-indigo-500/20 transition-all gap-2 self-start sm:self-center"
        >
          <UserPlus className="size-5" />
          {t('adminUsers.createBtn')}
        </Button>
      </div>

      {/* Search Filter */}
      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-5 text-muted-foreground" />
        <Input
          placeholder={t('adminUsers.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-11 rounded-xl bg-card border-input text-foreground placeholder-muted-foreground focus:ring-2 focus:ring-indigo-500"
        />
      </div>

      {/* Users Grid */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <Loader2 className="size-10 text-indigo-500 animate-spin" />
          <p className="text-muted-foreground text-sm">{t('adminUsers.loading')}</p>
        </div>
      ) : filteredUsers.length > 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
        >
          <AnimatePresence mode="popLayout">
            {filteredUsers.map((u) => (
              <motion.div
                key={u.id}
                layout
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="group relative bg-card text-card-foreground rounded-2xl border hover:border-indigo-500/30 hover:shadow-lg shadow-sm transition-all duration-300 overflow-hidden flex flex-col justify-between"
              >
                <div className="p-6 space-y-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="size-11 rounded-xl bg-indigo-500/10 flex items-center justify-center text-indigo-600 dark:text-indigo-400 font-extrabold text-sm border border-indigo-500/10 overflow-hidden shrink-0">
                        {u.avatar ? (
                          <img src={u.avatar} alt="Avatar" className="size-full object-cover" />
                        ) : (
                          `${u.firstName?.[0] ?? ''}${u.lastName?.[0] ?? ''}`.toUpperCase()
                        )}
                      </div>
                      <div>
                        <h3 className="font-bold text-lg text-foreground group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors leading-snug">
                          {u.firstName} {u.lastName}
                        </h3>
                        <Badge
                          className={
                            u.role === 'super_admin'
                              ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/20 mt-1'
                              : 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border border-indigo-500/20 mt-1'
                          }
                        >
                          {u.role === 'super_admin' ? t('adminUsers.roleSuperAdmin') : t('adminUsers.roleCompanyAdmin')}
                        </Badge>
                      </div>
                    </div>
                    <Badge
                      className={
                        u.isActive
                          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/20'
                          : 'bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/20'
                      }
                    >
                      {u.isActive ? t('adminUsers.statusActive') : t('adminUsers.statusSuspended')}
                    </Badge>
                  </div>

                  <div className="space-y-2 pt-2 text-sm border-t border-border">
                    <div className="flex items-center gap-2 text-foreground/80">
                      <Mail className="size-4 text-muted-foreground" />
                      <span className="truncate">{u.email}</span>
                    </div>
                    {u.phone && (
                      <div className="flex items-center gap-2 text-foreground/80">
                        <Phone className="size-4 text-muted-foreground animate-pulse" />
                        <span>{u.phone}</span>
                      </div>
                    )}
                    {u.streetLine1 && (
                      <div className="flex items-center gap-2 text-foreground/80">
                        <MapPin className="size-4 text-muted-foreground shrink-0" />
                        <span className="truncate">
                          {[u.streetLine1, u.city, u.state].filter(Boolean).join(', ')}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-foreground/80">
                      <Calendar className="size-4 text-muted-foreground" />
                      <span>
                        {t('adminUsers.registeredDate')} {new Date(u.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="px-6 py-4 bg-muted/40 border-t border-border flex items-center justify-between">
                  <span className="text-xs font-mono text-muted-foreground">
                    ID: {u.id.substring(0, 8)}...
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-9 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 rounded-lg transition-colors"
                      onClick={() => handleOpenEdit(u)}
                      title="Editar"
                    >
                      <Pencil className="size-4.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-9 text-slate-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition-colors"
                      onClick={() => setDeleteTarget(u)}
                      title="Eliminar"
                    >
                      <Trash2 className="size-4.5" />
                    </Button>
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      ) : (
        <div className="flex flex-col items-center justify-center py-20 bg-slate-900/20 rounded-2xl border border-white/5">
          <Users className="size-16 text-slate-600 mb-4" />
          <p className="text-slate-400">{t('adminUsers.noUsers')}</p>
        </div>
      )}

      {/* Creation/Editing Modal */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="bg-slate-900 text-white border border-white/10 rounded-2xl max-w-xl shadow-2xl overflow-y-auto max-h-[90vh]">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold flex items-center gap-2 text-indigo-400">
              <UserPlus className="size-6" />
              {editingUser ? t('adminUsers.editTitle') : t('adminUsers.newTitle')}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4 py-2">
            {/* Avatar upload */}
            <div className="flex flex-col items-center justify-center gap-2 py-3 border border-dashed border-white/10 rounded-xl bg-slate-950/20">
              <Label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Foto de Perfil
              </Label>
              <div className="relative group size-20 rounded-full overflow-hidden border border-white/10 bg-slate-950 flex items-center justify-center shadow-sm">
                {avatarPreview ? (
                  <img src={avatarPreview} alt="Avatar" className="size-full object-cover" />
                ) : (
                  <Users className="size-10 text-slate-600" />
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
                  className="h-7 text-rose-400 hover:text-rose-50 hover:bg-rose-950/20 text-xs"
                  onClick={() => {
                    setAvatarFile(null);
                    setAvatarPreview('');
                  }}
                >
                  Eliminar foto
                </Button>
              )}
              <p className="text-[10px] text-slate-500">Formatos: PNG, JPG, SVG. Máximo 1MB.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
                  {t('adminUsers.labelFirstName')}
                </Label>
                <Input
                  required
                  value={formData.firstName}
                  onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                  placeholder={t('adminUsers.placeholderFirstName')}
                  className="bg-slate-950 border-white/10 text-white rounded-xl focus:ring-indigo-500"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
                  {t('adminUsers.labelLastName')}
                </Label>
                <Input
                  required
                  value={formData.lastName}
                  onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                  placeholder={t('adminUsers.placeholderLastName')}
                  className="bg-slate-950 border-white/10 text-white rounded-xl focus:ring-indigo-500"
                />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
                  {t('adminUsers.labelEmail')}
                </Label>
                <Input
                  type="email"
                  required
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder={t('adminUsers.placeholderEmail')}
                  className="bg-slate-950 border-white/10 text-white rounded-xl focus:ring-indigo-500"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
                  {t('adminUsers.labelPassword')} {editingUser && t('adminUsers.passwordHint')}
                </Label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-slate-500" />
                  <Input
                    type="password"
                    required={!editingUser}
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    placeholder={editingUser ? '••••••••' : t('adminUsers.placeholderPassword')}
                    className="pl-11 bg-slate-950 border-white/10 text-white rounded-xl focus:ring-indigo-500"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
                  {t('adminUsers.labelRole')}
                </Label>
                <select
                  required
                  value={formData.role}
                  onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                  className="block w-full rounded-xl border border-white/10 bg-slate-950 text-white px-4 py-2 text-sm focus:ring-indigo-500 outline-none h-[38px]"
                >
                  <option value="company_admin">{t('adminUsers.roleCompanyAdmin')}</option>
                  <option value="super_admin">{t('adminUsers.roleSuperAdmin')}</option>
                </select>
              </div>

              {/* Teléfono */}
              <div className="space-y-1.5 md:col-span-2">
                <Label className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
                  Teléfono
                </Label>
                <Input
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  placeholder="+1 555-0199"
                  className="bg-slate-950 border-white/10 text-white rounded-xl focus:ring-indigo-500"
                />
              </div>

              {/* Autocomplete de dirección en EE.UU. */}
              <div className="space-y-1.5 md:col-span-2">
                <Label className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
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
                <Label className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
                  Suite / Oficina / Unidad (Opcional)
                </Label>
                <Input
                  value={formData.streetLine2}
                  onChange={(e) => setFormData({ ...formData, streetLine2: e.target.value })}
                  placeholder="Apt 2B"
                  className="bg-slate-950 border-white/10 text-white rounded-xl focus:ring-indigo-500"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
                  Ciudad / Localidad
                </Label>
                <Input
                  value={formData.city}
                  onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                  placeholder="Miami"
                  className="bg-slate-950 border-white/10 text-white rounded-xl focus:ring-indigo-500"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
                  Estado
                </Label>
                <select
                  value={formData.state}
                  onChange={(e) => setFormData({ ...formData, state: e.target.value })}
                  className="flex h-9 w-full rounded-xl border border-white/10 bg-slate-950 text-white px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
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
                <Label className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
                  Código Postal (ZIP Code)
                </Label>
                <Input
                  value={formData.zipCode}
                  onChange={(e) => setFormData({ ...formData, zipCode: e.target.value })}
                  placeholder="33101"
                  className="bg-slate-950 border-white/10 text-white rounded-xl focus:ring-indigo-500"
                />
              </div>
            </div>

            {editingUser && (
              <div className="flex items-center gap-3 pt-2">
                <input
                  type="checkbox"
                  id="isActiveUserCheck"
                  checked={formData.isActive}
                  onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                  className="size-4 rounded border-slate-700 bg-slate-950 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                />
                <Label
                  htmlFor="isActiveUserCheck"
                  className="text-slate-300 text-sm font-semibold select-none cursor-pointer"
                >
                  {t('adminUsers.labelActive')}
                </Label>
              </div>
            )}
            <DialogFooter className="pt-4 border-t border-white/5">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setModalOpen(false)}
                className="text-slate-400 hover:text-white rounded-xl"
              >
                {t('adminUsers.cancelBtn')}
              </Button>
              <Button
                type="submit"
                disabled={submitting}
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-xl shadow-lg shadow-indigo-500/20"
              >
                {submitting ? t('adminUsers.savingBtn') : t('adminUsers.saveBtn')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <DialogContent className="bg-slate-900 text-white border border-white/10 rounded-2xl max-w-md shadow-2xl">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold flex items-center gap-2 text-rose-500">
              <ShieldAlert className="size-6 text-rose-500 animate-bounce" />
              {t('adminUsers.deleteTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="py-2 text-sm text-slate-300">
            {t('adminUsers.deleteConfirm').replace(
              '{name}',
              `${deleteTarget?.firstName || ''} ${deleteTarget?.lastName || ''}`.trim(),
            )}
            <br />
            <br />
            {t('adminUsers.deleteWarning')}
          </div>
          <DialogFooter className="pt-4 border-t border-white/5">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              className="text-slate-400 hover:text-white rounded-xl"
            >
              {t('adminUsers.cancelBtn')}
            </Button>
            <Button
              type="button"
              disabled={deleting}
              onClick={executeDelete}
              className="bg-rose-600 hover:bg-rose-700 text-white font-semibold rounded-xl shadow-lg shadow-rose-500/20"
            >
              {deleting ? t('adminUsers.deletingBtn') : t('adminUsers.deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
