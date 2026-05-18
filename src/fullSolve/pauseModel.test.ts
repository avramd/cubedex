import { describe, expect, it } from 'vitest';
import {
  classifyPauseMove, computePauseReversePath, isPauseMoveClickable,
  type PauseState,
} from './pauseModel';

function state(over: Partial<PauseState> = {}): PauseState {
  return {
    originalMoves: ['R', 'U', "R'", "U'"],
    frontier: 3,
    wayward: [],
    redoneSet: new Set<number>(),
    targetIdx: null,
    ...over,
  };
}

describe('classifyPauseMove — reverse', () => {
  it('classifies inverse of frontier move as reverse and decrements frontier', () => {
    const r = classifyPauseMove(state({ frontier: 3 }), 'U'); // invert of U'
    expect(r.bucket).toBe('reverse');
    expect(r.next.frontier).toBe(2);
    expect(r.next.wayward).toEqual([]);
  });

  it('drops the previously-redone bookmark when reversing past it', () => {
    const r = classifyPauseMove(state({ frontier: 3, redoneSet: new Set([3]) }), 'U');
    expect(r.next.redoneSet.has(3)).toBe(false);
  });

  it('treats R2 as self-inverting when reversing', () => {
    const r = classifyPauseMove(
      state({ originalMoves: ['R', 'U2'], frontier: 1 }),
      'U2',
    );
    expect(r.bucket).toBe('reverse');
    expect(r.next.frontier).toBe(0);
  });
});

describe('classifyPauseMove — redo', () => {
  it('classifies the next original move as redo and increments frontier', () => {
    const r = classifyPauseMove(state({ frontier: 1 }), "R'"); // originalMoves[2]
    expect(r.bucket).toBe('redo');
    expect(r.next.frontier).toBe(2);
    expect(r.next.redoneSet.has(2)).toBe(true);
  });

  it('does not classify as redo past the end of original', () => {
    const r = classifyPauseMove(state({ frontier: 3 }), 'X');
    expect(r.bucket).toBe('wayward-new');
  });
});

describe('classifyPauseMove — wayward', () => {
  it('a non-matching move with empty wayward starts wayward', () => {
    const r = classifyPauseMove(state({ frontier: 3 }), 'F');
    expect(r.bucket).toBe('wayward-new');
    expect(r.next.wayward).toEqual(['F']);
    expect(r.next.frontier).toBe(3);
  });

  it('wayward-undo pops when move inverts the top of wayward', () => {
    const r = classifyPauseMove(state({ wayward: ['F', 'B'] }), "B'");
    expect(r.bucket).toBe('wayward-undo');
    expect(r.next.wayward).toEqual(['F']);
  });

  it('a non-undoing move while wayward non-empty EXTENDS wayward (not reverse)', () => {
    // U inverts the original frontier U', BUT wayward is non-empty so we
    // must not silently rewind underneath it.
    const r = classifyPauseMove(state({ frontier: 3, wayward: ['F'] }), 'U');
    expect(r.bucket).toBe('wayward-new');
    expect(r.next.wayward).toEqual(['F', 'U']);
    expect(r.next.frontier).toBe(3);
  });

  it('reverse only fires when wayward is empty', () => {
    const r = classifyPauseMove(state({ frontier: 3, wayward: [] }), 'U');
    expect(r.bucket).toBe('reverse');
  });
});

describe('classifyPauseMove — does not mutate input', () => {
  it('returns a new state without touching the original', () => {
    const s = state({ frontier: 3, wayward: ['F'], redoneSet: new Set([1]) });
    const snapshotWayward = [...s.wayward];
    const r = classifyPauseMove(s, "F'");
    expect(s.wayward).toEqual(snapshotWayward);
    expect(s.redoneSet.has(1)).toBe(true); // original still has it
    expect(r.next.wayward).toEqual([]);
  });
});

describe('computePauseReversePath', () => {
  it('returns empty when no target is set', () => {
    expect(computePauseReversePath(state({ targetIdx: null }))).toEqual([]);
  });

  it('returns empty when frontier already equals target and no wayward', () => {
    expect(computePauseReversePath(state({ frontier: 2, targetIdx: 2 }))).toEqual([]);
  });

  it('walks back from frontier down to targetIdx + 1 in execution order', () => {
    // originalMoves: [R, U, R', U']; frontier=3; target=0.
    // To reach state-after-move-0: invert U' (→U), R' (→R), U (→U').
    const r = computePauseReversePath(state({ frontier: 3, targetIdx: 0 }));
    expect(r).toEqual(['U', 'R', "U'"]);
  });

  it('undoes wayward first (LIFO) then walks back to target', () => {
    const r = computePauseReversePath(state({
      frontier: 3,
      targetIdx: 2,
      wayward: ['F', 'B'],
    }));
    // wayward first: invert(B)→B', invert(F)→F'. Then frontier 3 only
    // (down to targetIdx+1 = 3): invert(originalMoves[3] = U') → U.
    expect(r).toEqual(["B'", "F'", 'U']);
  });

  it('returns empty when frontier has gone past the target (over-reversed)', () => {
    expect(computePauseReversePath(state({ frontier: 0, targetIdx: 2 }))).toEqual([]);
  });
});

describe('isPauseMoveClickable', () => {
  const s = state({ frontier: 2, redoneSet: new Set([1]) });

  it('rejects indices forward of the frontier', () => {
    expect(isPauseMoveClickable(s, 3)).toBe(false);
  });

  it('rejects indices in the redoneSet', () => {
    expect(isPauseMoveClickable(s, 1)).toBe(false);
  });

  it('accepts indices at-or-behind frontier and not redone', () => {
    expect(isPauseMoveClickable(s, 0)).toBe(true);
    expect(isPauseMoveClickable(s, 2)).toBe(true);
  });
});

describe('classifyPauseMove — integration: reverse-then-redo round trip', () => {
  it('reverse then redo returns to the same frontier with redoneSet marking the move', () => {
    let s = state({ frontier: 3, redoneSet: new Set<number>() });
    s = classifyPauseMove(s, 'U').next;       // reverse: frontier 3→2
    expect(s.frontier).toBe(2);
    s = classifyPauseMove(s, "U'").next;      // redo:    frontier 2→3
    expect(s.frontier).toBe(3);
    expect(s.redoneSet.has(3)).toBe(true);
  });

  it('reverse → wayward → wayward-undo restores reverse-state cleanly', () => {
    let s = state({ frontier: 3 });
    s = classifyPauseMove(s, 'U').next;       // reverse → frontier 2, wayward []
    s = classifyPauseMove(s, 'F').next;       // wayward-new → wayward [F]
    s = classifyPauseMove(s, "F'").next;      // wayward-undo → wayward []
    expect(s.frontier).toBe(2);
    expect(s.wayward).toEqual([]);
  });
});
