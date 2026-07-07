'use client';

import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Activity, Search, Loader2, Calendar, Building, User, Info } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { formatDate } from '@/lib/format';

interface UserDetail {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

interface CompanyDetail {
  id: string;
  legalName: string;
}

interface AuditLog {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  details: string | null;
  createdAt: string;
  user: UserDetail | null;
  company: CompanyDetail | null;
}

import { useLanguageStore } from '@/store/language-store';
import { logger } from '@/lib/logger';

export default function AdminAuditLogsPage() {
  const t = useLanguageStore((s) => s.t);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/audit-logs');
      if (res.ok) {
        const data = await res.json();
        setLogs(data.auditLogs || []);
      }
    } catch (err) {
      logger.error(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  const filteredLogs = logs.filter((log) => {
    const q = searchQuery.toLowerCase();
    const action = log.action.toLowerCase();
    const entity = log.entity.toLowerCase();
    const details = (log.details || '').toLowerCase();
    const userEmail = log.user?.email.toLowerCase() || '';
    const userFullName = `${log.user?.firstName || ''} ${log.user?.lastName || ''}`.toLowerCase();
    const companyName = log.company?.legalName.toLowerCase() || '';

    return (
      action.includes(q) ||
      entity.includes(q) ||
      details.includes(q) ||
      userEmail.includes(q) ||
      userFullName.includes(q) ||
      companyName.includes(q)
    );
  });

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="p-6 bg-card text-card-foreground rounded-2xl border shadow-sm flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground flex items-center gap-3">
            <Activity className="size-8 text-indigo-600 animate-pulse" />
            {t('adminAuditLogs.title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t('adminAuditLogs.subtitle')}</p>
        </div>
      </div>

      {/* Search Filter */}
      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-5 text-muted-foreground" />
        <Input
          placeholder={t('adminAuditLogs.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-11 rounded-xl bg-card border-input text-foreground placeholder-muted-foreground focus:ring-2 focus:ring-indigo-500"
        />
      </div>

      {/* Logs Table / List */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <Loader2 className="size-10 text-indigo-500 animate-spin" />
          <p className="text-muted-foreground text-sm">{t('adminAuditLogs.loading')}</p>
        </div>
      ) : filteredLogs.length > 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-6 bg-card text-card-foreground rounded-2xl border shadow-sm overflow-hidden"
        >
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="min-w-full divide-y divide-border">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-6 py-3.5 text-left text-xs font-bold text-muted-foreground uppercase tracking-wider">
                    {t('adminAuditLogs.thTimestamp')}
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-bold text-muted-foreground uppercase tracking-wider">
                    {t('adminAuditLogs.thUser')}
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-bold text-muted-foreground uppercase tracking-wider">
                    {t('adminAuditLogs.thAction')}
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-bold text-muted-foreground uppercase tracking-wider">
                    {t('adminAuditLogs.thCompany')}
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-bold text-muted-foreground uppercase tracking-wider">
                    {t('adminAuditLogs.thDetails')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-card">
                {filteredLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-muted/20 transition-all text-sm">
                    {/* Timestamp */}
                    <td className="px-6 py-4 whitespace-nowrap text-foreground/80 font-mono text-xs">
                      <div className="flex items-center gap-1.5">
                        <Calendar className="size-3.5 text-muted-foreground" />
                        {formatDate(log.createdAt)}
                      </div>
                    </td>

                    {/* User */}
                    <td className="px-6 py-4 whitespace-nowrap">
                      {log.user ? (
                        <div className="flex items-center gap-2">
                          <User className="size-3.5 text-indigo-600 dark:text-indigo-400" />
                          <div>
                            <div className="font-semibold text-foreground">
                              {log.user.firstName} {log.user.lastName}
                            </div>
                            <div className="text-xs text-muted-foreground">{log.user.email}</div>
                          </div>
                        </div>
                      ) : (
                        <span className="text-muted-foreground italic">{t('adminAuditLogs.systemAnonymous')}</span>
                      )}
                    </td>

                    {/* Action / Entity */}
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="font-mono text-xs text-indigo-700 dark:text-indigo-400 font-bold bg-indigo-500/10 border border-indigo-500/20 px-2 py-1 rounded-md inline-block">
                        {log.action}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {t('adminAuditLogs.entityLabel')} {log.entity}
                      </div>
                    </td>

                    {/* Company */}
                    <td className="px-6 py-4 whitespace-nowrap">
                      {log.company ? (
                        <div className="flex items-center gap-1.5 text-foreground/80">
                          <Building className="size-3.5 text-muted-foreground" />
                          <span>{log.company.legalName}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground italic">-</span>
                      )}
                    </td>

                    {/* Details */}
                    <td className="px-6 py-4 max-w-xs truncate text-foreground/80">
                      <div className="flex items-center gap-1.5">
                        <Info className="size-3.5 text-muted-foreground shrink-0" />
                        <span className="truncate">{log.details || '-'}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </motion.div>
      ) : (
        <div className="flex flex-col items-center justify-center py-20 bg-muted/20 rounded-2xl border border-border">
          <Activity className="size-16 text-muted-foreground/60 mb-4" />
          <p className="text-muted-foreground">{t('adminAuditLogs.noLogs')}</p>
        </div>
      )}
    </div>
  );
}
