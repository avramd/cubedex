import { describe, expect, it } from 'vitest';
import {
  classifyPauseMove, computePauseReversePath, isPauseMoveClickable,
  computeRedundantBlocks, isRedundantIdx,
  type PauseState,
} from './pauseModel';

// Tests use opaque "facelet" labels (S0, S1, ...) — the module doesn't
// inspect facelet structure, only equality, so any string works.

function state(over: Partial<PauseState> = {}): PauseState {
  const originalMoves = over.originalMoves ?? ['R', 'U', "R'", "U'"];
  const originalStates = over.originalStates ?? ['S0', 'S1', 'S2', 'S3', 'S4'];
  return {
    originalMoves,
    originalStates,
    redundantBlocks: over.redundantBlocks ?? [],
    frontier: 3,
    wayward: [],
    redoneSet: new Set<number>(),
    targetIdx: null,
    ...over,
  };
}

describe('computeRedundantBlocks', () => {
  it('returns empty for non-redundant solves', () => {
    expect(computeRedundantBlocks(['A', 'B', 'C', 'D'])).toEqual([]);
  });

  it('identifies a single redundant pair (R R\')', () => {
    expect(computeRedundantBlocks(['A', 'B', 'A'])).toEqual([[0, 1]]);
  });

  it('picks the MAXIMAL block when a state recurs multiple times', () => {
    expect(computeRedundantBlocks(['A', 'B', 'A', 'B', 'A'])).toEqual([[0, 3]]);
  });

  it('keeps a single block when a state recurs once and a non-redundant tail follows', () => {
    expect(computeRedundantBlocks(['A', 'B', 'A', 'B'])).toEqual([[0, 1]]);
  });

  it('finds two distinct redundant blocks separated by a non-redundant move', () => {
    expect(computeRedundantBlocks(['A', 'B', 'A', 'C', 'D', 'C'])).toEqual([[0, 1], [3, 4]]);
  });
});

describe('classifyPauseMove — state matching', () => {
  it('advances frontier when new state matches the next index', () => {
    const s = state({ frontier: -1, originalStates: ['A', 'B', 'C'], originalMoves: ['m1', 'm2'] });
    const r = classifyPauseMove(s, 'm1', 'B');
    expect(r.bucket).toBe('on-path');
    expect(r.next.frontier).toBe(0);
    expect(r.next.redoneSet.has(0)).toBe(true);
  });

  it('jumps past a redundant block when state matches the post-block index', () => {
    const s = state({
      frontier: -1,
      originalMoves: ['R', "R'", 'R'],
      originalStates: ['A', 'B', 'A', 'B'],
      redundantBlocks: [[0, 1]],
    });
    const r = classifyPauseMove(s, 'R', 'B');
    expect(r.next.frontier).toBe(2);
    expect(r.next.redoneSet.has(2)).toBe(true);
    expect(r.next.redoneSet.has(0)).toBe(false);
    expect(r.next.redoneSet.has(1)).toBe(false);
  });

  it('off-path move grows wayward', () => {
    const s = state({
      frontier: 1, originalMoves: ['R', 'U'], originalStates: ['A', 'B', 'C'],
    });
    const r = classifyPauseMove(s, 'F', 'X');
    expect(r.bucket).toBe('wayward-new');
    expect(r.next.wayward).toEqual(['F']);
    expect(r.next.frontier).toBe(1);
  });

  it('wayward-undo pops when move inverts top AND new state is still off-path', () => {
    const s = state({
      frontier: 1,
      originalMoves: ['R', 'U'], originalStates: ['A', 'B', 'C'],
      wayward: ['F'],
    });
    const r = classifyPauseMove(s, "F'", 'Y');
    expect(r.bucket).toBe('wayward-undo');
    expect(r.next.wayward).toEqual([]);
  });

  it('wayward auto-clears when the user lands back on the path', () => {
    const s = state({
      frontier: 1,
      originalMoves: ['R', 'U'], originalStates: ['A', 'B', 'C'],
      wayward: ['F', 'F2'],
    });
    const r = classifyPauseMove(s, 'anything', 'A');
    expect(r.bucket).toBe('on-path');
    expect(r.next.frontier).toBe(-1);
    expect(r.next.wayward).toEqual([]);
  });

  it('walks backward when new state matches only a lower index', () => {
    const s = state({ frontier: 2, originalStates: ['A', 'B', 'C', 'D'], originalMoves: ['m1', 'm2', 'm3'] });
    const r = classifyPauseMove(s, "m3'", 'C');
    expect(r.next.frontier).toBe(1);
    expect(r.next.redoneSet.has(2)).toBe(false);
  });
});

