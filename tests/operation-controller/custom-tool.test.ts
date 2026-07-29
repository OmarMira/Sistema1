import { describe, it, expect } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { run } from '../../src/internal/operation-controller/controller'
import { FileResource } from '../../src/internal/operation-controller/resources/file-resource'
import type { Intent, Capability, Operation } from '../../src/internal/operation-controller/types'

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-custom-tool-'))
  return dir
}

function cleanTempWorkspace(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true })
}

describe('operation-controller-write custom tool logic', () => {
  it('creates a file via controller (granted)', () => {
    const ws = makeTempWorkspace()
    try {
      const filePath = 'test-output.txt'
      const content = 'hello from controller'
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
      }

      const capabilities: Capability[] = [
        { requester: intent.requester, resourceType: 'file', operation, mode: 'granted' },
      ]

      const result = run(intent, capabilities, new FileResource(ws))

      expect(result.status).toBe('completed')
      expect(fs.existsSync(path.join(ws, filePath))).toBe(true)
      expect(fs.readFileSync(path.join(ws, filePath), 'utf-8')).toBe(content)
    } finally {
      cleanTempWorkspace(ws)
    }
  })

  it('modifies a file via controller (granted)', () => {
    const ws = makeTempWorkspace()
    try {
      const filePath = 'test-modify.txt'
      fs.writeFileSync(path.join(ws, filePath), 'original')
      const content = 'modified'
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
      }

      const capabilities: Capability[] = [
        { requester: intent.requester, resourceType: 'file', operation, mode: 'granted' },
      ]

      const result = run(intent, capabilities, new FileResource(ws))

      expect(result.status).toBe('completed')
      expect(fs.readFileSync(path.join(ws, filePath), 'utf-8')).toBe(content)
    } finally {
      cleanTempWorkspace(ws)
    }
  })

  it('rejects path traversal in filePath', () => {
    const ws = makeTempWorkspace()
    try {
      const filePath = '../outside.txt'
      const intent: Intent = {
        id: crypto.randomUUID(),
        requester: 'opencode-operation-controller-write',
        target: filePath,
        resourceType: 'file',
        operation: 'create',
        effects: ['create'],
        changes: 1,
        expectedState: { [filePath]: 'should not write' },
      }

      const capabilities: Capability[] = [
        { requester: intent.requester, resourceType: 'file', operation: 'create', mode: 'granted' },
      ]

      const result = run(intent, capabilities, new FileResource(ws))

      expect(result.status).toBe('failed')
      expect(result.stage).toMatch(/execute|verify|snapshot/)
    } finally {
      cleanTempWorkspace(ws)
    }
  })

  it('rejects create on existing file', () => {
    const ws = makeTempWorkspace()
    try {
      const filePath = 'exists.txt'
      fs.writeFileSync(path.join(ws, filePath), 'existing')
      const intent: Intent = {
        id: crypto.randomUUID(),
        requester: 'opencode-operation-controller-write',
        target: filePath,
        resourceType: 'file',
        operation: 'create',
        effects: ['create'],
        changes: 1,
        expectedState: { [filePath]: 'should not overwrite' },
      }

      const capabilities: Capability[] = [
        { requester: intent.requester, resourceType: 'file', operation: 'create', mode: 'granted' },
      ]

      const result = run(intent, capabilities, new FileResource(ws))

      expect(result.status).toBe('failed')
      expect(fs.readFileSync(path.join(ws, filePath), 'utf-8')).toBe('existing')
    } finally {
      cleanTempWorkspace(ws)
    }
  })

  it('rejects modify on non-existent file', () => {
    const ws = makeTempWorkspace()
    try {
      const intent: Intent = {
        id: crypto.randomUUID(),
        requester: 'opencode-operation-controller-write',
        target: 'no-such-file.txt',
        resourceType: 'file',
        operation: 'modify',
        effects: ['modify'],
        changes: 1,
        expectedState: { 'no-such-file.txt': 'content' },
      }

      const capabilities: Capability[] = [
        { requester: intent.requester, resourceType: 'file', operation: 'modify', mode: 'granted' },
      ]

      const result = run(intent, capabilities, new FileResource(ws))

      expect(result.status).toBe('failed')
    } finally {
      cleanTempWorkspace(ws)
    }
  })

  it('rejects policy denied', () => {
    const ws = makeTempWorkspace()
    try {
      const intent: Intent = {
        id: crypto.randomUUID(),
        requester: 'untrusted-agent',
        target: 'any.txt',
        resourceType: 'file',
        operation: 'create',
        effects: ['create'],
        changes: 1,
        expectedState: { 'any.txt': 'content' },
      }

      const capabilities: Capability[] = [
        { requester: 'untrusted-agent', resourceType: 'file', operation: 'create', mode: 'denied' },
      ]

      const result = run(intent, capabilities, new FileResource(ws))

      expect(result.status).toBe('denied')
      expect(fs.existsSync(path.join(ws, 'any.txt'))).toBe(false)
    } finally {
      cleanTempWorkspace(ws)
    }
  })
})