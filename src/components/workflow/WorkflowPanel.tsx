'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import {
  ClipboardList,
  Landmark,
  Upload,
  Sliders,
  CheckCheck,
  Receipt,
  BarChart3,
  CheckCircle2,
  Lock,
  PlayCircle,
  Loader2,
} from 'lucide-react';
import { useAuthStore, type ViewName } from '@/store/auth-store';
import { useLanguageStore } from '@/store/language-store';
import { cn } from '@/lib/utils';
import { logger } from '@/lib/logger';

interface WorkflowPanelProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface NodeDefinition {
  key: string;
  view: ViewName;
  step: number;
  icon: React.ComponentType<{ className?: string }>;
  x: number;
  y: number;
  width: number;
  height: number;
}

// 4-Column Layout coordinates
// Col 1: Configuración (x=10)
// Col 2: Registro (x=230)
// Col 3: Conciliación (x=450)
// Col 4: Reportes (x=670)
const nodes: NodeDefinition[] = [
  {
    key: 'accounts',
    view: 'accounts',
    step: 1,
    icon: ClipboardList,
    x: 10,
    y: 20,
    width: 190,
    height: 80,
  },
  {
    key: 'banks',
    view: 'banks',
    step: 2,
    icon: Landmark,
    x: 10,
    y: 130,
    width: 190,
    height: 80,
  },
  {
    key: 'import',
    view: 'import',
    step: 3,
    icon: Upload,
    x: 230,
    y: 20,
    width: 190,
    height: 80,
  },
  {
    key: 'rules',
    view: 'bank-rules',
    step: 4,
    icon: Sliders,
    x: 230,
    y: 130,
    width: 190,
    height: 80,
  },
  {
    key: 'reconciliation',
    view: 'reconciliation',
    step: 5,
    icon: CheckCheck,
    x: 450,
    y: 20,
    width: 190,
    height: 80,
  },
  {
    key: 'journal',
    view: 'journal',
    step: 6,
    icon: Receipt,
    x: 450,
    y: 130,
    width: 190,
    height: 80,
  },
  {
    key: 'reports',
    view: 'reports',
    step: 7,
    icon: BarChart3,
    x: 670,
    y: 75,
    width: 190,
    height: 80,
  },
];

