import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { completeOnboarding } from '@/lib/services/onboarding.service';
import { createTestCompany, clearDatabase } from '../helpers/factories';
import { db } from '@/lib/db';

describe('OnboardingService', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('debe inicializar el onboarding contable de la empresa exitosamente con estrategia CALENDAR', async () => {
    const company = await createTestCompany();
    
    // Ejecutar el onboarding service
    const result = await completeOnboarding(
      company.id,
      company.legalName,
      'USD',
      1, // Enero
      2025, // Año
      'CALENDAR',
      1000 // Saldo Inicial
    );

    expect(result.success).toBe(true);
    expect(result.company.isOnboardingComplete).toBe(true);

    // 1. Verificar periodos fiscales generados (CALENDAR genera 12 periodos)
    const fiscalPeriods = await db.fiscalPeriod.findMany({
      where: { companyId: company.id },
      orderBy: { startDate: 'asc' }
    });
    expect(fiscalPeriods.length).toBe(12);
    // Verificación robusta compatible con cualquier zona horaria local del servidor
    const names = fiscalPeriods.map(p => p.name);
    expect(names.some(name => name.includes('2025'))).toBe(true);
    
    // 2. Verificar que se crearon cuentas del catálogo
    const accountsCount = await db.glAccount.count({
      where: { companyId: company.id }
    });
    expect(accountsCount).toBeGreaterThan(10); // catálogo básico cargado

    // 3. Verificar asiento de saldos iniciales (Cash y Equity)
    const entries = await db.journalEntry.findMany({
      where: { companyId: company.id, reference: 'OPENING-BALANCE' },
      include: { lines: true }
    });
    expect(entries.length).toBe(1);
    expect(entries[0].status).toBe('posted');
    expect(entries[0].lines.length).toBe(2);
  });

  it('debe inicializar el onboarding contable para la estrategia WEEK_52_53 exitosamente', async () => {
    const company = await createTestCompany();
    
    // Ejecutar el onboarding service especificando la estrategia de semanas
    const result = await completeOnboarding(
      company.id,
      company.legalName,
      'USD',
      1, // Enero
      2024, // Año de inicio
      'WEEK_52_53',
      0 // Sin saldo inicial
    );

    expect(result.success).toBe(true);
    expect(result.company.isOnboardingComplete).toBe(true);

    // 1. Verificar periodo fiscal de 2024 (WEEK_52_53 genera 1 periodo consolidado)
    const fiscalPeriods = await db.fiscalPeriod.findMany({
      where: { companyId: company.id }
    });
    expect(fiscalPeriods).toHaveLength(1);
    expect(fiscalPeriods[0].name).toContain('2024');
  });
});
