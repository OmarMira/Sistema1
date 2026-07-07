// ─── Financial Dashboard Types & Constants ────────────────────────

export interface Transaction {
  id: string;
  fecha: string;
  descripcion: string;
  monto: number;
  tipo: 'credito' | 'debito';
  cuenta_contable: string;
  conciliado: boolean;
  categoria?: string;
  glAccountCode?: string | null;
  glAccountName?: string | null;
  glAccountType?: string | null;
  matchedRuleId?: string | null;
  matchedRuleName?: string | null;
  matchedRuleGlAccountName?: string | null;
}

// Color Palette Constants matching the original visual identity
export const PALETTE = {
  verde: '#1D9E75',
  rojo: '#D85A30',
  morado: '#534AB7',
  azul: '#378ADD',
  ambar: '#BA7517',
  gris: '#888780',
  verdeClaro: 'rgba(29, 158, 117, 0.85)',
  rojoClaro: 'rgba(216, 90, 48, 0.85)',
};

export const MONTHS_SPANISH = [
  { key: '01', name: 'Ene' },
  { key: '02', name: 'Feb' },
  { key: '03', name: 'Mar' },
  { key: '04', name: 'Abr' },
  { key: '05', name: 'May' },
  { key: '06', name: 'Jun' },
  { key: '07', name: 'Jul' },
  { key: '08', name: 'Ago' },
  { key: '09', name: 'Sep' },
  { key: '10', name: 'Oct' },
  { key: '11', name: 'Nov' },
  { key: '12', name: 'Dic' },
];
