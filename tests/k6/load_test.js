/**
 * AccountExpress — k6 Full System Load Test
 * Covers: Auth, Dashboard, Accounts, Banks, Journal, Reports, Health
 *
 * Usage:
 *   k6 run tests/k6/load_test.js                     (smoke)
 *   k6 run -e PROFILE=load tests/k6/load_test.js     (load)
 *   k6 run -e PROFILE=stress tests/k6/load_test.js   (stress)
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// ─── Custom Metrics ───────────────────────────────────────────
const loginDuration   = new Trend('login_duration',   true);
const dashboardDuration = new Trend('dashboard_duration', true);
const accountsDuration  = new Trend('accounts_duration',  true);
const reportDuration    = new Trend('report_duration',    true);
const errorRate         = new Rate('error_rate');
const totalRequests     = new Counter('total_requests');

// ─── Configuration ────────────────────────────────────────────
const BASE_URL    = 'http://localhost:3000';
const CREDENTIALS = { email: 'admin@accountexpress.com', password: 'Admin123!' };

const PROFILES = {
  smoke: {
    vus: 1,
    iterations: 2,
    sleep: '1s',
  },
  load: {
    stages: [
      { duration: '30s', target: 5  },
      { duration: '1m',  target: 10 },
      { duration: '30s', target: 0  },
    ],
    sleep: '1s',
  },
  stress: {
    stages: [
      { duration: '20s', target: 20 },
      { duration: '40s', target: 50 },
      { duration: '20s', target: 0  },
    ],
    sleep: '500ms',
  },
};

const profile = __ENV.PROFILE || 'smoke';
const profileCfg = PROFILES[profile];

export const options = {
  ...(profileCfg.iterations
    ? { scenarios: {
        default: {
          executor: 'per-vu-iterations',
          vus: profileCfg.vus,
          iterations: profileCfg.iterations,
        },
      }}
    : { stages: profileCfg.stages }),
  thresholds: {
    http_req_duration:        ['p(95)<5000'],
    http_req_failed:          ['rate<0.05'],    // < 5% — tolera 429s ocasionales en burst
    error_rate:               ['rate<0.05'],
    login_duration:           ['p(95)<5000'],  // cold start puede demorar
    dashboard_duration:       ['p(95)<3000'],
    accounts_duration:        ['p(95)<2000'],
    report_duration:          ['p(95)<10000'],  // PDF exports: render time real
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

// ─── Helpers ──────────────────────────────────────────────────
const CSRF_HEADERS = {
  'Origin':  BASE_URL,
  'Referer': `${BASE_URL}/`,
};

function post(path, body, headers = {}) {
  totalRequests.add(1);
  return http.post(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', ...CSRF_HEADERS, ...headers },
  });
}

function get(path, headers = {}) {
  totalRequests.add(1);
  return http.get(`${BASE_URL}${path}`, { headers: { ...CSRF_HEADERS, ...headers } });
}

function ok(res, label) {
  const passed = check(res, {
    [`${label} → status 200`]: (r) => r.status === 200,
    [`${label} → response < 5s`]: (r) => r.timings.duration < 5000,
  });
  if (!passed) {
    errorRate.add(1);
    console.error(`FAIL: ${label} (status ${res.status}): ${res.body ? res.body.substring(0, 200) : 'no body'}`);
  } else {
    errorRate.add(0);
  }
  return res;
}

// ─── Setup: Login once, share session ─────────────────────────
export function setup() {
  // Use k6 cookie jar for automatic session management
  const jar = http.cookieJar();
  jar.clear(BASE_URL);

  const loginRes = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify(CREDENTIALS),
    {
      headers: {
        'Content-Type': 'application/json',
        'Origin':  BASE_URL,
        'Referer': `${BASE_URL}/`,
      },
      jar,
    }
  );

  loginDuration.add(loginRes.timings.duration);
  console.log(`Setup login status: ${loginRes.status}`);
  console.log(`Setup login body: ${loginRes.body.substring(0, 300)}`);

  if (loginRes.status !== 200) {
    console.error(`Setup login FAILED: ${loginRes.status} — ${loginRes.body}`);
    return { cookies: {}, companyId: '' };
  }

  // Capture all cookies from the jar
  const jarCookies = jar.cookiesForURL(BASE_URL);
  console.log(`Cookies received: ${JSON.stringify(Object.keys(jarCookies))}`);

  // Also capture Set-Cookie header as fallback
  const rawCookie = loginRes.headers['Set-Cookie'] || '';
  console.log(`Raw Set-Cookie: ${rawCookie.substring(0, 200)}`);

  let companyId = '';
  try {
    const body = JSON.parse(loginRes.body);
    companyId = body?.companies?.[0]?.id
      || body?.user?.companyMemberships?.[0]?.companyId
      || body?.companyMemberships?.[0]?.companyId
      || '';
    console.log(`Body keys: ${Object.keys(body || {}).join(', ')}`);
  } catch (e) {
    console.error(`JSON parse error: ${e}`);
  }

  // Build cookie string manually from jar
  let cookieStr = Object.entries(jarCookies)
    .map(([name, vals]) => `${name}=${vals[0]}`)
    .join('; ');

  // Fallback: use raw Set-Cookie header (strip attributes)
  if (!cookieStr && rawCookie) {
    cookieStr = rawCookie.split(',')
      .map(c => c.split(';')[0].trim())
      .join('; ');
  }

  // If still no companyId, try /api/auth/me with cookie
  if (!companyId && cookieStr) {
    const cr = http.get(`${BASE_URL}/api/auth/me`, {
      headers: {
        'Cookie':  cookieStr,
        'Origin':  BASE_URL,
        'Referer': `${BASE_URL}/`,
      },
    });
    console.log(`Auth me status: ${cr.status}, body: ${cr.body.substring(0, 200)}`);
    try {
      const b = JSON.parse(cr.body);
      companyId = b?.companies?.[0]?.id || b?.user?.companyMemberships?.[0]?.companyId || '';
    } catch (_) {}
  }

  // Fetch dashboard once to get first bankAccountId for reconciliation tests
  let firstBankAccountId = '';
  if (companyId && cookieStr) {
    const dashRes = http.get(`${BASE_URL}/api/dashboard?companyId=${companyId}`, {
      headers: { Cookie: cookieStr, ...CSRF_HEADERS },
    });
    if (dashRes.status === 200) {
      try {
        const dashData = JSON.parse(dashRes.body);
        if (dashData.bankAccounts && dashData.bankAccounts.length > 0) {
          firstBankAccountId = dashData.bankAccounts[0].id;
        }
      } catch (_) {}
    }
  }

  console.log(`Setup done: cookie=${cookieStr ? 'OK('+cookieStr.length+' chars)' : 'EMPTY'}, companyId=${companyId}, bankAccountId=${firstBankAccountId}`);
  return { cookieStr, companyId, firstBankAccountId };
}


// ─── Main Test ────────────────────────────────────────────────
export default function (data) {
  const { cookieStr, companyId, firstBankAccountId } = data;

  if (!cookieStr) {
    console.error('No session from setup — aborting');
    return;
  }

  const authHeaders = { Cookie: cookieStr };


  // ── 1. Health Check ────────────────────────────────────────
  group('01 Health Check', () => {
    ok(get('/api/health', authHeaders), 'health');
  });

  // ── 2. Auth Me ─────────────────────────────────────────────
  group('02 Auth — Me', () => {
    ok(get('/api/auth/me', authHeaders), 'auth/me');
  });

  // ── 3. Companies ───────────────────────────────────────────
  group('03 Companies', () => {
    ok(get('/api/admin/companies', authHeaders), 'admin/companies');
  });

  if (!companyId) {
    console.error('No companyId — skipping company-scoped tests');
    sleep(1);
    return;
  }

  // ── 4. Dashboard ───────────────────────────────────────────
  group('04 Dashboard', () => {
    const res = get(`/api/dashboard?companyId=${companyId}`, authHeaders);
    dashboardDuration.add(res.timings.duration);
    ok(res, 'dashboard');
  });

  // ── 5. GL Accounts ─────────────────────────────────────────
  group('05 GL Accounts', () => {
    const res = get(`/api/accounts?companyId=${companyId}`, authHeaders);
    accountsDuration.add(res.timings.duration);
    ok(res, 'accounts/list');
  });

  // ── 6. Banks ───────────────────────────────────────────────
  group('06 Banks', () => {
    ok(get(`/api/banks?companyId=${companyId}`, authHeaders), 'banks/list');
  });

  // ── 7a. Reconciliation — pending review ────────────────────
  if (firstBankAccountId) {
    group('07a Reconciliation Pending Review', () => {
      ok(get(
        `/api/reconciliation?bankAccountId=${firstBankAccountId}&companyId=${companyId}&status=pending_review`,
        authHeaders
      ), 'reconciliation/pending_review');
    });

    group('07b Reconciliation Unreconciled', () => {
      ok(get(
        `/api/reconciliation?bankAccountId=${firstBankAccountId}&companyId=${companyId}&status=unreconciled`,
        authHeaders
      ), 'reconciliation/unreconciled');
    });
  }

  // ── 08. Journal ────────────────────────────────────────────
  group('08 Journal', () => {
    ok(get(`/api/journal?companyId=${companyId}&page=1&pageSize=20`, authHeaders), 'journal');
  });

  // ── 09. Import History ─────────────────────────────────────
  group('09 Import History', () => {
    ok(get(`/api/import/history?companyId=${companyId}`, authHeaders), 'import/history');
  });

  // ── 10. Bank Rules ─────────────────────────────────────────
  group('10 Bank Rules', () => {
    ok(get(`/api/bank-rules?companyId=${companyId}`, authHeaders), 'bank-rules');
  });

  // ── 11. Fiscal Periods / Settings ─────────────────────────
  group('11 Fiscal Periods', () => {
    ok(get(`/api/settings?companyId=${companyId}`, authHeaders), 'settings/fiscal-periods');
  });

  // ── 12. Movement Summary ──────────────────────────────────
  group('12 Movement Summary', () => {
    ok(get(`/api/movement-summary?companyId=${companyId}`, authHeaders), 'movement-summary');
  });

  // ── 13. Report — Trial Balance PDF ────────────────────────
  group('13 Report Trial Balance PDF', () => {
    const res = get(
      `/api/export/pdf?type=trial_balance&companyId=${companyId}&asOfDate=2025-12-31`,
      authHeaders
    );
    reportDuration.add(res.timings.duration);
    check(res, {
      'trial_balance pdf → 200': (r) => r.status === 200,
      'trial_balance pdf → html': (r) => (r.headers['Content-Type'] || '').includes('text/html'),
    });
  });

  // ── 14. Report — Transactions PDF ─────────────────────────
  group('14 Report Transactions PDF', () => {
    const res = get(
      `/api/export/pdf?type=transactions&companyId=${companyId}&startDate=2025-01-01&endDate=2025-12-31`,
      authHeaders
    );
    reportDuration.add(res.timings.duration);
    check(res, { 'transactions pdf → 200': (r) => r.status === 200 });
  });

  // ── 15. Report — Trial Balance CSV ────────────────────────
  group('15 Report Trial Balance CSV', () => {
    const res = get(
      `/api/export/csv?type=trial_balance&companyId=${companyId}`,
      authHeaders
    );
    check(res, { 'trial_balance csv → 200': (r) => r.status === 200 });
  });

  const pause = parseFloat(profileCfg.sleep || '1');
  sleep(pause);
}


// ─── Summary Handler ──────────────────────────────────────────
export function handleSummary(data) {
  const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return {
    [`tests/k6/results/summary_${now}.json`]: JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}

// minimal textSummary fallback (k6 v2 includes it natively)
function textSummary(data, opts = {}) {
  return JSON.stringify(
    {
      metrics: Object.fromEntries(
        Object.entries(data.metrics || {}).map(([k, v]) => [k, v.values])
      ),
    },
    null,
    2
  );
}
