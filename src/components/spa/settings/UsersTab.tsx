'use client';

import { useState, useEffect } from 'react';
import { Users, Plus, Loader2, MoreVertical, Trash2, Mail } from 'lucide-react';
import { motion } from 'framer-motion';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
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

interface UserRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  role: string;
  isActive: boolean;
  companyRole: string;
  joinedAt: string;
}

/* ─── UsersTab ───────────────────────────────────────────────── */

export function UsersTab() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const companyId = activeCompany?.id;

  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteForm, setInviteForm] = useState({
    email: '',
    firstName: '',
    lastName: '',
    password: '',
    role: 'company_admin',
  });

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/users?companyId=${companyId}`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          setUsers(data.users || []);
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

  async function handleInvite() {
    if (
      !companyId ||
      !inviteForm.email ||
      !inviteForm.firstName ||
      !inviteForm.lastName ||
      !inviteForm.password
    )
      return;
    setInviting(true);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, ...inviteForm }),
      });
      if (res.ok) {
        const data = await res.json();
        setUsers((prev) => [
          {
            id: data.user.id,
            email: data.user.email,
            firstName: data.user.firstName,
            lastName: data.user.lastName,
            fullName: `${data.user.firstName} ${data.user.lastName}`,
            role: data.user.role,
            isActive: true,
            companyRole: data.user.role,
            joinedAt: new Date().toISOString(),
          },
          ...prev,
        ]);
        setInviteForm({
          email: '',
          firstName: '',
          lastName: '',
          password: '',
          role: 'company_admin',
        });
        setInviteOpen(false);
        toast.success(t('users.userCreated'));
      } else {
        const data = await res.json();
        toast.error(data.error || t('common.error'));
      }
    } catch {
      toast.error(t('common.error'));
    }
    setInviting(false);
  }

  function getInitials(firstName: string, lastName: string) {
    return `${firstName?.[0] ?? ''}${lastName?.[0] ?? ''}`.toUpperCase();
  }

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="space-y-6"
    >
      <motion.div variants={itemVariants}>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Users className="size-4" />
                  {t('settings.userManagement')}
                </CardTitle>
                <CardDescription className="mt-1">{t('users.inviteDesc')}</CardDescription>
              </div>
              <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
                <DialogTrigger asChild>
                  <Button size="sm">
                    <Plus className="size-3.5 mr-1" />
                    {t('users.inviteUser')}
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>{t('users.inviteTitle')}</DialogTitle>
                    <DialogDescription>{t('users.inviteDesc')}</DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 py-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <Label>{t('users.firstName')}</Label>
                        <Input
                          value={inviteForm.firstName}
                          onChange={(e) =>
                            setInviteForm((p) => ({ ...p, firstName: e.target.value }))
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t('users.lastName')}</Label>
                        <Input
                          value={inviteForm.lastName}
                          onChange={(e) =>
                            setInviteForm((p) => ({ ...p, lastName: e.target.value }))
                          }
                        />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label>{t('auth.email')}</Label>
                      <Input
                        type="email"
                        value={inviteForm.email}
                        onChange={(e) => setInviteForm((p) => ({ ...p, email: e.target.value }))}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>{t('auth.password')}</Label>
                      <Input
                        type="password"
                        value={inviteForm.password}
                        onChange={(e) => setInviteForm((p) => ({ ...p, password: e.target.value }))}
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setInviteOpen(false)}>
                      {t('common.cancel')}
                    </Button>
                    <Button
                      onClick={handleInvite}
                      disabled={
                        inviting ||
                        !inviteForm.email ||
                        !inviteForm.firstName ||
                        !inviteForm.lastName ||
                        !inviteForm.password
                      }
                    >
                      {inviting ? (
                        <>
                          <Loader2 className="size-4 mr-1 animate-spin" /> {t('settings.saving')}
                        </>
                      ) : (
                        <>
                          <Mail className="size-4 mr-1" /> {t('users.inviteUser')}
                        </>
                      )}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : users.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('users.noUsers')}</p>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="font-semibold">{t('common.name')}</TableHead>
                      <TableHead className="font-semibold">{t('auth.email')}</TableHead>
                      <TableHead className="font-semibold">{t('users.role')}</TableHead>
                      <TableHead className="font-semibold">{t('users.status')}</TableHead>
                      <TableHead className="font-semibold w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((u) => (
                      <TableRow key={u.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <Avatar className="size-8">
                              <AvatarFallback className="bg-primary/10 text-primary text-xs font-bold">
                                {getInitials(u.firstName, u.lastName)}
                              </AvatarFallback>
                            </Avatar>
                            <span className="font-medium">{u.fullName}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{u.email}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {u.role === 'super_admin'
                              ? t('users.superAdmin')
                              : t('users.companyAdmin')}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={u.isActive ? 'default' : 'secondary'}
                            className={`text-xs ${u.isActive ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : ''}`}
                          >
                            {u.isActive ? t('users.active') : t('users.inactive')}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
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
    </motion.div>
  );
}
