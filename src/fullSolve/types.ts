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
}
