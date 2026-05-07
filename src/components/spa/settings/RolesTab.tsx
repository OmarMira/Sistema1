'use client';

import {
  Shield,
  Crown,
  Building2,
  CheckCircle2,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useLanguageStore } from '@/store/language-store';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

/* ─── Animation Variants ──────────────────────────────────────── */

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.08 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

/* ─── Permission Item ─────────────────────────────────────────── */

function PermissionItem({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <CheckCircle2 className="size-3.5 text-emerald-500 shrink-0" />
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}

/* ─── RolesTab ────────────────────────────────────────────────── */

export function RolesTab() {
  const t = useLanguageStore((s) => s.t);

  const superAdminPermissions = [
    'Gestionar todas las empresas del sistema',
    'Crear, editar y eliminar usuarios',
    'Acceso completo a cuentas, pólizas y reportes',
    'Configurar períodos fiscales y respaldos',
    'Acceso al diagnóstico del sistema',
    'Gestionar roles y permisos',
  ];

  const companyAdminPermissions = [
    'Acceso completo a la empresa asignada',
    'Crear y gestionar cuentas contables',
    'Crear y registrar pólizas de diario',
    'Conciliación bancaria',
    'Generación de reportes financieros',
    'Importación de estados de cuenta',
  ];

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
            <CardTitle className="text-base flex items-center gap-2">
              <Shield className="size-4" />
              {t('settings.roles.title')}
            </CardTitle>
            <CardDescription>
              {t('settings.roles.permissions')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 md:grid-cols-2">
              {/* Super Admin */}
              <motion.div variants={itemVariants}>
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center justify-center size-10 rounded-lg bg-amber-100 dark:bg-amber-900/30">
                      <Crown className="size-5 text-amber-600 dark:text-amber-400" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-sm">{t('settings.roles.superAdmin')}</h3>
                      <p className="text-xs text-muted-foreground">{t('settings.roles.superAdminDesc')}</p>
                    </div>
                  </div>
                  <div className="border-t pt-3 space-y-0.5">
                    {superAdminPermissions.map((perm) => (
                      <PermissionItem key={perm} label={perm} />
                    ))}
                  </div>
                  <div className="flex justify-end">
                    <Badge variant="outline" className="text-xs border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400">
                      Super Admin
                    </Badge>
                  </div>
                </div>
              </motion.div>

              {/* Company Admin */}
              <motion.div variants={itemVariants}>
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center justify-center size-10 rounded-lg bg-sky-100 dark:bg-sky-900/30">
                      <Building2 className="size-5 text-sky-600 dark:text-sky-400" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-sm">{t('settings.roles.companyAdmin')}</h3>
                      <p className="text-xs text-muted-foreground">{t('settings.roles.companyAdminDesc')}</p>
                    </div>
                  </div>
                  <div className="border-t pt-3 space-y-0.5">
                    {companyAdminPermissions.map((perm) => (
                      <PermissionItem key={perm} label={perm} />
                    ))}
                  </div>
                  <div className="flex justify-end">
                    <Badge variant="outline" className="text-xs border-sky-300 text-sky-700 dark:border-sky-700 dark:text-sky-400">
                      Admin
                    </Badge>
                  </div>
                </div>
              </motion.div>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </motion.div>
  );
}
