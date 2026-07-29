export type Operation = 'read' | 'create' | 'modify' | 'delete' | 'execute' | 'connect';

export type Effect = 'modify' | 'create' | 'delete' | 'read' | 'execute' | 'connect';

export type PolicyMode = 'granted' | 'requires-approval' | 'requires-dual' | 'denied';

export type VerificationScope = 'scoped' | 'full';

export interface PolicyDecision {
  readonly mode: PolicyMode;
  readonly reason?: string;
}

export interface Intent {
  readonly id: string;
  readonly requester: string;
  readonly target: string;
  readonly resourceType: string;
  readonly operation: Operation;
  readonly effects: Effect[];
  readonly changes?: number;
  readonly expectedState?: Record<string, string>;
  readonly observedPaths?: readonly string[];
  readonly verificationScope: VerificationScope;
}

export interface Capability {
  readonly requester: string;
  readonly resourceType: string;
  readonly operation: Operation;
  readonly mode: PolicyMode;
}

export interface Budget {
  readonly maxChanges: number;
}

export interface ExecutionContract {
  readonly intentId: string;
  readonly target: string;
  readonly resourceType: string;
  readonly operation: Operation;
  readonly allowedEffects: Effect[];
  readonly forbiddenEffects: Effect[];
  readonly budget: Budget;
  readonly expectedState: Record<string, string>;
  readonly observedPaths?: readonly string[];
  readonly verificationScope: VerificationScope;
}

export type OperationState =
  | 'requested'
  | 'denied'
  | 'pending-approval'
  | 'authorized'
  | 'executing'
  | 'executed'
  | 'verified'
  | 'completed'
  | 'failed';

export interface EvidenceEntry {
  readonly timestamp: number;
  readonly state: OperationState;
  readonly intentId: string;
  readonly detail: string;
  readonly snapshot?: Record<string, string>;
}

export type ControllerResult =
  | { status: 'completed'; evidence: readonly EvidenceEntry[] }
  | { status: 'denied'; reason: string; evidence: readonly EvidenceEntry[] }
  | {
      status: 'pending-approval';
      mode: 'requires-approval' | 'requires-dual';
      reason?: string;
      evidence: readonly EvidenceEntry[];
    }
  | {
      status: 'failed';
      reason: string;
      stage: string;
      evidence: readonly EvidenceEntry[];
    };