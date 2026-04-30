import type { SolveRecord } from './types';

export type MergeCounts = { added: number; replaced: number; skipped: number };
export type MergeResult = { merged: SolveRecord[] } & MergeCounts;

// Validate that `r` has the minimum shape of a stored solve. Used at
// import time so partial / corrupted entries don't poison the local
// history. We deliberately accept extra fields (forward-compatible with
// future record additions) and don't check `twoLookOll`/`twoLookPll`
// because old records may have stored them as strings or omitted them.
export function isValidSolveRecord(r: any): r is SolveRecord {
  return !!r &&
    typeof r.ts === 'number' &&
    typeof r.totalMs === 'number' &&
    typeof r.scramble === 'string' &&
    typeof r.solution === 'string' &&
    !!r.phases && typeof r.phases === 'object' &&
    typeof r.process === 'string';
}

// Merge `incoming` into `existing`, deduping by `ts`. On collision, keep
// whichever record has the shorter `totalMs` (treats the same physical
// solve recorded twice as the canonical one — slower duplicates are
// usually re-derivations or imports from a less-trimmed copy). Sort
// chronologically and trim to `cap` (oldest dropped first).
export function mergeImportedHistory(
  existing: SolveRecord[],
  incoming: any[],
  cap: number,
): MergeResult {
  const byTs = new Map<number, SolveRecord>();
  for (const r of existing) byTs.set(r.ts, r);
  let added = 0, replaced = 0, skipped = 0;
  for (const r of incoming) {
    if (!isValidSolveRecord(r)) { skipped++; continue; }
    const existingRec = byTs.get(r.ts);
    if (!existingRec) {
      byTs.set(r.ts, r);
      added++;
    } else if (r.totalMs < existingRec.totalMs) {
      byTs.set(r.ts, r);
      replaced++;
    }
  }
  const merged = Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
  while (merged.length > cap) merged.shift();
  return { merged, added, replaced, skipped };
}
