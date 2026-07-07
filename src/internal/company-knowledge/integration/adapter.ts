import type { EntityType } from '../entity/types';

// ───────────────────────────────────────────────
// Adapter interfaces — EntityContext integration
//
// Company Knowledge defines the CONTRACTS.
// EntityContext module implements them.
// Company Knowledge never imports EntityContext types.
// ───────────────────────────────────────────────

/**
 * A single entity context entry pulled from EntityContext.
 * EntityContext implementations may add type hints via contextHints.
 */
export interface EntityContextEntry {
  id: string;
  companyId: string;
  rawName: string;
  contextHints: Record<string, unknown>;
}

/**
 * Detection bias pushed TO EntityContext so its detection
 * prefers known knowledge over raw inference.
 */
export interface DetectionBias {
  knowledgeId: string;
  type: EntityType;
  canonicalName: string;
  aliases: string[];
  relationship: string;
  decisionReason: string;
}

/**
 * Reader — pulls raw entity context entries for a company.
 */
export interface EntityContextReader {
  pull(companyId: string): Promise<EntityContextEntry[]>;
}

/**
 * Writer — pushes detection biases to EntityContext.
 */
export interface EntityContextWriter {
  push(companyId: string, bias: DetectionBias[]): Promise<void>;
}
