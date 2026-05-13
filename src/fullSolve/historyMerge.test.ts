import { describe, expect, it } from 'vitest';
import { isValidSolveRecord, mergeImportedHistory } from './historyMerge';
import type { SolveRecord } from './types';

function rec(ts: number, totalMs: number, extras: Partial<SolveRecord> = {}): SolveRecord {
  return {
    ts, totalMs,
    scramble: 's', solution: '', phases: { cross: 0 },
    process: 'cfop', twoLookOll: false, twoLookPll: false,
    ...extras,
  };
}

describe('isValidSolveRecord', () => {
  it('accepts a well-formed record', () => {
    expect(isValidSolveRecord(rec(1, 1000))).toBe(true);
  });

  it('rejects null / undefined / non-objects', () => {
    expect(isValidSolveRecord(null)).toBe(false);
    expect(isValidSolveRecord(undefined)).toBe(false);
    expect(isValidSolveRecord('not a record')).toBe(false);
    expect(isValidSolveRecord(42)).toBe(false);
  });

  it('rejects records missing required fields', () => {
    expect(isValidSolveRecord({ ts: 1 })).toBe(false);                   // no totalMs
    expect(isValidSolveRecord({ ...rec(1, 1000), ts: '1' })).toBe(false); // wrong ts type
    expect(isValidSolveRecord({ ...rec(1, 1000), phases: null })).toBe(false);
    expect(isValidSolveRecord({ ...rec(1, 1000), process: 42 })).toBe(false);
  });
});

describe('mergeImportedHistory — adding new records', () => {
  it('appends incoming records that have no ts collision', () => {
    const existing = [rec(1, 1000), rec(2, 1100)];
    const r = mergeImportedHistory(existing, [rec(3, 1200), rec(4, 1300)], 500);
    expect(r.added).toBe(2);
    expect(r.replaced).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.merged.map(x => x.ts)).toEqual([1, 2, 3, 4]);
  });

  it('returns the merged list sorted by ts ascending', () => {
    const r = mergeImportedHistory([rec(5, 1000)], [rec(2, 1000), rec(8, 1000)], 500);
    expect(r.merged.map(x => x.ts)).toEqual([2, 5, 8]);
  });

  it('does not mutate the input arrays', () => {
    const existing = [rec(1, 1000)];
    const incoming = [rec(2, 1000)];
    mergeImportedHistory(existing, incoming, 500);
    expect(existing.map(x => x.ts)).toEqual([1]);
    expect(incoming.map(x => x.ts)).toEqual([2]);
  });
});

describe('mergeImportedHistory — collision resolution (shorter wins)', () => {
  it('keeps the existing record when incoming has same ts but longer time', () => {
    const existing = [rec(1, 1000)];
    const r = mergeImportedHistory(existing, [rec(1, 1500)], 500);
    expect(r.added).toBe(0);
    expect(r.replaced).toBe(0);
    expect(r.merged[0].totalMs).toBe(1000);
  });

  it('replaces the existing record when incoming has same ts but shorter time', () => {
    const existing = [rec(1, 1500)];
    const r = mergeImportedHistory(existing, [rec(1, 1000)], 500);
    expect(r.added).toBe(0);
    expect(r.replaced).toBe(1);
    expect(r.merged[0].totalMs).toBe(1000);
  });

  it('treats equal totalMs as no replace (strict <)', () => {
    const existing = [rec(1, 1000)];
    const r = mergeImportedHistory(existing, [rec(1, 1000)], 500);
    expect(r.added).toBe(0);
    expect(r.replaced).toBe(0);
  });

  it('is idempotent — merging the same export twice is a no-op', () => {
    const exported = [rec(1, 1000), rec(2, 2000), rec(3, 3000)];
    const first  = mergeImportedHistory([], exported, 500);
    const second = mergeImportedHistory(first.merged, exported, 500);
    expect(second.added).toBe(0);
    expect(second.replaced).toBe(0);
    expect(second.merged.map(x => x.ts)).toEqual([1, 2, 3]);
  });
});

describe('mergeImportedHistory — invalid records', () => {
  it('counts skipped invalid entries without affecting the rest', () => {
    const r = mergeImportedHistory(
      [rec(1, 1000)],
      [rec(2, 2000), null, { ts: 'oops' }, rec(3, 3000)],
      500,
    );
    expect(r.added).toBe(2);
    expect(r.skipped).toBe(2);
    expect(r.merged.map(x => x.ts)).toEqual([1, 2, 3]);
  });
});

describe('mergeImportedHistory — passthrough of optional fields', () => {
  it('preserves `turns` on imported records', () => {
    const incoming = [rec(1, 1000, { turns: [0.1, 0.3, 1.2, 2.4] })];
    const r = mergeImportedHistory([], incoming, 500);
    expect(r.merged[0].turns).toEqual([0.1, 0.3, 1.2, 2.4]);
  });

  it('preserves `turns` when collision keeps the shorter record', () => {
    const existing = [rec(1, 1500)]; // no turns
    const incoming = [rec(1, 1000, { turns: [0.5, 1.0] })]; // shorter; should win
    const r = mergeImportedHistory(existing, incoming, 500);
    expect(r.merged[0].totalMs).toBe(1000);
    expect(r.merged[0].turns).toEqual([0.5, 1.0]);
  });
});

describe('mergeImportedHistory — cap', () => {
  it('drops the OLDEST records when over cap', () => {
    const existing = [rec(1, 1000), rec(2, 1000)];
    const incoming = [rec(3, 1000), rec(4, 1000), rec(5, 1000)];
    const r = mergeImportedHistory(existing, incoming, 3);
    expect(r.merged.map(x => x.ts)).toEqual([3, 4, 5]);
  });

  it('does not drop anything when under cap', () => {
    const r = mergeImportedHistory([rec(1, 1000)], [rec(2, 1000)], 10);
    expect(r.merged.map(x => x.ts)).toEqual([1, 2]);
  });
});
