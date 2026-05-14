import { describe, expect, it } from 'vitest';
import { PHASE_KEY_LABELS, phaseMsForDisplay } from './aggregate';
import type { SolveRecord } from './types';

function rec(phases: { [key: string]: number }): SolveRecord {
  return {
    ts: 0, scramble: '', solution: '', totalMs: 0,
    phases, process: 'cfop', twoLookOll: false, twoLookPll: false,
  };
}

describe('PHASE_KEY_LABELS', () => {
  it('covers every phase key the predicates emit', () => {
    for (const k of ['cross', 'f2l', 'oll', 'pll', 'eoll', 'ocll', 'cpll', 'epll', 'setup', 'll']) {
      expect(PHASE_KEY_LABELS[k]).toBeTruthy();
    }
  });
});

describe('phaseMsForDisplay — straight passthrough', () => {
  it('returns the stored value for a key the record has', () => {
    expect(phaseMsForDisplay(rec({ cross: 1500 }), 'cross')).toBe(1500);
    expect(phaseMsForDisplay(rec({ f2l: 4200 }),   'f2l')).toBe(4200);
    expect(phaseMsForDisplay(rec({ setup: 7000 }), 'setup')).toBe(7000);
  });

  it('returns 0 for an unknown key', () => {
    expect(phaseMsForDisplay(rec({}), 'cross')).toBe(0);
  });
});

describe('phaseMsForDisplay — 2-look toggled OFF (aggregate keys)', () => {
  it('OLL = oll on a 2-look-off record', () => {
    expect(phaseMsForDisplay(rec({ oll: 1000 }), 'oll')).toBe(1000);
  });

  it('OLL aggregates eoll + ocll on a 2-look-on record', () => {
    expect(phaseMsForDisplay(rec({ eoll: 600, ocll: 1200 }), 'oll')).toBe(1800);
  });

  it('OLL = oll + eoll + ocll if a record somehow has all three', () => {
    expect(phaseMsForDisplay(rec({ oll: 100, eoll: 200, ocll: 300 }), 'oll')).toBe(600);
  });

  it('PLL = pll on a 2-look-off record', () => {
    expect(phaseMsForDisplay(rec({ pll: 800 }), 'pll')).toBe(800);
  });

  it('PLL aggregates cpll + epll on a 2-look-on record', () => {
    expect(phaseMsForDisplay(rec({ cpll: 500, epll: 700 }), 'pll')).toBe(1200);
  });
});

describe('phaseMsForDisplay — 2-look toggled ON (split keys against records that lack the split)', () => {
  it('OCLL absorbs `oll` when no `ocll` is stored', () => {
    expect(phaseMsForDisplay(rec({ oll: 1500 }), 'ocll')).toBe(1500);
  });

  it('OCLL prefers stored `ocll` over `oll` when both present', () => {
    expect(phaseMsForDisplay(rec({ oll: 999, ocll: 1500 }), 'ocll')).toBe(1500);
  });

  it('EOLL is 0 when only the aggregate `oll` is stored (its time goes to OCLL)', () => {
    expect(phaseMsForDisplay(rec({ oll: 1500 }), 'eoll')).toBe(0);
  });

  it('EPLL absorbs `pll`; CPLL stays 0 in that case', () => {
    expect(phaseMsForDisplay(rec({ pll: 1100 }), 'epll')).toBe(1100);
    expect(phaseMsForDisplay(rec({ pll: 1100 }), 'cpll')).toBe(0);
  });
});

