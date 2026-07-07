'use client';

import { useRouter, usePathname } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { navItems, settingsItem } from '@/lib/constants/app-navigation';
import { useAuthStore, type ViewName } from '@/store/auth-store';
import { useLanguageStore } from '@/store/language-store';

export function DesktopNavItems({ collapsed }: { collapsed: boolean }) {
  const t = useLanguageStore((s) => s.t);
  const router = useRouter();
  const pathname = usePathname();
  const currentView = useAuthStore((s) => s.currentView);
  const setCurrentView = useAuthStore((s) => s.setCurrentView);

  const setAiAssistantOpen = useAuthStore((s) => s.setAiAssistantOpen);
  const allItems = [...navItems, settingsItem];

  function handleNav(view: ViewName) {
    if (view === 'accounts') {
      router.push('/accounts');
    } else {
      if (pathname !== '/') {
        router.push('/');
      }
      setCurrentView(view);
    }
  }

  return (
    <TooltipProvider delayDuration={400}>
      {allItems.map((item) => {
        const isActive =
          item.view === 'accounts'
            ? pathname === '/accounts'
            : pathname === '/' && currentView === item.view;
        return (
          <Tooltip key={item.view}>
            <TooltipTrigger asChild>
              <button
                onClick={() => handleNav(item.view)}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  collapsed ? 'justify-center' : 'w-full',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <item.icon className="size-4 shrink-0" />
                {!collapsed && t(item.labelKey)}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>{t(item.tooltipKey)}</p>
            </TooltipContent>
          </Tooltip>
        );
      })}
      {/* AI Assistant Button */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => setAiAssistantOpen(true)}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-purple-500/10 hover:text-purple-500 transition-colors',
              collapsed ? 'justify-center' : 'w-full',
            )}
          >
            <Sparkles className="size-4 shrink-0" />
            {!collapsed && t('aiAssistant.title')}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          <p>{t('sidebar.aiAssistantTooltip')}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
