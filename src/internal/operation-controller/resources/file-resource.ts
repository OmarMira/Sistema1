import path from 'node:path';
import fs from 'node:fs';
import { checkProtected, isOperationAllowed } from '../protected-zones';
import type { ExecutionContract, Effect } from '../types';
import type { Driver, DriverResult } from '../execute';

export class FileResource implements Driver {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = fs.realpathSync(workspaceRoot);
  }

  get workspace(): string {
    return this.workspaceRoot;
  }

  private effectForOperation(operation: string): Effect | null {
    const map: Record<string, Effect> = {
      read: 'read',
      create: 'create',
      modify: 'modify',
      delete: 'delete',
      execute: 'execute',
      connect: 'connect',
    };
    return map[operation] ?? null;
  }

  execute(contract: ExecutionContract): DriverResult {
    const safe = this.safePath(contract.target);
    if (!safe.ok) {
      return { success: false, error: safe.error };
    }

    const targetPath = safe.path;
    const protection = checkProtected(this.workspaceRoot, targetPath);
    if (protection.blocked && !isOperationAllowed(protection.zone!.mode, contract.operation)) {
      return { success: false, error: `Protected zone: ${protection.zone!.prefix} — ${protection.zone!.reason}` };
    }

    const effect = this.effectForOperation(contract.operation);
    if (!effect) {
      return { success: false, error: `Unsupported operation: ${contract.operation}` };
    }
    if (contract.forbiddenEffects.includes(effect)) {
      return { success: false, error: `Effect ${effect} is forbidden` };
    }
    if (!contract.allowedEffects.includes(effect)) {
      return { success: false, error: `Effect ${effect} is not allowed` };
    }

    switch (contract.operation) {
      case 'modify': {
        if (!fs.existsSync(targetPath)) {
          return { success: false, error: 'Target does not exist for modify' };
        }
        if (!fs.statSync(targetPath).isFile()) {
          return { success: false, error: 'Target is not a regular file' };
        }
        const content = contract.expectedState[contract.target];
        if (content === undefined) {
          return { success: false, error: 'No content in expectedState for modify' };
        }
        try {
          fs.writeFileSync(targetPath, content, 'utf-8');
          return { success: true };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'Write failed' };
        }
      }

      case 'create': {
        if (fs.existsSync(targetPath)) {
          return { success: false, error: 'Target already exists' };
        }
        const content = contract.expectedState[contract.target];
        if (content === undefined) {
          return { success: false, error: 'No content in expectedState for create' };
        }
        try {
          fs.writeFileSync(targetPath, content, 'utf-8');
          return { success: true };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'Create failed' };
        }
      }

      case 'delete': {
        if (!fs.existsSync(targetPath)) {
          return { success: false, error: 'Target does not exist' };
        }
        if (!fs.statSync(targetPath).isFile()) {
          return { success: false, error: 'Target is not a regular file' };
        }
        try {
          fs.unlinkSync(targetPath);
          return { success: true };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'Delete failed' };
        }
      }

      case 'read': {
        if (!fs.existsSync(targetPath)) {
          return { success: false, error: 'Target does not exist' };
        }
        if (!fs.statSync(targetPath).isFile()) {
          return { success: false, error: 'Target is not a regular file' };
        }
        try {
          const content = fs.readFileSync(targetPath, 'utf-8');
          return { success: true, detail: content };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'Read failed' };
        }
      }

      default:
        return { success: false, error: `Operation ${contract.operation} not supported by FileResource` };
    }
  }

  readFile(relativePath: string): string | null {
    const safe = this.safePath(relativePath);
    if (!safe.ok) return null;
    try {
      return fs.readFileSync(safe.path, 'utf-8');
    } catch {
      return null;
    }
  }

  exists(relativePath: string): boolean {
    const safe = this.safePath(relativePath);
    if (!safe.ok) return false;
    return fs.existsSync(safe.path);
  }

  snapshot(): Record<string, string> {
    const result: Record<string, string> = {};
    const visited = new Set<string>();
    this.collectFiles('', result, visited);
    return result;
  }

  snapshotObserved(observedPaths: readonly string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const relativePath of observedPaths) {
      const safe = this.safePath(relativePath);
      if (!safe.ok) {
        throw new Error(`Snapshot blocked: ${safe.error} for ${relativePath}`);
      }
      if (fs.existsSync(safe.path)) {
        const stat = fs.statSync(safe.path);
        if (stat.isFile()) {
          result[relativePath] = fs.readFileSync(safe.path, 'utf-8');
        } else if (!stat.isDirectory()) {
          throw new Error(`Snapshot blocked: unsupported entry at ${relativePath}`);
        }
      }
    }
    return result;
  }

  private collectFiles(
    relativeDir: string,
    acc: Record<string, string>,
    visited: Set<string>,
  ): void {
    const dirPath = path.join(this.workspaceRoot, relativeDir);
    const realDir = fs.realpathSync(dirPath);

    if (visited.has(realDir)) return;
    visited.add(realDir);

    const entries = fs.readdirSync(dirPath);
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry}` : entry;
      const unresolvedPath = path.join(dirPath, entry);
      const lstat = fs.lstatSync(unresolvedPath);

      if (lstat.isSymbolicLink()) {
        const safe = this.safePath(relativePath);
        if (!safe.ok) {
          throw new Error(`Snapshot blocked: ${safe.error} for ${relativePath}`);
        }
        const targetStat = fs.statSync(safe.path);
        if (targetStat.isDirectory()) {
          throw new Error(`Snapshot blocked: directory symlink at ${relativePath}`);
        }
        if (!targetStat.isFile()) {
          throw new Error(`Snapshot blocked: unsupported symlink target at ${relativePath}`);
        }
        acc[relativePath] = fs.readFileSync(safe.path, 'utf-8');
        continue;
      }

      if (lstat.isFile()) {
        const safe = this.safePath(relativePath);
        if (!safe.ok) {
          throw new Error(`Snapshot blocked: ${safe.error} for ${relativePath}`);
        }
        acc[relativePath] = fs.readFileSync(safe.path, 'utf-8');
      } else if (lstat.isDirectory()) {
        const safe = this.safePath(relativePath);
        if (!safe.ok) {
          throw new Error(`Snapshot blocked: ${safe.error} for ${relativePath}`);
        }
        this.collectFiles(relativePath, acc, visited);
      } else {
        throw new Error(`Snapshot blocked: unsupported entry at ${relativePath}`);
      }
    }
  }

  private safePath(
    relativePath: string,
  ): { ok: true; path: string } | { ok: false; error: string } {
    const resolved = path.resolve(this.workspaceRoot, relativePath);

    const relative = path.relative(this.workspaceRoot, resolved);
    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return { ok: false, error: 'Path outside workspace' };
    }

    try {
      const real = fs.realpathSync(resolved);
      const realRelative = path.relative(this.workspaceRoot, real);
      if (
        realRelative === '..' ||
        realRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(realRelative)
      ) {
        return { ok: false, error: 'Symlink points outside workspace' };
      }
      return { ok: true, path: real };
    } catch {
      const dir = path.dirname(resolved);
      try {
        const realDir = fs.realpathSync(dir);
        const dirRelative = path.relative(this.workspaceRoot, realDir);
        if (
          dirRelative === '..' ||
          dirRelative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(dirRelative)
        ) {
          return { ok: false, error: 'Parent directory symlink points outside workspace' };
        }
        return { ok: true, path: resolved };
      } catch {
        return { ok: false, error: 'Parent directory does not exist or is not accessible' };
      }
    }
  }
}