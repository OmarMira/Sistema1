import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Imported before pdfjs is used directly: pdf-parser's module body configures
// the shared pdfjs worker for Node before the ground-truth extraction runs.
import { parsePDF } from '@/lib/pdf-parser';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { db } from '@/lib/db';
import { invalidateAllProfilesCache } from '@/lib/bank-profile-service';
import { clearDatabase } from '../helpers/factories';

/**
 * Block 5 — Phase 1H.1: coordinate sampling repair, verified causally
 * against the physical statement fixture.
 *
 * Only the external inference boundary (z-ai-web-dev-sdk) is substituted; the
 * captured provider prompt is the product's real output. Ground truth (raw
 * blocks, pages, line geometry) is re-extracted independently with pdfjs in
 * this test, so every expectation is measured from the fixture — no block
 * lists, counts, or sample contents are written into the test as constants.
 */

// ── External boundary: inference provider only ──────────────────────────────
const llmCreate = vi.hoisted(() => vi.fn());

vi.mock('z-ai-web-dev-sdk', () => ({
  default: {
    create: async () => ({
      chat: {
        completions: {
          create: (args: unknown) => llmCreate(args),
        },
      },
    }),
  },
}));

// ── Fixture ─────────────────────────────────────────────────────────────────
const FIXTURE_DIR = join(__dirname, '../fixtures/boa-statements');
const FIXTURE_NAME = 'eStmt_2025-03-31.pdf';
const BUDGET = 100;
const EXAMPLES_MARKER = 'FEW-SHOT EXAMPLES:';
const SAMPLE_HEADER = 'MUESTRA DE COORDENADAS';
const DATE_ANCHOR = /^\d{2}\/\d{2}\/\d{2}$/;

// Deterministic provider-equivalent answer: the same product-valid config
// shape the certified E2E test uses, so the onboarding path completes for real.
const PROVIDER_RESPONSE = {
  bankName: 'Bank of America',
  fingerprints: ['Bank of America, N.A.', 'Business Advantage Relationship Banking'],
  config: {
    layoutType: 'SINGLE_AMOUNT_COLUMN',
    lineGroupingTolerancePx: 5,
    numberFormat: {
      decimalSeparator: '.',
      thousandsSeparator: ',',
      negativeIndicator: 'MINUS_SIGN',
      negativePosition: 'PREFIX',
    },
    rules: {
      anchor: {
        regex: '^\\d{2}/\\d{2}/\\d{2}$',
        columnRange: [0.0, 0.18],
      },
      columns: {
        date: [0.0, 0.18],
        description: [0.12, 0.8],
        amount: [0.8, 1.0],
      },
      metadata: {
        accountNumber: [
          {
            regex:
              '(?:Account number|Account\\s*#|Account\\s*no\\.?|Account\\s*Number):?\\s*([0-9\\s\\-]+)',
            captureGroup: 1,
          },
        ],
        initialBalance: [
          {
            regex:
              '(?:Beginning|Starting|Opening)\\s+balance(?:\\s+on\\s+[^$]+)?\\s+\\$?([0-9,.-]+)',
            captureGroup: 1,
          },
        ],
        finalBalance: [
          {
            regex:
              '(?:Ending|Closing|New)\\s+balance(?:\\s+on\\s+[^$]+)?\\s+\\$?([0-9,.-]+)',
            captureGroup: 1,
          },
        ],
      },
      stopSectionRegex: 'Daily ledger balances|Account summary',
    },
  },
};

// ── Ground truth: independent pdfjs extraction of the physical fixture ──────
interface RawBlock {
  page: number;
  text: string;
  x: number;
  y: number;
  lineKey: number;
}

interface GroundTruth {
  blocks: RawBlock[];
  pageWidth: number;
  pageCount: number;
}

interface SampleEntry {
  text: string;
  relativeX: string;
  y: number;
  page: number;
}

