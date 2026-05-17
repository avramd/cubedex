import { describe, expect, it } from 'vitest';
import {
  expandSolution, phaseAtMs, solveToCsvRows, rowsToCsv, historyToCsv,
} from './csvExport';
import type { SolveRecord } from './types';

function rec(overrides: Partial<SolveRecord> = {}): SolveRecord {
  return {
    ts: 1700000000000,
    scramble: '',
    solution: '',
    totalMs: 10000,
    phases: { cross: 1000, f2l: 4000, oll: 2000, pll: 3000 },
    process: 'cfop',
    twoLookOll: false,
    twoLookPll: false,
    ...overrides,
  };
}

describe('expandSolution', () => {
  it('passes through quarter-turns and primes', () => {
    expect(expandSolution("R U R' U'")).toEqual(['R', 'U', "R'", "U'"]);
  });

  it('expands half-turn tokens into two quarter-turns', () => {
    expect(expandSolution('R U2 R')).toEqual(['R', 'U', 'U', 'R']);
  });

  it('handles wide-turn half-turns', () => {
    expect(expandSolution('Rw2')).toEqual(['Rw', 'Rw']);
  });

  it('returns empty array for empty / whitespace solution', () => {
    expect(expandSolution('')).toEqual([]);
    expect(expandSolution('   ')).toEqual([]);
  });
});

describe('phaseAtMs — CFOP basics (no splits, no 2-look)', () => {
  const r = rec({ phases: { cross: 1000, f2l: 4000, oll: 2000, pll: 3000 } });

  it('classifies a time within each band', () => {
    expect(phaseAtMs(r, 500)).toBe('cross');     // 0..1000
    expect(phaseAtMs(r, 2500)).toBe('f2l');      // 1000..5000
    expect(phaseAtMs(r, 6000)).toBe('oll');      // 5000..7000
    expect(phaseAtMs(r, 8000)).toBe('pll');      // 7000..10000
    // After the final phase, no further bucket exists; phaseAtMs falls
    // through to 'solved' as a defensive default. (No row is emitted at
    // this instant — the final move row is the natural solve terminator.)
    expect(phaseAtMs(r, 10000)).toBe('solved');
  });

  it('places boundary instants in the LATER phase (strict <)', () => {
    // The move that COMPLETES a phase lands just before the next phase
    // begins, so `< phaseEnd` keeps it in the completing phase;
    // equality lands in the next phase.
    expect(phaseAtMs(r, 1000)).toBe('f2l');
    expect(phaseAtMs(r, 5000)).toBe('oll');
  });
});

describe('phaseAtMs — F2L slot splits', () => {
  it('uses f2l1..f2l4 when 4 splits are recorded', () => {
    const r = rec({
      phases: { cross: 1000, f2l: 4000, oll: 2000, pll: 3000 },
      f2lSplits: [2000, 3000, 4500, 5000],
    });
    // Inside F2L window: 1000..5000.
    expect(phaseAtMs(r, 1500)).toBe('f2l1'); // before splits[0]=2000
    expect(phaseAtMs(r, 2500)).toBe('f2l2'); // 2000..3000
    expect(phaseAtMs(r, 3500)).toBe('f2l3'); // 3000..4500
    expect(phaseAtMs(r, 4800)).toBe('f2l4'); // 4500..end
  });

  it('falls back to plain `f2l` when fewer than 4 splits exist', () => {
    const r = rec({
      phases: { cross: 1000, f2l: 4000, oll: 2000, pll: 3000 },
      f2lSplits: [2000, 3000],  // partial — treat as no splits
    });
    expect(phaseAtMs(r, 2500)).toBe('f2l');
  });
});

describe('phaseAtMs — 2-look LL', () => {
  it('uses split LL keys when present', () => {
    const r = rec({
      phases: {
        cross: 1000, f2l: 4000,
        eoll: 500, ocll: 1500,
        cpll: 800, epll: 2200,
      },
      twoLookOll: true,
      twoLookPll: true,
    });
    // f2lEnd = 5000. LL boundaries: eoll [5000..5500], ocll [5500..7000],
    // cpll [7000..7800], epll [7800..10000].
    expect(phaseAtMs(r, 5200)).toBe('eoll');
    expect(phaseAtMs(r, 6000)).toBe('ocll');
    expect(phaseAtMs(r, 7400)).toBe('cpll');
    expect(phaseAtMs(r, 9000)).toBe('epll');
  });
});

describe('phaseAtMs — beginner', () => {
  it('returns setup / ll / solved in order', () => {
    const r = rec({
      process: 'beginner',
      phases: { setup: 3000, ll: 5000 },
      totalMs: 8000,
    });
    expect(phaseAtMs(r, 1000)).toBe('setup');
    expect(phaseAtMs(r, 4000)).toBe('ll');
    expect(phaseAtMs(r, 8000)).toBe('solved');
  });
});

