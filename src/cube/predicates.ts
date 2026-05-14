// Color-neutral phase predicates. Each `*On(face, facelets)` checks the
// predicate as if `face` is the cross face (i.e., on the bottom). The
// stateful "which face is the cross face" detection lives in fullSolve.ts;
// these pure variants exist here so they can be tested in isolation
// against handcrafted facelet strings.

import { Face, FACES, OPPOSITE, faceStickers, isFaceMono } from './facelets';

// For each cross face X, the 4 (sideFace, stickerIndexOnSide) pairs that
// touch X's edge stickers — i.e., for cross to be done, every side face's
// adjacent middle-edge sticker must match its center.
export const CROSS_ADJ: Record<Face, [Face, number][]> = {
  U: [['B', 1], ['L', 1], ['R', 1], ['F', 1]],
  D: [['F', 7], ['L', 7], ['R', 7], ['B', 7]],
  F: [['U', 7], ['L', 5], ['R', 3], ['D', 1]],
  B: [['U', 1], ['R', 5], ['L', 3], ['D', 7]],
  R: [['U', 5], ['F', 5], ['B', 3], ['D', 5]],
  L: [['U', 3], ['B', 5], ['F', 3], ['D', 3]],
};

// For each cross face X, for each side face, the 6 sticker indices that lie
// in the "first 2 layers" band (the 2 rows or columns of that side face
// nearest to X). When X mono AND every side face's band matches that side's
// center, F2L is done.
export const F2L_BAND: Record<Face, [Face, number[]][]> = {
  U: [['F',[0,1,2,3,4,5]],['R',[0,1,2,3,4,5]],['B',[0,1,2,3,4,5]],['L',[0,1,2,3,4,5]]],
  D: [['F',[3,4,5,6,7,8]],['R',[3,4,5,6,7,8]],['B',[3,4,5,6,7,8]],['L',[3,4,5,6,7,8]]],
  F: [['U',[3,4,5,6,7,8]],['R',[0,1,3,4,6,7]],['D',[0,1,2,3,4,5]],['L',[1,2,4,5,7,8]]],
  B: [['U',[0,1,2,3,4,5]],['R',[1,2,4,5,7,8]],['D',[3,4,5,6,7,8]],['L',[0,1,3,4,6,7]]],
  R: [['U',[1,2,4,5,7,8]],['F',[1,2,4,5,7,8]],['D',[1,2,4,5,7,8]],['B',[0,1,3,4,6,7]]],
  L: [['U',[0,1,3,4,6,7]],['F',[0,1,3,4,6,7]],['D',[0,1,3,4,6,7]],['B',[1,2,4,5,7,8]]],
};

// For each cross face X, for each side face adjacent to X, the 2 sticker
// indices that are corners on the OLL (= opposite of X) face side. If those
// two stickers on each side face match, the corners are permuted (= "PLL
// corners done", or in our pipeline: 2-look-PLL "headlights" reached).
export const HEADLIGHT: Record<Face, [Face, [number, number]][]> = {
  U: [['F',[6,8]],['R',[6,8]],['B',[6,8]],['L',[6,8]]],
  D: [['F',[0,2]],['R',[0,2]],['B',[0,2]],['L',[0,2]]],
  F: [['U',[0,2]],['R',[2,8]],['D',[6,8]],['L',[0,6]]],
  B: [['U',[6,8]],['R',[0,6]],['D',[0,2]],['L',[2,8]]],
  R: [['U',[0,6]],['F',[0,6]],['D',[0,6]],['B',[2,8]]],
  L: [['U',[2,8]],['F',[2,8]],['D',[2,8]],['B',[0,6]]],
};

