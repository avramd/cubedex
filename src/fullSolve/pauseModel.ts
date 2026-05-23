import { invertMove } from './moves';

// Pure state machine for the interactive pause / rewind feature. While
// the solve timer is paused the user can physically reverse moves to
// inspect a past state, redo them forward, or wander off the recorded
// solve path. This module is STATE-based: each physical move is
// classified by the cube facelets it produces, not by the move token.
// That makes R2 self-inverse (either R+R or R'+R' reverts) and lets
// the user follow any path back to a known state — the system treats
// them as equivalent.

export type PauseBucket = 'on-path' | 'wayward-undo' | 'wayward-new';

export interface PauseState {
  // Move sequence captured at pause entry.
  originalMoves: string[];
  // Cube facelets at each state along the original path.
  // originalStates.length === originalMoves.length + 1.
  // originalStates[0] = state at solve start; originalStates[i] = state
  // after originalMoves[i-1] has been applied.
  originalStates: string[];
  // Maximal non-overlapping redundant blocks (greedy left-to-right):
  // each [a, b] means originalStates[a] === originalStates[b+1], so
  // moves at indices a..b cancel out. Sorted by `a` ascending.
  redundantBlocks: ReadonlyArray<readonly [number, number]>;
  // Index of the last original move CURRENTLY applied. -1 = at start
  // state; originalMoves.length - 1 = all applied. The user's cube
  // facelets equal originalStates[frontier + 1] when on path.
  frontier: number;
  // Off-plan moves layered on top of the frontier when the user's state
  // doesn't match any originalStates[j]. Cleared as soon as the cube
  // lands back on the path.
  wayward: string[];
  // Original-move indices the user undid and then redid forward during
  // this pause session. Rendered underlined + non-clickable per the UX
  // spec — they were "rewound past" then re-applied. Indices skipped
  // via a redundancy jump are NOT added here (they were never
  // physically performed during this pause session).
  redoneSet: ReadonlySet<number>;
  // Original-move index the user clicked to investigate. null = no
  // target chosen; the reverse-instruction list is empty.
  targetIdx: number | null;
}

export interface ClassifyResult {
  bucket: PauseBucket;
  next: PauseState;
}

// Compute maximal non-overlapping redundant blocks via greedy
// left-to-right scan: at each index `i`, find the largest `j > i` with
// originalStates[j] === originalStates[i] and mark [i, j-1] as one
// block, then jump past it. A move is "redundant" iff it falls inside
// some block.
export function computeRedundantBlocks(states: string[]): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  let i = 0;
  while (i < states.length - 1) {
    let bestJ = -1;
    for (let j = states.length - 1; j > i; j--) {
      if (states[j] === states[i]) { bestJ = j; break; }
    }
    if (bestJ > i) {
      blocks.push([i, bestJ - 1]);
      i = bestJ;
    } else {
      i++;
    }
  }
  return blocks;
}

// True iff `idx` falls inside some redundant block.
export function isRedundantIdx(state: PauseState, idx: number): boolean {
  for (const [a, b] of state.redundantBlocks) {
    if (idx >= a && idx <= b) return true;
    if (a > idx) return false;
  }
  return false;
}

// Classify an incoming physical move against the current pause state,
// given the cube's NEW facelets (after applying the move). The new
// state determines everything; the move token is only stored when the
// state is off-path (so the wayward list reads like move history).
//
// Heuristic when the new state matches multiple originalStates:
//   - Prefer forward progress (j > current state index). Among forward
//     matches, prefer the LARGEST j — this naturally skips redundant
//     blocks, since their endpoints share a state with their start.
//   - Otherwise prefer the LARGEST backward match (j ≤ current state
//     index) — undo as few moves as the state allows.
export function classifyPauseMove(
  state: PauseState,
  move: string,
  newFacelets: string,
): ClassifyResult {
  const matches: number[] = [];
  for (let j = 0; j < state.originalStates.length; j++) {
    if (state.originalStates[j] === newFacelets) matches.push(j);
  }

  if (matches.length === 0) {
    // Off-path: pop wayward if this move inverts its top; otherwise
    // extend wayward.
    if (state.wayward.length > 0) {
      const top = state.wayward[state.wayward.length - 1];
      if (move === invertMove(top)) {
        return {
          bucket: 'wayward-undo',
          next: { ...state, wayward: state.wayward.slice(0, -1) },
        };
      }
    }
    return {
      bucket: 'wayward-new',
      next: { ...state, wayward: [...state.wayward, move] },
    };
  }

  const prevIdx = state.frontier + 1;
  const forward = matches.filter(j => j > prevIdx);
  const newIdx = forward.length > 0
    ? Math.max(...forward)
    : Math.max(...matches.filter(j => j <= prevIdx));

  const newFrontier = newIdx - 1;
  const nextRedone = new Set(state.redoneSet);
  if (newFrontier > state.frontier) {
    // Mark every newly-applied index as "redone". Indices inside skipped
    // redundant blocks stay in the original (greyed) state — they were
    // never explicitly redone, just bypassed.
    for (let k = state.frontier + 1; k <= newFrontier; k++) {
      if (!isRedundantIdx(state, k)) nextRedone.add(k);
    }
  } else if (newFrontier < state.frontier) {
    // Walked backward — un-mark indices that are no longer applied.
    for (let k = newFrontier + 1; k <= state.frontier; k++) {
      nextRedone.delete(k);
    }
  }

  return {
    bucket: 'on-path',
    next: { ...state, frontier: newFrontier, wayward: [], redoneSet: nextRedone },
  };
}

// Ordered list of moves the user must still execute to reach the
// target state. Wayward is undone first (LIFO), then we walk back from
// frontier to targetIdx + 1, SKIPPING any redundant block whose entire
// range falls inside [targetIdx + 1, frontier]. Partial blocks
// (straddling the boundary) are NOT skipped — their cancellation
// depends on moves outside the user's revert range.
export function computePauseReversePath(state: PauseState): string[] {
  if (state.targetIdx === null) return [];
  const out: string[] = [];
  for (let i = state.wayward.length - 1; i >= 0; i--) {
    out.push(invertMove(state.wayward[i]));
  }
  const lo = state.targetIdx + 1;
  const hi = state.frontier;
  let i = hi;
  while (i >= lo) {
    const containing = findContainingBlock(state.redundantBlocks, i);
    if (containing && containing[0] >= lo && containing[1] <= hi) {
      i = containing[0] - 1;
      continue;
    }
    out.push(invertMove(state.originalMoves[i]));
    i--;
  }
  return out;
}

function findContainingBlock(
  blocks: ReadonlyArray<readonly [number, number]>,
  idx: number,
): readonly [number, number] | null {
  for (const block of blocks) {
    if (idx >= block[0] && idx <= block[1]) return block;
    if (block[0] > idx) return null;
  }
  return null;
}

// A move is clickable iff it's at-or-behind the frontier AND wasn't
// already rewound-then-redone during this pause session. Redundant
// moves remain clickable — the user may genuinely want to land there.
export function isPauseMoveClickable(state: PauseState, idx: number): boolean {
  if (idx > state.frontier) return false;
  if (state.redoneSet.has(idx)) return false;
  return true;
}
