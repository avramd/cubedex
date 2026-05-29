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

describe('mergeImportedHistory — full-record round-trip contract', () => {
  // KITCHEN-SINK record: every documented field on SolveRecord set to a
  // non-default value. When you add a new field to SolveRecord, ALSO add
  // it here AND to the deep-equality assertion below. The test then fails
  // until import/export demonstrably preserves it.
  const kitchenSink: SolveRecord = {
    ts: 1700000000000,
    scramble: "R U R' U R U2 R'",
    solution: "R U R' U R U2 R'",
    totalMs: 12345,
    phases: { cross: 1000, f2l: 4000, eoll: 600, ocll: 1100, cpll: 500, epll: 800 },
    process: 'cfop',
    twoLookOll: true,
    twoLookPll: true,
    turns: [0.21, 0.45, 0.83, 1.4, 2.1, 3.6, 5.8, 9.1, 11.2],
    f2lSplits: [1100, 2300, 3500, 5000],
    crossSplits: [300, 500, 750, 1000],
    inspectionMs: 14750,
    inspectionAutoExpired: true,
    aborted: true,
    abortedAtMs: 7250,
    tags: ['speed', 'two look pll', 'warmup'],
    twoLookCmll: true,
    threeLookLse: true,
    rouxPairTimingsMs: [2200, 3500, 5500, 7000],
    rouxBlock1FirstPairMs: 2200,
    rouxBlock2FirstPairMs: 5500,
  };

  it('export → import preserves every documented SolveRecord field byte-for-byte', () => {
    // Export = JSON.stringify of the array of records. Import = parse +
    // merge. This is the actual code path on the wire.
    const exportedJson = JSON.stringify([kitchenSink]);
    const parsed = JSON.parse(exportedJson);
    const result = mergeImportedHistory([], parsed, 500);
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.merged).toHaveLength(1);
    expect(result.merged[0]).toEqual(kitchenSink);
  });

  it('forward-compat: an unknown future field survives import unchanged', () => {
    // The merge stores records as-received (no field filtering), so a
    // future client that adds a new field to SolveRecord can be imported
    // here without losing data. Tested with a synthetic future field.
    const future = JSON.parse(JSON.stringify({
      ...kitchenSink,
      ts: kitchenSink.ts + 1,
      futureFeatureMs: [10, 20, 30],   // not in the type yet
      futureFlags: { whateverThisIs: true },
    }));
    const result = mergeImportedHistory([], [future], 500);
    expect(result.added).toBe(1);
    expect(result.merged[0]).toEqual(future);
  });

  it('backwards-compat: a legacy record (no turns / f2lSplits / split phases) imports cleanly', () => {
    // Pre-feature record shape: only the originally-shipped fields. The
    // import path must NOT reject these, and they must come out unchanged.
    const legacy = {
      ts: 1600000000000,
      scramble: "R U R' U' R' F R F'",
      solution: "R U R' U' R' F R F'",
      totalMs: 9876,
      phases: { cross: 800, f2l: 3500, oll: 1200, pll: 1500 },
      process: 'cfop' as const,
      twoLookOll: false,
      twoLookPll: false,
    };
    const result = mergeImportedHistory([], [legacy], 500);
    expect(result.added).toBe(1);
    expect(result.merged[0]).toEqual(legacy);
    // …including not silently injecting turns/f2lSplits — derived fields
    // come from the post-merge backfill in fullSolve.ts, not from the
    // pure merge. (Backfill itself has its own tests.)
    expect((result.merged[0] as any).turns).toBeUndefined();
    expect((result.merged[0] as any).f2lSplits).toBeUndefined();
  });

  it('full round-trip survives JSON serialization with no precision loss on turn timestamps', () => {
    // turns are fractional seconds; verify a precise value (5 decimals)
    // round-trips losslessly through JSON.
    const r = rec(1, 1000, { turns: [0.12345, 1.23456, 2.34567, 9.99999] });
    const serialized = JSON.parse(JSON.stringify([r]));
    const result = mergeImportedHistory([], serialized, 500);
    expect(result.merged[0].turns).toEqual([0.12345, 1.23456, 2.34567, 9.99999]);
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