// For each cross face X, the 4 F2L slots, each enumerated as 5 (sideFace,
// stickerIndex) pairs: 1 sticker on the cross face (the slot's corner on
// X), plus 2 stickers on each adjacent side face (the corner-side sticker
// + the edge-side sticker). A slot is "done" when all 5 stickers match
// their respective face centers.
//
// Hand-built (not auto-derived from F2L_BAND) because the band aggregates
// all 4 slots per side together; the structural test below verifies
// `union of slot stickers per side == band minus center and cross-edge`,
// which catches any transcription error.
export const F2L_SLOTS: Record<Face, Array<Array<[Face, number]>>> = {
  // Cross on D. Slots are at the 4 bottom corners: FR, FL, BR, BL.
  D: [
    [['D', 2], ['F', 8], ['R', 6], ['F', 5], ['R', 3]], // FR
    [['D', 0], ['F', 6], ['L', 8], ['F', 3], ['L', 5]], // FL
    [['D', 8], ['R', 8], ['B', 6], ['R', 5], ['B', 3]], // BR
    [['D', 6], ['L', 6], ['B', 8], ['L', 3], ['B', 5]], // BL
  ],
  // Cross on U.
  U: [
    [['U', 8], ['F', 2], ['R', 0], ['F', 5], ['R', 3]], // FR
    [['U', 6], ['F', 0], ['L', 2], ['F', 3], ['L', 5]], // FL
    [['U', 2], ['R', 2], ['B', 0], ['R', 5], ['B', 3]], // BR
    [['U', 0], ['L', 0], ['B', 2], ['L', 3], ['B', 5]], // BL
  ],
  // Cross on F. Slots involve U+L, U+R, D+L, D+R.
  F: [
    [['F', 0], ['U', 6], ['L', 2], ['U', 3], ['L', 1]], // UL
    [['F', 2], ['U', 8], ['R', 0], ['U', 5], ['R', 1]], // UR
    [['F', 6], ['D', 0], ['L', 8], ['D', 3], ['L', 7]], // DL
    [['F', 8], ['D', 2], ['R', 6], ['D', 5], ['R', 7]], // DR
  ],
  // Cross on B. Slots involve U+R, U+L, D+R, D+L (mirrored vs F because
  // B is viewed from the opposite side).
  B: [
    [['B', 0], ['U', 2], ['R', 2], ['U', 5], ['R', 1]], // UR
    [['B', 2], ['U', 0], ['L', 0], ['U', 3], ['L', 1]], // UL
    [['B', 6], ['D', 8], ['R', 8], ['D', 5], ['R', 7]], // DR
    [['B', 8], ['D', 6], ['L', 6], ['D', 3], ['L', 7]], // DL
  ],
  // Cross on R. Slots involve U+F, U+B, D+F, D+B.
  R: [
    [['R', 0], ['U', 8], ['F', 2], ['U', 7], ['F', 1]], // UF
    [['R', 2], ['U', 2], ['B', 0], ['U', 1], ['B', 1]], // UB
    [['R', 6], ['D', 2], ['F', 8], ['D', 1], ['F', 7]], // DF
    [['R', 8], ['D', 8], ['B', 6], ['D', 7], ['B', 7]], // DB
  ],
  // Cross on L.
  L: [
    [['L', 2], ['U', 6], ['F', 0], ['U', 7], ['F', 1]], // UF
    [['L', 0], ['U', 0], ['B', 2], ['U', 1], ['B', 1]], // UB
    [['L', 8], ['D', 0], ['F', 6], ['D', 1], ['F', 7]], // DF
    [['L', 6], ['D', 6], ['B', 8], ['D', 7], ['B', 7]], // DB
  ],
};

// Count how many F2L slots are correctly placed under the assumption that
// `face` is the cross face. A slot is "done" when its 5 stickers each
// match their own face's center. Returns 0..4. Color-neutral by design:
// callers pass the (already-detected) cross face in.
export function f2lSlotsDoneOn(face: Face, facelets: string): number {
  let count = 0;
  for (const slot of F2L_SLOTS[face]) {
    let allMatch = true;
    for (const [sideFace, idx] of slot) {
      const s = faceStickers(facelets, sideFace);
      if (s[idx] !== s[4]) { allMatch = false; break; }
    }
    if (allMatch) count++;
  }
  return count;
}

export function isCrossDoneOn(face: Face, facelets: string): boolean {
  const X = faceStickers(facelets, face);
  if (X[1] !== X[4] || X[3] !== X[4] || X[5] !== X[4] || X[7] !== X[4]) return false;
  for (const [side, idx] of CROSS_ADJ[face]) {
    const s = faceStickers(facelets, side);
    if (s[idx] !== s[4]) return false;
  }
  return true;
}

export function isF2LDoneOn(face: Face, facelets: string): boolean {
  if (!isFaceMono(facelets, face)) return false;
  for (const [side, indices] of F2L_BAND[face]) {
    const s = faceStickers(facelets, side);
    const c = s[4];
    for (const i of indices) if (s[i] !== c) return false;
  }
  return true;
}

// EOLL: 4 edges of the OLL (= opposite-of-cross) face match that face's center.
export function isEOLLDoneOn(face: Face, facelets: string): boolean {
  const opp = faceStickers(facelets, OPPOSITE[face]);
  return opp[1] === opp[4] && opp[3] === opp[4] && opp[5] === opp[4] && opp[7] === opp[4];
}

// OLL: opposite face is monochrome.
export function isOllDoneOn(face: Face, facelets: string): boolean {
  return isFaceMono(facelets, OPPOSITE[face]);
}

// Headlights: each side face's 2 OLL-side corners match each other.
export function isHeadlightsDoneOn(face: Face, facelets: string): boolean {
  for (const [side, [a, b]] of HEADLIGHT[face]) {
    const s = faceStickers(facelets, side);
    if (s[a] !== s[b]) return false;
  }
  return true;
}

// "Yellow cross" — the 4 edges of `face` match its center, regardless of
// any cross-face context. Used by Beginner-mode solvers as a fallback when
// no base cross has been detected yet.
export function isAnyEdgeCrossOn(face: Face, facelets: string): boolean {
  const s = faceStickers(facelets, face);
  return s[1] === s[4] && s[3] === s[4] && s[5] === s[4] && s[7] === s[4];
}

// Find the first face (in FACES order) for which `predOn(face, facelets)`
// is true, or null if none. Useful for color-neutral predicate dispatch
// when the cross face hasn't been detected yet.
export function firstMatchingFace(
  facelets: string,
  predOn: (face: Face, facelets: string) => boolean,
): Face | null {
  for (const f of FACES) if (predOn(f, facelets)) return f;
  return null;
}
