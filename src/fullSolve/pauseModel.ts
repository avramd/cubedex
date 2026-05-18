import { invertMove } from './moves';

// Pure state machine for the interactive pause / rewind feature. While
// the solve timer is paused the user can physically reverse moves to
// inspect a past state, redo them forward, or wander off the recorded
// solve path. This module classifies each incoming physical move into
// one of four buckets and produces the reverse-instruction list to a
// chosen target. DOM rendering and timer/cube wiring live in fullSolve.ts.

export type PauseBucket = 'wayward-undo' | 'reverse' | 'redo' | 'wayward-new';

export interface PauseState {
  // Frozen at pause entry — the solve-move list the user is investigating.
  originalMoves: string[];
  // Index of the last original move CURRENTLY applied to the cube.
  // -1 = back at solve start; originalMoves.length - 1 = all applied.
  frontier: number;
  // Off-plan moves layered on top of the frontier. Empty when the user
  // is exactly on an original-prefix state.
  wayward: string[];
  // Original-move indices the user undid and then redid forward during
  // this pause session. Rendered underlined + non-clickable per the spec.
  redoneSet: ReadonlySet<number>;
  // The original-move index the user clicked to investigate. null = no
  // target chosen; the reverse-instruction list is empty.
  targetIdx: number | null;
}

export interface ClassifyResult {
  bucket: PauseBucket;
  next: PauseState;
}

// Resolve a physical move against the current pause state. Priority:
//   1. wayward-undo — wayward non-empty AND move inverts wayward's top
//   2. reverse     — wayward empty, frontier ≥ 0, move inverts frontier
//   3. redo        — wayward empty, frontier < N-1, move equals next-original
//   4. wayward-new — anything else (extends wayward on top of frontier)
//
// Wayward-undo takes precedence over reverse/redo so the off-plan
// scratch path is undone before the on-plan rewinding resumes.
export function classifyPauseMove(state: PauseState, move: string): ClassifyResult {
  if (state.wayward.length > 0) {
    const top = state.wayward[state.wayward.length - 1];
    if (move === invertMove(top)) {
      return {
        bucket: 'wayward-undo',
        next: { ...state, wayward: state.wayward.slice(0, -1) },
      };
    }
    return {
      bucket: 'wayward-new',
      next: { ...state, wayward: [...state.wayward, move] },
    };
  }

  if (state.frontier >= 0
      && move === invertMove(state.originalMoves[state.frontier])) {
    const nextRedone = new Set(state.redoneSet);
    nextRedone.delete(state.frontier);
    return {
      bucket: 'reverse',
      next: { ...state, frontier: state.frontier - 1, redoneSet: nextRedone },
    };
  }

  if (state.frontier < state.originalMoves.length - 1
      && move === state.originalMoves[state.frontier + 1]) {
    const nextRedone = new Set(state.redoneSet);
    nextRedone.add(state.frontier + 1);
    return {
      bucket: 'redo',
      next: { ...state, frontier: state.frontier + 1, redoneSet: nextRedone },
    };
  }

  return {
    bucket: 'wayward-new',
    next: { ...state, wayward: [move] },
  };
}

// Ordered list of moves the user must still execute to reach the target.
// Wayward is undone first (in LIFO order), then the original tail is
// walked back from frontier down to targetIdx + 1. Returns [] if no
// target is set or the user is already at-or-past the target.
export function computePauseReversePath(state: PauseState): string[] {
  if (state.targetIdx === null) return [];
  const out: string[] = [];
  for (let i = state.wayward.length - 1; i >= 0; i--) {
    out.push(invertMove(state.wayward[i]));
  }
  for (let i = state.frontier; i > state.targetIdx; i--) {
    out.push(invertMove(state.originalMoves[i]));
  }
  return out;
}

// A move is clickable iff it's at-or-behind the frontier AND wasn't
// already rewound-then-redone during this pause session.
export function isPauseMoveClickable(state: PauseState, idx: number): boolean {
  if (idx > state.frontier) return false;
  if (state.redoneSet.has(idx)) return false;
  return true;
}
