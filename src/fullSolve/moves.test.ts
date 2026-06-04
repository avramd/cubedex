import { describe, expect, it } from 'vitest';
import {
  collapseDoubles, collapseSlicesAndDoubles,
  getFace, moveClass, parseScramble, sumQuarters,
} from './moves';

describe('moveClass', () => {
  it('classifies clockwise quarter-turns', () => {
    expect(moveClass('R')).toBe('clock');
    expect(moveClass('U')).toBe('clock');
    expect(moveClass('Rw')).toBe('clock');
  });

  it('classifies counter-clockwise turns by trailing apostrophe', () => {
    expect(moveClass("R'")).toBe('c-clock');
    expect(moveClass("Uw'")).toBe('c-clock');
  });

  it('classifies half-turns by trailing 2', () => {
    expect(moveClass('R2')).toBe('double');
    expect(moveClass('U2')).toBe('double');
    expect(moveClass('Rw2')).toBe('double');
  });
});

describe('getFace', () => {
  it('extracts the face letters before the suffix', () => {
    expect(getFace('R')).toBe('R');
    expect(getFace("R'")).toBe('R');
    expect(getFace('R2')).toBe('R');
    expect(getFace('Rw')).toBe('Rw');
    expect(getFace("Rw'")).toBe('Rw');
    expect(getFace('Rw2')).toBe('Rw');
  });

  it('returns the original token when there are no face letters', () => {
    expect(getFace('')).toBe('');
    expect(getFace("'")).toBe("'");
  });
});

describe('sumQuarters', () => {
  it('counts a single clockwise as 1', () => {
    expect(sumQuarters(['R'])).toBe(1);
  });

  it('counts a single counter-clockwise as 3 (mod 4)', () => {
    expect(sumQuarters(["R'"])).toBe(3);
  });

  it('counts a half-turn as 2', () => {
    expect(sumQuarters(['R2'])).toBe(2);
  });

  it('sums and reduces mod 4', () => {
    expect(sumQuarters(['R', 'R', 'R', 'R'])).toBe(0);
    expect(sumQuarters(['R', 'R', 'R'])).toBe(3);
    expect(sumQuarters(['R', 'R'])).toBe(2);
    expect(sumQuarters(['R2', 'R2'])).toBe(0);
    expect(sumQuarters(['R', "R'"])).toBe(0);
    expect(sumQuarters(['R', 'R2'])).toBe(3);
  });

  it('treats an empty group as 0', () => {
    expect(sumQuarters([])).toBe(0);
  });
});

describe('collapseDoubles', () => {
  it('passes through unrelated moves', () => {
    expect(collapseDoubles(['R', 'U', 'F'])).toEqual(['R', 'U', 'F']);
  });

  it('collapses two adjacent identical quarter-turns into a half-turn', () => {
    expect(collapseDoubles(['R', 'R'])).toEqual(['R2']);
    expect(collapseDoubles(["R'", "R'"])).toEqual(['R2']);
  });

  it('only collapses identical quarter-turn pairs (not mixed)', () => {
    // R + R' is a no-op turn-wise but the collapser is intentionally
    // conservative: it only fuses pairs with identical tokens.
    expect(collapseDoubles(['R', "R'"])).toEqual(['R', "R'"]);
    expect(collapseDoubles(['R', 'U'])).toEqual(['R', 'U']);
  });

  it('does not re-collapse an existing half-turn', () => {
    expect(collapseDoubles(['R2', 'R2'])).toEqual(['R2', 'R2']);
  });

  it('handles a long sequence with multiple pair sites', () => {
    expect(collapseDoubles(['R', 'R', 'U', 'F', 'F', "L'", "L'"]))
      .toEqual(['R2', 'U', 'F2', 'L2']);
  });

  it('does not chain: three Rs collapse into R2 + R, not R3', () => {
    expect(collapseDoubles(['R', 'R', 'R'])).toEqual(['R2', 'R']);
  });

  it('is idempotent on already-collapsed input', () => {
    const collapsed = collapseDoubles(['R', 'R', 'U']);
    expect(collapseDoubles(collapsed)).toEqual(collapsed);
  });
});

// All times are seconds-from-solve-start; tolerance is in MS. Helper to
// keep the tests readable.
const TOLERANCE = 80;

