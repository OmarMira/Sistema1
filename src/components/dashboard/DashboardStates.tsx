'use client';

import React from 'react';
import { RefreshCw, Database } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface LoadingStateProps {
  mounted: boolean;
  loadingText: string;
}

export function LoadingState({ mounted, loadingText }: LoadingStateProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[450px]">
      <RefreshCw className="w-10 h-10 animate-spin text-teal-600 dark:text-teal-400 mb-4" />
      {mounted && (
        <span className="text-sm font-bold text-slate-500 uppercase tracking-widest animate-pulse">
          {loadingText}
        </span>
      )}
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  description: string;
  buttonLabel: string;
  onGoImport: () => void;
}

export function EmptyState({ title, description, buttonLabel, onGoImport }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[500px] space-y-6 text-center px-4">
      <div className="p-6 rounded-3xl bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">
        <Database className="w-16 h-16 text-slate-400 dark:text-slate-500 mx-auto" />
      </div>
      <div className="space-y-2">
        <h2 className="text-xl font-bold text-slate-900 dark:text-white">{title}</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md">{description}</p>
      </div>
      <Button
        onClick={onGoImport}
        className="bg-teal-600 hover:bg-teal-700 text-white rounded-xl px-6 py-2.5 font-bold"
      >
        {buttonLabel}
      </Button>
    </div>
  );
}
