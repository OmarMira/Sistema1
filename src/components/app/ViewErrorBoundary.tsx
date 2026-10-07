'use client';

import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { logger } from '@/lib/logger';
import { useLanguageStore } from '@/store/language-store';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ViewErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const componentStack = errorInfo.componentStack;
    logger.error('ViewErrorBoundary caught an error:', {
      error: String(error),
      componentStack: String(componentStack),
    });
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  public render() {
    if (this.state.hasError) {
      const t = useLanguageStore.getState().t;

      return (
        <Card className="border-rose-500/20 bg-rose-500/[0.01]">
          <CardContent className="flex items-center gap-3 p-5 text-sm text-rose-600 dark:text-rose-400">
            <AlertCircle className="size-5 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{t('common.viewError')}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('common.viewErrorDesc')}</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={this.handleRetry}>
              {t('common.retry')}
            </Button>
          </CardContent>
        </Card>
      );
    }

    return this.props.children;
  }
}
