'use client';

import { useRouter, usePathname } from 'next/navigation';
import { LogOut, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { navItems, settingsItem } from '@/lib/constants/app-navigation';
import { useAuthStore, type ViewName } from '@/store/auth-store';
import { useLanguageStore } from '@/store/language-store';

export function SidebarNav({
  onNavigate,
  onOpenWorkflow,
}: {
  onNavigate?: () => void;
  onOpenWorkflow?: () => void;
}) {
  const t = useLanguageStore((s) => s.t);
  const router = useRouter();
  const pathname = usePathname();
  const currentView = useAuthStore((s) => s.currentView);
  const setCurrentView = useAuthStore((s) => s.setCurrentView);

  function handleNav(view: ViewName) {
    if (view === 'accounts') {
      router.push('/accounts');
    } else {
      if (pathname !== '/') {
        router.push('/');
      }
      setCurrentView(view);
    }
    onNavigate?.();
  }

  return (
    <div className="flex h-full flex-col">
      {/* Logo */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onOpenWorkflow}
              className="flex h-14 w-full items-center gap-2 px-4 hover:bg-accent/50 transition-colors text-left focus:outline-hidden cursor-pointer"
            >
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm">
                AE
              </div>
              <span className="text-lg font-semibold tracking-tight">{t('common.appName')}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            <p>{t('sidebar.logoTooltip')}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <Separator />

      {/* Nav links */}
      <TooltipProvider delayDuration={400}>
        <ScrollArea className="flex-1 py-2">
          <nav className="space-y-1 px-3">
            {navItems.map((item) => {
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
                        'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                      )}
                    >
                      <item.icon className="size-4 shrink-0" />
                      {t(item.labelKey)}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    <p>{t(item.tooltipKey)}</p>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </nav>
        </ScrollArea>

        <Separator />

        {/* AI Assistant + Settings + Logout */}
        <div className="p-3 space-y-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => useAuthStore.getState().setAiAssistantOpen(true)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-purple-500/10 hover:text-purple-500 transition-colors"
              >
                <Sparkles className="size-4 shrink-0" />
                {t('aiAssistant.title')}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>{t('sidebar.aiAssistantTooltip')}</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => handleNav('settings')}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  pathname === '/' && currentView === 'settings'
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <settingsItem.icon className="size-4 shrink-0" />
                {t(settingsItem.labelKey)}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>{t(settingsItem.tooltipKey)}</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => {
                  fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
                  useAuthStore.getState().logout();
                }}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500 transition-colors"
              >
                <LogOut className="size-4 shrink-0" />
                {t('auth.logout')}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>{t('sidebar.logoutTooltip')}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
    </div>
  );
}
