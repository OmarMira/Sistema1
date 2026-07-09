import { logger } from '@/lib/logger';
import ZAI from 'z-ai-web-dev-sdk';
import crypto from 'crypto';
import {
  BankProfileConfigSchema,
  BankProfileTyped,
  BankProfileConfig,
} from './bank-profile-schema';
import { getAllActiveProfiles, upsertBankProfile } from './bank-profile-service';
import { getAiConfig } from '@/lib/ai-config';

export interface PdfAnalysisData {
  fullText: string;
  pageWidth: number;
  blocksWithCoordinates: Array<{
    text: string;
    x: number;
    y: number;
    width: number;
    page: number;
  }>;
  firstPageSample: string;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Validates syntax of a regex and performs a simple ReDoS sanity check.
 */
export function validateRegex(regexStr: string, fieldName: string): void {
  try {
    const regex = new RegExp(regexStr);
    const testStrings = [
      'a'.repeat(100),
      '01/01/26',
      '$1,234.56',
      'Account number: 1234567890',
      'continued on the next page',
      'Withdrawals and other debits- continued',
    ];
    const startTime = Date.now();
    for (const testStr of testStrings) {
      regex.test(testStr);
      if (Date.now() - startTime > 100) {
        throw new Error(`Regex for ${fieldName} timed out (possible ReDoS vulnerability)`);
      }
    }
  } catch (err) {
    throw new Error(
      `Invalid regex for ${fieldName} ("${regexStr}"): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Uses Jaccard Similarity index (threshold >= 0.6) to find if an existing profile
 * matches the new fingerprints.
 */
export async function findExistingProfile(
  newFingerprints: string[],
): Promise<BankProfileTyped | null> {
  const allProfiles = await getAllActiveProfiles();
  const set1 = new Set(newFingerprints.map((f) => f.toLowerCase().trim()));

  for (const profile of allProfiles) {
    const set2 = new Set(profile.fingerprints.map((f) => f.toLowerCase().trim()));
    const intersection = new Set([...set1].filter((x) => set2.has(x)));
    const union = new Set([...set1, ...set2]);

    if (union.size === 0) continue;
    const similarity = intersection.size / union.size;

    if (similarity >= 0.6) {
      return profile;
    }
  }
  return null;
}

const LLM_TIMEOUT_MS = 15000;

export async function createProfileFromPdf(
  analysisData: PdfAnalysisData,
): Promise<BankProfileTyped> {
  const zai = await ZAI.create();

  // Prepare coordinate samples (first 100 blocks)
  const coordinateSample = analysisData.blocksWithCoordinates.slice(0, 100).map((b) => ({
    text: b.text,
    relativeX: (b.x / analysisData.pageWidth).toFixed(3),
    y: Math.round(b.y),
    page: b.page,
  }));

  const systemPrompt = `You are an expert financial system architect and bank statement parser analyst.
Your task is to analyze the text and coordinate samples of a PDF bank statement and generate a JSON configuration that allows parsing it automatically.

You must output a single, raw JSON object matching the following structure:
{
  "bankName": string, // Full readable name (e.g. "Wells Fargo")
  "fingerprints": string[], // 3-5 unique phrases/keywords found in ALL statements of this bank. Exclude dates, account numbers, amounts, balances.
  "config": {
    "layoutType": "SINGLE_AMOUNT_COLUMN" | "DUAL_AMOUNT_COLUMN",
    "lineGroupingTolerancePx": number, // Usually 5
    "numberFormat": {
      "decimalSeparator": "." | ",",
      "thousandsSeparator": "," | ".",
      "negativeIndicator": string, // e.g. "MINUS_SIGN" or "-"
      "negativePosition": "PREFIX" | "SUFFIX" | "PARENTHESES" | "TEXT_SUFFIX"
    },
    "rules": {
      "anchor": {
        "regex": string, // Regex to identify date headers starting transaction lines (e.g. "^\\\\d{2}/\\\\d{2}/\\\\d{2}$" or "^\\\\d{1,2}/\\\\d{1,2}/\\\\d{4}$")
        "columnRange": [number, number] // Percentage boundaries in page width where anchor is found, between 0.0 and 1.0 (e.g. [0.0, 0.15])
      },
      "columns": {
        "date": [number, number], // boundaries between 0.0 and 1.0 (relativeX)
        "description": [number, number], // boundaries between 0.0 and 1.0 (relativeX)
        "amount": [number, number], // required if layoutType is SINGLE_AMOUNT_COLUMN (e.g. [0.80, 1.00])
        "debit": [number, number], // required if layoutType is DUAL_AMOUNT_COLUMN
        "credit": [number, number] // required if layoutType is DUAL_AMOUNT_COLUMN
      },
      "metadata": {
        "accountNumber": [{ "regex": string, "captureGroup": number }],
        "initialBalance": [{ "regex": string, "captureGroup": number }],
        "finalBalance": [{ "regex": string, "captureGroup": number }]
      },
      "stopSectionRegex": string, // optional regex to identify where transaction section ends (e.g. "Daily ledger balances|Saldos diarios")
      "continuationMarkers": string[], // optional continuation strings (e.g. ["continued on the next page"])
      "sectionContinuationRegex": string, // optional regex for continuing headers (e.g. "Withdrawals and other debits- continued")
      "totalLinePatterns": string[] // optional regex patterns to exclude total sum lines (e.g. ["^Total\\\\s+"])
    }
  }
}

CRITICAL RULES:
1. COORDENADAS PORCENTUALES (relativeX):
   Use the relativeX coordinates in the sample to map columns.
   - For example, if transaction date is at relativeX 0.08, date range should be [0.0, 0.15].
   - If description is between 0.16 and 0.75, description range should be [0.15, 0.80].
   - If amount is at 0.85, amount range should be [0.80, 1.00].
2. FINGERPRINTS:
   Pick 3-5 unique strings from the statement. Do not include user name, numbers, dates or balances.
3. METADATA REGEXES:
   Generate regexes to capture account number, initial/starting balance, and final/closing balance. Specify the correct captureGroup.
4. stopSectionRegex:
   Identify text like 'Daily ledger balances' or 'Daily ledger' to stop parsing transactions. Do NOT include transaction headers or sections that may contain actual transactions (e.g., 'Service fees' or 'Monthly fee') in stopSectionRegex if they list transactions underneath.

FEW-SHOT EXAMPLES:

EXAMPLE 1: Complete Bank of America Statement
TEXT:
"Bank of America, N.A.
1.888.BUSINESS
Beginning balance on March 1, 2025 $24,684.40
Deposits and other credits 3,000.00
Withdrawals and other debits -4,543.67
Ending balance on March 31, 2025 $23,140.73
Date Description Amount
03/03/25 Zelle payment from CLIENTE A Conf# a1b2c3 1,100.00
03/10/25 Zelle payment to PROVEEDOR B Conf# c2b1a3 -1,000.00
Total deposits and other credits $3,000.00
Total withdrawals and other debits -$4,543.67
Daily ledger balances
Date Balance
03/03 25,784.40
03/10 24,784.40"
RESULT:
{
  "bankName": "Bank of America Business",
  "fingerprints": ["Bank of America, N.A.", "1.888.BUSINESS", "Deposits and other credits"],
  "config": {
    "layoutType": "SINGLE_AMOUNT_COLUMN",
    "lineGroupingTolerancePx": 5,
    "numberFormat": {
      "decimalSeparator": ".",
      "thousandsSeparator": ",",
      "negativeIndicator": "MINUS_SIGN",
      "negativePosition": "PREFIX"
    },
    "rules": {
      "anchor": {
        "regex": "^\\\\d{2}/\\\\d{2}/\\\\d{2}$",
        "columnRange": [0.0, 0.15]
      },
      "columns": {
        "date": [0.0, 0.15],
        "description": [0.15, 0.80],
        "amount": [0.80, 1.00]
      },
      "metadata": {
        "accountNumber": [{"regex": "Account number:\\\\s*([0-9\\\\s]+)", "captureGroup": 1}],
        "initialBalance": [{"regex": "Beginning balance on [^$]+\\\\$([0-9,.-]+)", "captureGroup": 1}],
        "finalBalance": [{"regex": "Ending balance on [^$]+\\\\$([0-9,.-]+)", "captureGroup": 1}]
      },
      "stopSectionRegex": "Daily ledger balances|Account summary|Service fees",
      "totalLinePatterns": ["^Total\\\\s+deposits", "^Total\\\\s+withdrawals"]
    }
  }
}

EXAMPLE 2: Statement with Empty Deposits Section
TEXT:
"Bank of America, N.A.
1.888.BUSINESS
Beginning balance on February 1, 2025 $34,461.61
Deposits and other credits 0.00
Withdrawals and other debits -9,777.21
Ending balance on February 28, 2025 $24,684.40
Withdrawals and other debits
Date Description Amount
02/10/25 Wire Transfer -9,777.21
Total withdrawals and other debits -$9,777.21"
RESULT:
{
  "bankName": "Bank of America Business",
  "fingerprints": ["Bank of America, N.A.", "1.888.BUSINESS", "Withdrawals and other debits"],
  "config": {
    "layoutType": "SINGLE_AMOUNT_COLUMN",
    "lineGroupingTolerancePx": 5,
    "numberFormat": {
      "decimalSeparator": ".",
      "thousandsSeparator": ",",
      "negativeIndicator": "MINUS_SIGN",
      "negativePosition": "PREFIX"
    },
    "rules": {
      "anchor": {
        "regex": "^\\\\d{2}/\\\\d{2}/\\\\d{2}$",
        "columnRange": [0.0, 0.15]
      },
      "columns": {
        "date": [0.0, 0.15],
        "description": [0.15, 0.80],
        "amount": [0.80, 1.00]
      },
      "metadata": {
        "accountNumber": [{"regex": "Account number:\\\\s*([0-9\\\\s]+)", "captureGroup": 1}],
        "initialBalance": [{"regex": "Beginning balance on [^$]+\\\\$([0-9,.-]+)", "captureGroup": 1}],
        "finalBalance": [{"regex": "Ending balance on [^$]+\\\\$([0-9,.-]+)", "captureGroup": 1}]
      },
      "stopSectionRegex": "Daily ledger balances|Account summary|Service fees",
      "totalLinePatterns": ["^Total\\\\s+withdrawals", "^Total\\\\s+deposits"]
    }
  }
}

EXAMPLE 3: Statement with Page Cut / Split Transactions
TEXT:
"01/29/25 Zelle payment to CLIENTE C Conf# x3j4 -1,000.00
continued on the next page
---PAGE_BREAK---
Withdrawals and other debits- continued
Date Description Amount
01/29/25 TARJETA CORPORATIVA DES:ACH PMT -3,543.67"
RESULT:
{
  "bankName": "Bank of America Business",
  "fingerprints": ["Bank of America, N.A.", "1.888.BUSINESS"],
  "config": {
    "layoutType": "SINGLE_AMOUNT_COLUMN",
    "lineGroupingTolerancePx": 5,
    "numberFormat": {
      "decimalSeparator": ".",
      "thousandsSeparator": ",",
      "negativeIndicator": "MINUS_SIGN",
      "negativePosition": "PREFIX"
    },
    "rules": {
      "anchor": {
        "regex": "^\\\\d{2}/\\\\d{2}/\\\\d{2}$",
        "columnRange": [0.0, 0.15]
      },
      "columns": {
        "date": [0.0, 0.15],
        "description": [0.15, 0.80],
        "amount": [0.80, 1.00]
      },
      "metadata": {
        "accountNumber": [{"regex": "Account number:\\\\s*([0-9\\\\s]+)", "captureGroup": 1}],
        "initialBalance": [{"regex": "Beginning balance on [^$]+\\\\$([0-9,.-]+)", "captureGroup": 1}],
        "finalBalance": [{"regex": "Ending balance on [^$]+\\\\$([0-9,.-]+)", "captureGroup": 1}]
      },
      "stopSectionRegex": "Daily ledger balances|Account summary|Service fees",
      "continuationMarkers": ["continued on the next page"],
      "sectionContinuationRegex": "Withdrawals and other debits- continued|Deposits and other credits- continued",
      "totalLinePatterns": ["^Total\\\\s+withdrawals", "^Total\\\\s+deposits"]
    }
  }
}

IMPORTANT: Return ONLY the JSON object. Do not include markdown codeblocks (like \`\`\`json) or any conversational text.`;

  const userPrompt = `TEXTO DEL PDF (primeros 2000 caracteres — suficiente para identificar el layout y fingerprints):
${analysisData.fullText.slice(0, 2000)}

MUESTRA DE COORDENADAS (primeros 100 bloques):
${JSON.stringify(coordinateSample, null, 2)}

CRITICAL: Do NOT invent or fabricate data. Only use patterns you can clearly identify in the provided text. If you are unsure about a column boundary, estimate conservatively (wider range). Never hallucinate amounts, balances, or account numbers.`;

  let lastError: unknown = null;

  logger.info('LLM inference for bank profile creation', { temperature: 0 });

  let aiModel = 'google/gemini-2.5-flash';
  try {
    const aiConfig = await getAiConfig();
    if (aiConfig.model && aiConfig.model !== 'openrouter/free') {
      aiModel = aiConfig.model;
    }
  } catch {
    // Use default model
  }

  try {
    const response = await Promise.race([
      zai.chat.completions.create({
        model: aiModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 1500,
        temperature: 0,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('LLM call timed out')), LLM_TIMEOUT_MS),
      ),
    ]);

    const content = response.choices?.[0]?.message?.content || '';
    if (!content) {
      throw new Error('AI returned an empty response.');
    }

    // Clean markdown code blocks
    let cleanJson = content.trim();
    if (cleanJson.startsWith('```')) {
      const lines = cleanJson.split('\n');
      if (lines[0].startsWith('```json') || lines[0].startsWith('```')) {
        lines.shift();
      }
      if (lines[lines.length - 1].startsWith('```')) {
        lines.pop();
      }
      cleanJson = lines.join('\n').trim();
    }

    const parsed = JSON.parse(cleanJson);

    // Validate fingerprints
    if (
      !parsed.fingerprints ||
      !Array.isArray(parsed.fingerprints) ||
      parsed.fingerprints.length === 0
    ) {
      throw new Error('LLM did not generate any fingerprints. Cannot create profile.');
    }
    if (parsed.fingerprints.length < 3) {
      logger.warn('LLM generated few fingerprints', { count: parsed.fingerprints.length });
    }

    const validatedConfig = BankProfileConfigSchema.parse(parsed.config);

    // Validate all generated regexes
    validateRegex(validatedConfig.rules.anchor.regex, 'anchor');
    for (const rule of validatedConfig.rules.metadata.accountNumber) {
      validateRegex(rule.regex, 'metadata.accountNumber');
    }
    for (const rule of validatedConfig.rules.metadata.initialBalance) {
      validateRegex(rule.regex, 'metadata.initialBalance');
    }
    for (const rule of validatedConfig.rules.metadata.finalBalance) {
      validateRegex(rule.regex, 'metadata.finalBalance');
    }
    if (validatedConfig.rules.stopSectionRegex) {
      validateRegex(validatedConfig.rules.stopSectionRegex, 'stopSectionRegex');
    }
    if (validatedConfig.rules.sectionContinuationRegex) {
      validateRegex(validatedConfig.rules.sectionContinuationRegex, 'sectionContinuationRegex');
    }
    if (validatedConfig.rules.totalLinePatterns) {
      for (const pattern of validatedConfig.rules.totalLinePatterns) {
        validateRegex(pattern, 'totalLinePatterns');
      }
    }

    const bankName = parsed.bankName || 'Inferred Bank Profile';
    const fingerprints = parsed.fingerprints;

    // Find if an existing profile is Jaccard matched (>= 0.6)
    const existingProfile = await findExistingProfile(fingerprints);

    if (existingProfile) {
      logger.info('Updating existing profile with new config', {
        bankId: existingProfile.bankId,
      });
      const profile = await upsertBankProfile(
        existingProfile.bankId,
        existingProfile.bankName,
        fingerprints,
        validatedConfig,
        true,
      );
      return profile;
    } else {
      const sortedFp = [...fingerprints].sort().join('|');
      const bankId = `auto-${sha256(sortedFp).slice(0, 12)}`;
      logger.info('Creating new profile', { bankId });
      const profile = await upsertBankProfile(
        bankId,
        bankName,
        fingerprints,
        validatedConfig,
        true,
      );
      return profile;
    }
  } catch (err) {
    logger.warn('Single LLM inference attempt failed', { error: err });
    lastError = err;
  }

  throw new Error(
    `Failed to generate valid bank profile. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
