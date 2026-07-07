'use client';

import { motion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { type TypeSectionConfig, sectionVariants } from '@/lib/constants/account-tree';
import { AccountTreeRow } from '@/components/accounts/AccountTreeRow';
import type { GlAccount as GlAccountType } from '@/components/spa/accounts/AccountFormClientDialog';
import { useLanguageStore } from '@/store/language-store';

export interface AccountTypeSectionProps {
  config: TypeSectionConfig;
  typeAccounts: GlAccountType[];
  sectionIndex: number;
  collapsedTypes: Set<string>;
  onToggleTypeSection: (key: string) => void;
  expandedIds: Set<string>;
  childrenMap: Map<string, GlAccountType[]>;
  onToggleExpand: (id: string) => void;
  onOpenEdit: (account: GlAccountType) => void;
  onToggleActive: (account: GlAccountType) => void;
  onDeleteClick: (account: GlAccountType) => void;
}

export function AccountTypeSection({
  config,
  typeAccounts,
  sectionIndex,
  collapsedTypes,
  onToggleTypeSection,
  expandedIds,
  childrenMap,
  onToggleExpand,
  onOpenEdit,
  onToggleActive,
  onDeleteClick,
}: AccountTypeSectionProps) {
  const t = useLanguageStore((s) => s.t);
  const typeLabel = t(config.i18nKey);
  const isCollapsed = collapsedTypes.has(config.key);
  const Icon = config.icon;
  const rootAccounts = typeAccounts
    .filter((a) => !a.parentId)
    .sort((a, b) => a.code.localeCompare(b.code));
  const accountCount = typeAccounts.length;

  return (
    <motion.div
      custom={sectionIndex}
      variants={sectionVariants}
      initial="hidden"
      animate="visible"
      layout
    >
      <Collapsible open={!isCollapsed} onOpenChange={() => onToggleTypeSection(config.key)}>
        <div className={cn('rounded-xl border overflow-hidden', config.accentBorder)}>
          {/* Section header */}
          <CollapsibleTrigger asChild>
            <button
              className={cn(
                'w-full flex items-center gap-3 px-4 py-3 transition-colors',
                'hover:opacity-90 cursor-pointer',
                config.accentBg,
                config.accentText,
              )}
            >
              <div className={cn('rounded-lg p-1.5 bg-white/20')}>
                <Icon className="size-4" />
              </div>
              <div className="flex-1 text-left">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-sm tracking-wide uppercase">{typeLabel}</span>
                  <Badge className="bg-white/25 text-white border-0 text-[11px] font-medium">
                    {accountCount}
                  </Badge>
                </div>
              </div>
              <motion.div
                animate={{ rotate: isCollapsed ? 0 : 180 }}
                transition={{ duration: 0.2 }}
              >
                <ChevronDown className="size-5" />
              </motion.div>
            </button>
          </CollapsibleTrigger>

          {/* Section content */}
          <CollapsibleContent>
            <div className="p-2 space-y-0.5 bg-muted/20">
              {rootAccounts.map((account, i) => (
                <AccountTreeRow
                  key={account.id}
                  account={account}
                  depth={0}
                  index={i}
                  config={config}
                  expandedIds={expandedIds}
                  childrenMap={childrenMap}
                  onToggleExpand={onToggleExpand}
                  onOpenEdit={onOpenEdit}
                  onToggleActive={onToggleActive}
                  onDeleteClick={onDeleteClick}
                />
              ))}
              {rootAccounts.length === 0 && typeAccounts.length === 0 && (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  {t('common.noData')}
                </div>
              )}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </motion.div>
  );
}
