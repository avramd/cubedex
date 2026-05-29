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

// For each cross face X, the 4 D-layer cross-edge slots in cyclic
// order CW-from-outside-X. Each entry encodes the X-sticker index +
// (sideFace, sideStickerIdx) for the edge at that slot. Used by
// crossEdgesCorrectlyPlaced for the max-consecutive-relative-position
// count rule.
const CROSS_CYCLIC: Record<Face, Array<{ sideFace: Face; xIdx: number; sideIdx: number }>> = {
  D: [
    { sideFace: 'F', xIdx: 1, sideIdx: 7 },
    { sideFace: 'L', xIdx: 3, sideIdx: 7 },
    { sideFace: 'B', xIdx: 7, sideIdx: 7 },
    { sideFace: 'R', xIdx: 5, sideIdx: 7 },
  ],
  U: [
    { sideFace: 'F', xIdx: 7, sideIdx: 1 },
    { sideFace: 'R', xIdx: 5, sideIdx: 1 },
    { sideFace: 'B', xIdx: 1, sideIdx: 1 },
    { sideFace: 'L', xIdx: 3, sideIdx: 1 },
  ],
  F: [
    { sideFace: 'U', xIdx: 1, sideIdx: 7 },
    { sideFace: 'R', xIdx: 5, sideIdx: 3 },
    { sideFace: 'D', xIdx: 7, sideIdx: 1 },
    { sideFace: 'L', xIdx: 3, sideIdx: 5 },
  ],
  B: [
    { sideFace: 'U', xIdx: 1, sideIdx: 1 },
    { sideFace: 'L', xIdx: 5, sideIdx: 3 },
    { sideFace: 'D', xIdx: 7, sideIdx: 7 },
    { sideFace: 'R', xIdx: 3, sideIdx: 5 },
  ],
  R: [
    { sideFace: 'U', xIdx: 1, sideIdx: 5 },
    { sideFace: 'B', xIdx: 5, sideIdx: 3 },
    { sideFace: 'D', xIdx: 7, sideIdx: 5 },
    { sideFace: 'F', xIdx: 3, sideIdx: 5 },
  ],
  L: [
    { sideFace: 'U', xIdx: 1, sideIdx: 3 },
    { sideFace: 'F', xIdx: 5, sideIdx: 3 },
    { sideFace: 'D', xIdx: 7, sideIdx: 3 },
    { sideFace: 'B', xIdx: 3, sideIdx: 5 },
  ],
};

