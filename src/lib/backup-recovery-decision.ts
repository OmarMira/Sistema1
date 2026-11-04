/** Pure reconciliation policy. Callers must verify the journal, exact file
 * hashes and authoritative DB receipt while maintenance remains drained.
 * `absent` means a successful authoritative query, never a connection failure.
 * No filesystem or database mutation is performed by this function.
 */
export function recoveryDecision(
  receipt: 'committed' | 'absent' | 'unknown',
  files: 'before' | 'after' | 'diverged',
): 'blocked' | 'apply-after' | 'apply-before' | 'complete' | 'aborted' {
  if (receipt === 'unknown' || files === 'diverged') return 'blocked';
  if (receipt === 'committed') return files === 'after' ? 'complete' : 'apply-after';
  return files === 'before' ? 'aborted' : 'apply-before';
}