export function WorkflowPanel({ open, onOpenChange }: WorkflowPanelProps = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const setCurrentView = useAuthStore((s) => s.setCurrentView);
  const companyId = activeCompany?.id;
  const t = useLanguageStore((s) => s.t);

  const [status, setStatus] = useState<Record<string, { completed: boolean; count: number }>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (companyId) {
      const fetchStatus = async () => {
        setLoading(true);
        try {
          const res = await fetch(`/api/dashboard/workflow-status?companyId=${companyId}`);
          if (res.ok) {
            const data = await res.json();
            setStatus(data);
          }
        } catch (err) {
          logger.error('Error fetching workflow status:', { error: String(err) });
        } finally {
          setStatus((prev) => prev);
          setLoading(false);
        }
      };
      fetchStatus();
    }
  }, [companyId]);

  const stepsOrder = [
    'accounts',
    'banks',
    'import',
    'rules',
    'reconciliation',
    'journal',
    'reports',
  ];
  const activeStepKey = stepsOrder.find((key) => !status[key]?.completed) || 'reports';

  const handleNodeClick = (nodeKey: string, view: ViewName) => {
    const stepStatus = status[nodeKey];
    const isCompleted = stepStatus?.completed;
    const isActive = activeStepKey === nodeKey;
    const isLocked = !isCompleted && !isActive;

    if (isLocked) {
      return; // Do not leave the page if card is locked
    }

    if (view === 'accounts') {
      router.push('/accounts');
    } else {
      if (pathname !== '/') {
        router.push('/');
      }
      setCurrentView(view);
    }
    if (onOpenChange) {
      onOpenChange(false);
    }
  };

  const getPathColor = (sourceKey: string, targetKey: string) => {
    const sourceCompleted = status[sourceKey]?.completed;
    const isTargetActive = activeStepKey === targetKey;

    if (sourceCompleted) {
      return 'stroke-emerald-500 stroke-[2] drop-shadow-[0_0_2px_rgba(16,185,129,0.5)]';
    }
    if (isTargetActive) {
      return 'stroke-amber-500 stroke-[2] animate-flow drop-shadow-[0_0_3px_rgba(245,158,11,0.5)]';
    }
    return 'stroke-muted-foreground/20 stroke-[1.5] dark:stroke-zinc-700/60';
  };

  const getPathMarker = (sourceKey: string, targetKey: string) => {
    const sourceCompleted = status[sourceKey]?.completed;
    const isTargetActive = activeStepKey === targetKey;

    if (sourceCompleted) {
      return 'url(#arrow-completed)';
    }
    if (isTargetActive) {
      return 'url(#arrow-active)';
    }
    return 'url(#arrow-locked)';
  };

  // Orthogonal step-lines centered in the gaps
  // Gap widths: 30px (e.g. 200 to 230, middle at 215)
  // Arrow heads offset ends by 6px to avoid overlaying card borders
  const connections = [
    { source: 'accounts', target: 'import', d: 'M 200 60 H 224' },
    { source: 'banks', target: 'import', d: 'M 200 170 H 215 V 60 H 224' },
    { source: 'import', target: 'rules', d: 'M 325 100 V 124' },
    { source: 'import', target: 'reconciliation', d: 'M 420 60 H 444' },
    { source: 'rules', target: 'reconciliation', d: 'M 420 170 H 435 V 60 H 444' },
    { source: 'rules', target: 'journal', d: 'M 420 170 H 444' },
    { source: 'reconciliation', target: 'journal', d: 'M 545 100 V 124' },
    { source: 'journal', target: 'reports', d: 'M 640 170 H 655 V 115 H 664' },
  ];

  return (
    <div className="w-full flex flex-col gap-5 max-h-[calc(100vh-100px)] overflow-hidden bg-background">
      <div className="pb-4 border-b border-border/30">
        <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-primary to-indigo-500 bg-clip-text text-transparent">
          {t('workflow.title')}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">{t('workflow.subtitle')}</p>
      </div>

      {!companyId ? (
        <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground flex-1">
          <Landmark className="size-12 mb-4 text-muted-foreground/50" />
          <p>{t('workflow.selectCompany')}</p>
        </div>
      ) : loading && Object.keys(status).length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 flex-1">
          <Loader2 className="size-8 animate-spin text-primary mb-2" />
          <p className="text-sm text-muted-foreground">{t('workflow.loading')}</p>
        </div>
      ) : (
        <div className="py-2 w-full flex flex-col items-center justify-center flex-1 overflow-hidden">
          {/* Header row for the columns */}
          <div className="w-[870px] grid grid-cols-4 gap-6 mb-2">
            <div className="text-center">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80 bg-background/90 px-3 py-1 rounded-full border border-border/50 shadow-xs">
                {t('workflow.initialSetup')}
              </span>
            </div>
            <div className="text-center">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80 bg-background/90 px-3 py-1 rounded-full border border-border/50 shadow-xs">
                {t('workflow.recordTransactions')}
              </span>
            </div>
            <div className="text-center">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80 bg-background/90 px-3 py-1 rounded-full border border-border/50 shadow-xs">
                {t('workflow.reconciliationJournal')}
              </span>
            </div>
            <div className="text-center">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80 bg-background/90 px-3 py-1 rounded-full border border-border/50 shadow-xs">
                {t('workflow.reportsClose')}
              </span>
            </div>
          </div>

          {/* SVG & Cards Canvas */}
          <div className="relative w-[870px] h-[230px] shrink-0 overflow-hidden">
            {/* Connection paths */}
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <style>
                {`
                  @keyframes flow {
                    to {
                      stroke-dashoffset: -20;
                    }
                  }
                  .animate-flow {
                    stroke-dasharray: 6, 4;
                    animation: flow 1.2s linear infinite;
                  }
                `}
              </style>
              <defs>
                <marker
                  id="arrow-completed"
                  viewBox="0 0 10 10"
                  refX="6"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#10b981" />
                </marker>
                <marker
                  id="arrow-active"
                  viewBox="0 0 10 10"
                  refX="6"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#f59e0b" />
                </marker>
                <marker
                  id="arrow-locked"
                  viewBox="0 0 10 10"
                  refX="6"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path
                    d="M 0 1.5 L 8 5 L 0 8.5 z"
                    fill="#3f3f46"
                    className="dark:fill-zinc-700 fill-zinc-300"
                  />
                </marker>
              </defs>
              {connections.map((conn, idx) => (
                <g key={idx}>
                  {/* Outer track groove for visual structure */}
                  <path
                    d={conn.d}
                    fill="none"
                    className="stroke-zinc-100/10 dark:stroke-zinc-800/30 stroke-[4.5]"
                  />
                  {/* Glowing/Flowing connection line */}
                  <path
                    d={conn.d}
                    fill="none"
                    className={getPathColor(conn.source, conn.target)}
                    markerEnd={getPathMarker(conn.source, conn.target)}
                  />
                </g>
              ))}
            </svg>

            {/* Node Cards */}
            {nodes.map((node) => {
              const stepStatus = status[node.key];
              const isCompleted = stepStatus?.completed;
              const isActive = activeStepKey === node.key;
              const isLocked = !isCompleted && !isActive;
              const count = stepStatus?.count ?? 0;

              const nodeTitle = t(`workflow.${node.key}Title`);
              const nodeDescription = t(`workflow.${node.key}Desc`);

              let badgeText = t('workflow.pending');
              if (isCompleted) {
                if (node.key === 'accounts')
                  badgeText = t('workflow.accountsCount').replace('{count}', count.toString());
                else if (node.key === 'banks')
                  badgeText = t('workflow.banksCount').replace('{count}', count.toString());
                else if (node.key === 'import')
                  badgeText = t('workflow.txsCount').replace('{count}', count.toString());
                else if (node.key === 'rules')
                  badgeText = t('workflow.rulesCount').replace('{count}', count.toString());
                else if (node.key === 'reconciliation')
                  badgeText = t('workflow.reconcCount').replace('{count}', count.toString());
                else if (node.key === 'journal')
                  badgeText = t('workflow.entriesCount').replace('{count}', count.toString());
                else if (node.key === 'reports') badgeText = t('workflow.ready');
              } else if (isActive) {
                badgeText = t('workflow.nextStep');
              } else {
                badgeText = t('workflow.locked');
              }

              return (
                <button
                  key={node.key}
                  onClick={() => handleNodeClick(node.key, node.view)}
                  disabled={isLocked}
                  className={cn(
                    'absolute flex items-center gap-3 rounded-xl p-2.5 text-left border transition-all duration-300 shadow-sm',
                    isCompleted &&
                      'border-emerald-500/40 bg-emerald-500/5 hover:bg-emerald-500/10 hover:scale-[1.02] active:scale-[0.98] cursor-pointer',
                    isActive &&
                      'border-amber-500/50 bg-amber-500/10 ring-2 ring-amber-500/40 shadow-[0_0_8px_rgba(245,158,11,0.2)] hover:scale-[1.02] active:scale-[0.98] cursor-pointer',
                    isLocked && 'border-border/40 bg-muted/20 opacity-60 cursor-not-allowed',
                  )}
                  style={{
                    left: `${node.x}px`,
                    top: `${node.y}px`,
                    width: `${node.width}px`,
                    height: `${node.height}px`,
                  }}
                >
                  <div className="flex items-center gap-2.5 h-full w-full">
                    {/* Left icon wrapper */}
                    <div
                      className={cn(
                        'p-2 rounded-lg flex items-center justify-center border shrink-0',
                        isCompleted && 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500',
                        isActive &&
                          'bg-amber-500/15 border-amber-500/30 text-amber-500 shadow-inner',
                        isLocked && 'bg-muted/40 border-border/30 text-muted-foreground',
                      )}
                    >
                      <node.icon className="size-5" />
                    </div>

                    {/* Right content */}
                    <div className="flex-1 min-w-0 flex flex-col justify-between h-full py-0.5">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[8px] font-bold text-muted-foreground uppercase tracking-wider">
                          {t('workflow.step').replace('{num}', node.step.toString())}
                        </span>
                        <div className="flex items-center gap-1">
                          <span
                            className={cn(
                              'inline-flex items-center rounded-sm px-1 py-0.2 text-[7px] font-bold border uppercase tracking-wide',
                              isCompleted &&
                                'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
                              isActive &&
                                'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
                              isLocked && 'bg-muted text-muted-foreground border-border/50',
                            )}
                          >
                            {badgeText}
                          </span>
                          {isCompleted ? (
                            <CheckCircle2 className="size-3 text-emerald-500" />
                          ) : isActive ? (
                            <PlayCircle className="size-3 text-amber-500 animate-pulse" />
                          ) : (
                            <Lock className="size-2.5 text-muted-foreground/60" />
                          )}
                        </div>
                      </div>

                      <div className="mt-0.5">
                        <h4 className="text-[11px] font-bold tracking-tight text-foreground truncate">
                          {nodeTitle}
                        </h4>
                        <p className="text-[9px] text-muted-foreground truncate font-normal leading-tight mt-0.5">
                          {nodeDescription}
                        </p>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
