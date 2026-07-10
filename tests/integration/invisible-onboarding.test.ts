import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parsePDF } from '@/lib/pdf-parser';
import { db } from '@/lib/db';
import { clearDatabase } from '../helpers/factories';
import { invalidateAllProfilesCache } from '@/lib/bank-profile-service';

// Mock the Z AI SDK completions module
const mockCreateChatCompletion = vi.fn();

vi.mock('z-ai-web-dev-sdk', () => {
  return {
    default: {
      create: async () => {
        return {
          chat: {
            completions: {
              create: mockCreateChatCompletion
            }
          }
        };
      }
    }
  };
});

let customGetDocumentMock: any = null;

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    GlobalWorkerOptions: original.GlobalWorkerOptions || {},
    getDocument: (...args: any[]) => {
      if (customGetDocumentMock) {
        return customGetDocumentMock(...args);
      }
      return original.getDocument(...args);
    },
  };
});

// Helper to generate dynamic mock PDF block structures for testing
const createPdfItems = (
  bankName: string,
  balanceStr: string,
  txs: Array<{ date: string; desc: string; amount: string }>
) => {
  const items = [
    { str: bankName, transform: [1, 0, 0, 1, 100, 750], width: 100, height: 10 },
    { str: 'Cuenta: 987-654321', transform: [1, 0, 0, 1, 100, 720], width: 100, height: 10 },
  ];
  if (balanceStr) {
    const [init, final] = balanceStr.split('|');
    if (init) {
      items.push({ str: `Saldo Inicial: $${init}`, transform: [1, 0, 0, 1, 100, 700], width: 100, height: 10 });
    }
    if (final) {
      items.push({ str: `Saldo Final: $${final}`, transform: [1, 0, 0, 1, 100, 680], width: 100, height: 10 });
    }
  }
  let currentY = 600;
  for (const tx of txs) {
    items.push({ str: tx.date, transform: [1, 0, 0, 1, 100, currentY], width: 50, height: 10 });
    items.push({ str: tx.desc, transform: [1, 0, 0, 1, 220, currentY], width: 100, height: 10 });
    items.push({ str: tx.amount, transform: [1, 0, 0, 1, 500, currentY], width: 50, height: 10 });
    currentY -= 20;
  }
  return items;
};

