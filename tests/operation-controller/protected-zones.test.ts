import { describe, it, expect } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { run } from '../../src/internal/operation-controller/controller'
import { FileResource } from '../../src/internal/operation-controller/resources/file-resource'
import { checkProtected, isOperationAllowed } from '../../src/internal/operation-controller/protected-zones'
import type { Intent, Capability, Operation } from '../../src/internal/operation-controller/types'

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-protected-'))
  return dir
}

function cleanTempWorkspace(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true })
}

function makeRun(ws: string, filePath: string, content: string, operation: Operation): ReturnType<typeof run> {
  const intent: Intent = {
    id: crypto.randomUUID(),
    requester: 'opencode-operation-controller-write',
    target: filePath,
    resourceType: 'file',
    operation,
    effects: [operation],
    changes: 1,
    expectedState: { [filePath]: content },
    verificationScope: 'scoped',
  }

  const capabilities: Capability[] = [
    { requester: intent.requester, resourceType: 'file', operation, mode: 'granted' },
  ]

  return run(intent, capabilities, new FileResource(ws))
}

function touchTarget(ws: string, filePath: string, content: string) {
  const abs = path.join(ws, filePath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf-8')
}

describe('protected zones via controller.run()', () => {
  it('blocks create on opencode.json', () => {
    const ws = makeTempWorkspace()
    try {
      const result = makeRun(ws, 'opencode.json', '{}', 'create')
      expect(result.status).toBe('denied')
      expect(result.reason).toMatch(/Protected zone/)
      expect(fs.existsSync(path.join(ws, 'opencode.json'))).toBe(false)
    } finally {
      cleanTempWorkspace(ws)
    }
  })

  it('blocks modify on opencode.json', () => {
    const ws = makeTempWorkspace()
    try {
      touchTarget(ws, 'opencode.json', '{}')
      const result = makeRun(ws, 'opencode.json', '{"x":1}', 'modify')
      expect(result.status).toBe('denied')
      expect(result.reason).toMatch(/Protected zone/)
      expect(fs.readFileSync(path.join(ws, 'opencode.json'), 'utf-8')).toBe('{}')
    } finally {
      cleanTempWorkspace(ws)
    }
  })

  it('blocks create inside .opencode/', () => {
    const ws = makeTempWorkspace()
    try {
      const result = makeRun(ws, '.opencode/tools/operation-controller-write.ts', 'modified', 'create')
      expect(result.status).toBe('denied')
      expect(result.reason).toMatch(/Protected zone/)
      expect(fs.existsSync(path.join(ws, '.opencode/tools/operation-controller-write.ts'))).toBe(false)
    } finally {
      cleanTempWorkspace(ws)
    }
  })

  it('blocks create inside src/internal/operation-controller/', () => {
    const ws = makeTempWorkspace()
    try {
      const result = makeRun(ws, 'src/internal/operation-controller/controller.ts', 'hacked', 'create')
      expect(result.status).toBe('denied')
      expect(result.reason).toMatch(/Protected zone/)
      expect(fs.existsSync(path.join(ws, 'src/internal/operation-controller/controller.ts'))).toBe(false)
    } finally {
      cleanTempWorkspace(ws)
    }
  })

  it('blocks modify inside src/internal/operation-controller/', () => {
    const ws = makeTempWorkspace()
    try {
      touchTarget(ws, 'src/internal/operation-controller/controller.ts', 'original')
      const result = makeRun(ws, 'src/internal/operation-controller/controller.ts', 'hacked', 'modify')
      expect(result.status).toBe('denied')
      expect(result.reason).toMatch(/Protected zone/)
      expect(fs.readFileSync(path.join(ws, 'src/internal/operation-controller/controller.ts'), 'utf-8')).toBe('original')
    } finally {
      cleanTempWorkspace(ws)
    }
  })

  it('blocks create inside openspec/', () => {
    const ws = makeTempWorkspace()
    try {
      const result = makeRun(ws, 'openspec/operation-controller/design.md', '# Hacked', 'create')
      expect(result.status).toBe('denied')
      expect(result.reason).toMatch(/Protected zone/)
      expect(fs.existsSync(path.join(ws, 'openspec/operation-controller/design.md'))).toBe(false)
    } finally {
      cleanTempWorkspace(ws)
    }
  })

  it('blocks create inside .git/', () => {
    const ws = makeTempWorkspace()
    try {
      const result = makeRun(ws, '.git/config', '[remote]', 'create')
      expect(result.status).toBe('denied')
      expect(result.reason).toMatch(/Protected zone/)
      expect(fs.existsSync(path.join(ws, '.git/config'))).toBe(false)
    } finally {
      cleanTempWorkspace(ws)
    }
  })

  it('blocks modify inside .audit/ (append-only)', () => {
    const ws = makeTempWorkspace()
    try {
      touchTarget(ws, '.audit/evidence.log', 'existing log entry')
      const result = makeRun(ws, '.audit/evidence.log', 'tampered', 'modify')
      expect(result.status).toBe('denied')
      expect(result.reason).toMatch(/Protected zone/)
      expect(fs.readFileSync(path.join(ws, '.audit/evidence.log'), 'utf-8')).toBe('existing log entry')
    } finally {
      cleanTempWorkspace(ws)
    }
  })

  it('allows create inside .audit/ (append-only)', () => {
    const ws = makeTempWorkspace()
    try {
      fs.mkdirSync(path.join(ws, '.audit'), { recursive: true })
      const result = makeRun(ws, '.audit/new-entry.log', 'new log entry', 'create')
      expect(result.status).toBe('completed')
      expect(fs.readFileSync(path.join(ws, '.audit/new-entry.log'), 'utf-8')).toBe('new log entry')
    } finally {
      cleanTempWorkspace(ws)
    }
  })

  it('allows normal source file write', () => {
    const ws = makeTempWorkspace()
    try {
      fs.mkdirSync(path.join(ws, 'src/components'), { recursive: true })
      const result = makeRun(ws, 'src/components/Button.tsx', 'export const Button = () => null', 'create')
      expect(result.status).toBe('completed')
      expect(fs.readFileSync(path.join(ws, 'src/components/Button.tsx'), 'utf-8')).toBe('export const Button = () => null')
    } finally {
      cleanTempWorkspace(ws)
    }
  })

  it('allows normal source file modify', () => {
    const ws = makeTempWorkspace()
    try {
      touchTarget(ws, 'src/lib/utils.ts', 'const x = 1')
      const result = makeRun(ws, 'src/lib/utils.ts', 'const x = 2', 'modify')
      expect(result.status).toBe('completed')
      expect(fs.readFileSync(path.join(ws, 'src/lib/utils.ts'), 'utf-8')).toBe('const x = 2')
    } finally {
      cleanTempWorkspace(ws)
    }
  })

  it('does not false-positive on similar prefix', () => {
    const ws = makeTempWorkspace()
    try {
      fs.mkdirSync(path.join(ws, 'src/internal/operation-controller-old'), { recursive: true })
      const result = makeRun(ws, 'src/internal/operation-controller-old/test.ts', 'ok', 'create')
      expect(result.status).toBe('completed')
      expect(fs.readFileSync(path.join(ws, 'src/internal/operation-controller-old/test.ts'), 'utf-8')).toBe('ok')
    } finally {
      cleanTempWorkspace(ws)
    }
  })
})

describe('checkProtected segment matching', () => {
  it('matches deep path inside zone', () => {
    const result = checkProtected('/workspace', '/workspace/src/internal/operation-controller/controller.ts')
    expect(result.blocked).toBe(true)
    expect(result.zone!.prefix).toBe('src/internal/operation-controller')
  })

  it('does not match similar prefix', () => {
    const result = checkProtected('/workspace', '/workspace/src/internal/operation-controller-old/controller.ts')
    expect(result.blocked).toBe(false)
  })

  it('matches root file exactly', () => {
    const result = checkProtected('/workspace', '/workspace/opencode.json')
    expect(result.blocked).toBe(true)
    expect(result.zone!.prefix).toBe('opencode.json')
  })

  it('does not match similar root file', () => {
    const result = checkProtected('/workspace', '/workspace/opencode-backup.json')
    expect(result.blocked).toBe(false)
  })
})

describe('isOperationAllowed', () => {
  it('deny-all allows only read', () => {
    expect(isOperationAllowed('deny-all', 'read')).toBe(true)
    expect(isOperationAllowed('deny-all', 'create')).toBe(false)
    expect(isOperationAllowed('deny-all', 'modify')).toBe(false)
    expect(isOperationAllowed('deny-all', 'delete')).toBe(false)
  })

  it('append-only allows read and create', () => {
    expect(isOperationAllowed('append-only', 'read')).toBe(true)
    expect(isOperationAllowed('append-only', 'create')).toBe(true)
    expect(isOperationAllowed('append-only', 'modify')).toBe(false)
    expect(isOperationAllowed('append-only', 'delete')).toBe(false)
  })
})