describe('computePauseReversePath', () => {
  it('returns empty with no target', () => {
    expect(computePauseReversePath(state({ targetIdx: null }))).toEqual([]);
  });

  it('skips fully-contained redundant blocks in the revert range', () => {
    const s = state({
      frontier: 2,
      targetIdx: -1,
      originalMoves: ['R', "R'", 'U'],
      originalStates: ['A', 'B', 'A', 'C'],
      redundantBlocks: [[0, 1]],
    });
    expect(computePauseReversePath(s)).toEqual(["U'"]);
  });

  it('does NOT skip a redundant block that straddles the revert range', () => {
    const s = state({
      frontier: 2,
      targetIdx: 0,
      originalMoves: ['R', 'U', "U'", "R'"],
      originalStates: ['A', 'B', 'C', 'B', 'A'],
      redundantBlocks: [[0, 3]],
    });
    expect(computePauseReversePath(s)).toEqual(['U', "U'"]);
  });

  it('undoes wayward first then walks back', () => {
    const s = state({
      frontier: 2,
      targetIdx: 1,
      wayward: ['F', 'B'],
      originalMoves: ['R', 'U', "U'"],
      originalStates: ['A', 'B', 'C', 'B'],
    });
    expect(computePauseReversePath(s)).toEqual(["B'", "F'", 'U']);
  });
});

describe('isPauseMoveClickable', () => {
  const s = state({ frontier: 2, redoneSet: new Set([1]) });

  it('rejects indices forward of frontier', () => {
    expect(isPauseMoveClickable(s, 3)).toBe(false);
  });

  it('rejects indices in redoneSet', () => {
    expect(isPauseMoveClickable(s, 1)).toBe(false);
  });

  it('accepts other in-range indices, including redundant ones', () => {
    expect(isPauseMoveClickable(s, 0)).toBe(true);
    expect(isPauseMoveClickable(s, 2)).toBe(true);
  });
});

describe('isRedundantIdx', () => {
  it('reports true for indices inside any redundant block', () => {
    const s = state({ redundantBlocks: [[0, 1], [3, 4]] });
    expect(isRedundantIdx(s, 0)).toBe(true);
    expect(isRedundantIdx(s, 1)).toBe(true);
    expect(isRedundantIdx(s, 2)).toBe(false);
    expect(isRedundantIdx(s, 3)).toBe(true);
    expect(isRedundantIdx(s, 4)).toBe(true);
    expect(isRedundantIdx(s, 5)).toBe(false);
  });
});

describe('classifyPauseMove — R2 reversal via any quarter-turn direction', () => {
  it('R+R or R\'+R\' both bring the cube back to the start state', () => {
    // Original: R R (=R2). States A → B → C. User at frontier=1
    // (state C). To get back to state A, they can do R+R (same
    // direction; intermediate state D is off-path) or R'+R'
    // (intermediate state B is on-path). Either path ends at A.
    const start = state({
      frontier: 1,
      originalMoves: ['R', 'R'],
      originalStates: ['A', 'B', 'C'],
    });

    // Path 1: R + R — first R lands the cube on an off-path state D.
    let s = classifyPauseMove(start, 'R', 'D').next;
    expect(s.frontier).toBe(1);
    expect(s.wayward).toEqual(['R']);
    s = classifyPauseMove(s, 'R', 'A').next;
    expect(s.frontier).toBe(-1);
    expect(s.wayward).toEqual([]);

    // Path 2: R' + R' — both intermediates are on path.
    let t = classifyPauseMove(start, "R'", 'B').next;
    expect(t.frontier).toBe(0);
    t = classifyPauseMove(t, "R'", 'A').next;
    expect(t.frontier).toBe(-1);
  });
});
