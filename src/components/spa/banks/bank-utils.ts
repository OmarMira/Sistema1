export function formatCurrency(amount: number): string {
  return Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function fmtCurrency(amount: number): string {
  return amount < 0 ? `-$${formatCurrency(amount)}` : `$${formatCurrency(amount)}`;
}

export function formatNumberWithComas(val: string): string {
  const cleaned = val.replace(/[^0-9.]/g, '');
  const parts = cleaned.split('.');
  if (parts.length > 2) return val;
  const integerPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (parts.length === 2) {
    return `${integerPart}.${parts[1].slice(0, 2)}`;
  }
  return integerPart;
}

export function maskAccountNo(accountNo: string | null): string {
  if (!accountNo) return '—';
  if (accountNo.length <= 4) return '••••';
  return '••••••••' + accountNo.slice(-4);
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}