async function extractGroundTruth(pdfBuffer: Buffer): Promise<GroundTruth> {
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    useWorkerFetch: false,
    useSystemFonts: true,
  }).promise;

  const blocks: RawBlock[] = [];
  let pageWidth = 612;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport ? page.getViewport({ scale: 1.0 }) : null;
    if (viewport && viewport.width) {
      pageWidth = viewport.width;
    } else if (page.view && page.view[2]) {
      pageWidth = page.view[2];
    }

    const textContent = await page.getTextContent();
    const items = textContent.items as Array<{ str: string; transform: number[] }>;
    const lineMap = new Map<number, Array<{ str: string; x: number; y: number }>>();
    for (const item of items) {
      if (!item.str || item.str.trim() === '') continue;
      const lineKey = Math.round(item.transform[5] * 2) / 2;
      const line = lineMap.get(lineKey);
      const entry = { str: item.str, x: item.transform[4], y: item.transform[5] };
      if (line) line.push(entry);
      else lineMap.set(lineKey, [entry]);
    }

    // Page order, top-of-page lines first, x ascending — the raw reading order.
    for (const lineKey of Array.from(lineMap.keys()).sort((a, b) => b - a)) {
      const line = lineMap.get(lineKey)!.slice().sort((a, b) => a.x - b.x);
      for (const item of line) {
        blocks.push({ page: pageNum, text: item.str, x: item.x, y: item.y, lineKey });
      }
    }
  }

  return { blocks, pageWidth, pageCount: pdf.numPages };
}

function tupleOfRaw(block: RawBlock, pageWidth: number): string {
  return `${block.page}|${block.text}|${(block.x / pageWidth).toFixed(3)}|${Math.round(block.y)}`;
}

function tupleOfSample(entry: SampleEntry): string {
  return `${entry.page}|${entry.text}|${entry.relativeX}|${entry.y}`;
}

function parseCoordinateSample(userPrompt: string): SampleEntry[] {
  const headerAt = userPrompt.indexOf(SAMPLE_HEADER);
  expect(headerAt).toBeGreaterThanOrEqual(0);
  const arrayStart = userPrompt.indexOf('[', headerAt);
  const arrayEnd = userPrompt.indexOf('\n\nCRITICAL:', arrayStart);
  expect(arrayStart).toBeGreaterThan(headerAt);
  expect(arrayEnd).toBeGreaterThan(arrayStart);
  return JSON.parse(userPrompt.slice(arrayStart, arrayEnd)) as SampleEntry[];
}

async function resetFormatState(): Promise<void> {
  await clearDatabase();
  // clearDatabase() does not cover BankProfile rows, and onboarding must start
  // from a provably empty format knowledge base.
  await db.bankProfile.deleteMany({});
  invalidateAllProfilesCache();
}

function installProviderDouble(): void {
  llmCreate.mockReset();
  llmCreate.mockImplementation(async () => ({
    choices: [{ message: { content: JSON.stringify(PROVIDER_RESPONSE) } }],
  }));
}

/** Runs the real parsePDF onboarding path and returns the captured prompt. */
async function runOnboarding(): Promise<{ systemPrompt: string; userPrompt: string }> {
  const pdfBuffer = readFileSync(join(FIXTURE_DIR, FIXTURE_NAME));
  await parsePDF(pdfBuffer, { fileName: FIXTURE_NAME });
  expect(llmCreate).toHaveBeenCalledTimes(1);
  const args = llmCreate.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
  const systemPrompt = args.messages.find((m) => m.role === 'system')?.content ?? '';
  const userPrompt = args.messages.find((m) => m.role === 'user')?.content ?? '';
  expect(systemPrompt.length).toBeGreaterThan(0);
  expect(userPrompt.length).toBeGreaterThan(0);
  return { systemPrompt, userPrompt };
}

