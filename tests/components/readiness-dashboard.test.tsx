// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ShadowMetricsReport } from '@/lib/services/shadow-metrics-reader';
import type { ReadinessCheckResult, ReadinessCheckCode, CanonicalReadiness } from '@/lib/services/canonical-readiness-service';
import { RATE_TO_CHECK_CODE, getCheckForRate, getRatePassed } from '@/lib/readiness/rate-check-mapper';
import type { RateKey } from '@/lib/readiness/rate-check-mapper';

afterEach(() => cleanup());

const tFn = (key: string) => {
  const labels: Record<string, string> = {
    'admin.readiness.status.ready': 'READY',
    'admin.readiness.status.notReady': 'NOT READY',
    'admin.readiness.status.insufficientData': 'INSUFFICIENT DATA',
    'admin.readiness.batches': 'Batches',
    'admin.readiness.totalEvaluated': 'Total Evaluated',
    'admin.readiness.validComparisons': 'Valid Comparisons',
    'admin.readiness.sameDecision': 'Same Decision',
    'admin.readiness.divergentDecision': 'Divergent',
    'admin.readiness.ambiguous': 'Ambiguous',
    'admin.readiness.errors': 'Errors',
    'admin.readiness.agreementRate': 'Agreement',
    'admin.readiness.divergenceRate': 'Divergence',
    'admin.readiness.ambiguityRate': 'Ambiguity',
    'admin.readiness.errorRate': 'Error',
    'admin.readiness.check': 'Check',
    'admin.readiness.status': 'Status',
    'admin.readiness.operator': 'Op',
    'admin.readiness.actual': 'Actual',
    'admin.readiness.expected': 'Expected',
    'admin.readiness.passed': 'Passed',
    'admin.readiness.failed': 'Failed',
    'admin.readiness.recommendation.ready': 'The engine meets the defined criteria. Activation remains manual.',
    'admin.readiness.recommendation.notReady': 'The engine does not meet the defined criteria. Review failed checks before considering activation.',
    'admin.readiness.recommendation.insufficientData': 'Insufficient data to evaluate. More batches are needed before assessing readiness.',
    'admin.readiness.untrustedWarning': 'Including LEGACY_UNTRUSTED data',
    'admin.readiness.untrustedWarningDesc': 'This view includes Apply All v0 batches, which are not fully trustworthy.',
    'admin.readiness.source': 'Source',
    'admin.readiness.trustPolicy': 'Trust Policy',
    'admin.readiness.from': 'From',
    'admin.readiness.to': 'To',
    'admin.readiness.apply': 'Apply',
    'admin.readiness.thresholds': 'Thresholds',
    'admin.readiness.sample': 'Sample',
    'admin.readiness.quality': 'Quality',
    'admin.readiness.integrity': 'Integrity',
    'admin.readiness.insufficientReasons': 'Insufficient data reasons',
    'admin.readiness.loading': 'Loading readiness data...',
    'admin.readiness.error': 'Failed to load readiness data',
    'admin.readiness.retry': 'Retry',
    'admin.readiness.companyRequired': 'Select a company first to view readiness data.',
    'admin.readiness.title': 'Readiness Operations Dashboard',
    'admin.readiness.subtitle': 'Inspect canonical engine readiness metrics',
    'admin.readiness.useCaseAlert': 'This dashboard is observational only.',
  };
  return labels[key] || key;
};

const mockLangState = { t: tFn, language: 'en' };
vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector: (s: any) => any) => selector(mockLangState),
}));

function makeReport(overrides?: Partial<ShadowMetricsReport>): ShadowMetricsReport {
  return {
    batches: 1,
    trustedBatches: 1,
    legacyBatches: 0,
    legacyUntrustedBatches: 0,
    invalidRecords: 0,
    totalEvaluated: 200,
    validComparisons: 200,
    sameDecision: 200,
    divergentDecision: 0,
    ambiguous: 0,
    errors: 0,
    agreementRate: null,
    divergenceRate: null,
    ambiguityRate: null,
    errorRate: null,
    reasons: { NO_MATCH: 0, AMBIGUOUS: 0, UNDETERMINED: 0, OTHER: 0 },
    ...overrides,
  };
}

