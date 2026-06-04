// Pure move-string helpers. Used both at storage time (collapsing pairs of
// quarter-turns into half-turns) and at display time (chunking, classing).

// Move-token typology. Used as a CSS class so the stylesheet can give
// .clock and .double a tiny right-padding when they aren't the last
// child of a .turn-group; .c-clock's apostrophe already provides its
// own visual separation, so it gets no padding.
export function moveClass(m: string): 'clock' | 'c-clock' | 'double' {
  if (m.endsWith('2')) return 'double';
  if (m.endsWith("'")) return 'c-clock';
  return 'clock';
}

// The face component of a move ("R", "Rw", "U", etc.) — i.e., everything
// before the optional "'" / "2" suffix. Same-face moves can be merged
// algebraically modulo 4 quarter-turns.
export function getFace(m: string): string {
  const match = m.match(/^[A-Za-z]+/);
  return match ? match[0] : m;
}

// Sum the quarter-turn count of a same-face move sequence, mod 4.
//   R = +1, R2 = +2, R' = -1
export function sumQuarters(moves: string[]): number {
  let n = 0;
  for (const m of moves) {
    if (m.endsWith('2')) n += 2;
    else if (m.endsWith("'")) n -= 1;
    else n += 1;
  }
  return ((n % 4) + 4) % 4;
}

// Accept face turns (U/D/L/R/F/B), slice turns (M/E/S), rotations
// (x/y/z), each optionally with `w` (wide) and a single trailing
// modifier (`'` or `2`). Lowercase face letters (rw equiv. to Rw) are
// also accepted since cubing.js handles them downstream.
const MOVE_TOKEN_RE = /^[UDLRFBMESxyzudlrfb]w?(['2])?$/;

// Validate and normalize a user-pasted scramble. Returns the cleaned
// space-separated scramble on success, or null if any token isn't a
// recognized move. Empty/whitespace-only input also returns null.
export function parseScramble(text: string): string | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  for (const t of tokens) if (!MOVE_TOKEN_RE.test(t)) return null;
  return tokens.join(' ');
}

// Invert a single move token: `R` ↔ `R'`, `R2` is self-inverse.
// Half-turn directionality (`R2` vs `R'2`) is intentionally elided —
// the storage format collapses both into `R2`, so the inverse is `R2`.
export function invertMove(m: string): string {
  if (m.endsWith("'")) return m.slice(0, -1);
  if (m.endsWith('2')) return m;
  return m + "'";
}

// Invert a sequence of moves: reverse the order, then invert each.
// Composing the original sequence with this result yields a no-op.
export function invertMoves(moves: string[]): string[] {
  return moves.slice().reverse().map(invertMove);
}

// Collapse adjacent quarter-turn pairs of the same move into a single
// half-turn. Smartcubes report half-turns as two consecutive quarter-
// turn events (so a user U2 lands as ['U', 'U']) — collapsing gives a
// readable display without affecting how solves are stored. Already-
// collapsed half-turns and mixed pairs (e.g., R R') are left alone.
export function collapseDoubles(moves: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    if (i + 1 < moves.length && m === moves[i + 1] && !m.endsWith('2')) {
      // R + R = R2;  R' + R' = R2 (also written R'2 but R2 is canonical).
      const face = m.endsWith("'") ? m.slice(0, -1) : m;
      out.push(face + '2');
      i++; // skip the second of the pair
    } else {
      out.push(m);
    }
  }
  return out;
}

// Slice-collapse tolerance, used by both the live visual-cube buffer
// in src/index.ts and the FS solution-panel buffer +
// collapseSlicesAndDoubles save-time pass. Empirically (per a real-
// cube recording), pairs the user actually fingertricked land ≤ ~50 ms
// apart and explicit fumbles start at ≥ ~140 ms — so 80 ms cleanly
// separates the two populations.
export const SLICE_TOLERANCE_MS = 80;

// Pairs of opposite-face moves that, when executed quickly, are the
// finger-trick equivalent of a single slice move.
export const SLICE_PAIR_MAP: Record<string, string> = {
  "R' L": "M'", "L R'": "M'",
  "R L'": "M",  "L' R": "M",
  "R2 L2": "M2", "L2 R2": "M2",
  "F' B": "S",  "B F'": "S",
  "F B'": "S'", "B' F": "S'",
  "F2 B2": "S2", "B2 F2": "S2",
  "D' U": "E",  "U D'": "E",
  "D U'": "E'", "U' D": "E'",
  "D2 U2": "E2", "U2 D2": "E2",
};

