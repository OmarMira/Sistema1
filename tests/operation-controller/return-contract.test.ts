import { describe, it, expect } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { run } from '../../src/internal/operation-controller/controller'
import { FileResource } from '../../src/internal/operation-controller/resources/file-resource'
import type { Intent, Capability, Operation } from '../../src/internal/operation-controller/types'

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-return-'))
  return dir
}

function cleanTempWorkspace(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true })
}

describe('operation-controller-write return contract', () => {
  it('completed result is safe for tool return serialization', () => {
    const ws = makeTempWorkspace()
    try {
      const filePath = 'safe-return.txt'
      const content = 'test content'
      const operation: Operation = 'create'

      const intent: Intent = {
        id: crypto.randomUUID(),
        requester: 'opencode-operation-controller-write',
        target: filePath,
        resourceType: 'file',
        operation,
        effects: [operation],
        changes: 1,
        expectedState: { [filePath]: content },
        observedPaths: [filePath],
        verificationScope: 'scoped',
      }

      const capabilities: Capability[] = [
        { requester: intent.requester, resourceType: 'file', operation, mode: 'granted' },
      ]

      const result = run(intent, capabilities, new FileResource(ws))

      expect(result.status).toBe('completed')

      const evidence = result.evidence
      expect(Array.isArray(evidence)).toBe(true)

      for (const entry of evidence) {
        expect(typeof entry.timestamp).toBe('number')
        expect(typeof entry.state).toBe('string')
        expect(typeof entry.intentId).toBe('string')
        expect(typeof entry.detail).toBe('string')

        if (entry.snapshot !== undefined) {
          expect(typeof entry.snapshot).toBe('object')
          expect(entry.snapshot).not.toBeNull()
        }
      }

      const asToolReturn = {
        status: 'completed',
        filePath,
        evidence,
      }

      expect(() => JSON.stringify(asToolReturn)).not.toThrow()
    } finally {
      cleanTempWorkspace(ws)
    }
  })

  it('completed result with modify is safe for tool return', () => {
    const ws = makeTempWorkspace()
    try {
      const filePath = 'safe-modify.txt'
      fs.writeFileSync(path.join(ws, filePath), 'original')
      const content = 'modified content'
      const operation: Operation = 'modify'

      const intent: Intent = {
        id: crypto.randomUUID(),
        requester: 'opencode-operation-controller-write',
        target: filePath,
        resourceType: 'file',
        operation,
        effects: [operation],
        changes: 1,
        expectedState: { [filePath]: content },
        observedPaths: [filePath],
        verificationScope: 'scoped',
      }

      const capabilities: Capability[] = [
        { requester: intent.requester, resourceType: 'file', operation, mode: 'granted' },
      ]

      const result = run(intent, capabilities, new FileResource(ws))

      expect(result.status).toBe('completed')

      const evidence = result.evidence
      expect(Array.isArray(evidence)).toBe(true)

      for (const entry of evidence) {
        expect(typeof entry.timestamp).toBe('number')
        expect(typeof entry.state).toBe('string')
        expect(typeof entry.intentId).toBe('string')
        expect(typeof entry.detail).toBe('string')
      }

      const asToolReturn = {
        status: 'completed',
        filePath,
        evidence,
      }

      expect(() => JSON.stringify(asToolReturn)).not.toThrow()
    } finally {
      cleanTempWorkspace(ws)
    }
  })

  it('denied result has no snapshot anomalies', () => {
    const ws = makeTempWorkspace()
    try {
      const intent: Intent = {
        id: crypto.randomUUID(),
        requester: 'untrusted',
        target: 'any.txt',
        resourceType: 'file',
        operation: 'create',
        effects: ['create'],
        changes: 1,
        expectedState: { 'any.txt': 'should be denied' },
        observedPaths: ['any.txt'],
        verificationScope: 'scoped',
      }

      const capabilities: Capability[] = [
        { requester: 'untrusted', resourceType: 'file', operation: 'create', mode: 'denied' },
      ]

      const result = run(intent, capabilities, new FileResource(ws))

      expect(result.status).toBe('denied')

      const evidence = result.evidence
      expect(Array.isArray(evidence)).toBe(true)

      for (const entry of evidence) {
        expect(typeof entry.timestamp).toBe('number')
        expect(typeof entry.state).toBe('string')
        expect(typeof entry.intentId).toBe('string')
        expect(typeof entry.detail).toBe('string')
      }

      const asToolReturn = {
        status: 'denied',
        reason: 'test',
        evidence,
      }

      expect(() => JSON.stringify(asToolReturn)).not.toThrow()
    } finally {
      cleanTempWorkspace(ws)
    }
  })
})