// Returns 0..4: the max number of D-down cross edges (edges with X-
// colour on the X face) that are in correct positions RELATIVE to one
// another. The rule, from the user:
//   - An edge "counts" only if its X-colour sticker is on the X face.
//   - Among those D-down edges, find the longest cyclic-consecutive run
//     where edges' actual relative positions match their colours' canon-
//     ical relative positions in the cube's side-colour cycle (BRGO for
//     D=white, etc. — derived from each side face's centre colour).
//   - Implementation: for each D-down edge, compute offset = (actual_pos
//     - canonical_pos) mod 4. Edges sharing an offset are in correct
//     relative positions. Max group size = count.
// Equals isCrossDoneOn (returns 4) iff full cross is solved.
export function crossEdgesCorrectlyPlaced(face: Face, facelets: string): number {
  const X = faceStickers(facelets, face);
  const xCentre = X[4];
  const positions = CROSS_CYCLIC[face];
  // canonical_pos[colour] = cyclic index where an edge of that colour
  // canonically belongs (= position whose side centre is that colour).
  const canonicalIdxByColor = new Map<string, number>();
  for (let i = 0; i < 4; i++) {
    const sideCentre = faceStickers(facelets, positions[i].sideFace)[4];
    canonicalIdxByColor.set(sideCentre, i);
  }
  const offsetCounts = new Map<number, number>();
  for (let p = 0; p < 4; p++) {
    const pos = positions[p];
    if (X[pos.xIdx] !== xCentre) continue; // not D-down
    const sideSticker = faceStickers(facelets, pos.sideFace)[pos.sideIdx];
    const canonicalPos = canonicalIdxByColor.get(sideSticker);
    if (canonicalPos === undefined) continue; // shouldn't happen on a valid cube
    const offset = ((p - canonicalPos) % 4 + 4) % 4;
    offsetCounts.set(offset, (offsetCounts.get(offset) ?? 0) + 1);
  }
  let maxCount = 0;
  for (const c of offsetCounts.values()) if (c > maxCount) maxCount = c;
  return maxCount;
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

// ---------- Roux / F3uL predicates ----------
//
// Roux solves the cube in two opposite 1x2x3 blocks (F1B, F2B), then
// the top corners (CMLL — corners only, top edges ignored), then the
// last six edges (LSE). F3uL reuses Roux's F1B + F2B but follows with
// FML (which makes the bottom 2 layers identical to CFOP's F2L-done
// state) and then standard CFOP OLL/PLL.
//
// Every predicate is parameterised by the user's down-face and (where
// relevant) the first-block side-face, mirroring the existing
// CROSS_ADJ / F2L_SLOTS pattern.

// D-face sticker index for the edge between D and S. Derived per face's
// Kociemba orientation: each face's 4 edge stickers live at indices
// 1, 3, 5, 7; this table just records which one corresponds to which
// side. (See CROSS_ADJ which gives the SIDE-face index of the same
// edge; this table gives the DOWN-face index.)
export const EDGE_DS: Record<Face, Partial<Record<Face, number>>> = {
  D: { F: 1, L: 3, R: 5, B: 7 },
  U: { B: 1, L: 3, R: 5, F: 7 },
  F: { U: 1, L: 3, R: 5, D: 7 },
  B: { U: 1, R: 3, L: 5, D: 7 },
  R: { U: 1, F: 3, B: 5, D: 7 },
  L: { U: 1, B: 3, F: 5, D: 7 },
};

// Given (downFace, sideFace), return the indices into F2L_SLOTS[D] of
// the two F2L slots that fall on S's side of D. Hand-built because the
// F2L_SLOTS rows differ per face and the "which slot is on which side"
// mapping isn't structural.
const ROUX_BLOCK_SLOT_INDICES: Record<Face, Partial<Record<Face, [number, number]>>> = {
  // D row: [FR, FL, BR, BL]
  D: { F: [0, 1], B: [2, 3], L: [1, 3], R: [0, 2] },
  // U row: [FR, FL, BR, BL]
  U: { F: [0, 1], B: [2, 3], L: [1, 3], R: [0, 2] },
  // F row: [UL, UR, DL, DR]
  F: { U: [0, 1], D: [2, 3], L: [0, 2], R: [1, 3] },
  // B row: [UR, UL, DR, DL]
  B: { U: [0, 1], D: [2, 3], R: [0, 2], L: [1, 3] },
  // R row: [UF, UB, DF, DB]
  R: { U: [0, 1], D: [2, 3], F: [0, 2], B: [1, 3] },
  // L row: [UF, UB, DF, DB]
  L: { U: [0, 1], D: [2, 3], F: [0, 2], B: [1, 3] },
};

// Check that every sticker in `pairs` matches its own face's center.
function allStickersMatchCenter(facelets: string, pairs: Array<[Face, number]>): boolean {
  for (const [face, idx] of pairs) {
    const s = faceStickers(facelets, face);
    if (s[idx] !== s[4]) return false;
  }
  return true;
}

// 1x2x3 block on side S of down-face D. Block covers: S-face's bottom
// 2 rows (F2L_BAND), the 2 F2L slots on S's side of D (corners + their
// vertical edges to F/B), AND the DS cross edge (D's S-side sticker).
export function isRouxFirstBlockDoneOn(d: Face, s: Face, facelets: string): boolean {
  if (s === d || s === OPPOSITE[d]) return false;
  const slotIdx = ROUX_BLOCK_SLOT_INDICES[d]?.[s];
  if (!slotIdx) return false;
  // 1. S-face band (6 stickers in S's bottom 2 rows, including DS edge S-side).
  for (const [side, indices] of F2L_BAND[d]) {
    if (side !== s) continue;
    const ss = faceStickers(facelets, side);
    const c = ss[4];
    for (const i of indices) if (ss[i] !== c) return false;
  }
  // 2. The 2 S-side F2L slots (each: cross-face corner sticker + 4
  //    side-face stickers covering corner + vertical edge).
  for (const idx of slotIdx) {
    if (!allStickersMatchCenter(facelets, F2L_SLOTS[d][idx])) return false;
  }
  // 3. DS cross edge — D-face sticker (S-face side is in the band check above).
  const dsIdx = EDGE_DS[d]?.[s];
  if (dsIdx === undefined) return false;
  const ds = faceStickers(facelets, d);
  if (ds[dsIdx] !== ds[4]) return false;
  return true;
}

// Both blocks done (F2B). The 2nd block is on the OPPOSITE side from
// the 1st (`s1`). Identical to "first block done on s1 AND first block
// done on opp(s1)" — the predicate is symmetric in the two blocks.
export function isRouxSecondBlockDoneOn(d: Face, s1: Face, facelets: string): boolean {
  return isRouxFirstBlockDoneOn(d, s1, facelets)
      && isRouxFirstBlockDoneOn(d, OPPOSITE[s1], facelets);
}

// OCLL (Roux/CMLL corner orientation): the 4 corner stickers of the
// opposite-of-d face (indices 0, 2, 6, 8) all show opp(d)-center color.
// CRUCIALLY DIFFERENT from isOllDoneOn (which also requires the 4 edge
// stickers to match) — in Roux, CMLL only solves corners; the edges of
// the top face are handled later in LSE.
export function areTopCornersOrientedOn(d: Face, facelets: string): boolean {
  const top = faceStickers(facelets, OPPOSITE[d]);
  const c = top[4];
  return top[0] === c && top[2] === c && top[6] === c && top[8] === c;
}

// LSEO — last 6 edges oriented. The 4 top-edge stickers on opp(d) show
// opp(d)-color, AND the 2 mid-slice D-side stickers (the F/B-axis edges
// when blocks are on L/R, or vice versa) show d-color.
export function isLSEOrientedOn(d: Face, s1: Face, facelets: string): boolean {
  // 4 top edges of opp(d).
  const top = faceStickers(facelets, OPPOSITE[d]);
  const tc = top[4];
  if (top[1] !== tc || top[3] !== tc || top[5] !== tc || top[7] !== tc) return false;
  // 2 mid-slice D-side stickers: the side-faces perpendicular to s1.
  const sides = (F2L_BAND[d].map(([f]) => f) as Face[])
    .filter(f => f !== s1 && f !== OPPOSITE[s1]);
  const ds = faceStickers(facelets, d);
  const dc = ds[4];
  for (const side of sides) {
    const dsIdx = EDGE_DS[d]?.[side];
    if (dsIdx === undefined) return false;
    if (ds[dsIdx] !== dc) return false;
  }
  return true;
}

// LRE — LSEO done AND the 2 "top edges of the side faces" (the edges
// between s1 / opp(s1) and opp(d)) are placed. Sticker check: s1's
// edge-toward-opp(d) sticker matches s1-center; same for opp(s1).
export function isLREDoneOn(d: Face, s1: Face, facelets: string): boolean {
  if (!isLSEOrientedOn(d, s1, facelets)) return false;
  const top = OPPOSITE[d];
  for (const side of [s1, OPPOSITE[s1]] as Face[]) {
    const idx = EDGE_DS[side]?.[top];
    if (idx === undefined) return false;
    const ss = faceStickers(facelets, side);
    if (ss[idx] !== ss[4]) return false;
  }
  return true;
}
