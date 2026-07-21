'use client';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import type { ReadinessForm, SourceOption, TrustPolicyOption } from '@/lib/readiness/default-readiness-profile';

interface ReadinessCriteriaFormProps {
  draftForm: ReadinessForm;
  onFieldChange: (field: keyof ReadinessForm, value: string) => void;
  onApply: () => void;
  loading: boolean;
  t: (key: string) => string;
}

const SOURCE_OPTIONS: SourceOption[] = ['ALL', 'IMPORT', 'APPLY_ALL'];
const TRUST_OPTIONS: TrustPolicyOption[] = ['TRUSTED_ONLY', 'INCLUDE_LEGACY_IMPORT', 'INCLUDE_UNTRUSTED_HISTORY'];

export default function ReadinessCriteriaForm({
  draftForm,
  onFieldChange,
  onApply,
  loading,
  t,
}: ReadinessCriteriaFormProps) {
  return (
    <div className="rounded-2xl border shadow-sm bg-card text-card-foreground p-6 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('admin.readiness.source')}</label>
          <Select
            value={draftForm.source}
            onValueChange={(v) => onFieldChange('source', v)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOURCE_OPTIONS.map((opt) => (
                <SelectItem key={opt} value={opt}>{opt}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('admin.readiness.trustPolicy')}</label>
          <Select
            value={draftForm.trustPolicy}
            onValueChange={(v) => onFieldChange('trustPolicy', v)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRUST_OPTIONS.map((opt) => (
                <SelectItem key={opt} value={opt}>{opt}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('admin.readiness.from')}</label>
          <input
            type="date"
            value={draftForm.from ?? ''}
            onChange={(e) => onFieldChange('from', e.target.value)}
            className="flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('admin.readiness.to')}</label>
          <input
            type="date"
            value={draftForm.to ?? ''}
            onChange={(e) => onFieldChange('to', e.target.value)}
            className="flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
      </div>

      <Accordion type="single" collapsible className="w-full">
        <AccordionItem value="thresholds">
          <AccordionTrigger>{t('admin.readiness.thresholds')}</AccordionTrigger>
          <AccordionContent>
            <div className="space-y-4 pt-2">
              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-2">{t('admin.readiness.sample')}</p>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">minEvaluatedTxs</label>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={draftForm.minimumEvaluatedTransactions}
                      onChange={(e) => onFieldChange('minimumEvaluatedTransactions', e.target.value)}
                      className="flex h-9 w-full rounded-xl border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">minBatches</label>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={draftForm.minimumBatches}
                      onChange={(e) => onFieldChange('minimumBatches', e.target.value)}
                      className="flex h-9 w-full rounded-xl border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    />
                  </div>
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-2">{t('admin.readiness.quality')}</p>
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">minAgree</label>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      value={draftForm.minimumAgreementRate}
                      onChange={(e) => onFieldChange('minimumAgreementRate', e.target.value)}
                      className="flex h-9 w-full rounded-xl border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">maxDiv</label>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      value={draftForm.maximumDivergenceRate}
                      onChange={(e) => onFieldChange('maximumDivergenceRate', e.target.value)}
                      className="flex h-9 w-full rounded-xl border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">maxAmb</label>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      value={draftForm.maximumAmbiguityRate}
                      onChange={(e) => onFieldChange('maximumAmbiguityRate', e.target.value)}
                      className="flex h-9 w-full rounded-xl border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    />
                  </div>
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-2">{t('admin.readiness.integrity')}</p>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">maxError</label>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      value={draftForm.maximumErrorRate}
                      onChange={(e) => onFieldChange('maximumErrorRate', e.target.value)}
                      className="flex h-9 w-full rounded-xl border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">maxInvalid</label>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      value={draftForm.maximumInvalidRecordRate}
                      onChange={(e) => onFieldChange('maximumInvalidRecordRate', e.target.value)}
                      className="flex h-9 w-full rounded-xl border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    />
                  </div>
                </div>
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <div className="flex justify-end">
        <Button onClick={onApply} disabled={loading}>
          {t('admin.readiness.apply')}
        </Button>
      </div>
    </div>
  );
}
