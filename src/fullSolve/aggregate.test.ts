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
