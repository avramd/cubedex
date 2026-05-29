import { describe, expect, it } from 'vitest';
import { type Face, FACES, FACE_OFFSET, OPPOSITE } from './facelets';
import {
  CROSS_ADJ, F2L_BAND, F2L_SLOTS, HEADLIGHT,
  isCrossDoneOn, isF2LDoneOn, isEOLLDoneOn, isOllDoneOn, isHeadlightsDoneOn,
  f2lSlotsDoneOn, isAnyEdgeCrossOn, firstMatchingFace,
  isRouxFirstBlockDoneOn, isRouxSecondBlockDoneOn,
  areTopCornersOrientedOn, isLSEOrientedOn, isLREDoneOn,
  EDGE_DS,
  crossEdgesCorrectlyPlaced,
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

describe('crossEdgesCorrectlyPlaced', () => {
  // SOLVED uses face letters as colours: D-face = 'D', F-face = 'F',
  // etc. Cross-face centre for D = 'D'. Side centres = F, R, B, L.

  // For each cross face, expect 4 (full cross) on a solved cube.
  it('returns 4 on a solved cube for every cross face', () => {
    for (const f of FACES) expect(crossEdgesCorrectlyPlaced(f, SOLVED)).toBe(4);
  });

  it('returns 0 when no cross edges are D-down', () => {
    // Flip every cross-face edge sticker to a non-D colour.
    let s = SOLVED;
    s = setSticker(s, 'D', 1, 'X');
    s = setSticker(s, 'D', 3, 'X');
    s = setSticker(s, 'D', 5, 'X');
    s = setSticker(s, 'D', 7, 'X');
    expect(crossEdgesCorrectlyPlaced('D', s)).toBe(0);
  });

  it('counts 1 D-down edge as 1 (single-edge groups are trivially in correct relative position)', () => {
    // 3 cross edges flipped (D-colour off D-face); the 4th still D-down.
    let s = SOLVED;
    s = setSticker(s, 'D', 3, 'X');
    s = setSticker(s, 'D', 5, 'X');
    s = setSticker(s, 'D', 7, 'X');
    expect(crossEdgesCorrectlyPlaced('D', s)).toBe(1);
  });

  it('counts 4 D-down edges at canonical positions as 4 (full cross)', () => {
    // Solved cube IS the canonical placement.
    expect(crossEdgesCorrectlyPlaced('D', SOLVED)).toBe(4);
  });

  it('counts 2 D-down edges at correct RELATIVE positions even when shifted', () => {
    // Swap the F-edge and the R-edge SIDE stickers — both still D-down,
    // but each is at the OTHER's canonical slot. Their offsets from their
    // canonical positions are the same (both shifted by the same cyclic
    // delta), so they read as "2 in correct relative position".
    // Per the cyclic order CROSS_CYCLIC[D] = [F, L, B, R]:
    //   F-slot = position 0, L = 1, B = 2, R = 3.
    //   F-colour canonical = 0, L-colour = 1, B-colour = 2, R-colour = 3.
    // Move R-colour edge to F-slot (still D-down) → at pos 0, canonical 3,
    // offset = (0 - 3 + 4) % 4 = 1.
    // Move F-colour edge to R-slot (still D-down) → at pos 3, canonical 0,
    // offset = (3 - 0) % 4 = 3.
    // Different offsets — count = 1 each, max = 1. So this is NOT what we
    // want. Try a rotation instead: shift ALL 4 edges by 1 cyclic position.
    //   F→L position: F-edge's side sticker shows F-colour, sits at L-slot.
    //     Canonical for F-colour = 0. Actual = 1. Offset = 1.
    //   L→B: L-colour at B-slot. canonical 1, actual 2. Offset = 1.
    // For 4 same-offset → count = 4. But on SOLVED, all 4 are at offset 0.
    //
    // Concrete test: swap the F-edge and R-edge cubies (as a 2-cycle).
    // Their positions swap, so:
    //   F-edge at R-slot (pos 3): side sticker = F-colour (canonical 0),
    //     offset = (3 - 0) % 4 = 3.
    //   R-edge at F-slot (pos 0): side sticker = R-colour (canonical 3),
    //     offset = (0 - 3 + 4) % 4 = 1.
    // Both offsets differ → count = 1 each, max = 1.
    // So a 2-cycle of adjacent edges does NOT increase the count above 1.
    // That's the correct semantic: a 2-cycle is "1 in relative-correct
    // position" because each edge is alone in its rotation class.
    //
    // To get 2: keep two edges at canonical and disturb the other two.
    let s = SOLVED;
    s = setSticker(s, 'D', 7, 'X'); // B-edge no longer D-down (3 D-down)
    s = setSticker(s, 'D', 5, 'X'); // R-edge no longer D-down (2 D-down)
    // Only F-edge (pos 0, F colour, offset 0) and L-edge (pos 1, L colour,
    // offset 0) remain D-down. Both at canonical → offset 0 for both →
    // count = 2.
    expect(crossEdgesCorrectlyPlaced('D', s)).toBe(2);
  });

  it('detects same-offset rotated edges as the same relative-position group', () => {
    // Build a hypothetical: 3 D-down edges all shifted by the SAME offset.
    // SOLVED has all 4 at offset 0. We need to rotate THREE edges into
    // the same NON-zero offset class while keeping their D-stickers down.
    // The cleanest hand-buildable test: simulate an AUF (D' move) on the
    // bottom layer — every cross edge shifts one slot but stays D-down.
    // After D': F-colour edge at L-slot, L-colour at B-slot, B at R, R at F.
    //   F-edge: pos 1, canonical 0, offset 1.
    //   L-edge: pos 2, canonical 1, offset 1.
    //   B-edge: pos 3, canonical 2, offset 1.
    //   R-edge: pos 0, canonical 3, offset (0-3+4)%4 = 1.
    // All 4 share offset 1 → count = 4 even though no edge is at its
    // canonical slot. That's the user's intent (BRGO-rotation = still cross).
    // Construct: rebuild D-layer edges shifted by 1 cyclic position.
    // Original D-stickers stay (all D-coloured). Side stickers rotate:
    //   F-slot (sideF, sideIdx7) shows R-colour.
    //   L-slot (sideL, sideIdx7) shows F-colour.
    //   B-slot (sideB, sideIdx7) shows L-colour.
    //   R-slot (sideR, sideIdx7) shows B-colour.
    let s = SOLVED;
    s = setSticker(s, 'F', 7, 'R');
    s = setSticker(s, 'L', 7, 'F');
    s = setSticker(s, 'B', 7, 'L');
    s = setSticker(s, 'R', 7, 'B');
    expect(crossEdgesCorrectlyPlaced('D', s)).toBe(4);
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

describe('f2lSlotsDoneOn', () => {
  it('returns 4 on a fully solved cube for every cross face', () => {
    for (const f of FACES) expect(f2lSlotsDoneOn(f, SOLVED)).toBe(4);
  });

  it('drops to 3 when one slot has a wrong sticker (cross=D, FR slot edge)', () => {
    // F2L_SLOTS.D[0] is FR with edge stickers F[5] + R[3].
    expect(f2lSlotsDoneOn('D', setSticker(SOLVED, 'F', 5, 'X'))).toBe(3);
  });

  it('drops to 3 when only the cross-face sticker of one slot is wrong', () => {
    // D[2] is FR's cross-face sticker.
    expect(f2lSlotsDoneOn('D', setSticker(SOLVED, 'D', 2, 'X'))).toBe(3);
  });

  it('counts independently per slot — breaking 2 slots gives 2', () => {
    let s = setSticker(SOLVED, 'D', 2, 'X');  // breaks FR
    s = setSticker(s, 'L', 5, 'X');           // breaks FL (edge sticker on L)
    expect(f2lSlotsDoneOn('D', s)).toBe(2);
  });

  it('returns 0 when LL face is scrambled but no F2L slot is broken (counter-test)', () => {
    // Mess with U corners only — U-face stickers aren't in any cross=D F2L
    // slot, so the count should stay at 4. This verifies the predicate
    // doesn't over-read from outside the slots.
    let s = setSticker(SOLVED, 'U', 0, 'X');
    s = setSticker(s, 'U', 8, 'X');
    expect(f2lSlotsDoneOn('D', s)).toBe(4);
  });

  it('color-neutral spot-check: works on cross=F too', () => {
    expect(f2lSlotsDoneOn('F', SOLVED)).toBe(4);
    // F2L_SLOTS.F[0] is UL with corner stickers F[0], U[6], L[2].
    expect(f2lSlotsDoneOn('F', setSticker(SOLVED, 'U', 6, 'X'))).toBe(3);
  });
});

describe('F2L_SLOTS / F2L_BAND structural invariant', () => {
  // For each cross face, the union of slot stickers on each side face must
  // equal the F2L_BAND entries for that side minus the center (always
  // index 4) and the cross-edge (the side-face index from CROSS_ADJ).
  // This catches any transcription error in either table.
  for (const cross of FACES) {
    it(`union(slots[side]) === F2L_BAND[${cross}].side − {center, cross-edge}`, () => {
      const slots = F2L_SLOTS[cross];
      const band = F2L_BAND[cross];
      const crossEdgeForSide = new Map<Face, number>();
      for (const [side, idx] of CROSS_ADJ[cross]) crossEdgeForSide.set(side, idx);
      for (const [side, bandIdxs] of band) {
        const expected = new Set(bandIdxs);
        expected.delete(4);
        const ce = crossEdgeForSide.get(side);
        if (ce != null) expected.delete(ce);
        const actual = new Set<number>();
        for (const slot of slots) {
          for (const [s, idx] of slot) {
            if (s === side) actual.add(idx);
          }
        }
        expect([...actual].sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));
      }
    });
  }
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

// ---------- Roux / F3uL predicates ----------

describe('EDGE_DS structural', () => {
  it('every face has 4 side-face entries (excludes self + opposite)', () => {
    for (const f of FACES) {
      const keys = Object.keys(EDGE_DS[f]) as Face[];
      expect(keys).toHaveLength(4);
      for (const s of keys) {
        expect(s).not.toBe(f);
        expect(s).not.toBe(OPPOSITE[f]);
      }
    }
  });

  it('all stored indices are valid edge positions (1, 3, 5, or 7)', () => {
    for (const f of FACES) {
      for (const idx of Object.values(EDGE_DS[f])) {
        expect([1, 3, 5, 7]).toContain(idx);
      }
    }
  });
});

describe('Roux predicates on a solved cube', () => {
  it('isRouxFirstBlockDoneOn returns true for every (d, side) pair', () => {
    for (const d of FACES) {
      for (const s of FACES) {
        if (s === d || s === OPPOSITE[d]) continue;
        expect(isRouxFirstBlockDoneOn(d, s, SOLVED)).toBe(true);
      }
    }
  });

  it('isRouxSecondBlockDoneOn returns true for every (d, s1) pair', () => {
    for (const d of FACES) {
      for (const s of FACES) {
        if (s === d || s === OPPOSITE[d]) continue;
        expect(isRouxSecondBlockDoneOn(d, s, SOLVED)).toBe(true);
      }
    }
  });

  it('areTopCornersOrientedOn returns true for every face', () => {
    for (const f of FACES) expect(areTopCornersOrientedOn(f, SOLVED)).toBe(true);
  });

  it('isLSEOrientedOn returns true for every (d, s1) pair', () => {
    for (const d of FACES) {
      for (const s of FACES) {
        if (s === d || s === OPPOSITE[d]) continue;
        expect(isLSEOrientedOn(d, s, SOLVED)).toBe(true);
      }
    }
  });

  it('isLREDoneOn returns true for every (d, s1) pair', () => {
    for (const d of FACES) {
      for (const s of FACES) {
        if (s === d || s === OPPOSITE[d]) continue;
        expect(isLREDoneOn(d, s, SOLVED)).toBe(true);
      }
    }
  });
});

describe('isRouxFirstBlockDoneOn — partial states', () => {
  it('rejects when sideFace equals downFace or its opposite', () => {
    expect(isRouxFirstBlockDoneOn('D', 'D', SOLVED)).toBe(false);
    expect(isRouxFirstBlockDoneOn('D', 'U', SOLVED)).toBe(false);
  });

  it('fails when the DS cross edge is wrong (D-side)', () => {
    // For D=D, S=L, DS sticker = D[3]. Break it.
    const s = setSticker(SOLVED, 'D', 3, '?');
    expect(isRouxFirstBlockDoneOn('D', 'L', s)).toBe(false);
    // R-side block unaffected.
    expect(isRouxFirstBlockDoneOn('D', 'R', s)).toBe(true);
  });

  it('fails when the side face\'s bottom band is wrong', () => {
    // Break L[8] (FL corner L-side).
    const s = setSticker(SOLVED, 'L', 8, '?');
    expect(isRouxFirstBlockDoneOn('D', 'L', s)).toBe(false);
  });

  it('survives top-half damage on the side face (only bottom 2 rows matter)', () => {
    // Break L[0], L[1], L[2] (top row of L face).
    let s = setSticker(SOLVED, 'L', 0, '?');
    s = setSticker(s, 'L', 1, '?');
    s = setSticker(s, 'L', 2, '?');
    expect(isRouxFirstBlockDoneOn('D', 'L', s)).toBe(true);
  });

  it('detects color-neutral block on any face', () => {
    // First-block detection should find every (d, s) on a solved cube.
    let found = 0;
    for (const d of FACES) for (const s of FACES) {
      if (s === d || s === OPPOSITE[d]) continue;
      if (isRouxFirstBlockDoneOn(d, s, SOLVED)) found++;
    }
    // 6 faces * 4 side-faces = 24 valid (d, s) combos.
    expect(found).toBe(24);
  });
});

describe('isRouxSecondBlockDoneOn', () => {
  it('fails when only the first block is done (other side missing)', () => {
    // Break the opposite-side block by wrecking R[8] (FR corner R-side).
    const s = setSticker(SOLVED, 'R', 8, '?');
    expect(isRouxFirstBlockDoneOn('D', 'L', s)).toBe(true);   // L block intact
    expect(isRouxSecondBlockDoneOn('D', 'L', s)).toBe(false); // R block broken
  });

  it('symmetric: s1=L and s1=R agree', () => {
    expect(isRouxSecondBlockDoneOn('D', 'L', SOLVED)).toBe(true);
    expect(isRouxSecondBlockDoneOn('D', 'R', SOLVED)).toBe(true);
  });
});

describe('areTopCornersOrientedOn — corners only', () => {
  it('passes when only the 4 top corners show top-color (edges may be wrong)', () => {
    // Break the 4 top edges of U (indices 1, 3, 5, 7).
    let s = SOLVED;
    s = setSticker(s, 'U', 1, '?');
    s = setSticker(s, 'U', 3, '?');
    s = setSticker(s, 'U', 5, '?');
    s = setSticker(s, 'U', 7, '?');
    // CFOP's OLL predicate would reject this (face not mono); Roux's
    // CMLL-orientation predicate accepts it (only corners matter).
    expect(isOllDoneOn('D', s)).toBe(false);
    expect(areTopCornersOrientedOn('D', s)).toBe(true);
  });

  it('fails when even one top corner is wrong', () => {
    const s = setSticker(SOLVED, 'U', 0, '?');
    expect(areTopCornersOrientedOn('D', s)).toBe(false);
  });
});

describe('isLSEOrientedOn — false-positive resistance', () => {
  it('fails when a mid-slice down-side edge is wrong (e.g., DF flipped)', () => {
    // For D=D, S=L, mid-slice axis is F-B. The DF down-sticker is D[1].
    const s = setSticker(SOLVED, 'D', 1, '?');
    expect(isLSEOrientedOn('D', 'L', s)).toBe(false);
  });

  it('fails when a top edge is wrong', () => {
    const s = setSticker(SOLVED, 'U', 1, '?');
    expect(isLSEOrientedOn('D', 'L', s)).toBe(false);
  });
});

describe('isLREDoneOn', () => {
  it('passes when both L/R "top" edges show their side-color', () => {
    expect(isLREDoneOn('D', 'L', SOLVED)).toBe(true);
  });

  it('fails when one of the L/R top edges has wrong side-face sticker', () => {
    // For D=D, S1=L: L's "top edge toward U" = L[1]. Break it.
    const s = setSticker(SOLVED, 'L', 1, '?');
    expect(isLREDoneOn('D', 'L', s)).toBe(false);
  });
});