describe('AI-driven Invisible Onboarding & Self-Healing Integration Tests', () => {
  beforeEach(async () => {
    await clearDatabase();
    await db.bankProfile.deleteMany({});
    invalidateAllProfilesCache();
    customGetDocumentMock = null;
    mockCreateChatCompletion.mockReset();
  });

  afterEach(async () => {
    await clearDatabase();
    await db.bankProfile.deleteMany({});
    invalidateAllProfilesCache();
    customGetDocumentMock = null;
    vi.restoreAllMocks();
  });

  it('debe inferir, guardar e invalidar cache para un banco desconocido exitosamente (Reconciliación exitosa: requiresReview -> false)', async () => {
    // 1. Mock the LLM output for "Banco Galicia Onboard" layout
    mockCreateChatCompletion.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              bankName: 'Banco Galicia Onboard',
              fingerprints: ['Galicia Onboard', 'Galicia Onboard Business'],
              config: {
                layoutType: 'SINGLE_AMOUNT_COLUMN',
                lineGroupingTolerancePx: 5,
                numberFormat: {
                  decimalSeparator: ',',
                  thousandsSeparator: '.',
                  negativeIndicator: '-',
                  negativePosition: 'PREFIX'
                },
                rules: {
                  anchor: {
                    regex: '^\\d{2}/\\d{2}/\\d{4}$',
                    columnRange: [0.0, 0.20]
                  },
                  columns: {
                    date: [0.0, 0.20],
                    description: [0.20, 0.80],
                    amount: [0.80, 1.00]
                  },
                  metadata: {
                    accountNumber: [{ regex: 'Cuenta:\\s*([0-9-]+)', captureGroup: 1 }],
                    initialBalance: [{ regex: 'Saldo Inicial:\\s*\\$?([0-9.,-]+)', captureGroup: 1 }],
                    finalBalance: [{ regex: 'Saldo Final:\\s*\\$?([0-9.,-]+)', captureGroup: 1 }]
                  }
                }
              }
            })
          }
        }
      ]
    });

    customGetDocumentMock = vi.fn().mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({
            items: createPdfItems('Banco Galicia Onboard', '1.000,00|1.400,00', [
              { date: '10/05/2026', desc: 'Deposito Mock Galicia', amount: '400,00' }
            ])
          })
        })
      })
    });

    // 2. Run parsePDF
    const result = await parsePDF(Buffer.from('mock_unknown_galicia_onboard_statement'));

    // 3. Verify results
    expect(result.mathValid).toBe(true);
    expect(result.transactions.length).toBe(1);
    expect(result.transactions[0].amount).toBe(400.0);
    expect(result.accountNo).toBe('987-654321');

    // 4. Verify the BankProfile record exists in DB
    const profileInDb = await db.bankProfile.findFirst({
      where: { bankName: 'Banco Galicia Onboard' }
    });

    expect(profileInDb).toBeDefined();
    expect(profileInDb?.requiresReview).toBe(false);
  });

  it('debe activar Self-Healing si la reconciliación falla con el perfil existente, re-onboardear con el LLM y corregir el perfil bancario', async () => {
    // 1. Crear un perfil erróneo en la base de datos (con anchor regex errónea que no encuentra transacciones)
    await db.bankProfile.create({
      data: {
        bankId: 'galicia-healing-unique',
        bankName: 'Banco Galicia Healing',
        fingerprints: JSON.stringify(['Galicia Healing', 'Galicia Healing Business']),
        requiresReview: false,
        isActive: true,
        config: JSON.stringify({
          layoutType: 'SINGLE_AMOUNT_COLUMN',
          lineGroupingTolerancePx: 5,
          numberFormat: {
            decimalSeparator: ',',
            thousandsSeparator: '.',
            negativeIndicator: '-',
            negativePosition: 'PREFIX'
          },
          rules: {
            anchor: {
              regex: '^FECHA_INCORRECTA$', // Hará que no parsee ninguna transacción
              columnRange: [0.0, 0.20]
            },
            columns: {
              date: [0.0, 0.20],
              description: [0.20, 0.80],
              amount: [0.80, 1.00]
            },
            metadata: {
              accountNumber: [{ regex: 'Cuenta:\\s*([0-9-]+)', captureGroup: 1 }],
              initialBalance: [{ regex: 'Saldo Inicial:\\s*\\$?([0-9.,-]+)', captureGroup: 1 }],
              finalBalance: [{ regex: 'Saldo Final:\\s*\\$?([0-9.,-]+)', captureGroup: 1 }]
            }
          }
        })
      }
    });

    // 2. Mockear la respuesta del LLM durante el Self-Healing para que devuelva la configuración correcta
    mockCreateChatCompletion.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              bankName: 'Banco Galicia Healing',
              fingerprints: ['Galicia Healing', 'Galicia Healing Business'],
              config: {
                layoutType: 'SINGLE_AMOUNT_COLUMN',
                lineGroupingTolerancePx: 5,
                numberFormat: {
                  decimalSeparator: ',',
                  thousandsSeparator: '.',
                  negativeIndicator: '-',
                  negativePosition: 'PREFIX'
                },
                rules: {
                  anchor: {
                    regex: '^\\d{2}/\\d{2}/\\d{4}$', // Regex corregida
                    columnRange: [0.0, 0.20]
                  },
                  columns: {
                    date: [0.0, 0.20],
                    description: [0.20, 0.80],
                    amount: [0.80, 1.00]
                  },
                  metadata: {
                    accountNumber: [{ regex: 'Cuenta:\\s*([0-9-]+)', captureGroup: 1 }],
                    initialBalance: [{ regex: 'Saldo Inicial:\\s*\\$?([0-9.,-]+)', captureGroup: 1 }],
                    finalBalance: [{ regex: 'Saldo Final:\\s*\\$?([0-9.,-]+)', captureGroup: 1 }]
                  }
                }
              }
            })
          }
        }
      ]
    });

    // 3. Mockear el PDF con transacciones correctas
    customGetDocumentMock = vi.fn().mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({
            items: createPdfItems('Banco Galicia Healing', '1.000,00|1.400,00', [
              { date: '10/05/2026', desc: 'Deposito Mock Galicia', amount: '400,00' }
            ])
          })
        })
      })
    });

    // 4. Parsear el PDF
    const result = await parsePDF(Buffer.from('mock_galicia_healing_statement'));

    // 5. Verificar que se parsearon transacciones
    expect(result.transactions.length).toBe(1);
    expect(result.transactions[0].amount).toBe(400.0);

    // 6. Verificar que la base de datos se actualizó y requireReview es false
    const profileInDb = await db.bankProfile.findFirst({
      where: { bankName: 'Banco Galicia Healing' }
    });
    expect(profileInDb).toBeDefined();
    expect(profileInDb?.requiresReview).toBe(false);
    expect(profileInDb?.bankId).toBe('galicia-healing-unique');

    const configParsed = JSON.parse(profileInDb!.config);
    expect(configParsed.rules.anchor.regex).toBe('^\\d{2}/\\d{2}/\\d{4}$');
  });

  it('debe actualizar el perfil existente si el Jaccard index es >= 0.6 en lugar de crear uno duplicado', async () => {
    // 1. Crear un perfil existente con fingerprints
    await db.bankProfile.create({
      data: {
        bankId: 'galicia-business-existente',
        bankName: 'Banco Galicia Existente',
        fingerprints: JSON.stringify(['Galicia Jaccard A1', 'Galicia Jaccard A2', 'Galicia Jaccard A3', 'Galicia Jaccard A4']),
        requiresReview: false,
        isActive: true,
        config: JSON.stringify({
          layoutType: 'SINGLE_AMOUNT_COLUMN',
          lineGroupingTolerancePx: 5,
          numberFormat: { decimalSeparator: ',', thousandsSeparator: '.', negativeIndicator: '-', negativePosition: 'PREFIX' },
          rules: {
            anchor: { regex: '^\\d{2}/\\d{2}/\\d{4}$', columnRange: [0.0, 0.20] },
            columns: { date: [0.0, 0.20], description: [0.20, 0.80], amount: [0.80, 1.00] },
            metadata: {
              accountNumber: [{ regex: 'Cuenta:\\s*([0-9-]+)', captureGroup: 1 }],
              initialBalance: [{ regex: 'Saldo Inicial:\\s*\\$?([0-9.,-]+)', captureGroup: 1 }],
              finalBalance: [{ regex: 'Saldo Final:\\s*\\$?([0-9.,-]+)', captureGroup: 1 }]
            }
          }
        })
      }
    });

    // 2. Mockear el LLM para retornar un perfil con fingerprints similares (Jaccard >= 0.6)
    mockCreateChatCompletion.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              bankName: 'Banco Galicia Existente Modificado',
              fingerprints: ['Galicia Jaccard A1', 'Galicia Jaccard A2', 'Galicia Jaccard A3', 'Galicia Jaccard A5'],
              config: {
                layoutType: 'SINGLE_AMOUNT_COLUMN',
                lineGroupingTolerancePx: 5,
                numberFormat: { decimalSeparator: ',', thousandsSeparator: '.', negativeIndicator: '-', negativePosition: 'PREFIX' },
                rules: {
                  anchor: { regex: '^\\d{2}/\\d{2}/\\d{4}$', columnRange: [0.0, 0.20] },
                  columns: { date: [0.0, 0.20], description: [0.20, 0.80], amount: [0.80, 1.00] },
                  metadata: {
                    accountNumber: [{ regex: 'Cuenta:\\s*([0-9-]+)', captureGroup: 1 }],
                    initialBalance: [{ regex: 'Saldo Inicial:\\s*\\$?([0-9.,-]+)', captureGroup: 1 }],
                    finalBalance: [{ regex: 'Saldo Final:\\s*\\$?([0-9.,-]+)', captureGroup: 1 }]
                  }
                }
              }
            })
          }
        }
      ]
    });

    customGetDocumentMock = vi.fn().mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({
            items: createPdfItems('Banco Galicia Existente', '1.000,00|1.400,00', [
              { date: '10/05/2026', desc: 'Deposito Mock Galicia', amount: '400,00' }
            ])
          })
        })
      })
    });

    // 3. Ejecutar parsePDF con un buffer que no hace match con el cache en memoria directamente,
    // forzando la detección y el onboarding.
    await parsePDF(Buffer.from('force_onboarding_statement_jaccard'));

    // 4. Verificar que se reutilizó el bankId existente
    const allProfiles = await db.bankProfile.findMany();
    expect(allProfiles.length).toBe(1);
    expect(allProfiles[0].bankId).toBe('galicia-business-existente');
  });

  it('debe respetar el cooldown de 24 horas y no gatillar Self-Healing si el perfil ya falló recientemente y tiene requiresReview: true', async () => {
    // 1. Crear un perfil que requiere revisión (requiresReview: true)
    await db.bankProfile.create({
      data: {
        bankId: 'galicia-cooldown',
        bankName: 'Banco Galicia Cooldown',
        fingerprints: JSON.stringify(['Galicia Cooldown', 'Galicia Cooldown Business']),
        requiresReview: true,
        isActive: true,
        config: JSON.stringify({
          layoutType: 'SINGLE_AMOUNT_COLUMN',
          lineGroupingTolerancePx: 5,
          numberFormat: {
            decimalSeparator: ',',
            thousandsSeparator: '.',
            negativeIndicator: '-',
            negativePosition: 'PREFIX'
          },
          rules: {
            anchor: {
              regex: '^\\d{2}/\\d{2}/\\d{4}$',
              columnRange: [0.0, 0.20]
            },
            columns: {
              date: [0.0, 0.20],
              description: [0.20, 0.80],
              amount: [0.80, 1.00]
            },
            metadata: {
              accountNumber: [{ regex: 'Cuenta:\\s*([0-9-]+)', captureGroup: 1 }],
              initialBalance: [{ regex: 'Saldo Inicial:\\s*\\$?([0-9.,-]+)', captureGroup: 1 }],
              finalBalance: [{ regex: 'Saldo Final:\\s*\\$?([0-9.,-]+)', captureGroup: 1 }]
            }
          }
        })
      }
    });

    // 2. Mockear el PDF con transacciones incorrectas para gatillar un fallo matemático
    customGetDocumentMock = vi.fn().mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({
            items: createPdfItems('Banco Galicia Cooldown', '1.000,00|2.000,00', [
              { date: '10/05/2026', desc: 'Deposito Mock Galicia', amount: '400,00' }
            ])
          })
        })
      })
    });

    // 3. Ejecutar parsePDF. El self-healing está deshabilitado.
    const result = await parsePDF(Buffer.from('mock_galicia_cooldown_statement'));

    // 4. Verificar que no se llamó al LLM y devuelve el warning adecuado
    expect(mockCreateChatCompletion).not.toHaveBeenCalled();
    expect(result.warnings.some(w => w.includes('La reconciliación matemática falló'))).toBe(true);
  });

  it('debe manejar de manera segura PDFs donde no se pueden extraer los saldos iniciales/finales, omitir reconciliación y registrar advertencias', async () => {
    // 1. Crear un perfil válido en la base de datos
    await db.bankProfile.create({
      data: {
        bankId: 'galicia-sin-saldos',
        bankName: 'Banco Galicia Sin Saldos',
        fingerprints: JSON.stringify(['Galicia Missing', 'Galicia Missing Business']),
        requiresReview: false,
        isActive: true,
        config: JSON.stringify({
          layoutType: 'SINGLE_AMOUNT_COLUMN',
          lineGroupingTolerancePx: 5,
          numberFormat: {
            decimalSeparator: ',',
            thousandsSeparator: '.',
            negativeIndicator: '-',
            negativePosition: 'PREFIX'
          },
          rules: {
            anchor: {
              regex: '^\\d{2}/\\d{2}/\\d{4}$',
              columnRange: [0.0, 0.20]
            },
            columns: {
              date: [0.0, 0.20],
              description: [0.20, 0.80],
              amount: [0.80, 1.00]
            },
            metadata: {
              accountNumber: [{ regex: 'Cuenta:\\s*([0-9-]+)', captureGroup: 1 }],
              initialBalance: [{ regex: 'Saldo Inicial Inexistente:\\s*\\$?([0-9.,-]+)', captureGroup: 1 }],
              finalBalance: [{ regex: 'Saldo Final Inexistente:\\s*\\$?([0-9.,-]+)', captureGroup: 1 }]
            }
          }
        })
      }
    });

    // 2. Mockear el PDF sin saldos iniciales ni finales
    customGetDocumentMock = vi.fn().mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({
            items: createPdfItems('Banco Galicia Missing Balances', '', [
              { date: '10/05/2026', desc: 'Deposito Mock Galicia', amount: '400,00' }
            ])
          })
        })
      })
    });

    // 3. Ejecutar parsePDF
    const result = await parsePDF(Buffer.from('mock_galicia_sin_saldos_statement'));

    // 4. Verificar que no explota, marca mathValid como false, y agrega los warnings correspondientes
    expect(result.mathValid).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.includes('No se pudo extraer el saldo'))).toBe(true);
  });
});
