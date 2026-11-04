'use client';

import { useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw, Info, TrendingUp, TrendingDown, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuthStore } from '@/store/auth-store';
import { useLanguageStore } from '@/store/language-store';
import { BANK_ACTIVITY_COPY } from '@/components/dashboard/bank-activity-copy';
import { BankActivityCharts, BankActivityIndicators } from '@/components/dashboard/BankActivityCharts';
import { type BankActivityData, type BankFilters, bankCategories, bankMonths, bankMovementsCSV, bankSummaryCSV, bankTotals, filterBankMovements, savedCategory, statementContext } from '@/lib/dashboard/bank-activity';
const allMonths = () => new Set(Array.from({
  length: 12
}, (_, i) => String(i + 1).padStart(2, '0')));
const panel = 'gap-0 rounded-xl border bg-card p-4 text-card-foreground shadow-sm sm:p-6';
const fieldClass = 'mt-1 h-9 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:opacity-50 dark:bg-input/30';
const inputClass = `${fieldClass} w-full`;
const emptyFilters = (): BankFilters => ({
  start: '',
  end: '',
  reconciliation: 'all',
  months: allMonths(),
  income: new Set(),
  expenses: new Set()
});
export function FinancialDashboardPage() {
  const language = useLanguageStore(s => s.language) === 'en' ? 'en' : 'es';
  const copy = BANK_ACTIVITY_COPY[language];
  const activeCompany = useAuthStore(s => s.activeCompany);
  const setCurrentView = useAuthStore(s => s.setCurrentView);
  const [selection, setSelection] = useState<{
    companyId?: string;
    accountId?: string;
    year?: number;
  }>({});
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<BankActivityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filters, setFilters] = useState<BankFilters>(emptyFilters);
  const [rowLimit, setRowLimit] = useState(50);
  const accountId = selection.companyId === activeCompany?.id ? selection.accountId : undefined;
  const year = selection.companyId === activeCompany?.id ? selection.year : undefined;
  function defaults(result: BankActivityData): BankFilters {
    const context = statementContext(result);
    return {
      ...emptyFilters(),
      start: context.start < `${result.year}-01-01` ? `${result.year}-01-01` : context.start,
      end: context.end > `${result.year}-12-31` ? `${result.year}-12-31` : context.end,
      income: new Set(result.transactions.filter(t => t.tipo === 'credito').map(savedCategory)),
      expenses: new Set(result.transactions.filter(t => t.tipo === 'debito').map(savedCategory))
    };
  }
  useEffect(() => {
    const controller = new AbortController();
    if (!activeCompany?.id) return () => controller.abort();
    const companyId = activeCompany.id;
    async function load() {
      setLoading(true);
      setError(false);
      setData(null);
      try {
        const params = new URLSearchParams({
          companyId
        });
        if (accountId) params.set('accountId', accountId);
        if (year) params.set('year', String(year));
        let result: BankActivityData | null = null;
        const movements: BankActivityData['transactions'] = [];
        const ids = new Set<string>();
        const cursors = new Set<string>();
        do {
          const response = await fetch(`/api/dashboard/bank-activity?${params}`, {
            signal: controller.signal
          });
          if (!response.ok) throw new Error('Bank activity unavailable');
          const page: BankActivityData = await response.json();
          if (result && (page.account?.id !== result.account?.id || page.year !== result.year || page.total !== result.total)) throw new Error('Bank activity changed while loading');
          result ??= page;
          for (const movement of page.transactions) {
            if (ids.has(movement.id)) throw new Error('Duplicate paginated movement');
            ids.add(movement.id);
            movements.push(movement);
          }
          if (!page.hasMore) break;
          if (!page.nextCursor || cursors.has(page.nextCursor) || page.transactions.length === 0 || movements.length >= page.total) throw new Error('Invalid bank activity pagination');
          cursors.add(page.nextCursor);
          params.set('cursor', page.nextCursor);
          params.set('accountId', page.account!.id);
          params.set('year', String(page.year));
        } while (!controller.signal.aborted);
        if (!result || movements.length !== result.total) throw new Error('Incomplete bank activity');
        if (!controller.signal.aborted) {
          const complete = {
            ...result,
            transactions: movements,
            hasMore: false,
            nextCursor: null
          };
          setData(complete);
          setFilters(defaults(complete));
          setRowLimit(50);
        }
      } catch {
        if (!controller.signal.aborted) {
          setError(true);
          setData(null);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [activeCompany?.id, accountId, year, reload]);
  const visible = useMemo(() => filterBankMovements(data?.transactions ?? [], filters), [data, filters]);
  const totals = bankTotals(visible);
  const context = data ? statementContext(data) : null;
  const invalidDates = !!filters.start && !!filters.end && filters.start > filters.end;
  const categories = {
    income: bankCategories(data?.transactions ?? [], 'credito'),
    expenses: bankCategories(data?.transactions ?? [], 'debito')
  };
  const money = (value: number | null) => {
    if (value === null) return copy.unavailable;
    const currency = data?.account?.currency ?? 'USD';
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency
      }).format(value);
    } catch {
      return `${value.toFixed(2)} ${currency}`;
    }
  };
  const date = (value: string) => new Date(value + 'T00:00:00Z').toLocaleDateString(language === 'en' ? 'en-GB' : 'es-ES', {
    timeZone: 'UTC',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
  const monthName = (month: string, long = false) => new Date(`${data?.year ?? 2025}-${month}-01T00:00:00Z`).toLocaleDateString(language === 'en' ? 'en-US' : 'es-ES', {
    timeZone: 'UTC',
    month: long ? 'long' : 'short'
  });
  const categoryName = (category: string) => category === 'Sin asignar' ? copy.unassigned : category;
  const toggle = (key: 'months' | 'income' | 'expenses', value: string) => setFilters(current => {
    const next = new Set(current[key]);
    if (next.has(value)) next.delete(value);else next.add(value);
    return {
      ...current,
      [key]: next
    };
  });
  const download = (filename: string, content: string) => {
    const url = URL.createObjectURL(new Blob([content], {
      type: 'text/csv;charset=utf-8;'
    }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };
  if (!activeCompany?.id) return <p role="status">{copy.chooseCompany}</p>;
  if (loading) return <p role="status" className={panel}>{copy.loading}</p>;
  if (error || !data) return <Card role="region" className={panel}><p role="alert">{copy.error}</p><Button onClick={() => setReload(n => n + 1)}>{copy.retry}</Button></Card>;
  const rows = data.transactions;
  const fees = bankTotals(visible.filter(t => t.tipo === 'debito' && /^(comisiones bancarias|comisión bancaria|bank fees)$/i.test(savedCategory(t)))).outgoing;
  const months = bankMonths(data, visible).filter(m => filters.months.has(m.key.slice(5, 7)) && (!filters.start || m.key >= filters.start.slice(0, 7)) && (!filters.end || m.key <= filters.end.slice(0, 7)));
  const barMax = Math.max(1, ...months.flatMap(m => [m.incoming, m.outgoing]));
  const summary = bankSummaryCSV(data);
  const bankTitle = data.account ? [...new Set([data.account.bankName, data.account.accountName].filter(Boolean))].join(' — ') : copy.noAccounts;
  return <div className="space-y-6 pb-12">
    <header className="space-y-2">
      <h1 className="text-2xl font-bold">{copy.title} — {activeCompany.legalName}</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">{copy.intro}</p>
      <h2 className="text-base font-semibold">{bankTitle}</h2>
    </header>
    <Card role="region" className={`${panel} grid grid-cols-1 gap-4 sm:flex sm:flex-row sm:flex-wrap sm:items-end`} aria-label={language === 'en' ? 'Account and period' : 'Cuenta y período'}>
      <label className="flex w-fit max-w-full min-w-0 flex-col text-sm font-medium"><span>{copy.account}</span><select className={`${fieldClass} w-fit min-w-0 max-w-full [field-sizing:content]`} value={data.account?.id ?? ''} disabled={!data.accounts.length} onChange={e => setSelection({
          companyId: activeCompany.id,
          accountId: e.target.value
        })}>
        {data.accounts.map(a => <option key={a.id} value={a.id}>{[...new Set([a.bankName, a.accountName])].join(' — ')} ({a.currency})</option>)}
      </select></label>
      <label className="grid w-max max-w-full min-w-0 text-sm font-medium"><span>{copy.year}</span><select className={`${fieldClass} w-full min-w-0`} value={data.year ?? ''} disabled={!data.years.length} onChange={e => setSelection({
          companyId: activeCompany.id,
          accountId: data.account?.id,
          year: Number(e.target.value)
        })}>
        {data.years.map(y => <option key={y} value={y}>{y}</option>)}
      </select></label>
      <Button variant="outline" onClick={() => setReload(n => n + 1)}><RefreshCw className="mr-2 size-4" />{copy.refresh}</Button>
    </Card>
    {!data.account || !rows.length && !data.statements.length ? <Card role="region" className={panel}><p role="status">{data.account ? copy.noMovements : copy.noAccounts}</p><Button className="mt-3" onClick={() => setCurrentView('banks')}>{copy.import}</Button></Card> : <>
      <Card role="region" className={panel} aria-label={copy.source}>
        <h2 className="font-semibold">{copy.source} · {data.account.currency}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{copy.sourceHelp}</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div><p className="text-sm">{copy.opening}</p><p className="text-2xl font-semibold tabular-nums">{money(context!.opening)}</p><p className="text-sm text-muted-foreground">{date(context!.start)}</p></div>
          <div><p className="text-sm">{copy.closing}</p><p className="text-2xl font-semibold tabular-nums">{money(context!.closing)}</p><p className="text-sm text-muted-foreground">{date(context!.end)}</p></div>
        </div>
        {!context!.verified && <p role="alert" className="mt-4 text-sm text-amber-700 dark:text-amber-400">{copy.coverage}</p>}
        {!context!.fullYear && <p className="mt-2 text-sm text-muted-foreground">{copy.partialYear}</p>}
      </Card>
      <Card role="region" className={panel} aria-label={copy.activity}>
        <h2 className="font-semibold">{copy.activity}</h2>
        <p className="mt-1 text-sm" aria-live="polite">{visible.length} {copy.count} {rows.length} {copy.movements}</p>
        <p className="mt-2 text-sm text-muted-foreground">{copy.subset}</p>
        {invalidDates ? <p role="alert" className="mt-4">{copy.invalidDates}</p> : !visible.length ? <p role="status" className="mt-4 rounded-lg bg-muted p-4">{copy.empty}</p> : <>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            {[[copy.incoming, totals.incoming, copy.incomeHelp], [copy.outgoing, totals.outgoing, copy.expenseHelp], [copy.net, totals.net, copy.netHelp]].map(([label, amount, description], index) => {
              const Icon = [TrendingUp, TrendingDown, Wallet][index];
              const iconClass = ['bg-emerald-100 text-emerald-600 dark:bg-emerald-950', 'bg-orange-100 text-orange-600 dark:bg-orange-950', 'bg-primary/10 text-primary'][index];
              return <Card key={String(label)} className="relative overflow-hidden"><CardContent className="p-6"><div className="flex items-start justify-between gap-3"><div className="min-w-0 space-y-1"><h3 className="text-sm font-medium text-muted-foreground">{label}</h3><p className="break-words text-2xl font-bold tracking-tight tabular-nums">{money(Number(amount))}</p></div><span className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${iconClass}`}><Icon className="size-5" aria-hidden="true" /></span></div><p className="mt-3 text-xs text-muted-foreground">{description}</p></CardContent></Card>;
            })}
          </div>
          <BankActivityIndicators visible={visible} language={language} money={money} />
          <p className="mt-4 text-sm text-muted-foreground">{fees ? `${copy.feesKnown}: ${money(fees)}. ${copy.feesHelp}` : copy.feesUnknown}</p>
        </>}
      </Card>
      <details className={panel} open>
        <summary className="cursor-pointer font-semibold">{copy.filters}</summary>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <label className="text-sm">{copy.from}<input type="date" className={inputClass} value={filters.start} onChange={e => setFilters(f => ({
              ...f,
              start: e.target.value
            }))} /></label>
          <label className="text-sm">{copy.until}<input type="date" className={inputClass} value={filters.end} onChange={e => setFilters(f => ({
              ...f,
              end: e.target.value
            }))} /></label>
          <label className="text-sm">{copy.status}<select className={inputClass} value={filters.reconciliation} onChange={e => setFilters(f => ({
              ...f,
              reconciliation: e.target.value
            }))}><option value="all">{copy.all}</option><option value="reconciled">{copy.reconciled}</option><option value="unreconciled">{copy.pending}</option></select></label>
        </div>
        <fieldset className="mt-4"><legend className="text-sm font-medium">{copy.months}</legend><div className="mt-2 flex flex-wrap gap-3">{[...allMonths()].map(m => <label key={m} className="flex items-center gap-1 text-sm"><input type="checkbox" aria-label={monthName(m).replace(/^./, c => c.toUpperCase()).replace('.', '')} checked={filters.months.has(m)} onChange={() => toggle('months', m)} />{monthName(m)}</label>)}</div></fieldset>
        <div className="mt-4 grid gap-4 md:grid-cols-2">{(['income', 'expenses'] as const).map(key => <fieldset key={key}><legend className="text-sm font-medium">{key === 'income' ? copy.incomeCategories : copy.expenseCategories}</legend><div className="mt-2 flex max-h-36 flex-col gap-2 overflow-y-auto">{categories[key].map(c => <label key={c.name} className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={`${key === 'income' ? copy.incomePrefix : copy.expensePrefix}: ${categoryName(c.name)}`} checked={filters[key].has(c.name)} onChange={() => toggle(key, c.name)} />{categoryName(c.name)}</label>)}</div></fieldset>)}</div>
        <Button variant="outline" className="mt-4" onClick={() => {
          setFilters(defaults(data));
          setRowLimit(50);
        }}>{copy.reset}</Button>
      </details>
      <Card role="region" className={panel} aria-label={copy.preparation}>
        <h2 className="font-semibold">{copy.preparation}</h2>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <p>{copy.classification}: {rows.filter(t => savedCategory(t) === 'Sin asignar').length}</p><p>{copy.pendingCount}: {rows.filter(t => !t.conciliado).length}</p><p>{copy.reconciledCount}: {rows.filter(t => t.conciliado).length}</p>
          {!!rows.filter(t => t.ignored).length && <p>{copy.ignoredCount}: {rows.filter(t => t.ignored).length}</p>}
        </div><p className="mt-3 max-w-4xl text-sm text-muted-foreground">{copy.preparationHelp}</p>
      </Card>
      {!!visible.length && !invalidDates && <>
        <BankActivityCharts data={data} visible={visible} months={months} language={language} money={money} />
        <Card role="region" className={panel} aria-label={copy.monthly}>
          <h2 className="font-semibold">{copy.monthly}</h2><p className="mt-1 text-sm text-muted-foreground">{copy.monthlyHelp}</p>
          <div className="mt-4 overflow-x-auto"><table aria-label={language === 'en' ? 'Monthly movement summary' : 'Resumen mensual de movimientos'} className="w-full min-w-[680px] text-left text-sm">
            <thead><tr>{[copy.month, copy.incoming, copy.outgoing, copy.net, copy.bankClosing, copy.closingDate].map(label => <th key={label} scope="col" className="border-b p-3 font-medium">{label}</th>)}</tr></thead>
            <tbody>{months.map(m => <tr key={m.key} className="border-b last:border-0"><th scope="row" className="p-3 font-medium capitalize">{monthName(m.key.slice(5), true)} {data.year}</th><td className="p-3 tabular-nums"><span>{money(m.incoming)}</span><span aria-hidden="true" className="mt-1 block h-1 rounded bg-emerald-600" style={{
                      width: `${m.incoming / barMax * 100}%`
                    }} /></td><td className="p-3 tabular-nums"><span>{money(m.outgoing)}</span><span aria-hidden="true" className="mt-1 block h-1 rounded bg-orange-600" style={{
                      width: `${m.outgoing / barMax * 100}%`
                    }} /></td><td className="p-3 tabular-nums">{money(m.net)}</td><td className="p-3 tabular-nums">{m.closing === null ? copy.noStatement : money(m.closing)}</td><td className="p-3">{m.closingDate ? date(m.closingDate) : '—'}</td></tr>)}</tbody>
          </table></div>
        </Card>
        <details className={panel}><summary className="cursor-pointer font-semibold">{copy.categories}</summary><p className="mt-3 text-sm text-muted-foreground">{copy.categoriesHelp}</p><div className="mt-4 grid gap-6 sm:grid-cols-2">{(['credito', 'debito'] as const).map(type => <div key={type}><h3 className="font-medium">{type === 'credito' ? copy.incoming : copy.outgoing}</h3>{bankCategories(visible, type).length ? bankCategories(visible, type).map(c => <div key={c.name} className="mt-3 text-sm"><div className="flex flex-wrap justify-between gap-2"><span>{categoryName(c.name)}</span><span>{money(c.value)} · {c.percentage.toFixed(1)}%</span></div><div className="mt-1 h-2 rounded bg-muted"><div className="h-2 rounded bg-teal-600" style={{
                    width: `${c.percentage}%`
                  }} /></div></div>) : <p className="mt-2 text-sm text-muted-foreground">{type === 'credito' ? copy.noIncome : copy.noExpense}</p>}</div>)}</div></details>
        <details className={panel}><summary className="cursor-pointer font-semibold">{copy.list} ({visible.length})</summary><div className="mt-4 max-h-[32rem] overflow-auto"><table aria-label={copy.list} className="w-full min-w-[560px] text-left text-sm"><thead><tr>{[copy.date, copy.description, copy.direction, copy.amount, copy.category].map(label => <th scope="col" key={label} className="border-b p-2">{label}</th>)}</tr></thead><tbody>{visible.slice(0, rowLimit).map(tx => <tr key={tx.id} className="border-b"><td className="p-2 whitespace-nowrap">{date(tx.fecha)}</td><td className="p-2">{tx.descripcion}</td><td className="p-2">{tx.tipo === 'credito' ? copy.incomePrefix : copy.expensePrefix}</td><td className="p-2 whitespace-nowrap tabular-nums">{money(tx.monto)}</td><td className="p-2">{categoryName(savedCategory(tx))}</td></tr>)}</tbody></table></div>{rowLimit < visible.length && <Button variant="outline" className="mt-3" onClick={() => setRowLimit(n => n + 50)}>{copy.more}</Button>}</details>
      </>}
      <Card role="region" className={panel} aria-label={copy.exports}>
        <h2 className="font-semibold">{copy.exports}</h2><p className="mt-2 max-w-4xl text-sm text-muted-foreground">{copy.exportHelp}</p><div className="mt-4 flex flex-wrap gap-3"><Button variant="outline" disabled={!visible.length || invalidDates} onClick={() => download('transacciones_clasificadas.csv', bankMovementsCSV(visible))}><Download className="mr-2 size-4" />{copy.exportRows}</Button><Button variant="outline" disabled={!summary} onClick={() => {
            if (summary) download('resumen_mensual_dashboard.csv', summary);
          }}><Download className="mr-2 size-4" />{copy.exportMonths}</Button></div>
      </Card>
    </>}
    <details className={panel}><summary className="cursor-pointer font-medium"><Info className="mr-2 inline size-4" />{copy.help}</summary><p className="mt-3 max-w-4xl text-sm text-muted-foreground">{copy.helpText}</p></details>
  </div>;
}
