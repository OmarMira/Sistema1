'use client';

import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { logger } from '@/lib/logger';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class FlowErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
  };

  public static getDerivedStateFromError(_: Error): State {
    return { hasError: true };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    logger.error('FlowErrorBoundary caught an error:', { error: String(error), componentStack: String(errorInfo) });
  }

  public render() {
    if (this.state.hasError) {
      return (
        <Card className="border-rose-500/20 bg-rose-500/[0.01]">
          <CardContent className="flex items-center gap-3 p-5 text-sm text-rose-600 dark:text-rose-400">
            <AlertCircle className="size-5 shrink-0" />
            <div>
              <p className="font-semibold">Error al cargar el panel de flujo contable</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Ocurrió un fallo en el procesamiento de datos. Los demás paneles del dashboard
                siguen operativos.
              </p>
            </div>
          </CardContent>
        </Card>
      );
    }

    return this.props.children;
  }
}