describe('collapseSlicesAndDoubles — quarter-turn slice pass', () => {
  it('collapses opposite-face pairs that fall within tolerance', () => {
    // R' L within 50 ms → M'.
    expect(collapseSlicesAndDoubles(["R'", 'L'], [1.000, 1.050], TOLERANCE))
      .toEqual(["M'"]);
  });

  it('leaves pairs further apart than tolerance alone', () => {
    expect(collapseSlicesAndDoubles(["R'", 'L'], [1.000, 1.200], TOLERANCE))
      .toEqual(["R'", 'L']);
  });

  it('collapses well inside the tolerance and not just outside it', () => {
    // 79 ms apart → collapses; 81 ms apart → does not. (Avoiding the
    // exact-edge case sidesteps float-precision noise in the
    // subtraction.)
    expect(collapseSlicesAndDoubles(["R'", 'L'], [1.000, 1.079], TOLERANCE))
      .toEqual(["M'"]);
    expect(collapseSlicesAndDoubles(["R'", 'L'], [1.000, 1.081], TOLERANCE))
      .toEqual(["R'", 'L']);
  });

  it('handles both orderings of the same slice pair', () => {
    expect(collapseSlicesAndDoubles(["R'", 'L'], [0, 0.01], TOLERANCE)).toEqual(["M'"]);
    expect(collapseSlicesAndDoubles(['L', "R'"], [0, 0.01], TOLERANCE)).toEqual(["M'"]);
  });

  it('does not over-eagerly chain: a slice token is not eligible as the next pair\'s first half', () => {
    // R' L R': first pair (R' L) collapses to M' if fast; the third R'
    // is left alone (M' + R' is not in the slice map).
    expect(collapseSlicesAndDoubles(["R'", 'L', "R'"], [0, 0.01, 0.02], TOLERANCE))
      .toEqual(["M'", "R'"]);
  });

  it('passes through non-slice opposite-face pairs', () => {
    // R L is not in the slice map (only R L' / L' R are M); leave alone.
    expect(collapseSlicesAndDoubles(['R', 'L'], [0, 0.01], TOLERANCE))
      .toEqual(['R', 'L']);
  });
});

describe('collapseSlicesAndDoubles — pipeline with doubles', () => {
  it('parallel-hand M2 (R, L, R, L pattern) → two M tokens → M2', () => {
    // Pattern simulating both hands flicking M2 simultaneously: each
    // pair lands within 10 ms, gaps between pairs ~70 ms. After pass
    // 1 the tokens are M' M'; pass 2's collapseDoubles strips the
    // prime when collapsing same-token (M' M' done twice nets to a
    // half-turn), yielding M2 — the canonical form.
    expect(collapseSlicesAndDoubles(
      ["R'", 'L', "R'", 'L'],
      [0.000, 0.010, 0.070, 0.080],
      TOLERANCE,
    )).toEqual(['M2']);
  });

  it('sequential M2 (R, R, L, L pattern) catches the X2 slice in pass 3', () => {
    // Pattern simulating R2 first, then L2: doubles collapse to
    // [R2, L2], then the X2 pass folds them to M2.
    expect(collapseSlicesAndDoubles(
      ['R', 'R', 'L', 'L'],
      [0.000, 0.060, 0.120, 0.180],
      TOLERANCE,
    )).toEqual(['M2']);
  });

  it('R2 L2 outside tolerance stays as two doubles', () => {
    expect(collapseSlicesAndDoubles(
      ['R', 'R', 'L', 'L'],
      // Big gap between the second R and the first L.
      [0.000, 0.060, 0.500, 0.560],
      TOLERANCE,
    )).toEqual(['R2', 'L2']);
  });
});

describe('collapseSlicesAndDoubles — non-slice + edge cases', () => {
  it('passes through ordinary moves untouched', () => {
    expect(collapseSlicesAndDoubles(['R', 'U', "R'", "U'"], [0, 1, 2, 3], TOLERANCE))
      .toEqual(['R', 'U', "R'", "U'"]);
  });

  it('still collapses adjacent same-face quarter-turns into a half-turn', () => {
    expect(collapseSlicesAndDoubles(['R', 'R'], [0, 0.05], TOLERANCE))
      .toEqual(['R2']);
  });

  it('handles E and S slices the same way', () => {
    expect(collapseSlicesAndDoubles(["D'", 'U'], [0, 0.01], TOLERANCE)).toEqual(['E']);
    expect(collapseSlicesAndDoubles(["F'", 'B'], [0, 0.01], TOLERANCE)).toEqual(['S']);
  });

  it('empty input → empty output', () => {
    expect(collapseSlicesAndDoubles([], [], TOLERANCE)).toEqual([]);
  });

  it('single move passes through', () => {
    expect(collapseSlicesAndDoubles(['R'], [0], TOLERANCE)).toEqual(['R']);
  });
});

describe('parseScramble', () => {
  it('returns the cleaned space-separated scramble on a valid input', () => {
    expect(parseScramble("R U R' U'")).toBe("R U R' U'");
  });

  it('collapses any internal whitespace runs to single spaces', () => {
    expect(parseScramble("  R\tU \n F2  ")).toBe('R U F2');
  });

  it('accepts wide turns and half-turns', () => {
    expect(parseScramble('Rw Uw2 Lw\'')).toBe('Rw Uw2 Lw\'');
  });

  it('accepts slice turns and rotations', () => {
    expect(parseScramble("M E S x y' z2")).toBe("M E S x y' z2");
  });

  it('accepts lowercase face letters (cubing.js handles them downstream)', () => {
    expect(parseScramble("r u f'")).toBe("r u f'");
  });

  it('returns null on empty / whitespace-only input', () => {
    expect(parseScramble('')).toBeNull();
    expect(parseScramble('   ')).toBeNull();
    expect(parseScramble('\n\t')).toBeNull();
  });

  it('returns null when any token is non-cube notation', () => {
    expect(parseScramble('R U Q')).toBeNull();    // Q isn't a face
    expect(parseScramble('R U R12')).toBeNull();  // 12 isn't a valid suffix
    expect(parseScramble('R U 5')).toBeNull();    // bare digit
  });

  it("rejects combined modifiers like R'2 / R2'", () => {
    expect(parseScramble("R'2")).toBeNull();
    expect(parseScramble("R2'")).toBeNull();
  });
});