describe('phaseMsForDisplay — F2L sub-band keys', () => {
  it('legacy record (no f2lSplits) folds full F2L into f2l_3, others 0', () => {
    const r = rec({ f2l: 8000, cross: 1000 });
    expect(phaseMsForDisplay(r, 'f2l_1')).toBe(0);
    expect(phaseMsForDisplay(r, 'f2l_2')).toBe(0);
    expect(phaseMsForDisplay(r, 'f2l_3')).toBe(8000);
    expect(phaseMsForDisplay(r, 'f2l_4')).toBe(0);
  });

  it('4 splits → 4 non-zero sub-bands whose sum equals f2l ms', () => {
    // cross=1s, f2l=10s total; splits land at 2s, 4s, 7s, 11s
    // since-solve-start. Subtract crossMs=1000 to get within-F2L offsets:
    // 1s, 3s, 6s, 10s. Sub-band durations: 1, 2, 3, 4.
    const r: SolveRecord = {
      ts: 0, scramble: '', solution: '', totalMs: 0,
      phases: { cross: 1000, f2l: 10000 },
      process: 'cfop', twoLookOll: false, twoLookPll: false,
      f2lSplits: [2000, 4000, 7000, 11000],
    };
    expect(phaseMsForDisplay(r, 'f2l_1')).toBe(1000);
    expect(phaseMsForDisplay(r, 'f2l_2')).toBe(2000);
    expect(phaseMsForDisplay(r, 'f2l_3')).toBe(3000);
    expect(phaseMsForDisplay(r, 'f2l_4')).toBe(4000);
    const sum = ['f2l_1','f2l_2','f2l_3','f2l_4']
      .reduce((s, k) => s + phaseMsForDisplay(r, k), 0);
    expect(sum).toBe(10000);
  });

  it('fewer than 4 splits → unrecorded sub-bands collapse to 0 duration', () => {
    // Only 2 slot increments captured. The remaining sub-bands sit at
    // f2lMs cap so their duration becomes 0.
    const r: SolveRecord = {
      ts: 0, scramble: '', solution: '', totalMs: 0,
      phases: { cross: 1000, f2l: 5000 },
      process: 'cfop', twoLookOll: false, twoLookPll: false,
      f2lSplits: [3000, 4500],
    };
    expect(phaseMsForDisplay(r, 'f2l_1')).toBe(2000);
    expect(phaseMsForDisplay(r, 'f2l_2')).toBe(1500);
    expect(phaseMsForDisplay(r, 'f2l_3')).toBe(1500); // pads to f2lMs
    expect(phaseMsForDisplay(r, 'f2l_4')).toBe(0);
    const sum = ['f2l_1','f2l_2','f2l_3','f2l_4']
      .reduce((s, k) => s + phaseMsForDisplay(r, k), 0);
    expect(sum).toBe(5000);
  });

  it('clamps non-monotonic splits without exploding (defensive)', () => {
    // Hand-crafted bad data: slot 3's split is BEFORE slot 2's. The
    // helper should clamp to monotonic without going negative.
    const r: SolveRecord = {
      ts: 0, scramble: '', solution: '', totalMs: 0,
      phases: { cross: 0, f2l: 10000 },
      process: 'cfop', twoLookOll: false, twoLookPll: false,
      f2lSplits: [3000, 6000, 5000, 9000], // 5000 < 6000
    };
    // sub_3 should clamp to >= sub_2 → duration 0 for sub_3
    expect(phaseMsForDisplay(r, 'f2l_3')).toBe(0);
    const sum = ['f2l_1','f2l_2','f2l_3','f2l_4']
      .reduce((s, k) => s + phaseMsForDisplay(r, k), 0);
    expect(sum).toBe(10000);
  });
});

describe('phaseMsForDisplay — total preservation', () => {
  it('per-record total is the same whether split keys or aggregate keys are summed', () => {
    const r = rec({ cross: 1000, f2l: 4000, eoll: 700, ocll: 1100, cpll: 500, epll: 800 });
    const splitTotal = ['cross','f2l','eoll','ocll','cpll','epll']
      .reduce((s, k) => s + phaseMsForDisplay(r, k), 0);
    const aggTotal = ['cross','f2l','oll','pll']
      .reduce((s, k) => s + phaseMsForDisplay(r, k), 0);
    expect(aggTotal).toBe(splitTotal);
  });

  it('also preserves total when the record only has aggregate keys', () => {
    const r = rec({ cross: 1000, f2l: 4000, oll: 1800, pll: 1300 });
    const splitTotal = ['cross','f2l','eoll','ocll','cpll','epll']
      .reduce((s, k) => s + phaseMsForDisplay(r, k), 0);
    const aggTotal = ['cross','f2l','oll','pll']
      .reduce((s, k) => s + phaseMsForDisplay(r, k), 0);
    expect(aggTotal).toBe(splitTotal);
    expect(aggTotal).toBe(1000 + 4000 + 1800 + 1300);
  });
});
