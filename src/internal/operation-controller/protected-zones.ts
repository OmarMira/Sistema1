import path from 'node:path'

export type ProtectedMode = 'deny-all' | 'append-only'

export interface ProtectedZone {
  readonly prefix: string
  readonly mode: ProtectedMode
  readonly reason: string
}

const ZONES: readonly ProtectedZone[] = [
  {
    prefix: '.git',
    mode: 'deny-all',
    reason: 'Repository integrity — git internals must not be modified',
  },
  {
    prefix: '.opencode',
    mode: 'deny-all',
    reason: 'Agent enforcement — OpenCode configuration and custom tools',
  },
  {
    prefix: 'src/internal/operation-controller',
    mode: 'deny-all',
    reason: 'Security kernel — Operation Controller core must not self-modify',
  },
  {
    prefix: 'openspec',
    mode: 'deny-all',
    reason: 'Canonical architecture — document authority must not be altered',
  },
  {
    prefix: 'opencode.json',
    mode: 'deny-all',
    reason: 'Agent permission configuration — enforcement boundary',
  },
  {
    prefix: '.audit',
    mode: 'append-only',
    reason: 'Forensic evidence — existing records must not be modified or deleted',
  },
]

export interface ProtectionCheck {
  readonly blocked: boolean
  readonly zone: ProtectedZone | null
}

export function checkProtected(workspaceRoot: string, targetPath: string): ProtectionCheck {
  const relative = path.relative(workspaceRoot, targetPath)
  const normalized = relative.split(path.sep).join('/')
  const targetSegments = normalized.split('/')

  for (const zone of ZONES) {
    const zoneSegments = zone.prefix.split('/')

    if (targetSegments.length < zoneSegments.length) continue

    const match = zoneSegments.every((seg, i) => targetSegments[i] === seg)
    if (match) {
      return { blocked: true, zone }
    }
  }

  return { blocked: false, zone: null }
}

export function isOperationAllowed(mode: ProtectedMode, operation: string): boolean {
  if (operation === 'read') return true

  switch (mode) {
    case 'deny-all':
      return false
    case 'append-only':
      return operation === 'create'
  }
}