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

export type Process = 'cfop' | 'beginner' | 'roux' | 'f3ul';

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
  // Wall-clock duration of the inspection phase in ms (from "scramble
  // complete" to "solve start"). Used by the CSV export to emit a single
  // `inspection` row with a negative timestamp.
  inspectionMs?: number;
  // True iff the solve timer started because the inspection countdown
  // expired (rather than because the user made their first move during
  // inspection). The CSV export emits an extra `start` row with
  // timestamp 0 when this is set.
  inspectionAutoExpired?: boolean;
  // True iff this record represents an incomplete solve (timer stopped
  // before the final-phase predicate fired). CSV export emits an
  // `abort` row in place of the `solved` row.
  aborted?: boolean;
  // Optional ms-from-solve-start at the explicit abort. Present only
  // when the user clicked abort during an active solve; absent when the
  // record is otherwise incomplete (no explicit abort moment to point
  // to). CSV emits the timestamp on the `abort` row when present.
  abortedAtMs?: number;
  // User-assigned labels. Always stored normalized (lowercase, trimmed,
  // internal whitespace collapsed to single spaces) so equality is
  // straightforward. Absent / empty array = untagged. Used by the
  // graph tag filter and shown as chips on history rows.
  tags?: string[];
  // Roux-specific: split CMLL into OCLL (corners oriented) + OPLL
  // (corner-permutation headlights). Only meaningful when process is 'roux'.
  twoLookCmll?: boolean;
  // Roux-specific: split LSE into LSEO → LRE → OPME (3-look LSE).
  // Only meaningful when process is 'roux'.
  threeLookLse?: boolean;
  // Roux/F3uL per-pair timing: ms-from-solve-start at each F2L slot
  // (= Roux pair) completion, in chronological order. Up to 4
  // entries. Drives the granular block-stage shade rendering; older
  // records lacking this fall back to the 2-band (f1b / f2b) display.
  rouxPairTimingsMs?: number[];
  // Absolute ms-from-solve-start at the FIRST pair of the
  // first-completed and second-completed blocks. Drives the
  // "block-aware" Roux color scheme. The corresponding
  // block-COMPLETE timestamps are recoverable from
  // r.phases.f1b / r.phases.f2b (cumulative).
  rouxBlock1FirstPairMs?: number;
  rouxBlock2FirstPairMs?: number;
}