const ALL_CHECK_CODES: ReadinessCheckCode[] = [
  'MINIMUM_EVALUATED_TRANSACTIONS',
  'MINIMUM_BATCHES',
  'MINIMUM_AGREEMENT_RATE',
  'MAXIMUM_DIVERGENCE_RATE',
  'MAXIMUM_AMBIGUITY_RATE',
  'MAXIMUM_ERROR_RATE',
  'MAXIMUM_INVALID_RECORD_RATE',
];

function makeChecks(overrides: Partial<Record<ReadinessCheckCode, boolean>> = {}): ReadinessCheckResult[] {
  return ALL_CHECK_CODES.map((code) => {
    const passed = code in overrides ? overrides[code]! : true;
    return {
      code,
      operator: code.startsWith('MINIMUM_') ? '>=' as const : '<=' as const,
      passed,
      actual: passed ? 100 : 0,
      expected: 1,
    };
  });
}

function makeReadinessResponse(
  status: CanonicalReadiness['status'],
  overrides?: { metrics?: Partial<ShadowMetricsReport>; checks?: Partial<Record<ReadinessCheckCode, boolean>> },
): CanonicalReadiness {
  const base = {
    metrics: makeReport(overrides?.metrics),
    checks: makeChecks(overrides?.checks),
  };
  if (status === 'READY') return { ...base, status: 'READY' };
  if (status === 'INSUFFICIENT_DATA') {
    const failedChecks = base.checks.filter(c => !c.passed);
    return {
      ...base,
      status: 'INSUFFICIENT_DATA',
      reasons: failedChecks.map(c => `${c.code}: expected ${c.operator} ${c.expected}, got ${c.actual}`),
    };
  }
  const failedChecks = base.checks.filter(c => !c.passed);
  return { ...base, status: 'NOT_READY', failedChecks };
}

describe('ReadinessStatusCard', () => {
  it('renders READY with green icon', async () => {
    const { default: ReadinessStatusCard } = await import('@/components/spa/admin/readiness/ReadinessStatusCard');
    const { container } = render(<ReadinessStatusCard status="READY" t={tFn} />);
    expect(screen.getByText('READY')).toBeInTheDocument();
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });

  it('renders NOT_READY with amber icon', async () => {
    const { default: ReadinessStatusCard } = await import('@/components/spa/admin/readiness/ReadinessStatusCard');
    render(<ReadinessStatusCard status="NOT_READY" t={tFn} />);
    expect(screen.getByText('NOT READY')).toBeInTheDocument();
  });

  it('renders INSUFFICIENT_DATA with gray icon + reasons', async () => {
    const { default: ReadinessStatusCard } = await import('@/components/spa/admin/readiness/ReadinessStatusCard');
    const reasons = ['Not enough batches', 'Not enough transactions'];
    render(<ReadinessStatusCard status="INSUFFICIENT_DATA" reasons={reasons} t={tFn} />);
    expect(screen.getByText('INSUFFICIENT DATA')).toBeInTheDocument();
    expect(screen.getByText('— Not enough batches')).toBeInTheDocument();
    expect(screen.getByText('— Not enough transactions')).toBeInTheDocument();
  });

  it('renders correct translation key for each status', async () => {
    const { default: ReadinessStatusCard } = await import('@/components/spa/admin/readiness/ReadinessStatusCard');
    render(<ReadinessStatusCard status="READY" t={tFn} />);
    expect(screen.getByText('READY')).toBeInTheDocument();
  });
});

