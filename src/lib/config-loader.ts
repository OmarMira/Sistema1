import { readFile, access } from 'fs/promises';
import { join } from 'path';

const cache = new Map<string, Promise<string>>();

export async function readJsonConfig<T = Record<string, unknown>>(filename: string): Promise<T> {
  const path = join(process.cwd(), 'rules', filename);
  if (!cache.has(path)) {
    cache.set(path, readFile(path, 'utf-8'));
  }
  const content = await cache.get(path)!;
  return JSON.parse(content) as T;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function clearConfigCache(): void {
  cache.clear();
}
