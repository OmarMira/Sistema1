import { logger } from '@/lib/logger';
import { db } from '@/lib/db';
import { createAuditLogWithRetry } from '@/lib/audit';
import { getPeriodStrategy } from '@/lib/fiscal-period/strategies';
import { CHART_OF_ACCOUNTS, seedChartOfAccounts } from '@/lib/chart-of-accounts';
import * as fs from 'fs';
import * as path from 'path';

// Helper seguro para guardar configs en JSON sin modificar el schema de Prisma
function saveCompanyConfig(companyId: string, currency: string, periodType: string) {
  const rulesDir = path.join(process.cwd(), 'rules');
  if (!fs.existsSync(rulesDir)) {
    fs.mkdirSync(rulesDir, { recursive: true });
  }
  const configPath = path.join(rulesDir, 'company-config.json');
  let configData: { companies: Record<string, unknown> } = { companies: {} };
  try {
    if (fs.existsSync(configPath)) {
      configData = JSON.parse(fs.readFileSync(configPath, 'utf8')) as typeof configData;
    }
  } catch (err) {
    logger.error('Error reading company-config.json, creating new', { error: err });
  }
  if (!configData.companies) {
    configData.companies = {};
  }
  configData.companies[companyId] = {
    currency,
    periodType,
    taxModuleEnabled: false,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf8');
}

export async function completeOnboarding(
  companyId: string,
  legalName: string,
  currency: string,
  fiscalYearStartMonth: number,
  fiscalYearStartYear: number,
  periodType: 'CALENDAR' | 'CUSTOM_MONTHS' | 'WEEK_52_53',
  initialCashBalance?: number,
  userId?: string,
) {
  return await db.$transaction(async (tx) => {
    // 1. Validar que la compañía exista
    const company = await tx.company.findUnique({
      where: { id: companyId },
    });
    if (!company) {
      throw new Error(`La compañía con ID ${companyId} no existe.`);
    }

    logger.info('Initializing onboarding', { legalName });

    // Actualizar nombre legal
    await tx.company.update({
      where: { id: companyId },
      data: { legalName },
    });

    // Guardar moneda y tipo de periodo en config JSON inmutable
    saveCompanyConfig(companyId, currency, periodType);

    // 2. Generar Períodos Fiscales con el Patrón Strategy
    const strategy = getPeriodStrategy(periodType);
    const calculatedPeriods = strategy.calculate({
      year: fiscalYearStartYear,
      config: {
        type: periodType,
        startMonth: fiscalYearStartMonth,
        closingAccountCode: '3020',
        periodsPerYear: 12,
        allowShortPeriods: false,
      },
    });

    // Guardar los períodos calculados de manera transaccional
    for (const period of calculatedPeriods) {
      const existingPeriod = await tx.fiscalPeriod.findUnique({
        where: {
          companyId_name: {
            companyId,
            name: period.name,
          },
        },
      });

      if (!existingPeriod) {
        await tx.fiscalPeriod.create({
          data: {
            companyId,
            name: period.name,
            startDate: period.startDate,
            endDate: period.endDate,
            isLocked: false,
          },
        });
      }
    }
    logger.info('Generated periods via strategy', {
      count: calculatedPeriods.length,
      strategy: periodType,
    });

    // 3. Crear Plan de Cuentas GAAP (COA) - Obligatorio antes del asiento de apertura (FK Constraint Guardrail 1)
    const existingAccountsCount = await tx.glAccount.count({
      where: { companyId },
    });

    const accountIdMap = new Map<string, string>();

    if (existingAccountsCount === 0) {
      logger.info('Seeding GAAP chart of accounts');
      for (const account of CHART_OF_ACCOUNTS) {
        const created = await tx.glAccount.create({
          data: {
            companyId,
            code: account.code,
            name: account.name,
            accountType: account.type,
            normalBalance: account.normalBalance,
            parentId: account.parentCode ? accountIdMap.get(account.parentCode) : null,
            isSystem: true,
            isActive: true,
          },
        });
        accountIdMap.set(account.code, created.id);
      }
      logger.info('Created standard accounts', { count: CHART_OF_ACCOUNTS.length });
    } else {
      const accounts = await tx.glAccount.findMany({
        where: { companyId },
      });
      for (const a of accounts) {
        accountIdMap.set(a.code, a.id);
      }
    }

    // 4. Asiento de Apertura de Saldos Iniciales (Solo si initialCashBalance > 0)
    let journalEntryId: string | undefined;
    if (initialCashBalance && initialCashBalance > 0) {
      const cashAccountId = accountIdMap.get('1010');
      const equityAccountId = accountIdMap.get('3010');

      if (!cashAccountId || !equityAccountId) {
        throw new Error(
          'Cuentas GL Cash (1010) o Equity (3010) no encontradas en el seeder contable.',
        );
      }

      // Crear asiento balanceado (Débito a Cash, Crédito a Equity)
      const openingEntry = await tx.journalEntry.create({
        data: {
          companyId,
          date: calculatedPeriods[0]!.startDate,
          description: 'Asiento de apertura - Saldo de efectivo inicial configurado en Onboarding',
          reference: 'OPENING-BALANCE',
          status: 'posted',
          lines: {
            create: [
              {
                glAccountId: cashAccountId,
                description: 'Efectivo y equivalentes de efectivo iniciales',
                debit: initialCashBalance,
                credit: 0,
              },
              {
                glAccountId: equityAccountId,
                description: 'Aportación de capital - Saldos iniciales',
                debit: 0,
                credit: initialCashBalance,
              },
            ],
          },
        },
      });
      journalEntryId = openingEntry.id;
      logger.info('Opening Journal Entry posted successfully', { initialCashBalance });

      // Crear BankAccount por defecto vinculada al efectivo
      await tx.bankAccount.create({
        data: {
          companyId,
          accountName: 'Efectivo Operativo (Caja General)',
          bankName: 'Caja General Onboarding',
          accountNo: 'CASH-OPERATIVE',
          glAccountId: cashAccountId,
          balance: initialCashBalance,
          initialBalance: initialCashBalance,
          currency,
          isActive: true,
        },
      });
    }

    // 5. Marcar onboarding como completado
    const updatedCompany = await tx.company.update({
      where: { id: companyId },
      data: { isOnboardingComplete: true },
    });

    // 6. Traza Forense en AuditLog (Guardrail 3)
    await createAuditLogWithRetry(
      {
        companyId,
        userId: userId || null,
        action: 'ONBOARDING_COMPLETED',
        entity: 'Company',
        entityId: companyId,
        details: JSON.stringify({
          payload: {
            companyId,
            legalName,
            currency,
            fiscalYearStartMonth,
            fiscalYearStartYear,
            periodType,
            initialCashBalance: initialCashBalance || 0,
          },
          strategyUsed: periodType,
          periodsGenerated: calculatedPeriods.length,
          openingBalanceApplied: initialCashBalance && initialCashBalance > 0 ? true : false,
          journalEntryId: journalEntryId || null,
        }),
      },
       
      tx as any,
    );

    logger.info('Complete system activation succeeded', { legalName: updatedCompany.legalName });

    return {
      success: true,
      company: updatedCompany,
    };
  });
}