describe('solveToCsvRows — scramble + moves + solved', () => {
  const r = rec({
    scramble: "R U R'",
    solution: "F U R",
    turns: [0.5, 1.5, 4.5],
    phases: { cross: 1000, f2l: 4000, oll: 2000, pll: 3000 },
    totalMs: 10000,
  });

  it('emits scramble moves with blank timestamps', () => {
    const rows = solveToCsvRows(r);
    expect(rows.slice(0, 3)).toEqual([
      ['', 'R', 'scramble'],
      ['', 'U', 'scramble'],
      ['', "R'", 'scramble'],
    ]);
  });

  it('places each solve move at its turn timestamp and correct phase', () => {
    const rows = solveToCsvRows(r);
    // Solve moves start after the 3 scramble rows.
    expect(rows[3]).toEqual(['0.500', 'F', 'cross']);   // 500ms in cross
    expect(rows[4]).toEqual(['1.500', 'U', 'f2l']);     // 1500ms in F2L
    expect(rows[5]).toEqual(['4.500', 'R', 'f2l']);     // 4500ms in F2L
  });

  it('ends at the final move row — no separate `solved` terminator', () => {
    const rows = solveToCsvRows(r);
    expect(rows.find(row => row[2] === 'solved')).toBeUndefined();
    // Last row is the final solving move at its turn timestamp.
    expect(rows[rows.length - 1]).toEqual(['4.500', 'R', 'f2l']);
  });

  it('skips inspection + start rows when those fields are absent', () => {
    const rows = solveToCsvRows(r);
    for (const row of rows) {
      expect(row[2]).not.toBe('inspection');
      expect(row[2]).not.toBe('start');
    }
  });
});

describe('solveToCsvRows — inspection metadata', () => {
  const base = rec({
    scramble: 'R',
    solution: 'F',
    turns: [0.3],
    totalMs: 5000,
  });

  it('emits an inspection row with negative timestamp when inspectionMs is set', () => {
    const rows = solveToCsvRows({ ...base, inspectionMs: 12500 });
    const inspect = rows.find(r => r[2] === 'inspection');
    expect(inspect).toEqual(['-12.500', '', 'inspection']);
  });

  it('emits the `start` row only when inspectionAutoExpired is true', () => {
    const expired = solveToCsvRows({ ...base, inspectionMs: 15000, inspectionAutoExpired: true });
    expect(expired.find(r => r[2] === 'start')).toEqual(['0.000', '', 'start']);

    const manual = solveToCsvRows({ ...base, inspectionMs: 7000 });
    expect(manual.find(r => r[2] === 'start')).toBeUndefined();
  });

  it('orders rows as scramble → inspection → start → moves (no solved row)', () => {
    const rows = solveToCsvRows({ ...base, inspectionMs: 10000, inspectionAutoExpired: true });
    const phases = rows.map(r => r[2]);
    expect(phases).toEqual(['scramble', 'inspection', 'start', 'cross']);
  });
});

describe('solveToCsvRows — half-turn expansion', () => {
  it('expands a half-turn in the solution into two move rows at consecutive turn times', () => {
    const r = rec({
      scramble: '',
      solution: 'R2 U',
      turns: [0.4, 0.9, 2.0],
      phases: { cross: 1000, f2l: 4000, oll: 2000, pll: 3000 },
      totalMs: 10000,
    });
    const rows = solveToCsvRows(r);
    // Two R rows (from R2 expansion) then U.
    expect(rows[0]).toEqual(['0.400', 'R', 'cross']);
    expect(rows[1]).toEqual(['0.900', 'R', 'cross']);
    expect(rows[2]).toEqual(['2.000', 'U', 'f2l']);
  });
});

describe('rowsToCsv', () => {
  it('joins rows with newlines and fields with commas', () => {
    expect(rowsToCsv([['a', 'b', 'c'], ['1', '2', '3']])).toBe('a,b,c\n1,2,3');
  });

  it('escapes fields containing commas / quotes / newlines', () => {
    expect(rowsToCsv([['a,b', 'q"q', 'n\nl']])).toBe('"a,b","q""q","n\nl"');
  });
});

describe('historyToCsv', () => {
  it('concatenates solves back-to-back without blank separator rows', () => {
    const a = rec({ scramble: 'R', solution: 'F', turns: [0.3], totalMs: 1000 });
    const b = rec({ scramble: 'U', solution: 'B', turns: [0.4], totalMs: 1100 });
    const csv = historyToCsv([a, b]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('timestamp,move,phase');
    // No blank rows anywhere — each solve's `solved`/`abort` row + the
    // next solve's `scramble` row is the only boundary.
    expect(lines).not.toContain(',,');
  });

  it('returns just the header when history is empty', () => {
    expect(historyToCsv([])).toBe('timestamp,move,phase');
  });
});

describe('solveToCsvRows — aborted solves', () => {
  it('emits an abort row with timestamp when abortedAtMs is set', () => {
    const r = rec({
      scramble: 'R', solution: 'F', turns: [0.3],
      aborted: true, abortedAtMs: 7250,
    });
    const rows = solveToCsvRows(r);
    expect(rows.find(row => row[2] === 'solved')).toBeUndefined();
    expect(rows[rows.length - 1]).toEqual(['7.250', '', 'abort']);
  });

  it('emits an abort row with blank timestamp when abortedAtMs is absent', () => {
    const r = rec({
      scramble: 'R', solution: '', turns: [],
      aborted: true,
    });
    const rows = solveToCsvRows(r);
    expect(rows[rows.length - 1]).toEqual(['', '', 'abort']);
  });

  it('still emits scramble and move rows before the abort row', () => {
    const r = rec({
      scramble: 'R U',
      solution: 'F',
      turns: [0.5],
      aborted: true,
      abortedAtMs: 3000,
    });
    const rows = solveToCsvRows(r);
    expect(rows.map(row => row[2])).toEqual(['scramble', 'scramble', 'cross', 'abort']);
  });
});

describe('historyToCsv — completed solves have no `solved` rows', () => {
  it('omits the terminator for every completed solve in history', () => {
    const a = rec({ scramble: 'R', solution: 'F', turns: [0.3], totalMs: 1000 });
    const b = rec({ scramble: 'U', solution: 'B', turns: [0.4], totalMs: 1100 });
    const csv = historyToCsv([a, b]);
    expect(csv.includes('solved')).toBe(false);
  });
});
