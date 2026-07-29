import path from 'node:path'
import { Evidence } from './evidence';
import { evaluatePolicy } from './policy';
import { createExecutionContract } from './contract-factory';
import { execute } from './execute';
import { verify } from './verify';
import { checkProtected, isOperationAllowed } from './protected-zones';
import type { Intent, Capability, ControllerResult } from './types';
import type { FileResource } from './resources/file-resource';

function writeEvidence(log: Evidence, state: Parameters<Evidence['write']>[0], intentId: string, detail: string, snapshot?: Record<string, string>): boolean {
  try {
    log.write(state, intentId, detail, snapshot);
    return true;
  } catch {
    return false;
  }
}

export function run(
  intent: Intent,
  capabilities: Capability[],
  resource: FileResource,
  evidence?: Evidence,
): ControllerResult {
  const log = evidence ?? new Evidence();

  if (intent.resourceType !== 'file') {
    writeEvidence(log, 'denied', intent.id, `Unsupported resource type: ${intent.resourceType}`);
    return { status: 'denied', reason: `Unsupported resource type: ${intent.resourceType}`, evidence: log.read() };
  }

  if (!writeEvidence(log, 'requested', intent.id, 'Intent received')) {
    return { status: 'failed', reason: 'Evidence write failed at requested', stage: 'evidence', evidence: log.read() };
  }

  const decision = evaluatePolicy(intent, capabilities);

  if (decision.mode === 'denied') {
    writeEvidence(log, 'denied', intent.id, decision.reason ?? 'Policy denied');
    return { status: 'denied', reason: decision.reason ?? 'Policy denied', evidence: log.read() };
  }

  if (decision.mode === 'requires-approval' || decision.mode === 'requires-dual') {
    writeEvidence(log, 'pending-approval', intent.id, `Requires ${decision.mode}`);
    return { status: 'pending-approval', mode: decision.mode, evidence: log.read() };
  }

  const targetPath = path.resolve(resource.workspace, intent.target);
  const protection = checkProtected(resource.workspace, targetPath);
  if (protection.blocked && !isOperationAllowed(protection.zone!.mode, intent.operation)) {
    const detail = `Protected zone: ${protection.zone!.prefix} — ${protection.zone!.reason}`;
    writeEvidence(log, 'denied', intent.id, detail);
    return { status: 'denied', reason: detail, evidence: log.read() };
  }

  const contract = createExecutionContract(intent);

  if (!writeEvidence(log, 'authorized', intent.id, 'Execution Contract created')) {
    return { status: 'failed', reason: 'Evidence write failed at authorized', stage: 'evidence', evidence: log.read() };
  }

  if (contract.verificationScope === 'full') {
    writeEvidence(log, 'failed', intent.id, 'FULL verification not implemented yet — use scoped');
    return { status: 'failed', reason: 'FULL verification not implemented yet — use scoped', stage: 'snapshot-before', evidence: log.read() };
  }

  let before: Record<string, string>;
  try {
    before = resource.snapshotObserved(contract.observedPaths!);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeEvidence(log, 'failed', intent.id, `Pre-execution snapshot failed: ${message}`);
    return { status: 'failed', reason: `Pre-execution snapshot failed: ${message}`, stage: 'snapshot-before', evidence: log.read() };
  }

  if (!writeEvidence(log, 'executing', intent.id, 'Starting execution')) {
    return { status: 'failed', reason: 'Evidence write failed at executing', stage: 'evidence', evidence: log.read() };
  }

  const driverResult = execute(contract, resource);

  if (!driverResult.success) {
    writeEvidence(log, 'failed', intent.id, `Execution failed: ${driverResult.error}`, afterSnapshot(resource, contract.observedPaths!));
    return { status: 'failed', reason: `Execution failed: ${driverResult.error}`, stage: 'execute', evidence: log.read() };
  }

  if (!writeEvidence(log, 'executed', intent.id, 'Execution completed')) {
    writeEvidence(log, 'failed', intent.id, 'Evidence write failed at executed');
    return { status: 'failed', reason: 'Evidence write failed at executed', stage: 'evidence', evidence: log.read() };
  }

  let after: Record<string, string>;
  try {
    after = resource.snapshotObserved(contract.observedPaths!);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeEvidence(log, 'failed', intent.id, `Post-execution snapshot failed: ${message}`);
    return { status: 'failed', reason: `Post-execution snapshot failed: ${message}`, stage: 'snapshot-after', evidence: log.read() };
  }

  const verification = verify(contract, before, after);

  if (!writeEvidence(log, 'verified', intent.id, `Verification: ${verification.detail}`, after)) {
    writeEvidence(log, 'failed', intent.id, 'Evidence write failed at verified');
    return { status: 'failed', reason: 'Evidence write failed at verified', stage: 'evidence', evidence: log.read() };
  }

  if (!verification.passed) {
    writeEvidence(log, 'failed', intent.id, `Verify failed: ${verification.reason}`, after);
    return { status: 'failed', reason: `Verify failed: ${verification.reason}`, stage: 'verify', evidence: log.read() };
  }

  if (!writeEvidence(log, 'completed', intent.id, 'Operation completed successfully', after)) {
    writeEvidence(log, 'failed', intent.id, 'Evidence write failed at completed');
    return { status: 'failed', reason: 'Evidence write failed at completed', stage: 'evidence', evidence: log.read() };
  }

  return { status: 'completed', evidence: log.read() };
}

function afterSnapshot(resource: FileResource, observedPaths: readonly string[]): Record<string, string> | undefined {
  try {
    return resource.snapshotObserved(observedPaths);
  } catch {
    return undefined;
  }
}