describe('Block 5 — Phase 1H.1 coordinate sampling (physical fixture)', () => {
  let fixtureBuffer: Buffer;
  let groundTruth: GroundTruth;

  beforeAll(async () => {
    fixtureBuffer = readFileSync(join(FIXTURE_DIR, FIXTURE_NAME));
    expect(fixtureBuffer.length).toBeGreaterThan(0);
    groundTruth = await extractGroundTruth(fixtureBuffer);
  });

  beforeEach(async () => {
    await resetFormatState();
    installProviderDouble();
  });

  afterEach(async () => {
    await resetFormatState();
  });

  it('samples every page proportionally, spread vertically, beyond the first 100 raw blocks', async () => {
    // Physical fixture facts (measured here, not assumed).
    expect(groundTruth.blocks.length).toBeGreaterThan(BUDGET);
    expect(groundTruth.pageCount).toBeGreaterThan(1);

    const { userPrompt } = await runOnboarding();
    const sample = parseCoordinateSample(userPrompt);

    // SAMPLE_BUDGET_MAX_100
    expect(sample.length).toBeGreaterThan(0);
    expect(sample.length).toBeLessThanOrEqual(BUDGET);

    // Conservation: every sampled tuple exists in the fixture with the claimed
    // page — a block from a later page relabeled as page 1 fails here.
    const rawTupleSet = new Set(
      groundTruth.blocks.map((b) => tupleOfRaw(b, groundTruth.pageWidth)),
    );
    for (const entry of sample) {
      expect(rawTupleSet.has(tupleOfSample(entry))).toBe(true);
    }

    const rawPages = Array.from(new Set(groundTruth.blocks.map((b) => b.page))).sort(
      (a, b) => a - b,
    );
    const sampledPages = Array.from(new Set(sample.map((e) => e.page))).sort((a, b) => a - b);

    // REAL_PAGE_1/2/3_PRESENT
    expect(sampledPages).toContain(1);
    expect(sampledPages).toContain(2);
    expect(sampledPages).toContain(3);
    // LATER_PAGE_REPRESENTATION: the sample covers every page of the fixture
    // (the omitted pages of the first-100 prefix are exactly the later ones).
    expect(sampledPages).toEqual(rawPages);

    // The first 100 raw blocks cover only the earliest pages — measured prefix
    // behaviour that SAMPLE_IS_NOT_FIRST_100_PREFIX below compares against.
    const prefix = groundTruth.blocks.slice(0, BUDGET);
    const prefixPages = Array.from(new Set(prefix.map((b) => b.page)));
    expect(prefixPages.length).toBeLessThan(rawPages.length);

    const rawIndexByTuple = new Map<string, number>();
    groundTruth.blocks.forEach((block, index) => {
      const key = tupleOfRaw(block, groundTruth.pageWidth);
      if (!rawIndexByTuple.has(key)) rawIndexByTuple.set(key, index);
    });

    const sampleTuples = sample.map(tupleOfSample);
    const prefixTuples = prefix.map((b) => tupleOfRaw(b, groundTruth.pageWidth));
    // SAMPLE_IS_NOT_FIRST_100_PREFIX
    expect(sampleTuples).not.toEqual(prefixTuples.slice(0, sampleTuples.length));
    expect(sampleTuples.some((tuple) => (rawIndexByTuple.get(tuple) ?? -1) >= BUDGET)).toBe(
      true,
    );

    // PROPORTIONAL_PAGE_ALLOCATION: no page starved, and per-page selection
    // rates stay close together (equal-split and prefix sampling fail both).
    const rawCounts = new Map<number, number>();
    const sampledCounts = new Map<number, number>();
    for (const block of groundTruth.blocks) {
      rawCounts.set(block.page, (rawCounts.get(block.page) ?? 0) + 1);
    }
    for (const entry of sample) {
      sampledCounts.set(entry.page, (sampledCounts.get(entry.page) ?? 0) + 1);
    }
    const rates = rawPages.map(
      (page) => (sampledCounts.get(page) ?? 0) / (rawCounts.get(page) ?? 1),
    );
    for (const rate of rates) {
      expect(rate).toBeGreaterThan(0);
    }
    expect(Math.max(...rates) - Math.min(...rates)).toBeLessThanOrEqual(0.3);

    // VERTICAL_DISTRIBUTION on page 3: sampled lines must span the page, with
    // both the top and the bottom quarter represented — first-N sampling of a
    // page leaves the opposite quarter empty.
    const page3 = groundTruth.blocks.filter((b) => b.page === 3);
    const page3Lines = Array.from(new Set(page3.map((b) => b.lineKey))).sort((a, b) => b - a);
    expect(page3Lines.length).toBeGreaterThan(4);

    const sampledLineIndices = new Set<number>();
    for (const entry of sample) {
      if (entry.page !== 3) continue;
      const rawIndex = rawIndexByTuple.get(tupleOfSample(entry));
      if (rawIndex === undefined) continue;
      sampledLineIndices.add(page3Lines.indexOf(groundTruth.blocks[rawIndex].lineKey));
    }
    const indices = Array.from(sampledLineIndices).sort((a, b) => a - b);
    expect(indices.length).toBeGreaterThanOrEqual(2);
    const coverage = (indices[indices.length - 1] - indices[0]) / (page3Lines.length - 1);
    expect(coverage).toBeGreaterThanOrEqual(0.8);
    expect(indices.some((i) => i < page3Lines.length / 4)).toBe(true);
    expect(indices.some((i) => i >= (3 * page3Lines.length) / 4)).toBe(true);

    // PAGE3_TRANSACTION_GEOMETRY_PRESENT: at least one complete page-3
    // transaction row (anchor + its description/amount geometry, all blocks of
    // the line) is inside the sample.
    const anchorLineKeys = new Set(
      page3.filter((b) => DATE_ANCHOR.test(b.text.trim())).map((b) => b.lineKey),
    );
    expect(anchorLineKeys.size).toBeGreaterThan(0);
    const sampleSet = new Set(sampleTuples);
    const fullySampledAnchorLines = Array.from(anchorLineKeys).filter((key) =>
      page3
        .filter((b) => b.lineKey === key)
        .every((b) => sampleSet.has(tupleOfRaw(b, groundTruth.pageWidth))),
    );
    expect(fullySampledAnchorLines.length).toBeGreaterThanOrEqual(1);
  });

  it('prompt prescribes deriving bounds from the sample, with no fixed range repeated across examples', async () => {
    const { systemPrompt, userPrompt } = await runOnboarding();

    const examplesAt = systemPrompt.indexOf(EXAMPLES_MARKER);
    expect(examplesAt).toBeGreaterThan(0);
    const normative = systemPrompt.slice(0, examplesAt);

    // NO_{FIXED_DESCRIPTION,UNIVERSAL_FIXED_DATE,UNIVERSAL_FIXED_AMOUNT}_BOUND
    // _IN_NORMATIVE_PROMPT: no bracketed decimal range outside the few-shot
    // examples, while the derive-from-sample contract stays in force.
    expect(normative).not.toMatch(/\[\s*\d+\.\d+\s*,\s*\d+\.\d+\s*\]/);
    expect(normative).toContain('Derive boundary estimates from the coordinateSample provided');
    expect(normative).toContain('do NOT apply fixed universal ranges');

    // NO_PRESCRIPTIVE_FIXED_BOUND_PATTERN_IN_ALL_EXAMPLES: for every bound,
    // the three few-shot examples must show three distinct ranges.
    const exampleChunks = systemPrompt.slice(examplesAt).split(/EXAMPLE \d/).slice(1);
    expect(exampleChunks.length).toBe(3);
    const extractBound = (chunk: string, key: string): string | undefined =>
      chunk.match(new RegExp(`"${key}"\\s*:\\s*\\[([^\\]]+)\\]`))?.[1]?.trim();
    for (const key of ['columnRange', 'date', 'description', 'amount']) {
      const values = exampleChunks.map((chunk) => extractBound(chunk, key));
      expect(values.every((value) => value !== undefined)).toBe(true);
      expect(new Set(values).size).toBe(3);
    }

    // The coordinate-sample section must not claim a prefix of the blocks.
    const sampleHeader =
      userPrompt.split('\n').find((line) => line.includes(SAMPLE_HEADER)) ?? '';
    expect(sampleHeader.length).toBeGreaterThan(0);
    expect(sampleHeader).not.toMatch(/primeros/i);
  });

  it('DETERMINISTIC_SAMPLING: two independent onboarding runs send the identical sample', async () => {
    const first = parseCoordinateSample((await runOnboarding()).userPrompt);
    expect(first.length).toBeGreaterThan(0);

    await resetFormatState();
    installProviderDouble();

    const second = parseCoordinateSample((await runOnboarding()).userPrompt);
    expect(second.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });
});
