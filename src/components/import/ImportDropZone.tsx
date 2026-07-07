'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Upload, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useLanguageStore } from '@/store/language-store';
import {
  ACCEPTED_TYPES,
  MAX_FILE_SIZE,
  FORMAT_BADGES,
  formatFileSize,
  getFileIcon,
} from '@/lib/types/import-page';

interface ImportDropZoneProps {
  files: File[];
  onFilesAdded: (files: File[]) => void;
  onRemoveFile: (index: number) => void;
  onClearFiles: () => void;
  onError: (error: string) => void;
  uploading?: boolean;
}

export function ImportDropZone({
  files,
  onFilesAdded,
  onRemoveFile,
  onClearFiles,
  onError,
  uploading = false,
}: ImportDropZoneProps) {
  const t = useLanguageStore((s) => s.t);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (files.length === 0 && fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [files.length]);

  /* ─── Drag & Drop ────────────────────────────────────────────── */

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    onError('');

    const droppedFiles = e.dataTransfer.files;
    if (droppedFiles.length > 0) {
      validateAndAddFiles(Array.from(droppedFiles));
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const inputFiles = e.target.files;
    if (inputFiles && inputFiles.length > 0) {
      validateAndAddFiles(Array.from(inputFiles));
    }
  }

  function validateAndAddFiles(newFiles: File[]) {
    const validFiles: File[] = [];
    let errorMsg = '';

    for (const file of newFiles) {
      const ext = '.' + (file.name.split('.').pop()?.toLowerCase() || '');
      if (!ACCEPTED_TYPES.includes(ext)) {
        errorMsg = `${t('common.type')}: "${ext}" — ${t('banks.supportedFormats')}`;
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        errorMsg = `${t('common.type')}: ${formatFileSize(file.size)} — ${t('banks.supportedFormats')}`;
        continue;
      }
      validFiles.push(file);
    }

    if (validFiles.length > 0) {
      onFilesAdded(validFiles);
    }
    if (errorMsg) {
      onError(errorMsg);
    }
  }

  function handleRemove(idx: number) {
    onRemoveFile(idx);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  function handleClear() {
    onClearFiles();
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  /* ─── Render ─────────────────────────────────────────────────── */

  return (
    <div
      className={cn(
        'relative rounded-xl border-2 border-dashed p-8 text-center transition-all cursor-pointer',
        isDragging
          ? 'border-primary bg-primary/5 scale-[1.01]'
          : files.length > 0
            ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/50 dark:bg-emerald-950/20'
            : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50',
        uploading && 'pointer-events-none opacity-60',
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={(e) => {
        if (uploading) return;
        if (
          (e.target as HTMLElement).tagName === 'BUTTON' ||
          (e.target as HTMLElement).closest('button')
        ) {
          return;
        }
        fileInputRef.current?.click();
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".csv,.tsv,.txt,.ofx,.qfx,.pdf"
        multiple
        onChange={handleFileInput}
      />

      {files.length > 0 ? (
        /* Selected files preview */
        <div className="flex flex-col items-center gap-4 w-full max-w-md mx-auto">
          <div className="w-full space-y-2 max-h-[200px] overflow-y-auto pr-1">
            {files.map((file, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between p-2 rounded-lg border bg-background text-left"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  {getFileIcon(file.name)}
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate max-w-[200px]">
                      {file.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatFileSize(file.size)}
                    </p>
                  </div>
                </div>
                {!uploading && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:text-red-600 shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemove(idx);
                    }}
                  >
                    <X className="size-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
          {!uploading && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-red-600"
              onClick={(e) => {
                e.stopPropagation();
                handleClear();
              }}
            >
              <X className="size-3.5 mr-1" />
              {t('importPage.clearAll')}
            </Button>
          )}
        </div>
      ) : (
        /* Empty drop zone */
        <div className="flex flex-col items-center gap-3">
          <div
            className={cn(
              'flex size-14 items-center justify-center rounded-full transition-colors',
              isDragging ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
            )}
          >
            <Upload className="size-6" />
          </div>
          <div>
            <p className="text-sm font-medium">
              {isDragging ? t('banks.dragDrop') : t('banks.dragDrop')}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {t('banks.supportedFormats')}
            </p>
          </div>
          <div className="flex items-center gap-2 mt-2">
            {FORMAT_BADGES.map((fmt) => (
              <Badge
                key={fmt.label}
                variant="outline"
                className={cn('text-xs font-bold px-3 py-1', fmt.className)}
              >
                {fmt.label}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