// True if `move` could be the first half of a slice pair. Cheap pre-
// filter so the per-tick cost is just one charset check, not a full
// map lookup.
export function isSliceCandidate(move: string): boolean {
  return 'RLFBUD'.includes(move.charAt(0));
}

// Slice token for a pair, or null if the two moves don't compose into
// a slice per SLICE_PAIR_MAP.
export function getSliceForPair(a: string, b: string): string | null {
  return SLICE_PAIR_MAP[a + ' ' + b] ?? null;
}

// Tracks raw quarter-turn timestamps an output token covers. Used by
// collapseSlicesAndDoubles internally so a downstream X2-slice sweep
// can compute the gap between two collapsed half-turn tokens.
interface SpannedToken {
  token: string;
  rawStart: number;  // inclusive
  rawEnd: number;    // inclusive
}

// Full slice + double collapse pipeline. Runs three left-to-right
// sweeps over the raw quarter-turn stream:
//
//   1. Quarter-turn slice pass: adjacent opposite-face pairs that
//      match SLICE_PAIR_MAP AND fall within `toleranceMs` collapse
//      into a slice glyph (R' L → M', etc).
//   2. Double pass: same-token adjacency collapses to a half-turn
//      (R + R → R2, M + M → M2). Identical to the existing
//      collapseDoubles, just span-aware.
//   3. X2-slice pass: adjacent half-turn pairs that match the X2
//      entries in SLICE_PAIR_MAP (R2 L2 → M2) collapse when their
//      timing gap is within tolerance. Catches users who fingertrick
//      M2 as R2 then L2 sequentially.
//
// Returns the final token list as a plain string[]. `rawTurnsSec` is
// the parallel timestamp list (seconds-from-solve-start) — the array
// length must match `rawMoves`.
export function collapseSlicesAndDoubles(
  rawMoves: string[],
  rawTurnsSec: number[],
  toleranceMs: number,
): string[] {
  const gap = (a: SpannedToken, b: SpannedToken) =>
    (rawTurnsSec[b.rawStart] - rawTurnsSec[a.rawEnd]) * 1000;

  // Pass 1 — quarter-turn slice collapse.
  const afterSlice: SpannedToken[] = [];
  for (let i = 0; i < rawMoves.length; i++) {
    if (i + 1 < rawMoves.length
        && isSliceCandidate(rawMoves[i]) && isSliceCandidate(rawMoves[i + 1])) {
      const sliced = getSliceForPair(rawMoves[i], rawMoves[i + 1]);
      if (sliced && (rawTurnsSec[i + 1] - rawTurnsSec[i]) * 1000 <= toleranceMs) {
        afterSlice.push({ token: sliced, rawStart: i, rawEnd: i + 1 });
        i++;
        continue;
      }
    }
    afterSlice.push({ token: rawMoves[i], rawStart: i, rawEnd: i });
  }

  // Pass 2 — double-collapse adjacent same-token entries.
  const afterDoubles: SpannedToken[] = [];
  for (let i = 0; i < afterSlice.length; i++) {
    const cur = afterSlice[i];
    if (i + 1 < afterSlice.length
        && cur.token === afterSlice[i + 1].token
        && !cur.token.endsWith('2')) {
      const next = afterSlice[i + 1];
      const face = cur.token.endsWith("'") ? cur.token.slice(0, -1) : cur.token;
      afterDoubles.push({
        token: face + '2',
        rawStart: cur.rawStart,
        rawEnd: next.rawEnd,
      });
      i++;
      continue;
    }
    afterDoubles.push(cur);
  }

  // Pass 3 — X2-slice collapse (R2 L2 → M2 et al.) gated by tolerance
  // on the inter-token gap.
  const afterX2: SpannedToken[] = [];
  for (let i = 0; i < afterDoubles.length; i++) {
    const cur = afterDoubles[i];
    if (i + 1 < afterDoubles.length) {
      const next = afterDoubles[i + 1];
      const sliced = getSliceForPair(cur.token, next.token);
      if (sliced && gap(cur, next) <= toleranceMs) {
        afterX2.push({ token: sliced, rawStart: cur.rawStart, rawEnd: next.rawEnd });
        i++;
        continue;
      }
    }
    afterX2.push(cur);
  }

  return afterX2.map(t => t.token);
}
