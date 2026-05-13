// Shared Full Solve types extracted so other helpers can reference SolveRecord
// without pulling in the DOM/Chart-coupled fullSolve.ts module.

export type Process = 'cfop' | 'beginner';

export interface SolveRecord {
  ts: number;        // Unix ms
  scramble: string;
  solution: string;  // moves the user made during the solve, space-separated
  totalMs: number;
  // Per-phase ms. Keys match PhaseDef.key for the process/options used.
  phases: { [key: string]: number };
  process: Process;
  twoLookOll: boolean;
  twoLookPll: boolean;
  // Fractional seconds from solve start, one per PHYSICAL move (i.e. one
  // smartcube event), EXCLUDING paused intervals. Note this may exceed the
  // move-count parsed from `solution`, since `solution` collapses adjacent
  // quarter-turn pairs into half-turns at save time. The popup graph uses
  // this raw per-event series so paces show as the user actually executed
  // them. Optional for back-compat with records made before this field.
  turns?: number[];
}
