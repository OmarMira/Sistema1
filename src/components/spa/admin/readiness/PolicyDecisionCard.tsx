'use client';

import { ShieldCheck, ShieldAlert, HelpCircle, Ban, CheckCircle, XCircle, Minus } from 'lucide-react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import type { OperationalPolicyDecision } from '@/lib/operational-policy/types';
import type { CanonicalReadiness } from '@/lib/services/canonical-readiness-service';

interface PolicyDecisionCardProps {
  decision: OperationalPolicyDecision;
}

const ACTION_COLORS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  ALLOW: 'default',
  WARN: 'secondary',
  CONFIRM: 'outline',
  BLOCK: 'destructive',
};

function ActionIcon({ action }: { action: string }) {
  switch (action) {
    case 'ALLOW':
      return <ShieldCheck className="size-4 text-green-600 dark:text-green-400" />;
    case 'WARN':
      return <ShieldAlert className="size-4 text-yellow-600 dark:text-yellow-400" />;
    case 'CONFIRM':
      return <HelpCircle className="size-4 text-orange-600 dark:text-orange-400" />;
    case 'BLOCK':
      return <Ban className="size-4 text-red-600 dark:text-red-400" />;
    default:
      return null;
  }
}

function MatchedIcon({ matched }: { matched: boolean }) {
  if (matched) {
    return <CheckCircle className="size-4 text-green-600 dark:text-green-400" />;
  }
  return <Minus className="size-4 text-muted-foreground" />;
}

function ReadinessEvidenceBlock({ readiness }: { readiness: CanonicalReadiness }) {
  const metrics = readiness.metrics;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-semibold">Status:</span>
        <Badge variant={readiness.status === 'READY' ? 'default' : readiness.status === 'NOT_READY' ? 'destructive' : 'secondary'}>
          {readiness.status}
        </Badge>
      </div>
      <div className="rounded-lg border p-3">
        <p className="font-semibold mb-1">Metrics</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <span>Batches: {metrics.batches}</span>
          <span>Trusted: {metrics.trustedBatches}</span>
          <span>Legacy: {metrics.legacyBatches}</span>
          <span>Legacy Untrusted: {metrics.legacyUntrustedBatches}</span>
          <span>Total Evaluated: {metrics.totalEvaluated}</span>
          <span>Valid Comparisons: {metrics.validComparisons}</span>
          <span>Same Decision: {metrics.sameDecision}</span>
          <span>Divergent: {metrics.divergentDecision}</span>
          <span>Ambiguous: {metrics.ambiguous}</span>
          <span>Errors: {metrics.errors}</span>
        </div>
      </div>
      <div className="rounded-lg border p-3">
        <p className="font-semibold mb-1">Checks ({readiness.checks.length})</p>
        {readiness.checks.map(c => (
          <div key={c.code} className="flex items-center gap-2 text-xs">
            <span>{c.passed ? '✅' : '❌'}</span>
            <span>{c.code}: {c.actual ?? 'N/A'} {c.operator} {c.expected}</span>
          </div>
        ))}
      </div>
      {'failedChecks' in readiness && readiness.failedChecks.length > 0 && (
        <div className="rounded-lg border border-red-200 p-3">
          <p className="font-semibold mb-1 text-red-600">Failed Checks ({readiness.failedChecks.length})</p>
          {readiness.failedChecks.map(c => (
            <div key={c.code} className="text-xs">{c.code}: {c.actual ?? 'N/A'} {c.operator} {c.expected}</div>
          ))}
        </div>
      )}
      {'reasons' in readiness && readiness.reasons.length > 0 && (
        <div className="rounded-lg border p-3">
          <p className="font-semibold mb-1">Insufficient Data Reasons</p>
          {readiness.reasons.map((r) => (
            <div key={r} className="text-xs">{r}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PolicyDecisionCard({ decision }: PolicyDecisionCardProps) {
  return (
    <div className="rounded-2xl border shadow-sm bg-card text-card-foreground p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Operational Policy Decision</h3>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{decision.context}</Badge>
          <Badge variant={ACTION_COLORS[decision.action] ?? 'outline'}>
            <span className="flex items-center gap-1">
              <ActionIcon action={decision.action} />
              {decision.action}
            </span>
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-muted-foreground">Profile: </span>
          <span className="font-mono">{decision.profileId}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Version: </span>
          <span className="font-mono">{decision.profileVersion}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Reason: </span>
          <span className="font-mono">{decision.reasons.reasonCode}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Summary: </span>
          <span>{decision.reasons.summary}</span>
        </div>
      </div>

      <div className="rounded-xl border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rule</TableHead>
              <TableHead>Context</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Matched</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {decision.rules.map((rule) => (
              <TableRow key={rule.ruleId}>
                <TableCell className="font-mono text-xs">{rule.ruleId}</TableCell>
                <TableCell>{rule.context}</TableCell>
                <TableCell>{rule.readinessStatus}</TableCell>
                <TableCell>
                  <MatchedIcon matched={rule.matched} />
                </TableCell>
                <TableCell>
                  <Badge variant={ACTION_COLORS[rule.action] ?? 'outline'}>
                    {rule.action}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{rule.reasonCode}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Accordion type="single" collapsible className="w-full">
        <AccordionItem value="evidence">
          <AccordionTrigger>Raw Readiness Evidence</AccordionTrigger>
          <AccordionContent>
            <div className="text-xs space-y-3 overflow-x-auto max-h-96 overflow-y-auto">
              <ReadinessEvidenceBlock readiness={decision.readiness} />
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
