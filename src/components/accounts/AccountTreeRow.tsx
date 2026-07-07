'use client';

import { motion } from 'framer-motion';
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Folder,
  Lock,
  Pencil,
  Trash2,
  Power,
  PowerOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import {
  type TypeSectionConfig,
  CODE_COLORS,
  LINE_COLORS,
  rowVariants,
  fmtCurrency,
} from '@/lib/constants/account-tree';
import type { GlAccount as GlAccountType } from '@/components/spa/accounts/AccountFormClientDialog';
import { useLanguageStore } from '@/store/language-store';

export interface AccountTreeRowProps {
  account: GlAccountType;
  depth: number;
  index: number;
  config: TypeSectionConfig;
  expandedIds: Set<string>;
  childrenMap: Map<string, GlAccountType[]>;
  onToggleExpand: (id: string) => void;
  onOpenEdit: (account: GlAccountType) => void;
  onToggleActive: (account: GlAccountType) => void;
  onDeleteClick: (account: GlAccountType) => void;
}

export function AccountTreeRow({
  account,
  depth,
  index,
  config,
  expandedIds,
  childrenMap,
  onToggleExpand,
  onOpenEdit,
  onToggleActive,
  onDeleteClick,
}: AccountTreeRowProps) {
  const t = useLanguageStore((s) => s.t);
  const hasChildren = (account._count?.children ?? 0) > 0;
  const isExpanded = expandedIds.has(account.id);
  const children = childrenMap.get(account.id) ?? [];
  const isRoot = depth === 0;

  return (
    <motion.div
      custom={index}
      variants={rowVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      layout
    >
      <Collapsible open={isExpanded} onOpenChange={() => onToggleExpand(account.id)}>
        <div
          className={cn(
            'group flex items-center gap-2 rounded-md px-3 py-2 transition-colors cursor-pointer select-none',
            'hover:bg-muted/60',
            !account.isActive && 'opacity-50',
            depth > 0 && 'ml-1',
          )}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onOpenEdit(account);
          }}
        >
          {/* Tree indentation + connection line */}
          {depth > 0 && (
            <div className="shrink-0 flex items-center">
              <div
                className={cn(
                  'border-l-2 rounded-l',
                  LINE_COLORS[config.key] ?? 'border-muted-foreground/30',
                )}
                style={{ height: '20px', marginLeft: `${(depth - 1) * 24}px` }}
              />
            </div>
          )}

          {/* Expand arrow or spacer */}
          <div className="shrink-0 w-6">
            {hasChildren ? (
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="icon" className="size-6 p-0">
                  {isExpanded ? (
                    <ChevronDown className="size-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-3.5 text-muted-foreground" />
                  )}
                </Button>
              </CollapsibleTrigger>
            ) : (
              <div className="w-6" />
            )}
          </div>

          {/* Folder icon for parent accounts */}
          <div className="shrink-0 w-4">
            {hasChildren ? (
              isExpanded ? (
                <FolderOpen className="size-4 text-muted-foreground" />
              ) : (
                <Folder className="size-4 text-muted-foreground" />
              )
            ) : null}
          </div>

          {/* Code */}
          <span
            className={cn(
              'font-mono text-sm font-semibold min-w-[60px] shrink-0',
              CODE_COLORS[config.key] ?? 'text-muted-foreground',
            )}
          >
            {account.code}
          </span>

          {/* Name */}
          <span
            className={cn('flex-1 truncate', isRoot ? 'font-semibold' : 'font-medium text-sm')}
          >
            {account.isSystem && (
              <Lock className="inline size-3 mr-1 text-amber-500" aria-label="System account" />
            )}
            {account.name}
          </span>

          {/* Balance / Importe */}
          <span className="font-mono text-sm text-right min-w-[90px] hidden sm:inline mr-2 text-muted-foreground">
            {fmtCurrency(account.balance ?? 0)}
          </span>

          {/* Account Type */}
          <span className="hidden md:inline mr-2">
            <Badge
              variant="outline"
              className={cn(
                'text-[10px] px-1.5 py-0 capitalize font-medium',
                config.iconColor,
                config.iconBg,
                config.accentBorder,
              )}
            >
              {t(`accounts.${account.accountType}`)}
            </Badge>
          </span>

          {/* Status badge */}
          {!account.isActive && (
            <div className="shrink-0 hidden sm:block mr-2">
              <Badge
                variant="secondary"
                className="text-[10px] px-1.5 py-0 bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
              >
                {t('common.inactive')}
              </Badge>
            </div>
          )}

          {/* Actions */}
          <div className="shrink-0 flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'size-7 transition-colors',
                account.isActive
                  ? 'text-emerald-500 hover:text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/30'
                  : 'text-amber-500 hover:text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/30',
              )}
              onClick={(e) => {
                e.stopPropagation();
                onToggleActive(account);
              }}
              title={account.isActive ? t('accounts.deactivate') : t('accounts.activate')}
            >
              {account.isActive ? (
                <Power className="size-3.5" />
              ) : (
                <PowerOff className="size-3.5" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={(e) => {
                e.stopPropagation();
                onOpenEdit(account);
              }}
            >
              <Pencil className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'size-7 transition-colors',
                account.isSystem
                  ? 'text-zinc-500/60 dark:text-zinc-400/50 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                  : 'text-red-500 hover:text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30',
              )}
              onClick={(e) => {
                e.stopPropagation();
                onDeleteClick(account);
              }}
              title={account.isSystem ? 'System account' : t('common.delete')}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>

        {/* Children */}
        {hasChildren && (
          <CollapsibleContent>
            {children.map((child, childIndex) => (
              <AccountTreeRow
                key={child.id}
                account={child}
                depth={depth + 1}
                index={index + childIndex + 1}
                config={config}
                expandedIds={expandedIds}
                childrenMap={childrenMap}
                onToggleExpand={onToggleExpand}
                onOpenEdit={onOpenEdit}
                onToggleActive={onToggleActive}
                onDeleteClick={onDeleteClick}
              />
            ))}
          </CollapsibleContent>
        )}
      </Collapsible>
    </motion.div>
  );
}