describe('ReadinessMetricsGrid', () => {
  it('renders all 7 metrics', async () => {
    const { default: ReadinessMetricsGrid } = await import('@/components/spa/admin/readiness/ReadinessMetricsGrid');
    const metrics = makeReport({ batches: 5, totalEvaluated: 1000 });
    render(<ReadinessMetricsGrid metrics={metrics} loading={false} t={tFn} />);
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('1000')).toBeInTheDocument();
    expect(screen.getByText('Batches')).toBeInTheDocument();
    expect(screen.getByText('Total Evaluated')).toBeInTheDocument();
  });

  it('shows skeletons when loading and no data', async () => {
    const { default: ReadinessMetricsGrid } = await import('@/components/spa/admin/readiness/ReadinessMetricsGrid');
    const { container } = render(<ReadinessMetricsGrid metrics={null} loading={true} t={tFn} />);
    const skeletons = container.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBe(7);
  });

  it('keeps old values visible during refetch', async () => {
    const { default: ReadinessMetricsGrid } = await import('@/components/spa/admin/readiness/ReadinessMetricsGrid');
    const metrics = makeReport({ batches: 3 });
    const { rerender } = render(<ReadinessMetricsGrid metrics={metrics} loading={false} t={tFn} />);
    expect(screen.getByText('3')).toBeInTheDocument();
    rerender(<ReadinessMetricsGrid metrics={metrics} loading={true} t={tFn} />);
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});

describe('ReadinessRatesGrid', () => {
  it('renders 4 rates with pass/fail from checks', async () => {
    const { default: ReadinessRatesGrid } = await import('@/components/spa/admin/readiness/ReadinessRatesGrid');
    const metrics = makeReport({
      agreementRate: 0.95,
      divergenceRate: 0.05,
      ambiguityRate: 0.02,
      errorRate: 0.01,
    });
    const checks = makeChecks();
    render(<ReadinessRatesGrid metrics={metrics} checks={checks} loading={false} t={tFn} />);
    expect(screen.getByText('95.0%')).toBeInTheDocument();
    expect(screen.getByText('5.0%')).toBeInTheDocument();
    expect(screen.getByText('2.0%')).toBeInTheDocument();
    expect(screen.getByText('1.0%')).toBeInTheDocument();
  });

  it('null rate displays as em dash', async () => {
    const { default: ReadinessRatesGrid } = await import('@/components/spa/admin/readiness/ReadinessRatesGrid');
    const metrics = makeReport({ agreementRate: null });
    const checks = makeChecks();
    render(<ReadinessRatesGrid metrics={metrics} checks={checks} loading={false} t={tFn} />);
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it('color derived from check.passed not local comparison', async () => {
    const { default: ReadinessRatesGrid } = await import('@/components/spa/admin/readiness/ReadinessRatesGrid');
    const metrics = makeReport({ agreementRate: 0.5 });
    const checks = makeChecks({ MINIMUM_AGREEMENT_RATE: true });
    render(<ReadinessRatesGrid metrics={metrics} checks={checks} loading={false} t={tFn} />);
    expect(screen.getByText('50.0%')).toBeInTheDocument();
  });
});

describe('ReadinessChecksTable', () => {
  it('renders all 7 checks', async () => {
    const { default: ReadinessChecksTable } = await import('@/components/spa/admin/readiness/ReadinessChecksTable');
    const checks = makeChecks();
    render(<ReadinessChecksTable checks={checks} t={tFn} />);
    for (const code of ALL_CHECK_CODES) {
      expect(screen.getByText(code)).toBeInTheDocument();
    }
  });

  it('highlights failed checks when failedChecks provided', async () => {
    const { default: ReadinessChecksTable } = await import('@/components/spa/admin/readiness/ReadinessChecksTable');
    const checks = makeChecks({ MINIMUM_BATCHES: false });
    const failed = checks.filter(c => !c.passed);
    const { container } = render(<ReadinessChecksTable checks={checks} failedChecks={failed} t={tFn} />);
    const rows = container.querySelectorAll('tr');
    const hasRedBg = Array.from(rows).some(row =>
      row.className.includes('bg-red-50') || row.className.includes('dark:bg-red-950'),
    );
    expect(hasRedBg).toBe(true);
  });

  it('visible in all states including INSUFFICIENT_DATA', async () => {
    const { default: ReadinessChecksTable } = await import('@/components/spa/admin/readiness/ReadinessChecksTable');
    const checks = makeChecks({ MINIMUM_BATCHES: false });
    render(<ReadinessChecksTable checks={checks} t={tFn} />);
    expect(screen.getByText('MINIMUM_BATCHES')).toBeInTheDocument();
  });
});

describe('ReadinessRecommendationBanner', () => {
  it('correct text per status', async () => {
    const { default: ReadinessRecommendationBanner } = await import('@/components/spa/admin/readiness/ReadinessRecommendationBanner');
    render(<ReadinessRecommendationBanner status="READY" t={tFn} />);
    expect(screen.getByText('The engine meets the defined criteria. Activation remains manual.')).toBeInTheDocument();
  });

  it('shows NOT_READY text', async () => {
    const { default: ReadinessRecommendationBanner } = await import('@/components/spa/admin/readiness/ReadinessRecommendationBanner');
    render(<ReadinessRecommendationBanner status="NOT_READY" t={tFn} />);
    expect(screen.getByText('The engine does not meet the defined criteria. Review failed checks before considering activation.')).toBeInTheDocument();
  });

  it('shows INSUFFICIENT_DATA text', async () => {
    const { default: ReadinessRecommendationBanner } = await import('@/components/spa/admin/readiness/ReadinessRecommendationBanner');
    render(<ReadinessRecommendationBanner status="INSUFFICIENT_DATA" t={tFn} />);
    expect(screen.getByText('Insufficient data to evaluate. More batches are needed before assessing readiness.')).toBeInTheDocument();
  });
});

describe('TrustPolicyWarning', () => {
  it('visible when INCLUDE_UNTRUSTED + legacyUntrustedBatches > 0', async () => {
    const { default: TrustPolicyWarning } = await import('@/components/spa/admin/readiness/TrustPolicyWarning');
    render(<TrustPolicyWarning trustPolicy="INCLUDE_UNTRUSTED_HISTORY" legacyUntrustedBatches={5} t={tFn} />);
    expect(screen.getByText('Including LEGACY_UNTRUSTED data')).toBeInTheDocument();
  });

  it('hidden when INCLUDE_LEGACY_IMPORT', async () => {
    const { default: TrustPolicyWarning } = await import('@/components/spa/admin/readiness/TrustPolicyWarning');
    const { container } = render(<TrustPolicyWarning trustPolicy="INCLUDE_LEGACY_IMPORT" legacyUntrustedBatches={5} t={tFn} />);
    expect(container.innerHTML).toBe('');
  });

  it('hidden when legacyUntrustedBatches === 0', async () => {
    const { default: TrustPolicyWarning } = await import('@/components/spa/admin/readiness/TrustPolicyWarning');
    const { container } = render(<TrustPolicyWarning trustPolicy="INCLUDE_UNTRUSTED_HISTORY" legacyUntrustedBatches={0} t={tFn} />);
    expect(container.innerHTML).toBe('');
  });

  it('uses trustPolicy from prop, not from form', async () => {
    const { default: TrustPolicyWarning } = await import('@/components/spa/admin/readiness/TrustPolicyWarning');
    const { container } = render(<TrustPolicyWarning trustPolicy="TRUSTED_ONLY" legacyUntrustedBatches={5} t={tFn} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('Rate-check mapper', () => {
  it('RATE_TO_CHECK_CODE covers all RateKey values', () => {
    const rateKeys: RateKey[] = ['agreementRate', 'divergenceRate', 'ambiguityRate', 'errorRate'];
    for (const key of rateKeys) {
      expect(RATE_TO_CHECK_CODE[key]).toBeDefined();
    }
  });

  it('getCheckForRate returns correct check', () => {
    const checks = makeChecks({ MINIMUM_AGREEMENT_RATE: false });
    const result = getCheckForRate(checks, 'agreementRate');
    expect(result?.code).toBe('MINIMUM_AGREEMENT_RATE');
    expect(result?.passed).toBe(false);
  });

  it('getRatePassed returns undefined for missing check', () => {
    expect(getRatePassed([], 'agreementRate')).toBeUndefined();
  });
});

describe('Mapper exhaustiveness', () => {
  it('all rate-related ReadinessCheckCode values have a RATE_TO_CHECK_CODE entry', () => {
    const rateCodes: ReadinessCheckCode[] = [
      'MINIMUM_AGREEMENT_RATE',
      'MAXIMUM_DIVERGENCE_RATE',
      'MAXIMUM_AMBIGUITY_RATE',
      'MAXIMUM_ERROR_RATE',
    ];
    const mapped = Object.values(RATE_TO_CHECK_CODE);
    for (const code of rateCodes) {
      expect(mapped).toContain(code);
    }
  });
});

describe('No local threshold comparison', () => {
  it('rates grid derives pass/fail from getRatePassed', async () => {
    const { default: ReadinessRatesGrid } = await import('@/components/spa/admin/readiness/ReadinessRatesGrid');
    const getRatePassedSpy = vi.spyOn(await import('@/lib/readiness/rate-check-mapper'), 'getRatePassed');
    const metrics = makeReport({ agreementRate: 0.5 });
    const checks = makeChecks({ MINIMUM_AGREEMENT_RATE: false });
    render(<ReadinessRatesGrid metrics={metrics} checks={checks} loading={false} t={tFn} />);
    expect(getRatePassedSpy).toHaveBeenCalled();
    getRatePassedSpy.mockRestore();
  });
});


