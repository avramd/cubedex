// Shared Full Solve types extracted so other helpers can reference SolveRecord
// without pulling in the DOM/Chart-coupled fullSolve.ts module.
//
// ## Import/export contract
//
// History is exported as `JSON.stringify(history[])` and imported via
// mergeImportedHistory. The contract is:
//
//   1. Every field of every record round-trips byte-for-byte. The pure
//      merge stores records by reference without filtering, so this is
//      automatic — but the kitchen-sink test in historyMerge.test.ts
//      enforces it.
//   2. Old records (missing optional fields) import without issue. Their
//      downstream consumers handle the gaps (e.g. phaseMsForDisplay's
//      fallbacks).
//   3. Unknown future fields pass through unchanged (forward compat).
//   4. Anything that's *derivable* from other stored fields (e.g.
//      f2lSplits and 2-look subphase ms are derivable from `turns` +
//      `scramble` + `solution`) should be backfilled at import time
//      via the backfillF2lSplits()/recomputeMissingSplitsFor() path
//      in fullSolve.ts.
//
// ### When you add a new field here
//   - If it's data the user typed/recorded (not derived): mark optional,
//     add it to the kitchen-sink test record in historyMerge.test.ts.
//   - If it's derivable from existing fields: extend recomputeMissingSplitsFor
//     in fullSolve.ts so old exports can be imported and re-derive it.

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
  // Milliseconds-from-solve-start at each successive F2L slot-count
  // increment (monotonic; up to 4 entries). Used by the "F2L slots" graph
  // toggle to split the F2L band into sub-bands. Optional / missing on
  // records made before this field — graph renders those as a single
  // F2L band even with the toggle on.
  f2lSplits?: number[];
}
