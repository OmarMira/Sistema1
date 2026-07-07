'use client';

import { useRef } from 'react';
import { Upload, CheckCircle2, ArrowDownToLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLanguageStore } from '@/store/language-store';
import { formatFileSize } from '@/lib/types/backup';
import { toast } from 'sonner';

interface RestoreDropZoneProps {
  restoreFile: File | null;
  onFileSelect: (file: File | null) => void;
  onRestoreClick: () => void;
}

export function RestoreDropZone({ restoreFile, onFileSelect, onRestoreClick }: RestoreDropZoneProps) {
  const t = useLanguageStore((s) => s.t);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (dropRef.current) {
      dropRef.current.classList.add('border-primary', 'bg-primary/5');
    }
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (dropRef.current) {
      dropRef.current.classList.remove('border-primary', 'bg-primary/5');
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (dropRef.current) {
      dropRef.current.classList.remove('border-primary', 'bg-primary/5');
    }
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.json')) {
      onFileSelect(file);
    } else {
      toast.error(t('settings.backup.errorInvalidFile'));
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      onFileSelect(file);
    }
  }

  return (
    <>
      <div
        ref={dropRef}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`
          flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-6 cursor-pointer transition-colors
          ${
            restoreFile
              ? 'border-emerald-300 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/20'
              : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50'
          }
        `}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleFileSelect}
          className="hidden"
        />
        {restoreFile ? (
          <>
            <div className="flex size-10 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900">
              <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium">{restoreFile.name}</p>
              <p className="text-xs text-muted-foreground">
                {formatFileSize(restoreFile.size)}
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="flex size-10 items-center justify-center rounded-full bg-muted">
              <Upload className="size-5 text-muted-foreground" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium">{t('settings.backup.selectFile')}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {t('settings.backup.dragDrop')}
              </p>
            </div>
          </>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {t('settings.backup.supportedFormats')}
      </p>

      {restoreFile && (
        <div className="flex gap-2">
          <Button
            onClick={() => {
              onFileSelect(null);
              if (fileInputRef.current) fileInputRef.current.value = '';
            }}
            variant="outline"
            size="sm"
          >
            {t('common.cancel')}
          </Button>
          <Button
            onClick={onRestoreClick}
            variant="destructive"
            size="sm"
          >
            <ArrowDownToLine className="size-4 mr-1" />
            {t('settings.backup.restoreBackup')}
          </Button>
        </div>
      )}
    </>
  );
}
