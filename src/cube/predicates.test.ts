import { describe, expect, it } from 'vitest';
import { type Face, FACES, FACE_OFFSET, OPPOSITE } from './facelets';
import {
  CROSS_ADJ, F2L_BAND, HEADLIGHT,
  isCrossDoneOn, isF2LDoneOn, isEOLLDoneOn, isOllDoneOn, isHeadlightsDoneOn,
  isAnyEdgeCrossOn, firstMatchingFace,
} from './predicates';

// Solved cube using face letters as colors (URFDLB layout, 9 stickers each).
const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';

function setSticker(facelets: string, face: Face, index: number, to: string): string {
  const o = FACE_OFFSET[face] + index;
  return facelets.slice(0, o) + to + facelets.slice(o + 1);
}

// Replace all 9 stickers of one face with the same character — useful for
// erasing F2L or OLL data without touching the cross side.
function paintFace(facelets: string, face: Face, color: string): string {
  const o = FACE_OFFSET[face];
  return facelets.slice(0, o) + color.repeat(9) + facelets.slice(o + 9);
}

// Replace specific sticker indices on `face` with `color`.
function paintIndices(facelets: string, face: Face, indices: number[], color: string): string {
  let out = facelets;
  for (const i of indices) out = setSticker(out, face, i, color);
  return out;
}

describe('CROSS_ADJ / F2L_BAND / HEADLIGHT tables', () => {
  it('CROSS_ADJ has 4 entries per face, naming only side faces', () => {
    for (const f of FACES) {
      expect(CROSS_ADJ[f]).toHaveLength(4);
      for (const [side] of CROSS_ADJ[f]) {
        expect(side).not.toBe(f);
        expect(side).not.toBe(OPPOSITE[f]);
      }
    }
  });

  it('F2L_BAND has 4 side faces × 6 indices each', () => {
    for (const f of FACES) {
      expect(F2L_BAND[f]).toHaveLength(4);
      for (const [side, indices] of F2L_BAND[f]) {
        expect(side).not.toBe(f);
        expect(side).not.toBe(OPPOSITE[f]);
        expect(indices).toHaveLength(6);
        // All indices in 0..8.
        for (const i of indices) {
          expect(i).toBeGreaterThanOrEqual(0);
          expect(i).toBeLessThanOrEqual(8);
        }
      }
    }
  });

  it('HEADLIGHT has 4 side faces × 2 indices each', () => {
    for (const f of FACES) {
      expect(HEADLIGHT[f]).toHaveLength(4);
      for (const [side, [a, b]] of HEADLIGHT[f]) {
        expect(side).not.toBe(f);
        expect(side).not.toBe(OPPOSITE[f]);
        expect(a).not.toBe(b);
      }
    }
  });
});

describe('predicates on a solved cube (color-neutral)', () => {
  it('isCrossDoneOn returns true for every face', () => {
    for (const f of FACES) expect(isCrossDoneOn(f, SOLVED)).toBe(true);
  });

  it('isF2LDoneOn returns true for every face', () => {
    for (const f of FACES) expect(isF2LDoneOn(f, SOLVED)).toBe(true);
  });

  it('isEOLLDoneOn returns true for every face', () => {
    for (const f of FACES) expect(isEOLLDoneOn(f, SOLVED)).toBe(true);
  });

  it('isOllDoneOn returns true for every face', () => {
    for (const f of FACES) expect(isOllDoneOn(f, SOLVED)).toBe(true);
  });

  it('isHeadlightsDoneOn returns true for every face', () => {
    for (const f of FACES) expect(isHeadlightsDoneOn(f, SOLVED)).toBe(true);
  });
});

