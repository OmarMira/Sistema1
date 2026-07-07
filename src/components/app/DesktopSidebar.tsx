'use client';

import { ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { DesktopNavItems } from '@/components/app/DesktopNavItems';
import { useLanguageStore } from '@/store/language-store';

export function DesktopSidebar({
  collapsed,
  onToggle,
  onOpenWorkflow,
}: {
  collapsed: boolean;
  onToggle: () => void;
  onOpenWorkflow?: () => void;
}) {
  const t = useLanguageStore((s) => s.t);
  return (
    <aside
      className={cn(
        'hidden lg:flex flex-col border-r bg-card transition-all duration-300 shrink-0',
        collapsed ? 'w-16' : 'w-64',
      )}
    >
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onOpenWorkflow}
              className={cn(
                'flex h-14 items-center hover:bg-accent/50 transition-colors text-left focus:outline-hidden cursor-pointer',
                collapsed ? 'justify-center px-2' : 'gap-2 px-4 w-full',
              )}
            >
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm">
                AE
              </div>
              {!collapsed && (
                <span className="text-lg font-semibold tracking-tight truncate">
                  AccountExpress
                </span>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            <p>{t('sidebar.logoTooltip')}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <Separator />

      <ScrollArea className="flex-1 py-2">
        <nav className="space-y-1 px-2">
          <DesktopNavItems collapsed={collapsed} />
        </nav>
      </ScrollArea>

      <Separator />

      <div className="p-2">
        <button
          onClick={onToggle}
          className="flex w-full items-center justify-center rounded-lg py-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <ChevronLeft className={cn('size-4 transition-transform', collapsed && 'rotate-180')} />
        </button>
      </div>
    </aside>
  );
}
