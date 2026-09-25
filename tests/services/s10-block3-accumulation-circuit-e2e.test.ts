// S10 Block 3 — continuous accumulative-learning certification (TEST ONLY).
//
// Closes the certified BLOCK_3_GAP=TEST_ONLY on the REAL test database.
//
// One causal circuit, no module mocks of the property under test.
//
// THREE asserted states establish the controlled causal model:
//
//   STATE_1  1 real observation
//             → discoverStructuralCandidateForGroup → 'single_observation'
//             → insufficient evidence to create a structural candidate
//             → resolveImportDecision(future unseen description)
//             → source='rule_engine'   (fallback REACHABLE, boundary LIVE)
//
//   STATE_2  + 2 more real observations (same company/entity/GL/direction)
//             → real structural discovery → real candidate persisted
//             → candidate NOT authorized
//             → resolveImportDecision(SAME future unseen description)
//             → source='rule_engine'   (accumulation alone is NOT enough)
//
//   STATE_3  same accumulated candidate, now really authorized
//             → resolveImportDecision(SAME future unseen description)
//             → source='ke'             (fallback NOT reached)
//
// Therefore accumulation is NECESSARY to make structural knowledge
// authorizable, and authorization is INDEPENDENTLY NECESSARY before that
// accumulated knowledge can change future behavior. Accumulation alone
// does NOT change behavior: STATE_2 proves it. Only authorized accumulated
// knowledge changes future behavior: STATE_3 proves it.
//
// Observability: `resolveRule` is a PARAMETER of resolveImportDecision, not
// an imported module, so observing it requires no mocking at all. That
// callback is the only path from the decision pipeline to
// resolveImportRule → runRuleEngineV2, which is the single product boundary
// producing BOTH the deterministic v2 evaluation and the AI proposal
// (rule-engine-adapter/index.ts:133 evaluateRulesWithAiFallback). STATE_1
// proves the fallback boundary is live in this run; STATE_2 proves that
// accumulated but unauthorized knowledge still falls through; STATE_3 proves
// that after authorization the final resolution bypasses that boundary — so
// its unchanged call count is informative, not vacuous.
//
// Real and not mocked: db, createAdapter, recordClassificationObservation,
// getClassificationObservationRecords, discoverStructuralCandidateForGroup,
// discoverStructuralCandidate, recordStructuralCandidate,
// authorizeStructuralCandidate, matchAuthorizedPattern, resolveEntity,
// lookupTreatment and resolveImportDecision. The human authorization gate is
// preserved exactly as designed — this test never inserts an authorized
// pattern directly.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '@/lib/db';
import { resolveImportDecision } from '@/lib/services/import.service';
import {
  createAdapter,
  recordClassificationObservation,
  getClassificationObservationRecords,
  discoverStructuralCandidateForGroup,
  recordStructuralCandidate,
  authorizeStructuralCandidate,
  type StructuralGroupKey,
} from '@/memory/classification-knowledge';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  clearDatabase,
} from '../helpers/factories';

const COMPANY_LEGAL_NAME = 'block3-accum Co';

// The future, never-observed description. It shares the STABLE token
// positions with the observed descriptions, and differs only at the VARIABLE
// middle position — which is exactly what structural generalization learns.
const FUTURE_DESCRIPTION = 'ABC 999 XYZ';
const OBSERVED_DESCRIPTIONS = ['ABC 111 XYZ', 'ABC 222 XYZ', 'ABC 333 XYZ'];