describe('isCrossDoneOn — partial states', () => {
  it('true when cross-face edges + adjacent center-row stickers are right (corners may be wrong)', () => {
    // Mess up D corners (indices 0, 2, 6, 8) — cross is still done.
    let s = setSticker(SOLVED, 'D', 0, 'X');
    s = setSticker(s, 'D', 2, 'X');
    s = setSticker(s, 'D', 6, 'X');
    s = setSticker(s, 'D', 8, 'X');
    expect(isCrossDoneOn('D', s)).toBe(true);
  });

  it('false when one cross edge sticker is wrong', () => {
    expect(isCrossDoneOn('D', setSticker(SOLVED, 'D', 1, 'X'))).toBe(false);
  });

  it('false when the cross center is wrong', () => {
    expect(isCrossDoneOn('D', setSticker(SOLVED, 'D', 4, 'X'))).toBe(false);
  });

  it('false when an adjacent side-face sticker is wrong', () => {
    // CROSS_ADJ.D has F[7], L[7], R[7], B[7]. Break F[7].
    expect(isCrossDoneOn('D', setSticker(SOLVED, 'F', 7, 'X'))).toBe(false);
  });

  it('detects cross on a non-D face independently', () => {
    // Break a D edge so D is NOT the cross face — solved otherwise means
    // cross IS also done on every other face. Confirm color neutrality by
    // spot-checking U. (Painting D entirely with one new color doesn't
    // actually break "cross done" on D — every D edge still matches the D
    // center, just in the new color; this is exactly what color neutrality
    // means.)
    const s = setSticker(SOLVED, 'D', 1, 'X');
    expect(isCrossDoneOn('D', s)).toBe(false);
    expect(isCrossDoneOn('U', s)).toBe(true);
  });
});

describe('isF2LDoneOn — partial states', () => {
  it('false when the cross face is not mono', () => {
    // Cross face must be entirely uniform (not just edges) for F2L done.
    expect(isF2LDoneOn('D', setSticker(SOLVED, 'D', 0, 'X'))).toBe(false);
  });

  it('false when an F2L band sticker is wrong', () => {
    // F2L_BAND.D for F is [3,4,5,6,7,8] — break F[6].
    expect(isF2LDoneOn('D', setSticker(SOLVED, 'F', 6, 'X'))).toBe(false);
  });

  it('true when the LL face is scrambled but cross-side bands match', () => {
    // Scramble U entirely — F2L on D should still hold.
    const s = paintFace(SOLVED, 'U', 'X');
    expect(isF2LDoneOn('D', s)).toBe(true);
  });
});

describe('isOllDoneOn / isEOLLDoneOn / isHeadlightsDoneOn', () => {
  it('OLL false when the LL face is not mono', () => {
    expect(isOllDoneOn('D', setSticker(SOLVED, 'U', 0, 'X'))).toBe(false);
  });

  it('OLL false even if EOLL holds (corners off but edges right)', () => {
    // Break a corner on U; edges still match center, so EOLL holds, OLL doesn't.
    const s = setSticker(SOLVED, 'U', 0, 'X');
    expect(isEOLLDoneOn('D', s)).toBe(true);
    expect(isOllDoneOn('D', s)).toBe(false);
  });

  it('EOLL false when an LL edge is off', () => {
    expect(isEOLLDoneOn('D', setSticker(SOLVED, 'U', 1, 'X'))).toBe(false);
  });

  it('headlights detects matching corner pairs even when not solved', () => {
    // Replace the LL face entirely with Xs (so OLL is "done in X"). The side
    // faces are still solved → headlights pairs (per side, the two LL-side
    // corners) are equal because the side face is fully one color.
    const s = paintFace(SOLVED, 'U', 'X');
    expect(isHeadlightsDoneOn('D', s)).toBe(true);
  });

  it('headlights false when one side has mismatched corner pair', () => {
    // HEADLIGHT.D has F[0,2]. Make F[0] differ from F[2].
    let s = paintFace(SOLVED, 'U', 'X');
    s = setSticker(s, 'F', 0, 'Z');
    expect(isHeadlightsDoneOn('D', s)).toBe(false);
  });
});

describe('isAnyEdgeCrossOn', () => {
  it('true on a face whose 4 edges match its center', () => {
    for (const f of FACES) expect(isAnyEdgeCrossOn(f, SOLVED)).toBe(true);
  });

  it('false when an edge is off', () => {
    expect(isAnyEdgeCrossOn('U', setSticker(SOLVED, 'U', 1, 'X'))).toBe(false);
  });

  it('does not require the corners to match', () => {
    const s = paintIndices(SOLVED, 'U', [0, 2, 6, 8], 'X');
    expect(isAnyEdgeCrossOn('U', s)).toBe(true);
  });
});

describe('firstMatchingFace', () => {
  it('returns the first face for which the predicate is true', () => {
    expect(firstMatchingFace(SOLVED, isCrossDoneOn)).not.toBeNull();
  });

  it('returns null when no face matches', () => {
    // Break a cross edge on every face so isCrossDoneOn fails everywhere.
    // (An all-X cube would actually have cross done on every face — every
    // sticker matches every center.)
    let s = SOLVED;
    for (const f of FACES) s = setSticker(s, f, 1, '?'); // break top edge of each face
    expect(firstMatchingFace(s, isCrossDoneOn)).toBeNull();
  });
});