// This file's companyKnowledge rows must go BEFORE clearDatabase(): the shared
// helper cannot delete them (restrict FK blocks the company cascade) and
// never discovers companies whose membership is already gone. Only rows of
// this file's own company are touched.
async function purgeOwnFixtures() {
  const companies = await db.company.findMany({
    where: { legalName: COMPANY_LEGAL_NAME },
    select: { id: true },
  });
  const ids = companies.map((c) => c.id);
  if (ids.length === 0) return;
  await db.memoryItem.deleteMany({ where: { companyId: { in: ids } } }).catch(() => {});
  await db.memoryVersion.deleteMany({ where: { companyId: { in: ids } } }).catch(() => {});
  await db.glAccount.deleteMany({ where: { companyId: { in: ids } } }).catch(() => {});
  await db.companyMember.deleteMany({ where: { companyId: { in: ids } } }).catch(() => {});
  await db.companyKnowledge.deleteMany({ where: { companyId: { in: ids } } }).catch(() => {});
  await db.company.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
}

async function setup() {
  const user = await createTestUser('block3-accum@example.com');
  const company = await createTestCompany('block3-accum');
  await createTestCompanyMember(user.id, company.id);

  const gl = await createTestGlAccount({
    companyId: company.id,
    code: '6100',
    name: 'Accumulated treatment',
    accountType: 'expense',
  });

  // Entity identity fixture: the company already knows this merchant under a
  // canonical name plus the alias that will later be resolved WITHOUT any
  // observation. Knowing the ENTITY is not knowing its GL TREATMENT — the
  // treatment for FUTURE_DESCRIPTION is never observed and never learned.
  const entity = await db.companyKnowledge.create({
    data: {
      companyId: company.id,
      type: 'COMPANY',
      canonicalName: 'ACME MERCHANT',
      aliases: [FUTURE_DESCRIPTION],
      metadata: {},
      source: 'test',
      status: 'active',
    },
  });

  return { user, company, gl, entity, adapter: createAdapter(db, (fn) => db.$transaction(fn)) };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function observe(
  s: Setup,
  originalDescription: string,
  transactionId: string,
) {
  return recordClassificationObservation(s.adapter, s.company.id, {
    entityId: s.entity.id,
    originalDescription,
    glAccountId: s.gl.id,
    direction: 'any',
    source: 'user_correction',
    transactionId,
  });
}

function groupKey(s: Setup): StructuralGroupKey {
  return {
    companyId: s.company.id,
    entityId: s.entity.id,
    glAccountId: s.gl.id,
    direction: 'any',
  };
}

describe('S10 Block 3 — accumulative learning changes future behavior (real DB)', () => {
  beforeEach(async () => {
    await purgeOwnFixtures();
    await clearDatabase();
  });

  afterEach(async () => {
    await purgeOwnFixtures();
    await clearDatabase();
  });

  it('one observation yields no reusable statistical behavior; accumulated observations resolve a never-seen description without the rule engine or AI', async () => {
    const s = await setup();

    // ─── STATE_1 — exactly ONE real observation ──────────────────────────
    const first = await observe(s, OBSERVED_DESCRIPTIONS[0]!, 'tx-1');
    expect(first.ok).toBe(true);

    const observationsA = await getClassificationObservationRecords(
      s.adapter,
      s.company.id,
      s.entity.id,
    );
    expect(observationsA).toHaveLength(1);

    // The real discovery authority refuses to generalize from a single
    // observation — there is nothing to compare.
    const discoveryA = await discoverStructuralCandidateForGroup(s.adapter, groupKey(s));
    expect(discoveryA.kind).toBe('none');
    if (discoveryA.kind === 'none') {
      expect(discoveryA.reason).toBe('single_observation');
    }

    // Control: the future description was never observed.
    const observedDescriptions = observationsA.map((r) => r.observation.originalDescription);
    expect(observedDescriptions).not.toContain(FUTURE_DESCRIPTION);

    // Fallback boundary is LIVE and reachable in this run.
    const resolveRule = vi
      .fn()
      .mockResolvedValue({ matchedRuleId: 'rule-A', glAccountId: 'gl_FALLBACK' });
    const decisionA = await resolveImportDecision(
      s.adapter,
      s.company.id,
      FUTURE_DESCRIPTION,
      resolveRule,
    );

    // STATE_1: no statistical authority — the pipeline falls through.
    expect(decisionA.source).toBe('rule_engine');
    expect(decisionA.glAccountId).toBe('gl_FALLBACK');
    expect(decisionA.matchedRuleId).toBe('rule-A');
    expect(resolveRule).toHaveBeenCalledTimes(1);

    // ─── STATE_2 — accumulate to the real threshold ───────────────────────
    for (let i = 1; i < OBSERVED_DESCRIPTIONS.length; i++) {
      const rec = await observe(s, OBSERVED_DESCRIPTIONS[i]!, `tx-${i + 1}`);
      expect(rec.ok).toBe(true);
    }

    const observationsB = await getClassificationObservationRecords(
      s.adapter,
      s.company.id,
      s.entity.id,
    );
    expect(observationsB).toHaveLength(OBSERVED_DESCRIPTIONS.length);

    // Real discovery over the accumulated group, same company/entity/GL/direction.
    const discoveryB = await discoverStructuralCandidateForGroup(s.adapter, groupKey(s));
    expect(discoveryB.kind).toBe('candidate');
    if (discoveryB.kind !== 'candidate') return;
    expect(discoveryB.candidate.companyId).toBe(s.company.id);
    expect(discoveryB.candidate.entityId).toBe(s.entity.id);
    expect(discoveryB.candidate.glAccountId).toBe(s.gl.id);
    expect(discoveryB.candidate.observationIds).toHaveLength(
      OBSERVED_DESCRIPTIONS.length,
    );

    // Real candidate persistence through the productive authority.
    const recorded = await recordStructuralCandidate(s.adapter, discoveryB.candidate);
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    // A candidate alone changes nothing — it is not yet knowledge.
    const beforeAuth = await resolveImportDecision(
      s.adapter,
      s.company.id,
      FUTURE_DESCRIPTION,
      vi.fn().mockResolvedValue({ matchedRuleId: 'rule-B', glAccountId: 'gl_FALLBACK' }),
    );
    expect(beforeAuth.source).toBe('rule_engine');

    // Real human authorization — the gate the product already requires.
    const auth = await authorizeStructuralCandidate(
      s.adapter,
      s.company.id,
      recorded.candidateId,
      s.user.id,
    );
    expect(auth.status).toBe('AUTHORIZED');

    // ─── STATE_3 resolution — SAME never-seen description ────────────────
    const resolveRuleFinal = vi
      .fn()
      .mockResolvedValue({ matchedRuleId: 'rule-FINAL', glAccountId: 'gl_FALLBACK' });
    const decisionB = await resolveImportDecision(
      s.adapter,
      s.company.id,
      FUTURE_DESCRIPTION,
      resolveRuleFinal,
    );

    // The accumulated-and-authorized evidence now decides.
    expect(decisionB.source).toBe('ke');
    expect(decisionB.glAccountId).toBe(s.gl.id);
    expect(decisionB.matchedRuleId).toBeNull();

    // Neither the deterministic v2 engine nor the AI provider was reached.
    expect(resolveRuleFinal).not.toHaveBeenCalled();

    // The three states, asserted together, ARE the causal proof. All three
    // resolve the SAME never-seen description, so the only varying input is
    // the accumulated evidence and its authorization:
    //   STATE_1 (1 observation, no candidate)          → 'rule_engine'
    //   STATE_2 (accumulated, candidate NOT authorized) → 'rule_engine'
    //   STATE_3 (accumulated, candidate authorized)     → 'ke'
    // Consequently: accumulation is necessary, authorization is independently
    // necessary, accumulation ALONE does not change behavior, and authorized
    // accumulated knowledge does. Kept as an explicit end-state restatement
    // rather than as a stand-alone "accumulation alone caused it" claim.
    expect(decisionA.source).toBe('rule_engine');
    expect(beforeAuth.source).toBe('rule_engine');
    expect(decisionB.source).toBe('ke');
    expect(decisionA.source).not.toBe(decisionB.source);
  });
});
