import { Alg } from 'cubing/alg';
import { cube3x3x3 } from 'cubing/puzzles';
import { KPattern, KPuzzle } from 'cubing/kpuzzle';
import { Chart, registerables } from 'chart.js';
import { patternToFacelets } from './utils';
import { type Face, FACES, OPPOSITE, faceStickers, isSolved } from './cube/facelets';
import {
  isCrossDoneOn, isF2LDoneOn, isEOLLDoneOn, isOllDoneOn, isHeadlightsDoneOn,
  f2lSlotsDoneOn, F2L_SLOTS,
  isRouxFirstBlockDoneOn, isRouxSecondBlockDoneOn,
  areTopCornersOrientedOn, isLSEOrientedOn, isLREDoneOn,
} from './cube/predicates';
import { generateRandomScramble3x3 } from './cube/scramble';
import { type Process, type SolveRecord } from './fullSolve/types';
import { moveClass, collapseDoubles, parseScramble, invertMoves } from './fullSolve/moves';
import { classifyMoves } from './fullSolve/classify';
import { PHASE_KEY_LABELS, phaseMsForDisplay } from './fullSolve/aggregate';
import { mergeImportedHistory as mergeHistoryPure } from './fullSolve/historyMerge';
import {
  classifyPauseMove, computePauseReversePath, isPauseMoveClickable,
  computeRedundantBlocks, isRedundantIdx,
  type PauseState,
} from './fullSolve/pauseModel';
import { historyToCsv } from './fullSolve/csvExport';
import {
  normalizeTag, allTagsWithCounts, sortedTagsForDialog,
  applyTagFilter, pushRecentTagSet, tagFilterLabel, isProcessName,
  type TagFilter,
} from './fullSolve/tags';
import { rollingAverage, meanAndSd } from './fullSolve/stats';
import { placeLabelsAvoidOverlap, remapClippedTargets } from './fullSolve/labelLayout';

Chart.register(...registerables);

// ---------- Types ----------

export type { Process } from './fullSolve/types';
// Inspection options. 'none' is a special "untimed" mode: the timer
// never runs and the completed solve is NOT recorded into history. It's
// for casual practice (or when you just want to follow a shared scramble
// without it counting). Treated like 'pause' for the scramble→inspection
// transition (no auto-countdown), but the first move no longer kicks off
// any timing/recording machinery.
export type Inspection = '3' | '5' | '10' | '15' | 'pause' | 'none';

interface FullSolvePrefs {
  enabled: boolean;
  process: Process;
  inspection: Inspection;
  twoLookOll: boolean;
  twoLookPll: boolean;
  graphRange: number;
  graphYClip: '1sd' | '2sd' | 'log';
  graphAo5: boolean;
  graphAo12: boolean;
  // When true, split the F2L band of each solve in the main graph into
  // up to 4 alpha-scaled sub-bands of the same green, one per slot-count
  // milestone recorded in SolveRecord.f2lSplits. Solves without f2lSplits
  // (pre-feature records) render as a single full-alpha band regardless.
  f2lSplits: boolean;
  // Roux-only: when true, split CMLL into OCLL (corner orientation) +
  // OPLL (corner permutation headlights). Ignored for non-Roux processes.
  twoLookCmll: boolean;
  // Roux-only: when true, split LSE into LSEO → LRE → OPME (3-look LSE).
  // Ignored for non-Roux processes.
  threeLookLse: boolean;
  // Roux/F3uL block-stage shade scheme (display only):
  //   1 = block-aware (1st-pair-of-block → block-done shades)
  //   2 = pair-count   (chronological pair-count shades)
  rouxColorScheme: 1 | 2;
  // Tags pending to be applied to the NEXT completed solve. Sticky:
  // they remain after each solve until the user removes them via the
  // pre-solve tag editor.
  pendingSolveTags: string[];
  // Active graph tag filter — see src/fullSolve/tags.ts:applyTagFilter.
  // Both sides empty = "All Solves".
  graphTagFilter: { include: string[]; exclude: string[] };
  // Most-recent committed filters from the advanced dialog (LRU,
  // capped at 5). Surfaced as options in the tags-filter dropdown.
  recentTagSets: { include: string[]; exclude: string[] }[];
}

interface PhaseDef {
  key: string;
  label: string;
  // Check whether this phase's target state has been reached, given the current facelets string.
  predicate: (facelets: string) => boolean;
  color: string;
}

type Mode = 'idle' | 'scrambling' | 'inspection' | 'solving' | 'paused' | 'done';

// ---------- Prefs ----------

const PREFS_KEY = 'fullSolvePrefs';

const defaultPrefs: FullSolvePrefs = {
  enabled: false,
  process: 'cfop',
  inspection: '15',
  twoLookOll: false,
  twoLookPll: false,
  graphRange: 20,
  graphYClip: '1sd',
  graphAo5: true,
  graphAo12: true,
  f2lSplits: false,
  twoLookCmll: false,
  threeLookLse: false,
  rouxColorScheme: 1,
  pendingSolveTags: [],
  graphTagFilter: { include: [], exclude: [] },
  recentTagSets: [],
};

function loadPrefs(): FullSolvePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...defaultPrefs };
    return { ...defaultPrefs, ...JSON.parse(raw) };
  } catch { return { ...defaultPrefs }; }
}

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}

let prefs: FullSolvePrefs = loadPrefs();

// ---------- Solve history ----------

const HISTORY_KEY = 'fullSolveHistory';
const HISTORY_CAP = 500;

function loadHistory(): SolveRecord[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // Migrate older records that used the 'wc' phase key to 'cross'.
    arr.forEach((r: SolveRecord) => {
      if (r.phases && Object.prototype.hasOwnProperty.call(r.phases, 'wc')) {
        if (!Object.prototype.hasOwnProperty.call(r.phases, 'cross')) {
          r.phases.cross = r.phases.wc;
        }
        delete r.phases.wc;
      }
    });
    return arr;
  } catch { return []; }
}

function saveHistory() {
  try {
    while (history.length > HISTORY_CAP) history.shift();
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch { /* ignore */ }
}

let history: SolveRecord[] = loadHistory();

function exportHistoryAsJson() {
  const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `cubedex-solve-history-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Analysis-friendly export: per-physical-move CSV (timestamp,move,phase)
// with blank rows between solves. NOT re-importable — for re-import use
// the JSON export. Pure CSV building lives in fullSolve/csvExport.ts.
function exportHistoryAsCsvFile() {
  const blob = new Blob([historyToCsv(history)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `cubedex-solve-history-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Merge `incoming` into the module-level `history`, persist, and return
// the per-batch counts. Pure merge logic lives in fullSolve/historyMerge.ts.
function mergeImportedHistory(incoming: any[]): { added: number; replaced: number; skipped: number } {
  const { merged, added, replaced, skipped } = mergeHistoryPure(history, incoming, HISTORY_CAP);
  history = merged;
  saveHistory();
  return { added, replaced, skipped };
}

// ---------- Replay-based backfill ----------
// For records that have `turns` (per-physical-move timestamps) but lack
// derived data — F2L slot splits, or 2-look OLL/PLL splits — we can
// replay scramble + solution onto a solved cube, watch cube state, and
// re-derive the missing fields. Mid-half-turn intermediate state is
// approximated: the COLLAPSED solution is applied directly (R2 in one
// shot, not R + R), so a state transition that would have completed
// between the two physical quarter-turns of a pair gets attributed to
// the second one (≤ ~200ms timing error in practice, acceptable for
// visualisation).

interface ReplayDerived {
  f2lSplits?: number[];
  // ms durations (not absolute timestamps). Cumulatively: cross_ms +
  // f2l_ms + eoll + ocll + cpll + epll === totalMs (approximately).
  twoLookOll?: { eoll: number; ocll: number };
  twoLookPll?: { cpll: number; epll: number };
}

function recomputeMissingSplitsFor(r: SolveRecord): ReplayDerived | null {
  if (!kpuzzle) return null;
  // Backfill only applies to CFOP's F2L slot splits + 2-look LL timings.
  // Beginner has no F2L; Roux / F3uL split F2L into named block phases,
  // so per-slot timing isn't meaningful for them.
  if (r.process === 'beginner') return null;
  if (r.process === 'roux' || r.process === 'f3ul') return null;
  if (!r.turns || r.turns.length === 0) return null;
  let p = kpuzzle.defaultPattern();
  for (const m of r.scramble.split(/\s+/).filter(Boolean)) {
    try { p = p.applyMove(m); } catch { return null; }
  }
  const tokens = r.solution.split(/\s+/).filter(Boolean);
  let physicalIdx = 0; // index into r.turns of the most-recent physical event
  let crossFace: Face | null = null;
  let slotsEver = 0;
  const f2lSplits: number[] = [];
  // Absolute ms-from-solve-start at first detection of each LL phase.
  let eollAt: number | null = null;
  let ocllAt: number | null = null;
  let cpllAt: number | null = null;
  let epllAt: number | null = null;
  for (const t of tokens) {
    try { p = p.applyMove(t); } catch { return null; }
    physicalIdx += t.endsWith('2') ? 2 : 1;
    let facelets: string;
    try { facelets = patternToFacelets(p); } catch { continue; }
    if (!crossFace) {
      for (const f of FACES) {
        if (isCrossDoneOn(f, facelets)) { crossFace = f; break; }
      }
      if (!crossFace) continue;
    }
    const tIdx = Math.min(physicalIdx, r.turns.length) - 1;
    const tMs = Math.round((r.turns[tIdx] ?? 0) * 1000);
    if (slotsEver < 4) {
      const slots = f2lSlotsDoneOn(crossFace, facelets);
      while (slots > slotsEver) {
        slotsEver++;
        f2lSplits.push(tMs);
      }
    }
    // 2-look OLL transitions. Lock on FIRST observation (monotonic) —
    // matches the real-time phase detection behaviour.
    if (eollAt === null && isEOLLDoneOn(crossFace, facelets)) eollAt = tMs;
    if (ocllAt === null && isOllDoneOn(crossFace, facelets)) {
      ocllAt = tMs;
      if (eollAt === null) eollAt = tMs; // full OLL implies EOLL
    }
    // 2-look PLL transitions. Require OLL already detected so we don't
    // mis-fire from an earlier accidental matching state.
    if (ocllAt !== null && cpllAt === null && isHeadlightsDoneOn(crossFace, facelets) && isOllDoneOn(crossFace, facelets)) {
      cpllAt = tMs;
    }
    if (epllAt === null && isSolved(facelets)) {
      epllAt = tMs;
      if (cpllAt === null) cpllAt = tMs; // solved implies headlights
    }
  }
  const out: ReplayDerived = {};
  if (f2lSplits.length > 0) out.f2lSplits = f2lSplits;
  if (eollAt !== null && ocllAt !== null) {
    // f2l-done ms-from-solveStart = cross_ms + f2l_ms (stored).
    const f2lDoneMs = (r.phases?.cross ?? 0) + (r.phases?.f2l ?? 0);
    out.twoLookOll = {
      eoll: Math.max(0, eollAt - f2lDoneMs),
      ocll: Math.max(0, ocllAt - eollAt),
    };
  }
  if (cpllAt !== null && epllAt !== null && ocllAt !== null) {
    out.twoLookPll = {
      cpll: Math.max(0, cpllAt - ocllAt),
      epll: Math.max(0, epllAt - cpllAt),
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Replay the recorded solve under a TARGET process's phase sequence
// and produce a fresh phase-durations map. Used by the post-hoc
// method-edit feature: when the user picks the wrong process at
// solve time (or wants to retag a solve as a different method), we
// re-walk the solution against the new process's predicates to
// derive the phase breakdown.
//
// Phase detection follows the same first-match-wins discipline the
// live recorder uses, but uses pure predicates with locally-scoped
// face-detection state (so this doesn't disturb the active solve).
//
// Returns null if the puzzle engine isn't available or the record
// lacks per-turn timestamps. Phases that never fire are simply
// absent from the returned map — the graph + CSV handle missing
// keys as zero.
function replayPhasesForProcess(r: SolveRecord, targetProcess: Process): Record<string, number> | null {
  if (!kpuzzle) return null;
  if (!r.turns || r.turns.length === 0) return null;
  let pat = kpuzzle.defaultPattern();
  for (const m of r.scramble.split(/\s+/).filter(Boolean)) {
    try { pat = pat.applyMove(m); } catch { return null; }
  }
  const tokens = r.solution.split(/\s+/).filter(Boolean);

  // Locally-scoped face detection — each replay starts fresh.
  let crossFace: Face | null = null;
  let downFace: Face | null = null;
  let side1Face: Face | null = null;

  type ReplayCheck = { key: string; check: (f: string) => boolean };
  const phaseChecks: ReplayCheck[] = (() => {
    if (targetProcess === 'beginner') {
      return [
        { key: 'setup', check: (f: string) => {
          for (const face of FACES) if (isEOLLDoneOn(face, f)) return true;
          return false;
        }},
        { key: 'll', check: (f: string) => isSolved(f) },
      ];
    }
    if (targetProcess === 'roux') {
      return [
        { key: 'f1b', check: (f: string) => {
          if (downFace && side1Face) return isRouxFirstBlockDoneOn(downFace, side1Face, f);
          for (const d of FACES) for (const s of FACES) {
            if (s === d || s === OPPOSITE[d]) continue;
            if (isRouxFirstBlockDoneOn(d, s, f)) { downFace = d; side1Face = s; return true; }
          }
          return false;
        }},
        { key: 'f2b',  check: (f: string) => !!(downFace && side1Face) && isRouxSecondBlockDoneOn(downFace!, side1Face!, f) },
        { key: 'ocll', check: (f: string) => !!downFace && areTopCornersOrientedOn(downFace!, f) },
        { key: 'opll', check: (f: string) => !!downFace && areTopCornersOrientedOn(downFace!, f) && isHeadlightsDoneOn(downFace!, f) },
        { key: 'lseo', check: (f: string) => !!(downFace && side1Face) && isLSEOrientedOn(downFace!, side1Face!, f) },
        { key: 'lre',  check: (f: string) => !!(downFace && side1Face) && isLREDoneOn(downFace!, side1Face!, f) },
        { key: 'opme', check: (f: string) => isSolved(f) },
      ];
    }
    if (targetProcess === 'f3ul') {
      return [
        { key: 'f1b', check: (f: string) => {
          if (downFace && side1Face) return isRouxFirstBlockDoneOn(downFace, side1Face, f);
          for (const d of FACES) for (const s of FACES) {
            if (s === d || s === OPPOSITE[d]) continue;
            if (isRouxFirstBlockDoneOn(d, s, f)) { downFace = d; side1Face = s; return true; }
          }
          return false;
        }},
        { key: 'f2b',  check: (f: string) => !!(downFace && side1Face) && isRouxSecondBlockDoneOn(downFace!, side1Face!, f) },
        { key: 'fml',  check: (f: string) => !!downFace && isF2LDoneOn(downFace!, f) },
        { key: 'eoll', check: (f: string) => !!downFace && isEOLLDoneOn(downFace!, f) },
        { key: 'ocll', check: (f: string) => !!downFace && isOllDoneOn(downFace!, f) },
        { key: 'cpll', check: (f: string) => !!downFace && isOllDoneOn(downFace!, f) && isHeadlightsDoneOn(downFace!, f) },
        { key: 'epll', check: (f: string) => isSolved(f) },
      ];
    }
    // cfop
    return [
      { key: 'cross', check: (f: string) => {
        if (crossFace) return isCrossDoneOn(crossFace, f);
        for (const face of FACES) if (isCrossDoneOn(face, f)) { crossFace = face; return true; }
        return false;
      }},
      { key: 'f2l',  check: (f: string) => !!crossFace && isF2LDoneOn(crossFace!, f) },
      { key: 'eoll', check: (f: string) => !!crossFace && isEOLLDoneOn(crossFace!, f) },
      { key: 'ocll', check: (f: string) => !!crossFace && isOllDoneOn(crossFace!, f) },
      { key: 'cpll', check: (f: string) => !!crossFace && isOllDoneOn(crossFace!, f) && isHeadlightsDoneOn(crossFace!, f) },
      { key: 'epll', check: (f: string) => isSolved(f) },
    ];
  })();

  const timings: (number | null)[] = phaseChecks.map(() => null);
  let physicalIdx = 0;

  for (const t of tokens) {
    try { pat = pat.applyMove(t); } catch { return null; }
    physicalIdx += t.endsWith('2') ? 2 : 1;
    let facelets: string;
    try { facelets = patternToFacelets(pat); } catch { continue; }
    const tIdx = Math.min(physicalIdx, r.turns.length) - 1;
    const tMs = Math.round((r.turns[tIdx] ?? 0) * 1000);
    for (let i = 0; i < phaseChecks.length; i++) {
      if (timings[i] !== null) continue;
      // Strict in-order detection: only check phase i if phase i-1 is done.
      if (i > 0 && timings[i - 1] === null) break;
      if (phaseChecks[i].check(facelets)) timings[i] = tMs;
    }
  }

  const out: Record<string, number> = {};
  let prev = 0;
  for (let i = 0; i < phaseChecks.length; i++) {
    if (timings[i] === null) continue;
    out[phaseChecks[i].key] = Math.max(0, (timings[i]!) - prev);
    prev = timings[i]!;
  }
  return out;
}

function backfillF2lSplits() {
  if (!kpuzzle) return;
  let updated = 0;
  for (const r of history) {
    if (!r.turns || r.turns.length === 0) continue;
    if (r.process === 'beginner') continue;
    const hasF2l = !!r.f2lSplits;
    const hasOllSplit = typeof r.phases?.eoll === 'number' && typeof r.phases?.ocll === 'number';
    const hasPllSplit = typeof r.phases?.cpll === 'number' && typeof r.phases?.epll === 'number';
    if (hasF2l && hasOllSplit && hasPllSplit) continue;
    const derived = recomputeMissingSplitsFor(r);
    if (!derived) continue;
    let touched = false;
    if (!hasF2l && derived.f2lSplits) {
      r.f2lSplits = derived.f2lSplits;
      touched = true;
    }
    if (!hasOllSplit && derived.twoLookOll) {
      r.phases.eoll = derived.twoLookOll.eoll;
      r.phases.ocll = derived.twoLookOll.ocll;
      touched = true;
    }
    if (!hasPllSplit && derived.twoLookPll) {
      r.phases.cpll = derived.twoLookPll.cpll;
      r.phases.epll = derived.twoLookPll.epll;
      touched = true;
    }
    if (touched) updated++;
  }
  if (updated > 0) {
    saveHistory();
    if (prefs.enabled) renderGraph();
  }
}

// Pair timings recorded by an earlier (buggy) version collapsed pairs
// 1+2 to the same ms (and 3+4 the same) because down-face wasn't
// locked until block-1 was done. Detect that signature so we can
// recompute over the affected records — equal adjacent pair times
// almost never happen genuinely (would require two pair completions
// on a single physical move).
function hasCollapsedPairTimings(arr?: number[]): boolean {
  if (!arr || arr.length < 2) return false;
  for (let i = 1; i < arr.length; i++) if (arr[i] === arr[i - 1]) return true;
  return false;
}

// Roux/F3uL pair-timing backfill — populates rouxPairTimingsMs and
// rouxBlock{1,2}FirstPairMs by replaying the recorded scramble +
// solution. Skips records that already have plausible data. Records
// without r.turns can't be back-timed and are skipped.
function backfillRouxPairTimings() {
  if (!kpuzzle) return;
  let updated = 0;
  for (const r of history) {
    if (r.process !== 'roux' && r.process !== 'f3ul') continue;
    if (r.rouxPairTimingsMs && r.rouxPairTimingsMs.length > 0
        && !hasCollapsedPairTimings(r.rouxPairTimingsMs)) continue;
    if (!r.turns || r.turns.length === 0) continue;
    let pat = kpuzzle.defaultPattern();
    let badScramble = false;
    for (const m of r.scramble.split(/\s+/).filter(Boolean)) {
      try { pat = pat.applyMove(m); } catch { badScramble = true; break; }
    }
    if (badScramble) continue;
    const tokens = r.solution.split(/\s+/).filter(Boolean);
    let down: Face | null = null;
    let side1: Face | null = null;
    let physIdx = 0;
    let doneMask = 0;
    const pairMs: number[] = [];
    const pairSlots: number[] = [];
    let block1FirstPairMs: number | null = null;
    let block2FirstPairMs: number | null = null;
    let block1DoneSeen = false;
    let block2DoneSeen = false;
    for (const t of tokens) {
      try { pat = pat.applyMove(t); } catch { break; }
      physIdx += t.endsWith('2') ? 2 : 1;
      let facelets: string;
      try { facelets = patternToFacelets(pat); } catch { continue; }
      const tIdx = Math.min(physIdx, r.turns.length) - 1;
      const tMs = Math.round((r.turns[tIdx] ?? 0) * 1000);
      // Lock the down-face on the FIRST pair completion (any of 6 ×
      // 4 candidate (d, slot) combos). Without this early lock, pairs
      // 1 + 2 of the 1st block can't be detected individually and
      // both end up timestamped at the block-done moment.
      if (!down) {
        outer: for (const candidate of FACES) {
          const slots = F2L_SLOTS[candidate];
          for (let i = 0; i < slots.length; i++) {
            let allMatch = true;
            for (const [sideFace, idx] of slots[i]) {
              const s = faceStickers(facelets, sideFace);
              if (s[idx] !== s[4]) { allMatch = false; break; }
            }
            if (allMatch) { down = candidate; break outer; }
          }
        }
      }
      if (!down) continue;
      // Lock the 1st-block side independently — fires the moment a
      // full 1x2x3 is formed (same logic as the live wrapper).
      if (!side1) {
        for (const s of FACES) {
          if (s === down || s === OPPOSITE[down]) continue;
          if (isRouxFirstBlockDoneOn(down, s, facelets)) { side1 = s; break; }
        }
      }
      // Record any newly-completed pairs.
      const slots = F2L_SLOTS[down];
      for (let i = 0; i < slots.length; i++) {
        if (doneMask & (1 << i)) continue;
        let allMatch = true;
        for (const [sideFace, idx] of slots[i]) {
          const s = faceStickers(facelets, sideFace);
          if (s[idx] !== s[4]) { allMatch = false; break; }
        }
        if (allMatch) {
          doneMask |= (1 << i);
          pairMs.push(tMs);
          pairSlots.push(i);
        }
      }
      // Block-done events: capture earliest pair for each block by
      // side-face membership in the slot's sticker tuple.
      if (!block1DoneSeen && side1 && isRouxFirstBlockDoneOn(down, side1, facelets)) {
        block1DoneSeen = true;
        for (let i = 0; i < pairSlots.length; i++) {
          const slotFaces = new Set(F2L_SLOTS[down][pairSlots[i]].map(([f]) => f));
          if (slotFaces.has(side1)) {
            if (block1FirstPairMs === null || pairMs[i] < block1FirstPairMs) {
              block1FirstPairMs = pairMs[i];
            }
          }
        }
      }
      if (!block2DoneSeen && side1 && isRouxSecondBlockDoneOn(down, side1, facelets)) {
        block2DoneSeen = true;
        const side2 = OPPOSITE[side1];
        for (let i = 0; i < pairSlots.length; i++) {
          const slotFaces = new Set(F2L_SLOTS[down][pairSlots[i]].map(([f]) => f));
          if (slotFaces.has(side2)) {
            if (block2FirstPairMs === null || pairMs[i] < block2FirstPairMs) {
              block2FirstPairMs = pairMs[i];
            }
          }
        }
      }
      if (pairMs.length >= 4 && block1DoneSeen && block2DoneSeen) break;
    }
    if (pairMs.length > 0) {
      r.rouxPairTimingsMs = pairMs;
      if (block1FirstPairMs !== null) r.rouxBlock1FirstPairMs = block1FirstPairMs;
      if (block2FirstPairMs !== null) r.rouxBlock2FirstPairMs = block2FirstPairMs;
      updated++;
    }
  }
  if (updated > 0) {
    saveHistory();
    if (prefs.enabled) renderGraph();
  }
}

function importHistoryFromText(text: string) {
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { alert('Import failed: invalid JSON.'); return; }
  if (!Array.isArray(parsed)) { alert('Import failed: expected a JSON array of solves.'); return; }
  const before = history.length;
  const { added, replaced, skipped } = mergeImportedHistory(parsed);
  // Imported records may have `turns` but no `f2lSplits`; replay them so
  // the F2L-slots toggle has data to show.
  backfillF2lSplits();
  backfillRouxPairTimings();
  renderGraph();
  renderStatsBoxes();
  renderStatsLegend();
  renderSolveList();
  const parts = [`Imported ${added} new solve${added === 1 ? '' : 's'}`];
  if (replaced) parts.push(`replaced ${replaced} with shorter time${replaced === 1 ? '' : 's'}`);
  if (skipped) parts.push(`skipped ${skipped} invalid record${skipped === 1 ? '' : 's'}`);
  parts.push(`history size: ${before} → ${history.length}`);
  alert(parts.join('. ') + '.');
}

// ---------- Phase predicates (stateful wrappers around pure cube/predicates) ----------
// Speedcubers solve color-neutral: the "cross face" is whichever face the
// cuber chose to put on the bottom for this solve. We don't know which until
// it shows up in the cube state, so each phase predicate dispatches over all
// 6 candidates until one matches; that face is then locked for the rest of
// the solve via `detectedCrossFace`. The pure per-face checks live in
// src/cube/predicates.ts; the stateful detection logic stays here.

let detectedCrossFace: Face | null = null;

function isCrossDone(facelets: string): boolean {
  if (detectedCrossFace) return isCrossDoneOn(detectedCrossFace, facelets);
  for (const f of FACES) {
    if (isCrossDoneOn(f, facelets)) {
      detectedCrossFace = f;
      return true;
    }
  }
  return false;
}

function isF2LDone(facelets: string): boolean {
  return detectedCrossFace ? isF2LDoneOn(detectedCrossFace, facelets) : false;
}

function isYellowCrossDone(facelets: string): boolean {
  // Used as Beginner's first phase predicate AND as EOLL in 2-look CFOP. In
  // both cases it means "edges oriented on the last-layer face". For Beginner
  // before any cross has been detected, infer the LL face from whichever face
  // has the cross edges showing the OPPOSITE face's center color — a fully-
  // detected cross-face also implies the LL face is its opposite.
  if (detectedCrossFace) return isEOLLDoneOn(detectedCrossFace, facelets);
  for (const f of FACES) {
    if (isCrossDoneOn(f, facelets)) {
      detectedCrossFace = f;
      return isEOLLDoneOn(f, facelets);
    }
  }
  // Fallback: if any face has its 4 edges matching center (yellow-cross-like
  // pattern on any face), accept it. This lets Beginner solvers without a
  // detected base cross still get an EO transition recorded.
  for (const f of FACES) {
    const s = faceStickers(facelets, f);
    if (s[1] === s[4] && s[3] === s[4] && s[5] === s[4] && s[7] === s[4]) return true;
  }
  return false;
}

function isOllDone(facelets: string): boolean {
  return detectedCrossFace ? isOllDoneOn(detectedCrossFace, facelets) : false;
}

function isHeadlightsDone(facelets: string): boolean {
  return detectedCrossFace ? isHeadlightsDoneOn(detectedCrossFace, facelets) : false;
}

// ---------- Roux / F3uL stateful wrappers ----------
//
// Roux is parameterised by TWO orientation choices: the down-face (like
// CFOP's cross face) AND which side hosts the first 1x2x3 block (one of
// the 4 faces adjacent to D). Once the first block is detected, we lock
// BOTH so subsequent predicates dispatch directly. For F3uL we only
// need detectedDownFace (FML reuses CFOP's F2L predicate against it).

let detectedDownFace: Face | null = null;
let detectedRouxSide1: Face | null = null;

function isFirstBlockDone(facelets: string): boolean {
  // Both anchors locked — fast dispatch.
  if (detectedDownFace && detectedRouxSide1) {
    return isRouxFirstBlockDoneOn(detectedDownFace, detectedRouxSide1, facelets);
  }
  // downFace already locked by sampleRouxPairProgression (which fires
  // on the FIRST pair) but side1 isn't — search only sides on the
  // locked downFace, never overwrite downFace.
  if (detectedDownFace) {
    for (const s of FACES) {
      if (s === detectedDownFace || s === OPPOSITE[detectedDownFace]) continue;
      if (isRouxFirstBlockDoneOn(detectedDownFace, s, facelets)) {
        detectedRouxSide1 = s;
        return true;
      }
    }
    return false;
  }
  // Cold start — color-neutral search across all 24 (d, s) combos.
  for (const d of FACES) {
    for (const s of FACES) {
      if (s === d || s === OPPOSITE[d]) continue;
      if (isRouxFirstBlockDoneOn(d, s, facelets)) {
        detectedDownFace = d;
        detectedRouxSide1 = s;
        return true;
      }
    }
  }
  return false;
}

function isSecondBlockDone(facelets: string): boolean {
  if (!detectedDownFace || !detectedRouxSide1) return false;
  return isRouxSecondBlockDoneOn(detectedDownFace, detectedRouxSide1, facelets);
}

function isFmlDone(facelets: string): boolean {
  // F3uL's "fix middle layer" lands the cube in CFOP's F2L-done state.
  return detectedDownFace ? isF2LDoneOn(detectedDownFace, facelets) : false;
}

function isCmllOriented(facelets: string): boolean {
  // CORNERS-ONLY orientation (top edges are ignored throughout CMLL).
  return detectedDownFace ? areTopCornersOrientedOn(detectedDownFace, facelets) : false;
}

function isCmllDone(facelets: string): boolean {
  // OCLL + headlights — same pairwise-match semantic CFOP uses for CPLL.
  return detectedDownFace
    ? (areTopCornersOrientedOn(detectedDownFace, facelets)
       && isHeadlightsDoneOn(detectedDownFace, facelets))
    : false;
}

function isLseOriented(facelets: string): boolean {
  return (detectedDownFace && detectedRouxSide1)
    ? isLSEOrientedOn(detectedDownFace, detectedRouxSide1, facelets)
    : false;
}

function isLreDone(facelets: string): boolean {
  return (detectedDownFace && detectedRouxSide1)
    ? isLREDoneOn(detectedDownFace, detectedRouxSide1, facelets)
    : false;
}

// ---------- Phase sequences ----------

// Index 0 (cross) and index 4 (CPLL) are swapped from a natural rainbow
// so the two 2-look pairs sit adjacent on the colour wheel:
//   2-look OLL:  yellow (EOLL) → orange (OCLL)
//   2-look PLL:  blue (CPLL)   → purple (EPLL)
const PHASE_COLORS = [
  'rgba(236, 72, 153, 0.6)',   // 0  pink   — cross / F1B
  // F2L runs at alpha 0.75 so the unsplit / no-data band reads at the
  // same saturation as the topmost sub-band when the F2L-slots toggle is
  // on. F2L is usually the largest phase by far, so its higher contrast
  // is also visually appropriate. FML (F3uL's "fix middle layer") shares
  // this color since FML lands the cube in the same state as CFOP's F2L
  // being done — it's conceptually the tail of the F2L stage.
  'rgba(16, 185, 129, 0.75)',  // 1  green  — F2L / FML  (4th F2L sub-band)
  'rgba(234, 179, 8, 0.6)',    // 2  yellow — EOLL / LSEO
  'rgba(249, 115, 22, 0.6)',   // 3  orange — OCLL / headlights
  'rgba(59, 130, 246, 0.6)',   // 4  blue   — CPLL / OPLL
  'rgba(139, 92, 246, 0.6)',   // 5  purple — EPLL / OPME (final phase)
  'rgba(244, 63, 94, 0.6)',    // 6  red    — LRE (Roux's UL/UR-placed)
  // F2B uses the 2nd F2L sub-band shade (alpha 0.45) — same green
  // family as F2L/FML, just less saturated so the two block phases
  // read as related-but-distinct.
  'rgba(16, 185, 129, 0.45)',  // 7  green-light — F2B  (2nd F2L sub-band)
  // Block-stage sub-shade colors for the Roux/F3uL granular display.
  // Light pink sits below the existing pink (slot 0 = CFOP cross
  // color) for the first-block lead-in, so Roux/F3uL's 1st block
  // visually parallels CFOP's cross. Light green ditto for the
  // second-block lead-in (paralleling F2L green).
  'rgba(236, 72, 153, 0.30)',  // 8  light pink  — block-stage "1st pair" sub-shade
  'rgba(16, 185, 129, 0.30)',  // 9  light green — block-stage "1st pair of 2nd block" sub-shade
];

// The canonical RECORDING phase sequence — what phase detection watches
// for and what gets stored on each SolveRecord. Always emits the fully
// split form (EOLL→OCLL, CPLL→EPLL) in CFOP so the data is captured
// regardless of the user's display preference; the 2-look toggles only
// influence how the bands are drawn after the fact. Use displayPhaseSequence
// for legend / graph rendering.
function currentPhaseSequence(): PhaseDef[] {
  if (prefs.process === 'beginner') {
    // Until beginner intermediate phases are defined, track 2 buckets:
    // everything up to yellow-cross, and yellow-cross → solved.
    return [
      { key: 'setup', label: 'Setup', predicate: isYellowCrossDone, color: PHASE_COLORS[0] },
      { key: 'll', label: 'LL', predicate: isSolved, color: PHASE_COLORS[4] },
    ];
  }
  if (prefs.process === 'roux') {
    return [
      { key: 'f1b',  label: '1st Block', predicate: isFirstBlockDone,  color: PHASE_COLORS[0] },
      { key: 'f2b',  label: '2nd Block', predicate: isSecondBlockDone, color: PHASE_COLORS[7] },
      { key: 'ocll', label: 'OCLL',      predicate: isCmllOriented,    color: PHASE_COLORS[3] },
      { key: 'opll', label: 'OPLL',      predicate: isCmllDone,        color: PHASE_COLORS[4] },
      { key: 'lseo', label: 'LSEO',      predicate: isLseOriented,     color: PHASE_COLORS[2] },
      { key: 'lre',  label: 'LRE',       predicate: isLreDone,         color: PHASE_COLORS[6] },
      { key: 'opme', label: 'OPME',      predicate: isSolved,          color: PHASE_COLORS[5] },
    ];
  }
  if (prefs.process === 'f3ul') {
    return [
      { key: 'f1b',  label: '1st Block', predicate: isFirstBlockDone,  color: PHASE_COLORS[0] },
      { key: 'f2b',  label: '2nd Block', predicate: isSecondBlockDone, color: PHASE_COLORS[7] },
      { key: 'fml',  label: 'FML',       predicate: isFmlDone,         color: PHASE_COLORS[1] },
      { key: 'eoll', label: 'EOLL',      predicate: isYellowCrossDone, color: PHASE_COLORS[2] },
      { key: 'ocll', label: 'OCLL',      predicate: isOllDone,         color: PHASE_COLORS[3] },
      { key: 'cpll', label: 'CPLL',      predicate: (f) => isOllDone(f) && isHeadlightsDone(f), color: PHASE_COLORS[4] },
      { key: 'epll', label: 'EPLL',      predicate: isSolved,          color: PHASE_COLORS[5] },
    ];
  }
  return [
    { key: 'cross', label: 'Cross', predicate: isCrossDone, color: PHASE_COLORS[0] },
    { key: 'f2l',   label: 'F2L',   predicate: isF2LDone,   color: PHASE_COLORS[1] },
    { key: 'eoll',  label: 'EOLL',  predicate: isYellowCrossDone, color: PHASE_COLORS[2] },
    { key: 'ocll',  label: 'OCLL',  predicate: isOllDone,   color: PHASE_COLORS[3] },
    { key: 'cpll',  label: 'CPLL',  predicate: (f) => isOllDone(f) && isHeadlightsDone(f), color: PHASE_COLORS[4] },
    { key: 'epll',  label: 'EPLL',  predicate: isSolved,    color: PHASE_COLORS[5] },
  ];
}

// Canonical solve-progression order for ALL phase keys across every
// process. The graph + legend use this to build a unified key order
// when the filtered history mixes multiple processes — each record
// contributes only to the keys in its own `displayPhaseSequenceFor`
// list, so per-solve totals stay correct. Order: setup-equivalents,
// then F2L-equivalents, then OLL/CMLL phase (splits before
// aggregates, lower-stacked sub-phase first), then PLL/LSE phase
// (same), then the Beginner aggregate at the very top.
const CANONICAL_KEY_ORDER: readonly string[] = [
  'setup', 'cross', 'f1b',
  // Roux/F3uL block-stage sub-shades (Scheme 1 = block-aware; Scheme 2
  // = pair-count). At most one of these key families appears for a
  // given record + scheme; the other contributes 0 across the slice.
  'b1_pre', 'b1_done', 'b2_pre', 'b2_done',
  'rp1', 'rp2', 'rp3', 'rp4',
  'f2l', 'f2b', 'fml',
  // OLL/CMLL phase
  'eoll',
  'ocll',
  'oll',
  'opll',
  'cmll',
  // PLL/LSE phase
  'cpll',
  'lseo',
  'lre',
  'epll',
  'opme',
  'pll',
  'lse',
  'll',
];

// Per-record display key sequence — what bands a single record
// contributes to. Uses CURRENT global prefs for the split/aggregate
// choice, so toggling 2-look from the UI restacks every solve
// uniformly. Roux records honor twoLookCmll/threeLookLse; CFOP/F3uL
// records honor twoLookOll/twoLookPll.
function displayPhaseSequenceFor(r: SolveRecord): string[] {
  if (r.process === 'beginner') return ['setup', 'll'];
  // Roux/F3uL block-stage key choice depends on (a) whether the record
  // has the granular per-pair data and (b) the active color scheme.
  // Records without granular data fall back to the original 2-band
  // ['f1b', 'f2b'] display regardless of scheme.
  const hasGranular = !!r.rouxPairTimingsMs && r.rouxPairTimingsMs.length >= 4;
  const hasScheme1Anchors = typeof r.rouxBlock1FirstPairMs === 'number'
                          && typeof r.rouxBlock2FirstPairMs === 'number';
  const blockKeys = (() => {
    if (prefs.rouxColorScheme === 1 && hasScheme1Anchors) {
      return ['b1_pre', 'b1_done', 'b2_pre', 'b2_done'];
    }
    if (prefs.rouxColorScheme === 2 && hasGranular) {
      return ['rp1', 'rp2', 'rp3', 'rp4'];
    }
    return ['f1b', 'f2b'];
  })();
  if (r.process === 'roux') {
    const oll = prefs.twoLookCmll ? ['ocll', 'opll'] : ['cmll'];
    const lse = prefs.threeLookLse ? ['lseo', 'lre', 'opme'] : ['lse'];
    return [...blockKeys, ...oll, ...lse];
  }
  if (r.process === 'f3ul') {
    const oll = prefs.twoLookOll ? ['eoll', 'ocll'] : ['oll'];
    const pll = prefs.twoLookPll ? ['cpll', 'epll'] : ['pll'];
    return [...blockKeys, 'fml', ...oll, ...pll];
  }
  // cfop
  const oll = prefs.twoLookOll ? ['eoll', 'ocll'] : ['oll'];
  const pll = prefs.twoLookPll ? ['cpll', 'epll'] : ['pll'];
  return ['cross', 'f2l', ...oll, ...pll];
}

// Union of every key any record in `records` would display, ordered
// per CANONICAL_KEY_ORDER. Used as the stacked-area chart's dataset
// order. Roux's LRE/OPME/LSEO bands "come and go" automatically: they
// only appear when a Roux solve with split LSE is in the filtered view.
function unifiedKeyOrder(records: SolveRecord[]): string[] {
  const seen = new Set<string>();
  for (const r of records) for (const k of displayPhaseSequenceFor(r)) seen.add(k);
  return CANONICAL_KEY_ORDER.filter(k => seen.has(k));
}

// ---------- DOM refs ----------

const $$ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

const fullSolveToggleEl = () => $$<HTMLInputElement>('full-solve-toggle');
const trainingContentEl = () => $$('training-mode-content');
const fullSolveContentEl = () => $$('full-solve-content');
const fsGraphControlsEl = () => $$('fs-graph-controls');
const fsProcessEl = () => $$<HTMLSelectElement>('fs-process-select');
const fsInspectionEl = () => $$<HTMLSelectElement>('fs-inspection-select');
const fsTwoLookOllEl = () => $$<HTMLInputElement>('fs-twolook-oll-toggle');
const fsTwoLookPllEl = () => $$<HTMLInputElement>('fs-twolook-pll-toggle');
const fsTwoLookCmllEl = () => $$<HTMLInputElement>('fs-twolook-cmll-toggle');
const fsThreeLookLseEl = () => $$<HTMLInputElement>('fs-threelook-lse-toggle');
const fsCfopOptionsEl = () => $$('fs-cfop-options');
const fsRouxOptionsEl = () => $$('fs-roux-options');
const fsScrambleEl = () => $$('fs-scramble-display');
const fsTimerEl = () => $$('fs-timer');
const fsStatusEl = () => $$('fs-status');
const fsSolutionMovesEl = () => $$('fs-solution-moves');
const fsRetraceHintEl = () => $$('fs-retrace-hint');
const fsPauseBtnEl = () => $$<HTMLButtonElement>('fs-pause-btn');
const fsAbortBtnEl = () => $$<HTMLButtonElement>('fs-abort-btn');
const fsNewScrambleBtnEl = () => $$<HTMLButtonElement>('fs-new-scramble-btn');
const fsCopyScrambleBtnEl = () => $$<HTMLButtonElement>('fs-copy-scramble-btn');
const fsPasteScrambleBtnEl = () => $$<HTMLButtonElement>('fs-paste-scramble-btn');
const fsSolveListEl = () => $$('fs-solve-list');
const fsSolveListHintEl = () => $$('fs-solve-list-hint');
const fsExportHistoryBtnEl = () => $$<HTMLButtonElement>('fs-export-history');
const fsExportHistoryCsvBtnEl = () => $$<HTMLButtonElement>('fs-export-history-csv');
const fsImportHistoryBtnEl = () => $$<HTMLButtonElement>('fs-import-history');
const fsImportHistoryInputEl = () => $$<HTMLInputElement>('fs-import-history-input');
const fsPendingTagsBtnEl = () => $$<HTMLButtonElement>('fs-pending-tags-btn');
const fsPendingTagsDisplayEl = () => $$('fs-pending-tags-display');
const fsTagsFilterMenuEl = () => $$<HTMLSelectElement>('fs-tags-filter-menu');
const fsRouxSchemeEl = () => $$<HTMLSelectElement>('fs-roux-scheme');
const fsTagEditorDialogEl = () => $$<HTMLDialogElement>('fs-tag-editor-dialog');
const fsTagEditorTitleEl = () => $$('fs-tag-editor-title');
const fsTagEditorSelectedEl = () => $$('fs-tag-editor-selected');
const fsTagEditorMethodRowEl = () => $$('fs-tag-editor-method-row');
const fsTagEditorMethodEl = () => $$<HTMLSelectElement>('fs-tag-editor-method');
const fsTagEditorInputEl = () => $$<HTMLInputElement>('fs-tag-editor-input');
const fsTagEditorListEl = () => $$('fs-tag-editor-list');
const fsTagEditorCancelEl = () => $$<HTMLButtonElement>('fs-tag-editor-cancel');
const fsTagEditorAddEl = () => $$<HTMLButtonElement>('fs-tag-editor-add');
const fsTagEditorConfirmEl = () => $$<HTMLButtonElement>('fs-tag-editor-confirm');
const fsTagsFilterDialogEl = () => $$<HTMLDialogElement>('fs-tags-filter-dialog');
const fsFilterIncludeEl = () => $$('fs-filter-include');
const fsFilterUnselectedEl = () => $$('fs-filter-unselected');
const fsFilterExcludeEl = () => $$('fs-filter-exclude');
const fsFilterClearEl = () => $$<HTMLButtonElement>('fs-filter-clear');
const fsFilterCancelEl = () => $$<HTMLButtonElement>('fs-filter-cancel');
const fsFilterConfirmEl = () => $$<HTMLButtonElement>('fs-filter-confirm');
const fsFilterMoveIncludeEl = () => $$<HTMLButtonElement>('fs-filter-move-include');
const fsFilterMoveUnselectedEl = () => $$<HTMLButtonElement>('fs-filter-move-unselected');
const fsFilterMoveExcludeEl = () => $$<HTMLButtonElement>('fs-filter-move-exclude');
// Full Solve renders into the same large graphing area training mode uses.
const fsGraphCanvasEl = () => $$<HTMLCanvasElement>('statsGraph');
const algStatsEl = () => $$('alg-stats');
const algNameDisplay2El = () => $$('alg-name-display2');
const statsLegendEl = () => $$('stats-legend');
const averageTimeBoxEl = () => $$('average-time-box');
const averageTpsBoxEl = () => $$('average-tps-box');
const singlePbBoxEl = () => $$('single-pb-box');
const leftSideInnerEl = () => $$('left-side-inner');
const fsGraphRangeEl = () => $$<HTMLInputElement>('fs-graph-range');
const fsGraphRangeValueEl = () => $$('fs-graph-range-value');
const fsGraphYClipEl = () => $$<HTMLSelectElement>('fs-graph-yclip');
const fsGraphAo5El = () => $$<HTMLInputElement>('fs-graph-ao5');
const fsGraphAo12El = () => $$<HTMLInputElement>('fs-graph-ao12');
const fsGraphF2lSplitsEl = () => $$<HTMLInputElement>('fs-graph-f2l-splits');

// ---------- Runtime state ----------

let kpuzzle: KPuzzle | null = null;
let lastPattern: KPattern | null = null;   // most recent pattern from twistyTracker
let myPattern: KPattern | null = null;     // internally-maintained; applyMove on each physical move
cube3x3x3.kpuzzle().then(kp => {
  kpuzzle = kp;
  // Records made between the turn-timestamps feature and the F2L-slots
  // feature have `turns` but no `f2lSplits`. Replay them now that we have
  // the kpuzzle, so the F2L-slots toggle visualises every applicable
  // historical solve uniformly.
  backfillF2lSplits();
  backfillRouxPairTimings();
});

let mode: Mode = 'idle';
let cubeConnected = false;
let cubeIsSolved = false;
let pendingScramble: string | null = null;  // set by 🎯 install-as-next
// "Share scrambles" peer state. Set by index.ts via setShareScramblesState.
// `sharingScrambles` = this peer is broadcasting. `peerSharingScrambles` =
// the partner is broadcasting (so our switch is greyed out). `onLocalScrambleChange`
// fires when we change scramble locally (not via remote); index.ts uses it
// to broadcast the new scramble when we're the sharer. When `applyingRemoteScramble`
// is true the next newScramble() suppresses the local-change callback to avoid
// echoing the change back.
let sharingScrambles = false;
let peerSharingScrambles = false;
let applyingRemoteScramble = false;
let onLocalScrambleChange: ((scramble: string) => void) | null = null;
let onShareStateChange: ((sharing: boolean) => void) | null = null;
// Set of solve-record timestamps whose solutions the user has revealed
// (default: every solve's solution is hidden until they click 👀). Keyed
// by `ts` rather than array index so deletions don't shift state.
const revealedSolveTimestamps = new Set<number>();
// Subset of `revealedSolveTimestamps` whose solutions are currently rendered
// in expanded mode (same-face redundancies struck through with their
// equivalent single move in italics).
const expandedSolveTimestamps = new Set<number>();

// Scramble state
let currentScramble: string = '';
let scrambleMoves: string[] = [];
let scrambleTargetFacelets: string | null = null; // facelets string after applying scramble to solved
let scrambleProgress = 0;                         // how far along the scramble we are
let scramblePatternStack: string[] = [];          // precomputed facelets for each scramble step [0..N]
let scrambleHalfwayStates: { [step: number]: string[] } = {}; // per-step facelets reached by either quarter-turn of an X2 scramble move
let halfwayActive = false;                         // user has applied one quarter-turn of the next-expected double turn
let deviationMoves: string[] = [];                // user moves that took us off-track during scrambling

// Solve state
let solveStartMs = 0;
let solveEndMs = 0;
let pausedAccumMs = 0;      // ms accumulated across pause intervals
let pauseStartedAtMs = 0;
// Interactive-pause state. Captured on togglePause→paused and mutated as
// the user physically reverses / redoes / wanders. Cleared on resume.
// pauseState.originalMoves is the snapshot of solveMoves at pause entry;
// pauseOriginalTurns is the parallel solveTurns snapshot; pauseOriginalSeq
// is the phaseSeq at pause entry (held to color each original move by
// the phase it contributed to). See src/fullSolve/pauseModel.ts.
let pauseState: PauseState = {
  originalMoves: [], originalStates: [], redundantBlocks: [],
  frontier: -1, wayward: [], redoneSet: new Set<number>(),
  targetIdx: null,
};
let pauseOriginalTurns: number[] = [];
let pauseOriginalPhaseReached: number[] = [];
let inspectionStartMs = 0;
let inspectionTimeoutHandle: number | null = null;
// Set true if the inspection countdown ran out and auto-started the
// solve timer (vs the user making a move during inspection). Persisted
// onto the SolveRecord so CSV export can emit a `start` row at t=0.
let inspectionAutoExpiredFlag = false;
let timerRafHandle = 0;
let phaseSeq: PhaseDef[] = [];
let phaseTimestamps: (number | null)[] = [];   // one per transition point; null until reached
let solveMoves: string[] = [];
// Parallel to solveMoves: fractional seconds since solveStartMs at the moment
// each move arrived, EXCLUDING paused intervals (we subtract pausedAccumMs).
let solveTurns: number[] = [];
// Per-solve F2L slot-count progression: ms-from-solveStart at each moment
// f2lSlotsDoneOn(detectedCrossFace, ...) strictly increased. Monotonic and
// bounded to 4 entries (matching the 4 F2L slots).
let solveF2lSplits: number[] = [];
let f2lSlotsEverDone = 0;
// Roux/F3uL per-pair tracking (parallel arrays, chronological).
// solveRouxPairTimingsMs[i] = absolute ms-from-solveStart at i-th pair
// completion. solveRouxPairSlotIdxs[i] = which F2L_SLOTS[D] slot
// completed (so we can attribute pairs to block 1 vs block 2 when
// each block-done predicate fires).
let solveRouxPairTimingsMs: number[] = [];
let solveRouxPairSlotIdxs: number[] = [];
let solveRouxPairSlotsDoneMask = 0;        // bitmask of slot indices already recorded
let solveRouxBlock1FirstPairMs: number | null = null;
let solveRouxBlock2FirstPairMs: number | null = null;

// Graph
let graphChart: Chart | null = null;

// Click-to-focus on a phase group in the main history graph. null = no
// focus (full stack visible). Set by a click within a phase band; cleared
// by a click outside the focused band (or on the cross / empty space).
let focusedPhaseGroup: 'f2l' | 'll' | null = null;

const F2L_KEYS = new Set(['f2l', 'f2l_1', 'f2l_2', 'f2l_3', 'f2l_4']);
const LL_KEYS  = new Set(['oll', 'pll', 'eoll', 'ocll', 'cpll', 'epll', 'll']);

function groupOfKey(k: string): 'cross' | 'f2l' | 'll' | null {
  if (k.startsWith('idle:')) k = k.slice(5);
  if (k === 'cross' || k === 'setup') return 'cross';
  if (F2L_KEYS.has(k)) return 'f2l';
  if (LL_KEYS.has(k))  return 'll';
  return null;
}

// Cumulative ms-from-solve-start at the moment the given display phase
// would have BEGUN (assuming the canonical ordering Cross → F2L (slot
// 1..4) → EOLL → OCLL → CPLL → EPLL). Used by the idle-shading plugin to
// figure out how long after a phase started the user actually made their
// first turn during it.
function phaseStartMsFor(r: SolveRecord, key: string): number {
  const p = r.phases || {};
  const crossMs = p.cross ?? 0;
  const f2lMs   = p.f2l   ?? 0;
  switch (key) {
    case 'cross':
    case 'setup': return 0;
    case 'f2l':
    case 'f2l_1': return crossMs;
    case 'f2l_2': return r.f2lSplits?.[0] ?? crossMs;
    case 'f2l_3': return r.f2lSplits?.[1] ?? crossMs;
    case 'f2l_4': return r.f2lSplits?.[2] ?? crossMs;
    case 'oll':
    case 'eoll':
    case 'll':
      return crossMs + f2lMs;
    case 'ocll':
      return crossMs + f2lMs + (p.eoll ?? 0);
    case 'cpll':
    case 'pll': {
      const ollSplit = (p.eoll ?? 0) + (p.ocll ?? 0);
      const ollUsed  = ollSplit > 0 ? ollSplit : (p.oll ?? 0);
      return crossMs + f2lMs + ollUsed;
    }
    case 'epll': {
      const ollSplit = (p.eoll ?? 0) + (p.ocll ?? 0);
      const ollUsed  = ollSplit > 0 ? ollSplit : (p.oll ?? 0);
      return crossMs + f2lMs + ollUsed + (p.cpll ?? 0);
    }
    default: return 0;
  }
}

// Idle (think-time) ms at the start of the given phase: how long after
// the phase began before the user's first physical turn during it. Zero
// if no turn data is recorded (legacy records) or if the first turn
// happened at-or-before the phase start.
function phaseIdleMsFor(r: SolveRecord, key: string): number {
  const turns = r.turns;
  if (!turns || turns.length === 0) return 0;
  const startMs = phaseStartMsFor(r, key);
  let firstAfter: number | null = null;
  for (const t of turns) {
    const ms = t * 1000;
    if (ms > startMs) { firstAfter = ms; break; }
  }
  if (firstAfter === null) return 0;
  return Math.max(0, firstAfter - startMs);
}


// ---------- Scramble precompute ----------

// Generate a random-move 3x3 scramble locally (no Web Worker). Chooses
// faces such that no two consecutive moves share a face, which avoids
// trivial cancellations. Not random-state (true uniform distribution
// requires a Kociemba-style solver, which cubing.js runs in a Worker —
// avoided here because Vite's worker bundle pulls in DOM-touching code
// from the main app and crashes with "document is not defined").
function isHalfTurn(move: string): boolean {
  // Standard 3x3 face/wide turns ending with "2" (e.g., U2, F2, Rw2).
  return /^[A-Za-z]+w?2$/.test(move);
}

function precomputeScramblePatterns(scramble: string, start: KPattern): {
  patterns: string[];
  moves: string[];
  halfwayStates: { [step: number]: string[] };
} {
  const moves: string[] = scramble.trim().split(/\s+/).filter(Boolean);
  const patterns: string[] = [patternToFacelets(start)];
  const halfwayStates: { [step: number]: string[] } = {};
  let p = start;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    // Before applying m, p is the state at step i. If m is a 180° turn,
    // either of its quarter-turn variants applied here lands us in a
    // "half-done" state for step i.
    if (isHalfTurn(m)) {
      const base = m.slice(0, -1); // "U" from "U2"
      try {
        const half1 = patternToFacelets(p.applyMove(base));
        const half2 = patternToFacelets(p.applyMove(base + "'"));
        halfwayStates[i] = [half1, half2];
      } catch { /* ignore — leave undefined */ }
    }
    try { p = p.applyMove(m); }
    catch { break; }
    patterns.push(patternToFacelets(p));
  }
  return { patterns, moves, halfwayStates };
}

// ---------- Mode switching & rendering ----------

function applyFullSolveMode() {
  const enabled = prefs.enabled;
  trainingContentEl()?.classList.toggle('hidden', enabled);
  fullSolveContentEl()?.classList.toggle('hidden', !enabled);
  fullSolveContentEl()?.classList.toggle('flex', enabled);
  fsGraphControlsEl()?.classList.toggle('hidden', !enabled);
  fsGraphControlsEl()?.classList.toggle('flex', enabled);
  const toggle = fullSolveToggleEl();
  if (toggle) toggle.checked = enabled;
  // Banner state depends on enabled+connected and must update either way.
  updateCubeGate();
  updateShareScramblesUi();
  if (enabled) {
    updateCfopOptionsVisibility();
    // Reuse training mode's #alg-stats area: big graph + 3 stat boxes.
    algStatsEl()?.style.removeProperty('display');
    leftSideInnerEl()?.classList.add('hidden');
    renderStatsBoxes();
    renderStatsLegend();
    // The canvas may have been display:none until just now — redraw to size
    // properly against the visible container.
    requestAnimationFrame(() => renderGraph());
  } else {
    // Leaving Full Solve — hide the stats area. Training mode re-shows it
    // when an algorithm is loaded. Destroy our chart so the shared
    // #statsGraph canvas is free for training mode's createStatsGraph().
    if (graphChart) { graphChart.destroy(); graphChart = null; }
    if (algStatsEl()) (algStatsEl() as HTMLElement).style.display = 'none';
    // Restore the original Single/Ao5/Ao12 legend that training mode draws.
    restoreTrainingLegend();
    const algNameEl = algNameDisplay2El();
    if (algNameEl) algNameEl.textContent = '';
  }
}

const TRAINING_STATS_LEGEND_HTML = `
  <span class="flex items-center gap-1"><span style="display:inline-block;width:14px;height:10px;border-radius:2px;background-color:rgba(54,162,235,1);flex-shrink:0"></span>Single</span>
  <span class="flex items-center gap-1"><span style="display:inline-block;width:14px;height:10px;border-radius:2px;background-color:rgba(255,159,64,1);flex-shrink:0"></span>Ao5</span>
  <span class="flex items-center gap-1"><span style="display:inline-block;width:14px;height:10px;border-radius:2px;background-color:rgba(75,192,192,1);flex-shrink:0"></span>Ao12</span>
`.trim();

function renderStatsLegend() {
  // Build a per-phase legend that matches the stacked-area dataset
  // colors actually in the graph. Cross-process: uses the same
  // unifiedKeyOrder as the graph, so the legend shows exactly the
  // phases visible in the current view (Roux's LRE band appears when
  // Roux solves are in scope, vanishes otherwise). Trendlines
  // (Ao5/Ao12) get appended.
  const el = statsLegendEl();
  if (!el) return;
  const items: string[] = [];
  const keys = unifiedKeyOrder(filteredHistory());
  keys.forEach((k) => {
    const baseColor = PHASE_COLOR_BY_KEY[k] ?? PHASE_COLORS[0];
    // Legend swatches use the phase's hue at full opacity (regardless of
    // the band's stacked-area alpha). Match-and-replace the alpha value.
    const color = baseColor.replace(/,\s*[\d.]+\)\s*$/, ', 1)');
    const label = PHASE_KEY_LABELS[k] ?? k;
    items.push(`<span class="flex items-center gap-1"><span style="display:inline-block;width:14px;height:10px;border-radius:2px;background-color:${color};flex-shrink:0"></span>${label}</span>`);
  });
  const isDark = document.documentElement.classList.contains('dark');
  const ao5Color = isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.75)';
  const ao12Color = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.45)';
  if (prefs.graphAo5) {
    items.push(`<span class="flex items-center gap-1"><span style="display:inline-block;width:14px;height:0;border-top:2px dashed ${ao5Color};flex-shrink:0"></span>Ao5</span>`);
  }
  if (prefs.graphAo12) {
    items.push(`<span class="flex items-center gap-1"><span style="display:inline-block;width:14px;height:0;border-top:2px dashed ${ao12Color};flex-shrink:0"></span>Ao12</span>`);
  }
  el.innerHTML = items.join('');
}

function restoreTrainingLegend() {
  const el = statsLegendEl();
  if (el) el.innerHTML = TRAINING_STATS_LEGEND_HTML;
}

function renderStatsBoxes() {
  // Filter applied uniformly with the graph so the stats boxes
  // reflect the same slice the user is looking at.
  const filtered = filteredHistory();
  const totals = filtered.map(r => r.totalMs);
  if (totals.length === 0) {
    averageTimeBoxEl()?.replaceChildren();
    if (averageTimeBoxEl()) averageTimeBoxEl()!.innerHTML = 'Average Time<br />--';
    if (averageTpsBoxEl()) averageTpsBoxEl()!.innerHTML = 'Average TPS<br />--';
    if (singlePbBoxEl()) singlePbBoxEl()!.innerHTML = 'Single PB<br />--';
    return;
  }
  // Mean over the last 12 (or fewer if not enough history).
  const recent = totals.slice(-12);
  const meanMs = recent.reduce((a, b) => a + b, 0) / recent.length;
  if (averageTimeBoxEl()) averageTimeBoxEl()!.innerHTML = `Average Time<br />${formatTime(meanMs)}`;

  // TPS: total moves / total time (in seconds), averaged over last 12.
  const recentRecords = filtered.slice(-12);
  let totalMoves = 0;
  let totalSec = 0;
  recentRecords.forEach(r => {
    const moveCount = r.solution ? r.solution.trim().split(/\s+/).filter(Boolean).length : 0;
    totalMoves += moveCount;
    totalSec += r.totalMs / 1000;
  });
  const tps = totalSec > 0 ? (totalMoves / totalSec).toFixed(2) : '--';
  if (averageTpsBoxEl()) averageTpsBoxEl()!.innerHTML = `Average TPS<br />${tps}`;

  const pb = Math.min(...totals);
  if (singlePbBoxEl()) singlePbBoxEl()!.innerHTML = `Single PB<br />${formatTime(pb)}`;

  // Header text — reflect current method choice.
  const algNameEl = algNameDisplay2El();
  if (algNameEl) {
    const optionTags: string[] = [];
    if (prefs.process === 'cfop') {
      optionTags.push('CFOP');
      if (prefs.twoLookOll) optionTags.push('2-look OLL');
      if (prefs.twoLookPll) optionTags.push('2-look PLL');
    } else if (prefs.process === 'roux') {
      optionTags.push('Roux');
      if (prefs.twoLookCmll) optionTags.push('2-look CMLL');
      if (prefs.threeLookLse) optionTags.push('3-look LSE');
    } else if (prefs.process === 'f3ul') {
      optionTags.push('F3uL');
      if (prefs.twoLookOll) optionTags.push('2-look OLL');
      if (prefs.twoLookPll) optionTags.push('2-look PLL');
    } else {
      optionTags.push('Beginner');
    }
    algNameEl.textContent = optionTags.join(' · ');
  }
}

// Classes that turn the status line into a dotted-border banner. Applied
// when Full Solve is enabled but no smartcube is connected (the only state
// in which we show "Connect a smart cube to track your solves." in place
// of the normal status text).
const NO_CUBE_BANNER_CLASSES = ['px-2', 'py-1', 'border', 'border-dashed', 'border-gray-400', 'dark:border-gray-500', 'rounded', 'inline-block'];

function updateCubeGate() {
  // When Full Solve is enabled and no cube is connected, the status line
  // becomes a dotted "Connect a smart cube…" banner. When connected (or
  // Full Solve is off), the banner styling is stripped and renderStatus
  // is free to drive the line again.
  const status = fsStatusEl();
  const showBanner = prefs.enabled && !cubeConnected;
  if (status) {
    if (showBanner) {
      status.textContent = 'Connect a smart cube to track your solves.';
      status.classList.add(...NO_CUBE_BANNER_CLASSES);
    } else {
      status.classList.remove(...NO_CUBE_BANNER_CLASSES);
    }
  }
}

function updateCfopOptionsVisibility() {
  // CFOP-shaped options (2-look OLL/PLL, F2L slots, share scrambles)
  // are shown for CFOP AND F3uL — F3uL's last-layer steps are identical
  // to CFOP's, so the same toggles apply.
  const cfopLike = prefs.process === 'cfop' || prefs.process === 'f3ul';
  fsCfopOptionsEl()?.classList.toggle('hidden', !cfopLike);
  fsCfopOptionsEl()?.classList.toggle('flex', cfopLike);
  // Roux-only toggle group (2-look CMLL, 3-look LSE).
  const isRoux = prefs.process === 'roux';
  fsRouxOptionsEl()?.classList.toggle('hidden', !isRoux);
  fsRouxOptionsEl()?.classList.toggle('flex', isRoux);
}

// ---------- Scramble display ----------

function renderScrambleDisplay() {
  const el = fsScrambleEl();
  if (!el) return;
  el.replaceChildren();
  // Walk the scramble in chunks of 4, wrapping each chunk in a .turn-group
  // span. Each move span carries one of .clock / .c-clock / .double so
  // the stylesheet can pad clockwise and half-turn moves; per-move
  // styling (greyed-out for past, blue+bold for current) is added on
  // top of the move-class as additional Tailwind classes.
  for (let i = 0; i < scrambleMoves.length; i += 4) {
    const group = document.createElement('span');
    group.className = 'turn-group';
    const chunk = scrambleMoves.slice(i, i + 4);
    chunk.forEach((m, j) => {
      const moveIdx = i + j;
      const cls = moveClass(m);
      let extra = '';
      if (moveIdx < scrambleProgress) extra = 'text-gray-400 line-through';
      else if (moveIdx === scrambleProgress) extra = 'font-bold text-blue-600 dark:text-blue-300';

      if (moveIdx === scrambleProgress && halfwayActive && isHalfTurn(m)) {
        // Render "~~U~~2": strikethrough only on the letter portion, keep
        // the trailing 2 normal.
        const wrapper = document.createElement('span');
        wrapper.className = `${cls} ${extra}`.trim();
        const letterSpan = document.createElement('span');
        letterSpan.textContent = m.slice(0, -1);
        letterSpan.className = 'line-through';
        wrapper.appendChild(letterSpan);
        const numSpan = document.createElement('span');
        numSpan.textContent = m.slice(-1);
        wrapper.appendChild(numSpan);
        group.appendChild(wrapper);
      } else {
        const span = document.createElement('span');
        span.className = `${cls} ${extra}`.trim();
        span.textContent = m;
        group.appendChild(span);
      }
    });
    el.appendChild(group);
    if (i + 4 < scrambleMoves.length) el.appendChild(document.createTextNode(' '));
  }
  if (deviationMoves.length > 0) {
    const corr = document.createElement('span');
    corr.className = 'text-red-500 font-bold ml-2';
    corr.textContent = '— undo: ';
    el.appendChild(corr);
    const movesSpan = document.createElement('span');
    movesSpan.className = 'text-red-500 font-bold';
    setFormattedMoves(movesSpan, collapseDoubles(invertMoves(deviationMoves)).join(' '));
    el.appendChild(movesSpan);
  }
}

// ---------- Solve UI rendering ----------

function renderTimer() {
  const el = fsTimerEl();
  if (!el) return;
  // Untimed practice: the timer never runs; show a placeholder so the
  // 2:00-ish spot in the layout doesn't suddenly empty out.
  if (prefs.inspection === 'none') {
    el.textContent = '—';
    return;
  }
  let ms = 0;
  if (mode === 'inspection') {
    if (prefs.inspection === 'pause') {
      ms = 0;
      el.textContent = 'Ready';
      return;
    }
    const limit = parseInt(prefs.inspection, 10) * 1000;
    const elapsed = Date.now() - inspectionStartMs;
    ms = Math.max(0, limit - elapsed);
    el.textContent = Math.ceil(ms / 1000).toString();
    return;
  }
  if (mode === 'solving') {
    ms = Date.now() - solveStartMs - pausedAccumMs;
  } else if (mode === 'paused') {
    ms = pauseStartedAtMs - solveStartMs - pausedAccumMs;
  } else if (mode === 'done') {
    ms = solveEndMs - solveStartMs - pausedAccumMs;
  }
  el.textContent = formatTime(ms);
}

function formatTime(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  if (total >= 60) {
    const m = Math.floor(total / 60);
    const s = total - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  }
  return total.toFixed(2);
}

function startTimerLoop() {
  cancelAnimationFrame(timerRafHandle);
  const tick = () => {
    renderTimer();
    if (mode === 'inspection' || mode === 'solving') {
      timerRafHandle = requestAnimationFrame(tick);
    }
  };
  timerRafHandle = requestAnimationFrame(tick);
}

function renderStatus(text: string) {
  // Suppress normal status text while updateCubeGate is showing the
  // "Connect a smart cube…" banner — otherwise scramble/solve flows
  // would overwrite the banner the moment they fire.
  if (prefs.enabled && !cubeConnected) return;
  const el = fsStatusEl();
  if (el) el.textContent = text;
}

function renderSolutionMoves() {
  const el = fsSolutionMovesEl();
  if (!el) return;
  if (mode === 'paused') {
    renderPausedSolveMoves(el);
    return;
  }
  setFormattedMoves(el, collapseDoubles(solveMoves).join(' '));
}

// During pause, render the snapshotted original-move list as individual
// (uncollapsed) interactive spans, with per-move phase coloring, plus
// any wayward off-plan moves in italics at the tail. The collapsing we
// normally do at storage time is skipped here so each click maps 1:1 to
// an original-move index.
function renderPausedSolveMoves(el: HTMLElement) {
  el.replaceChildren();
  const phaseColorForIdx = (i: number): string => {
    // The move at index i contributed to the smallest phase p whose
    // reached-at-index is strictly greater than i (the move that
    // COMPLETED a phase lands one index before that phase's marker).
    for (let p = 0; p < pauseOriginalPhaseReached.length; p++) {
      const reachedAt = pauseOriginalPhaseReached[p];
      if (reachedAt < 0) continue;
      if (reachedAt > i) return phaseSeq[p]?.color ?? '';
    }
    return '';
  };
  for (let i = 0; i < pauseState.originalMoves.length; i++) {
    const m = pauseState.originalMoves[i];
    const span = document.createElement('span');
    span.className = `${moveClass(m)} fs-paused-move`;
    span.textContent = m;
    const redundant = isRedundantIdx(pauseState, i);
    if (i > pauseState.frontier) {
      // Forward of the frontier (currently un-applied). Greyed and
      // non-interactive.
      span.classList.add('text-gray-400', 'dark:text-gray-500');
    } else if (redundant) {
      // Redundant move that's been applied (or skipped via state-jump).
      // Grey it out so the user sees it's a no-op cycle; still
      // clickable so they can target a moment inside the redundancy if
      // they want to.
      span.classList.add('text-gray-400', 'dark:text-gray-500', 'cursor-pointer');
      span.addEventListener('click', () => onPausedMoveClick(i));
      if (i === pauseState.targetIdx) {
        span.classList.add('ring-2', 'ring-offset-1', 'rounded');
      }
    } else {
      const color = phaseColorForIdx(i);
      if (color) span.style.color = color;
      if (pauseState.redoneSet.has(i)) {
        span.classList.add('underline');
      } else if (isPauseMoveClickable(pauseState, i)) {
        span.classList.add('cursor-pointer');
        span.addEventListener('click', () => onPausedMoveClick(i));
      }
      if (i === pauseState.targetIdx) {
        span.classList.add('ring-2', 'ring-offset-1', 'rounded');
      }
    }
    el.appendChild(span);
    if (i < pauseState.originalMoves.length - 1) {
      el.appendChild(document.createTextNode(' '));
    }
  }
  if (pauseState.wayward.length > 0) {
    el.appendChild(document.createTextNode(' | '));
    for (let j = 0; j < pauseState.wayward.length; j++) {
      const w = pauseState.wayward[j];
      const span = document.createElement('span');
      span.className = `${moveClass(w)} italic`;
      span.textContent = w;
      el.appendChild(span);
      if (j < pauseState.wayward.length - 1) {
        el.appendChild(document.createTextNode(' '));
      }
    }
  }
}

function onPausedMoveClick(idx: number) {
  if (mode !== 'paused') return;
  if (!isPauseMoveClickable(pauseState, idx)) return;
  pauseState = { ...pauseState, targetIdx: idx };
  renderSolutionMoves();
  renderRetraceHint();
}

function renderRetraceHint() {
  // During pause, show the user the move-by-move reverse path to whichever
  // original-move-index they clicked. The head of the list is the next
  // move they should make; completed moves drop off the front.
  const el = fsRetraceHintEl();
  if (!el) return;
  if (mode !== 'paused') { el.replaceChildren(); return; }
  const path = computePauseReversePath(pauseState);
  setFormattedMoves(el, collapseDoubles(path).join(' '));
}

let phaseReachedAtMoveIdx: number[] = [];

// ---------- Scramble flow ----------

async function newScramble() {
  resetSolveState();
  renderStatus('Generating scramble…');
  if (!kpuzzle) {
    renderStatus('Loading cube engine, try again in a moment.');
    return;
  }
  const start = lastPattern ?? kpuzzle.defaultPattern();
  // Start our internal pattern in sync with the tracker's pattern.
  myPattern = start;
  if (pendingScramble) {
    currentScramble = pendingScramble;
    pendingScramble = null;
  } else {
    currentScramble = generateRandomScramble3x3();
  }
  // Broadcast to the peer if we're the active scramble-sharer. Suppress
  // when applying a scramble received from the peer (otherwise the two
  // peers would ping-pong indefinitely).
  if (sharingScrambles && !applyingRemoteScramble && onLocalScrambleChange) {
    onLocalScrambleChange(currentScramble);
  }
  const pre = precomputeScramblePatterns(currentScramble, start);
  scrambleMoves = pre.moves;
  scramblePatternStack = pre.patterns;
  scrambleHalfwayStates = pre.halfwayStates;
  scrambleProgress = 0;
  halfwayActive = false;
  deviationMoves = [];
  scrambleTargetFacelets = scramblePatternStack[scramblePatternStack.length - 1] || null;
  mode = 'scrambling';
  // Abort stays disabled in scrambling mode — there's no run to abort
  // yet. It re-enables on the scramble→inspection transition.
  const abortBtn = fsAbortBtnEl();
  if (abortBtn) abortBtn.disabled = true;
  renderScrambleDisplay();
  const startFacelets = patternToFacelets(start);
  if (!isSolved(startFacelets)) {
    renderStatus('Cube is not solved — scramble starts from current state. For a fair scramble, solve your cube first.');
  } else {
    renderStatus('Scramble your cube to match.');
  }
}

function resetSolveState() {
  mode = 'idle';
  cancelAnimationFrame(timerRafHandle);
  if (inspectionTimeoutHandle !== null) {
    clearTimeout(inspectionTimeoutHandle);
    inspectionTimeoutHandle = null;
  }
  pausedAccumMs = 0;
  pauseStartedAtMs = 0;
  solveStartMs = 0;
  solveEndMs = 0;
  inspectionStartMs = 0;
  inspectionAutoExpiredFlag = false;
  solveMoves = [];
  solveTurns = [];
  solveF2lSplits = [];
  f2lSlotsEverDone = 0;
  solveRouxPairTimingsMs = [];
  solveRouxPairSlotIdxs = [];
  solveRouxPairSlotsDoneMask = 0;
  solveRouxBlock1FirstPairMs = null;
  solveRouxBlock2FirstPairMs = null;
  halfwayActive = false;
  detectedCrossFace = null;
  detectedDownFace = null;
  detectedRouxSide1 = null;
  phaseSeq = currentPhaseSequence();
  phaseTimestamps = phaseSeq.map(() => null);
  phaseReachedAtMoveIdx = phaseSeq.map(() => -1);
  pauseState = {
    originalMoves: [], originalStates: [], redundantBlocks: [],
    frontier: -1, wayward: [], redoneSet: new Set<number>(),
    targetIdx: null,
  };
  pauseOriginalTurns = [];
  pauseOriginalPhaseReached = [];
  const pauseBtn = fsPauseBtnEl();
  if (pauseBtn) { pauseBtn.disabled = true; pauseBtn.textContent = 'Pause'; }
  const abortBtn = fsAbortBtnEl();
  if (abortBtn) abortBtn.disabled = true;
  renderTimer();
  renderSolutionMoves();
  renderRetraceHint();
}

function abortSolve() {
  // Stop the timer and discard the recording, but KEEP the same
  // scramble loaded. The user can either reset their cube and retry
  // the scramble, or solve the cube and re-scramble normally — the
  // existing scramble-progress matching handles both cases purely
  // from facelets.
  if (mode === 'idle' || mode === 'scrambling' || mode === 'done') return;

  cancelAnimationFrame(timerRafHandle);
  if (inspectionTimeoutHandle !== null) {
    clearTimeout(inspectionTimeoutHandle);
    inspectionTimeoutHandle = null;
  }
  pausedAccumMs = 0;
  pauseStartedAtMs = 0;
  solveStartMs = 0;
  solveEndMs = 0;
  inspectionStartMs = 0;
  inspectionAutoExpiredFlag = false;
  solveMoves = [];
  solveTurns = [];
  solveF2lSplits = [];
  f2lSlotsEverDone = 0;
  solveRouxPairTimingsMs = [];
  solveRouxPairSlotIdxs = [];
  solveRouxPairSlotsDoneMask = 0;
  solveRouxBlock1FirstPairMs = null;
  solveRouxBlock2FirstPairMs = null;
  detectedCrossFace = null;
  detectedDownFace = null;
  detectedRouxSide1 = null;
  phaseTimestamps = phaseSeq.map(() => null);
  phaseReachedAtMoveIdx = phaseSeq.map(() => -1);
  pauseState = {
    originalMoves: [], originalStates: [], redundantBlocks: [],
    frontier: -1, wayward: [], redoneSet: new Set<number>(),
    targetIdx: null,
  };
  pauseOriginalTurns = [];
  pauseOriginalPhaseReached = [];

  mode = 'scrambling';
  scrambleProgress = 0;
  halfwayActive = false;
  deviationMoves = [];

  // Sync scramble progress from the cube's actual facelets. Solved →
  // progress 0. At scramble target → onScrambleComplete fires →
  // mode='inspection' (rare, but harmless). Mid-solve → no stack
  // match, progress stays 0 and deviation accumulates as user moves.
  if (myPattern) {
    try {
      resolveScrambleProgressFromPattern(patternToFacelets(myPattern));
    } catch { /* ignore */ }
  }

  const pauseBtn = fsPauseBtnEl();
  if (pauseBtn) { pauseBtn.disabled = true; pauseBtn.textContent = 'Pause'; }
  const abortBtn = fsAbortBtnEl();
  if (abortBtn) abortBtn.disabled = true;  // no run to abort while scrambling

  renderTimer();
  renderSolutionMoves();
  renderRetraceHint();
  renderStatus('Solve aborted — same scramble. Reset the cube to the scrambled state to retry.');
}

function onScrambleMove(move: string) {
  // Append to deviation tentatively, then collapse adjacent cancellations
  // (R R' → empty, R R → R2, etc.) so the hint stays as short as the user's
  // *net* deviation from the path, not the raw move history.
  deviationMoves.push(move);
  deviationMoves = simplifyMoves(deviationMoves);
}

function simplifyMoves(moves: string[]): string[] {
  if (moves.length === 0) return [];
  try {
    const simplified = Alg.fromString(moves.join(' '))
      .experimentalSimplify({ cancel: true, puzzleLoader: cube3x3x3 })
      .toString()
      .trim();
    return simplified ? simplified.split(/\s+/).filter(Boolean) : [];
  } catch { return moves; }
}

function resolveScrambleProgressFromPattern(facelets: string) {
  // Stack match (any step, forward or backward).
  for (let i = scramblePatternStack.length - 1; i >= 0; i--) {
    if (scramblePatternStack[i] === facelets) {
      scrambleProgress = i;
      halfwayActive = false;
      deviationMoves = [];
      if (scrambleProgress === scrambleMoves.length && scrambleTargetFacelets === facelets) {
        onScrambleComplete();
      }
      renderScrambleDisplay();
      return;
    }
  }
  // Halfway match: if the next expected scramble move is a double turn and
  // the user has applied one quarter-turn of that face (either direction),
  // mark halfway done. We DON'T treat the quarter-turn as a correction; the
  // display strikes through the letter of the X2 instead.
  const halfs = scrambleHalfwayStates[scrambleProgress];
  if (halfs && halfs.includes(facelets)) {
    halfwayActive = true;
    deviationMoves = [];
    renderScrambleDisplay();
    return;
  }
  // No match: deviation persists. (deviationMoves is managed in onScrambleMove.)
  halfwayActive = false;
  renderScrambleDisplay();
}

// ---------- Inspection / solve flow ----------

function onScrambleComplete() {
  if (mode !== 'scrambling') return;
  mode = 'inspection';
  inspectionStartMs = Date.now();
  deviationMoves = [];
  const abortBtn = fsAbortBtnEl();
  if (abortBtn) abortBtn.disabled = false;
  if (prefs.inspection === 'pause') {
    renderStatus('Inspection (untimed). Make any turn to start solve timer.');
  } else if (prefs.inspection === 'none') {
    renderStatus('No-timer practice. Solve at your own pace — not recorded.');
  } else {
    const limitMs = parseInt(prefs.inspection, 10) * 1000;
    renderStatus(`Inspection: ${prefs.inspection}s`);
    inspectionTimeoutHandle = window.setTimeout(() => {
      if (mode === 'inspection') {
        // Mark the transition as an auto-expire so the CSV export knows
        // to emit a `start` row. The flag persists on the SolveRecord
        // via finishSolve.
        inspectionAutoExpiredFlag = true;
        startSolving();
      }
    }, limitMs);
  }
  startTimerLoop();
}

function startSolving() {
  mode = 'solving';
  solveStartMs = Date.now();
  pausedAccumMs = 0;
  const untimed = prefs.inspection === 'none';
  renderStatus(untimed
    ? `Solving (untimed) — phase: ${phaseSeq[0]?.label ?? '?'}`
    : `Solving — phase: ${phaseSeq[0]?.label ?? '?'}`);
  const pauseBtn = fsPauseBtnEl();
  if (pauseBtn) pauseBtn.disabled = untimed;  // pause is meaningless w/o a timer
  const abortBtn = fsAbortBtnEl();
  if (abortBtn) abortBtn.disabled = false;
  if (!untimed) startTimerLoop();
}

function onSolveMove(move: string) {
  if (mode === 'paused') {
    // While paused, the cube has already been turned (fsOnPhysicalMove
    // applies the move to myPattern regardless of mode). Feed the
    // resulting facelets through the state-based classifier so the UI
    // tracks rewind / redo / wayward exploration; the new solveMoves
    // are reconciled on resume.
    let facelets = '';
    if (myPattern) {
      try { facelets = patternToFacelets(myPattern); } catch { /* ignore */ }
    }
    pauseState = classifyPauseMove(pauseState, move, facelets).next;
    renderSolutionMoves();
    renderRetraceHint();
    return;
  }
  solveMoves.push(move);
  solveTurns.push((Date.now() - solveStartMs - pausedAccumMs) / 1000);
  renderSolutionMoves();
}

// Sample the F2L slot-count progression. Each strict increase in slot
// count pushes one entry to solveF2lSplits (ms since solveStart). Bounded
// to 4 entries (the 4 F2L slots). Skipped for beginner mode (no F2L
// phase) and before cross has been detected.
function sampleF2lSlotProgression(facelets: string, now: number) {
  // Slot-progression sampling is CFOP-specific. Beginner has no F2L
  // phase; Roux/F3uL replace F2L with 2 explicit block phases (F1B,
  // F2B) whose timings the user gets directly, so sub-slot splits add
  // no information.
  if (prefs.process === 'beginner') return;
  if (prefs.process === 'roux' || prefs.process === 'f3ul') return;
  if (!detectedCrossFace) return;
  if (f2lSlotsEverDone >= 4) return;
  const crossIdx = phaseSeq.findIndex(p => p.key === 'cross');
  if (crossIdx < 0 || phaseTimestamps[crossIdx] === null) return;
  const slots = f2lSlotsDoneOn(detectedCrossFace, facelets);
  while (slots > f2lSlotsEverDone) {
    f2lSlotsEverDone++;
    solveF2lSplits.push(now - solveStartMs);
  }
}

// Roux/F3uL analog. Tracks per-PAIR completion (not just count) so we
// can attribute each pair to block 1 vs block 2 once the corresponding
// block-done predicate fires. Uses F2L_SLOTS[D] directly to identify
// which specific slot just completed.
//
// CRITICAL: this runs BEFORE detectedDownFace is set by isFirstBlockDone
// (the block-done predicate fires only when BOTH pairs + the cross
// edge are in place). To capture pair-1 and pair-2 timings as they
// happen — not at the moment block-1 completes — we color-neutrally
// scan all 6 candidate down-faces × 4 slots until we find a done
// slot, then lock detectedDownFace for the rest of the solve.
function sampleRouxPairProgression(facelets: string, now: number) {
  if (prefs.process !== 'roux' && prefs.process !== 'f3ul') return;
  if (solveRouxPairTimingsMs.length >= 4) return;
  const msFromStart = now - solveStartMs;

  // First-pair-anywhere detection: lock detectedDownFace as soon as
  // ANY slot is done against ANY candidate down-face. Subsequent moves
  // dispatch against the locked face only.
  if (!detectedDownFace) {
    outer: for (const candidate of FACES) {
      const slots = F2L_SLOTS[candidate];
      for (let i = 0; i < slots.length; i++) {
        let allMatch = true;
        for (const [sideFace, idx] of slots[i]) {
          const s = faceStickers(facelets, sideFace);
          if (s[idx] !== s[4]) { allMatch = false; break; }
        }
        if (allMatch) { detectedDownFace = candidate; break outer; }
      }
    }
    if (!detectedDownFace) return;  // no pair yet
  }

  const slots = F2L_SLOTS[detectedDownFace];
  for (let i = 0; i < slots.length; i++) {
    if (solveRouxPairSlotsDoneMask & (1 << i)) continue;
    let allMatch = true;
    for (const [sideFace, idx] of slots[i]) {
      const s = faceStickers(facelets, sideFace);
      if (s[idx] !== s[4]) { allMatch = false; break; }
    }
    if (allMatch) {
      solveRouxPairSlotsDoneMask |= (1 << i);
      solveRouxPairTimingsMs.push(msFromStart);
      solveRouxPairSlotIdxs.push(i);
    }
  }
}

// When isFirstBlockDone fires, two of the four pair slots will sit on
// detectedRouxSide1 (= the 1st-block side). Capture the earlier of
// their two recorded timings as the "1st pair of 1st block" anchor.
function captureRouxBlockFirstPair(whichBlock: 1 | 2) {
  if (!detectedDownFace || !detectedRouxSide1) return;
  // Determine the side face (the actual Face) for this block.
  const blockSide: Face = whichBlock === 1
    ? detectedRouxSide1
    : OPPOSITE[detectedRouxSide1];
  // Map slot index → its side face. The F2L_SLOTS[D] rows always
  // include 2 stickers from each adjacent side face for each slot;
  // the slot's "side face" is whichever of those isn't D's opposite
  // and matches blockSide. Look at slot stickers and pick.
  const earliestForBlock = (() => {
    let earliest: number | null = null;
    for (let i = 0; i < solveRouxPairSlotIdxs.length; i++) {
      const slotIdx = solveRouxPairSlotIdxs[i];
      // A slot belongs to `blockSide` if `blockSide` appears in its
      // sticker tuple. Equivalent to checking whether blockSide is
      // one of the two perpendicular faces this slot touches.
      const slotFaces = new Set(F2L_SLOTS[detectedDownFace!][slotIdx].map(([f]) => f));
      if (slotFaces.has(blockSide)) {
        if (earliest === null || solveRouxPairTimingsMs[i] < earliest) {
          earliest = solveRouxPairTimingsMs[i];
        }
      }
    }
    return earliest;
  })();
  if (earliestForBlock === null) return;
  if (whichBlock === 1 && solveRouxBlock1FirstPairMs === null) {
    solveRouxBlock1FirstPairMs = earliestForBlock;
  }
  if (whichBlock === 2 && solveRouxBlock2FirstPairMs === null) {
    solveRouxBlock2FirstPairMs = earliestForBlock;
  }
}

function evaluatePhaseTransitions(facelets: string) {
  if (mode !== 'solving') return;
  const now = Date.now() - pausedAccumMs;
  // Always sample pair progression FIRST so the block-first-pair
  // anchors captured below can see the pair-completion timings (a
  // block-done predicate often fires on the same move that completes
  // its 2nd pair, which we need recorded already).
  sampleRouxPairProgression(facelets, now);
  const fired: string[] = [];
  for (let i = 0; i < phaseSeq.length; i++) {
    if (phaseTimestamps[i] !== null) continue;
    if (i > 0 && phaseTimestamps[i - 1] === null) continue;
    if (phaseSeq[i].predicate(facelets)) {
      phaseTimestamps[i] = now;
      phaseReachedAtMoveIdx[i] = solveMoves.length;
      fired.push(phaseSeq[i].label);
      renderStatus(`Phase reached: ${phaseSeq[i].label}`);
      // Roux/F3uL: when a block-done predicate fires, attribute its
      // 2 constituent pairs and remember the earlier of them as the
      // block's "first pair" anchor (drives scheme-1 shades).
      if (phaseSeq[i].key === 'f1b') captureRouxBlockFirstPair(1);
      if (phaseSeq[i].key === 'f2b') captureRouxBlockFirstPair(2);
      const nextPhase = phaseSeq[i + 1];
      if (!nextPhase) {
        // Sample slot progression once more before finishing, so a same-
        // move cross-done + F2L-done + final-phase-done sequence doesn't
        // skip recording any intermediate slot increments.
        sampleF2lSlotProgression(facelets, now);
        if (fired.length > 0) console.log('[fs-phase] fired:', fired.join(','), 'crossFace=', detectedCrossFace);
        finishSolve();
        return;
      }
    }
  }
  // Catches the common case: between cross-done and F2L-done, every move
  // arrives here without firing any phase transition; we want to record
  // slot-count increments anyway.
  sampleF2lSlotProgression(facelets, now);
  if (fired.length > 0) console.log('[fs-phase] fired:', fired.join(','), 'crossFace=', detectedCrossFace);
}

function finishSolve() {
  if (mode !== 'solving') return;
  mode = 'done';
  solveEndMs = Date.now();
  cancelAnimationFrame(timerRafHandle);
  renderTimer();
  const pauseBtn = fsPauseBtnEl();
  if (pauseBtn) pauseBtn.disabled = true;
  // 'none' inspection = untimed practice. The solve doesn't get recorded
  // and the stats boxes / graph don't change.
  if (prefs.inspection === 'none') {
    renderStatus('Solved! (untimed — not recorded)');
    return;
  }
  renderStatus('Solved!');
  // Record solve
  const totalMs = solveEndMs - solveStartMs - pausedAccumMs;
  const phases: Record<string, number> = {};
  let prev = 0;
  for (let i = 0; i < phaseSeq.length; i++) {
    const ts = phaseTimestamps[i];
    if (ts === null) continue;
    const phaseMs = ts - (solveStartMs + prev);
    phases[phaseSeq[i].key] = Math.max(0, phaseMs);
    prev = ts - solveStartMs;
  }
  const record: SolveRecord = {
    ts: Date.now(),
    scramble: currentScramble,
    // Pair-collapse identical-quarter-turn pairs at save time so storage
    // reads "U2" instead of "U U" when the solver did a half-turn as two
    // physical events. The display layer can still re-derive a richer
    // "expanded" view that calls out longer same-face redundancies.
    solution: collapseDoubles(solveMoves).join(' '),
    totalMs,
    phases,
    process: prefs.process,
    twoLookOll: prefs.twoLookOll,
    twoLookPll: prefs.twoLookPll,
    // Roux-specific toggles — only stored on Roux records to keep
    // CFOP/F3uL/Beginner record shape unchanged.
    ...(prefs.process === 'roux' ? { twoLookCmll: prefs.twoLookCmll } : {}),
    ...(prefs.process === 'roux' ? { threeLookLse: prefs.threeLookLse } : {}),
    // Roux/F3uL granular pair timings (drives the block-stage shade
    // schemes). Only attached when we actually captured at least one
    // pair completion.
    ...((prefs.process === 'roux' || prefs.process === 'f3ul') && solveRouxPairTimingsMs.length > 0
        ? { rouxPairTimingsMs: solveRouxPairTimingsMs.slice() }
        : {}),
    ...(solveRouxBlock1FirstPairMs !== null
        ? { rouxBlock1FirstPairMs: solveRouxBlock1FirstPairMs }
        : {}),
    ...(solveRouxBlock2FirstPairMs !== null
        ? { rouxBlock2FirstPairMs: solveRouxBlock2FirstPairMs }
        : {}),
    turns: solveTurns.slice(),
    // Only attach when we actually recorded splits — keeps records small
    // for runs that didn't hit the F2L phase (e.g. beginner mode).
    ...(solveF2lSplits.length > 0 ? { f2lSplits: solveF2lSplits.slice() } : {}),
    // Inspection metadata for CSV export. inspectionMs is the wall-clock
    // duration from "scramble done" to "solve start"; the auto-expired
    // flag is set only when the countdown ran out (not when the user
    // started early by making a move during inspection).
    ...(inspectionStartMs > 0 && solveStartMs > inspectionStartMs
        ? { inspectionMs: solveStartMs - inspectionStartMs }
        : {}),
    ...(inspectionAutoExpiredFlag ? { inspectionAutoExpired: true } : {}),
    // Apply any pre-selected tags from the scramble row's tag editor.
    // Sticky: prefs.pendingSolveTags persists across solves until the
    // user clears them via the dialog.
    ...(prefs.pendingSolveTags.length > 0
        ? { tags: prefs.pendingSolveTags.slice() }
        : {}),
  };
  history.push(record);
  saveHistory();
  renderGraph();
  renderStatsBoxes();
  renderStatsLegend();
  renderSolveList();
}

// ---------- Pause / resume ----------

function togglePause() {
  if (mode === 'solving') {
    mode = 'paused';
    pauseStartedAtMs = Date.now();
    cancelAnimationFrame(timerRafHandle);
    // Snapshot the solve. The state list is computed by REWINDING the
    // current pattern through inverse moves, which is exact and avoids
    // having to track every intermediate state during the live solve.
    const states = computeOriginalStates(solveMoves);
    pauseState = {
      originalMoves: solveMoves.slice(),
      originalStates: states,
      redundantBlocks: computeRedundantBlocks(states),
      frontier: solveMoves.length - 1,
      wayward: [],
      redoneSet: new Set<number>(),
      targetIdx: null,
    };
    pauseOriginalTurns = solveTurns.slice();
    pauseOriginalPhaseReached = phaseReachedAtMoveIdx.slice();
    renderTimer();
    renderSolutionMoves();
    renderRetraceHint();
    const pauseBtn = fsPauseBtnEl();
    if (pauseBtn) pauseBtn.textContent = 'Resume';
    renderStatus('Paused — click any move to plan a rewind.');
  } else if (mode === 'paused') {
    pausedAccumMs += Date.now() - pauseStartedAtMs;
    pauseStartedAtMs = 0;
    mode = 'solving';
    reconcileSolveAfterPause();
    // Drop the snapshot now that we've rebuilt the live state.
    pauseState = {
      originalMoves: [], originalStates: [], redundantBlocks: [],
      frontier: -1, wayward: [], redoneSet: new Set<number>(),
      targetIdx: null,
    };
    pauseOriginalTurns = [];
    pauseOriginalPhaseReached = [];
    renderSolutionMoves();
    renderRetraceHint();
    startTimerLoop();
    const pauseBtn = fsPauseBtnEl();
    if (pauseBtn) pauseBtn.textContent = 'Pause';
    renderStatus('Solving…');
    // Edge case: if the user happened to solve the cube during pause
    // (or reversed and re-solved differently), reconcile sets the final
    // phase timestamp directly. finishSolve normally runs from inside
    // evaluatePhaseTransitions; the post-resume move would skip the
    // already-set predicate, so trigger it here.
    if (phaseTimestamps.length > 0 && phaseTimestamps[phaseTimestamps.length - 1] !== null) {
      finishSolve();
    }
  }
}

// On resume, rebuild the canonical solve state to match the cube's
// actual position: keep the original moves up to the current frontier,
// append any wayward off-plan moves, and re-evaluate phase predicates
// against the current facelets. Phases the user reversed past clear
// out; phases still satisfied are re-timestamped at "now" (approximate
// wall-clock, but keeps downstream counters internally consistent).
function reconcileSolveAfterPause() {
  const frontier = pauseState.frontier;
  const keptMoves = pauseState.originalMoves.slice(0, frontier + 1);
  const keptTurns = pauseOriginalTurns.slice(0, frontier + 1);
  const nowSec = (Date.now() - solveStartMs - pausedAccumMs) / 1000;
  solveMoves = keptMoves.concat(pauseState.wayward);
  solveTurns = keptTurns.concat(pauseState.wayward.map(() => nowSec));

  // Re-evaluate phase predicates against the actual current cube.
  phaseTimestamps = phaseSeq.map(() => null);
  phaseReachedAtMoveIdx = phaseSeq.map(() => -1);
  if (myPattern) {
    let facelets: string;
    try { facelets = patternToFacelets(myPattern); } catch { return; }
    const now = Date.now() - pausedAccumMs;
    for (let i = 0; i < phaseSeq.length; i++) {
      if (i > 0 && phaseTimestamps[i - 1] === null) break;
      if (phaseSeq[i].predicate(facelets)) {
        phaseTimestamps[i] = now;
        phaseReachedAtMoveIdx[i] = solveMoves.length;
      } else {
        break;
      }
    }
  }
}

// Build the originalStates list by rewinding `myPattern` through each
// inverse move. Returns an array of `moves.length + 1` facelet strings:
// states[0] = state at solve start; states[i] = state after moves[i-1].
// Falls back to all-empty-strings if myPattern is null or any rewind
// throws — the resulting pause UI degrades to wayward-only matching.
function computeOriginalStates(moves: string[]): string[] {
  if (!myPattern) return moves.map(() => '').concat(['']);
  const states: string[] = new Array(moves.length + 1);
  try {
    let pat = myPattern;
    states[moves.length] = patternToFacelets(pat);
    for (let i = moves.length - 1; i >= 0; i--) {
      pat = pat.applyMove(invertMoveTok(moves[i]));
      states[i] = patternToFacelets(pat);
    }
    return states;
  } catch {
    return moves.map(() => '').concat(['']);
  }
}

function invertMoveTok(m: string): string {
  if (m.endsWith("'")) return m.slice(0, -1);
  if (m.endsWith('2')) return m;
  return m + "'";
}

// ---------- Graph ----------

// Diagonal-stripe pattern used by the missing-data overlay band. The
// stripes read as "no data here" in standard data-visualisation idiom
// (vs. a solid fill, which would be misread as a phase band).
function makeStripePattern(isDark: boolean): CanvasPattern | null {
  const size = 8;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  // Wrap the diagonal across 3 segments so the pattern tiles seamlessly.
  ctx.moveTo(-2, 2);  ctx.lineTo(2, -2);
  ctx.moveTo(-2, 10); ctx.lineTo(10, -2);
  ctx.moveTo(6, 10);  ctx.lineTo(10, 6);
  ctx.stroke();
  return ctx.createPattern(c, 'repeat');
}

function renderGraph() {
  const canvas = fsGraphCanvasEl();
  if (!canvas) return;
  // Active tag filter applied to history BEFORE everything else, so
  // graph + AoX trendlines all reflect the same view.
  const filtered = filteredHistory();
  const range = Math.max(1, Math.min(filtered.length, prefs.graphRange));
  const slice = filtered.slice(-range);
  if (slice.length === 0) {
    if (graphChart) { graphChart.destroy(); graphChart = null; }
    return;
  }
  // The graph builds its key order from the UNION of phase keys present
  // in the filtered slice, in canonical solve-progression order. This
  // lets CFOP, F3uL, Roux, and Beginner solves all stack correctly in
  // the same chart — each solve contributes only to the keys in its
  // own displayPhaseSequenceFor list (see the per-record gate in the
  // cumulative loop below), so totals stay accurate per solve.
  //
  // When the "F2L slots" toggle is on, expand the F2L key into 4 sub-
  // band keys (f2l_1..f2l_4) so each renders as a separately-coloured
  // stacked band. phaseMsForDisplay handles the per-record split using
  // r.f2lSplits; non-CFOP records have no f2l data so render as 0.
  let keyOrder = unifiedKeyOrder(slice);
  if (prefs.f2lSplits) {
    const fIdx = keyOrder.indexOf('f2l');
    if (fIdx >= 0) {
      keyOrder = [
        ...keyOrder.slice(0, fIdx),
        'f2l_1', 'f2l_2', 'f2l_3', 'f2l_4',
        ...keyOrder.slice(fIdx + 1),
      ];
    }
  }
  // Precompute each solve's allowed key set so the cumulative loop can
  // gate contributions without recomputing per (solve, key) pair.
  const sliceKeySets: Array<Set<string>> = slice.map(r => new Set(displayPhaseSequenceFor(r)));
  // Phase-focus: when set, the graph hides every band outside the focused
  // group (F2L or LL) and re-baselines the remaining bands from zero, so
  // the user can inspect just that phase's variation without the rest of
  // the stack visually compressing it.
  if (focusedPhaseGroup) {
    keyOrder = keyOrder.filter(k => groupOfKey(k) === focusedPhaseGroup);
    if (keyOrder.length === 0) {
      // Focus group has no representative keys for this configuration —
      // bail back to the unfocused view.
      focusedPhaseGroup = null;
      keyOrder = unifiedKeyOrder(slice);
    } else {
      // Insert an "idle:<phase>" key BEFORE each phase key. The idle
      // dataset gets the same `tension: 0.15` smoothing as the bands, so
      // the shaded region's bottom and top curves match the band edges
      // automatically — no need to replicate Chart.js's cardinal-spline
      // math in our own polygon plugin.
      const expanded: string[] = [];
      for (const k of keyOrder) {
        expanded.push('idle:' + k);
        expanded.push(k);
      }
      keyOrder = expanded;
    }
  }
  const labels = slice.map((_, i) => `${filtered.length - slice.length + i + 1}`);

  // Alpha-scaled green for F2L sub-bands. Legacy records (no f2lSplits)
  // are folded into sub-band 4 by phaseMsForDisplay, so they render at
  // the topmost (darkest) saturation.
  const F2L_SUB_ALPHAS = [0.3, 0.45, 0.6, 0.75];
  const colorForKey = (k: string): string => {
    if (k.startsWith('f2l_')) {
      const n = parseInt(k.slice(4), 10);
      const a = F2L_SUB_ALPHAS[n - 1] ?? 0.6;
      // Replace whatever alpha sits on PHASE_COLORS[1] with the sub-band's.
      // (PHASE_COLORS[1] itself uses 0.75 to match the topmost sub-band.)
      return PHASE_COLORS[1].replace(/,\s*[\d.]+\)\s*$/, `, ${a})`);
    }
    // Cross-process color lookup via the global key→color map (covers
    // every process's keys, not just the current one).
    return PHASE_COLOR_BY_KEY[k] ?? PHASE_COLORS[0];
  };
  const labelForKey = (k: string): string => {
    if (k.startsWith('f2l_')) {
      // When the user has focused on F2L, the 4 sub-bands get individual
      // "1P/2P/3P/4P" chit labels (one per pair slot reached). Otherwise
      // the inline-label pass collapses them into a single "F2L" chit at
      // the topmost sub-band — so the dataset label stays "F2L".
      if (focusedPhaseGroup === 'f2l') {
        const n = parseInt(k.slice(4), 10);
        return `${n}P`;
      }
      return 'F2L';
    }
    return PHASE_KEY_LABELS[k] ?? k;
  };

  // For a stacked-area chart without activating Chart.js's scale-level stacking
  // (which would also stack the Ao5/Ao12 trendlines), compute cumulative values
  // per solve and let each dataset fill down to the previous one. For an
  // "idle:<phase>" key, the segment height is the phase's initial idle ms;
  // for the underlying phase key it's (total phase ms − idle ms) so the
  // two together sum to the full phase duration.
  const cumulative: number[][] = slice.map(() => []);
  slice.forEach((r, solveIdx) => {
    let acc = 0;
    const allowed = sliceKeySets[solveIdx];
    // For F2L sub-bands, the record's allowed-key check is on 'f2l'.
    const allowsKey = (k: string) => {
      if (k.startsWith('idle:')) k = k.slice(5);
      if (k.startsWith('f2l_'))  return allowed.has('f2l');
      return allowed.has(k);
    };
    for (const k of keyOrder) {
      let segmentMs = 0;
      // Per-record gate: a record only contributes to keys in its own
      // displayPhaseSequenceFor list (plus the f2l_* sub-bands when its
      // own seq has 'f2l'). Without this gate, a Roux record whose
      // seq is {f1b, f2b, cmll, lse} would still contribute its stored
      // `ocll` value to the 'ocll' band in keyOrder (added by a CFOP
      // record's seq) — and the same time would also flow into 'cmll'
      // via aggregation, double-counting.
      if (!allowsKey(k)) {
        // Keep cumulative in lock-step with keyOrder by pushing the
        // unchanged accumulator. Zero contribution still produces a
        // dataset cell at this stack position.
        cumulative[solveIdx].push(acc);
        continue;
      }
      if (k.startsWith('idle:')) {
        const phaseKey = k.slice(5);
        const totalMs = phaseMsForDisplay(r, phaseKey);
        segmentMs = totalMs > 0 ? Math.min(phaseIdleMsFor(r, phaseKey), totalMs) : 0;
      } else if (focusedPhaseGroup) {
        const totalMs = phaseMsForDisplay(r, k);
        const idleMs  = totalMs > 0 ? Math.min(phaseIdleMsFor(r, k), totalMs) : 0;
        segmentMs = totalMs - idleMs;
      } else {
        segmentMs = phaseMsForDisplay(r, k);
      }
      acc += segmentMs / 1000;
      cumulative[solveIdx].push(acc);
    }
  });

  // Idle-stripe color for a focused phase band. Reproduces the look of
  // the original polygon-plugin shading (a 20% white-overlay in dark
  // mode, 20% black-overlay in light mode) as a *solid fill* so the
  // dataset approach can match it. Algebra: a band at alpha A draws as
  //   visible = A·phase + (1−A)·bg
  // and the overlay makes it
  //   visible' = 0.20·overlay + 0.80·visible
  //            = 0.20·overlay + 0.80·A·phase + 0.80·(1−A)·bg
  // A solid fill X at alpha A_idle reproduces this iff
  //   A_idle    = 0.20 + 0.80·A
  //   A_idle·X  = 0.20·overlay + 0.80·A·phase
  // (so the result is independent of the actual background color).
  const isDarkForIdle = document.documentElement.classList.contains('dark');
  const OVERLAY_RGB = isDarkForIdle ? 255 : 0;
  const OVERLAY_ALPHA = 0.20;
  const idleColorForPhase = (rgba: string): string => {
    const m = rgba.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/);
    if (!m) return rgba;
    const r = Number(m[1]);
    const g = Number(m[2]);
    const b = Number(m[3]);
    const a = Number(m[4]);
    const aIdle = OVERLAY_ALPHA + (1 - OVERLAY_ALPHA) * a;
    const xR = (OVERLAY_ALPHA * OVERLAY_RGB + (1 - OVERLAY_ALPHA) * a * r) / aIdle;
    const xG = (OVERLAY_ALPHA * OVERLAY_RGB + (1 - OVERLAY_ALPHA) * a * g) / aIdle;
    const xB = (OVERLAY_ALPHA * OVERLAY_RGB + (1 - OVERLAY_ALPHA) * a * b) / aIdle;
    return `rgba(${Math.round(xR)}, ${Math.round(xG)}, ${Math.round(xB)}, ${aIdle.toFixed(3)})`;
  };

  const datasets: any[] = keyOrder.map((k, kIdx) => {
    if (k.startsWith('idle:')) {
      // Phantom dataset that draws the idle stripe at the bottom of each
      // focused phase band. Same tension as the bands so the curves match
      // exactly; color is a darker shade of the phase's own color so the
      // stripe is read as part of that phase (not a foreign grey overlay).
      const phaseKey = k.slice(5);
      return {
        type: 'line' as const,
        label: '',
        data: cumulative.map(row => row[kIdx]),
        backgroundColor: idleColorForPhase(colorForKey(phaseKey)),
        borderColor: 'transparent',
        borderWidth: 0,
        fill: kIdx === 0 ? 'origin' : '-1',
        pointRadius: 0,
        pointHoverRadius: 0,
        tension: 0.15,
        order: 2,
        clip: false,
      };
    }
    const fill = colorForKey(k);
    const stroke = fill.replace(/(0\.\d+)\)/, '1)');
    return {
      type: 'line' as const,
      label: labelForKey(k),
      data: cumulative.map(row => row[kIdx]),
      backgroundColor: fill,
      borderColor: stroke,
      borderWidth: 1,
      fill: kIdx === 0 ? 'origin' : '-1',
      pointRadius: 2,
      pointHoverRadius: 4,
      pointBackgroundColor: stroke,
      tension: 0.15,
      order: 2,
      // Allow point circles at data[0] and data[n-1] to render fully even
      // though their centers sit at the chart-area edges.
      clip: false,
    };
  });

  // When focused, "totals" become the sum of just the focused-group phase
  // ms, so the Y-axis cap (1σ/2σ) and AoX trendlines scale to the focused
  // bands instead of the whole solve.
  const recordTotalSec = (r: SolveRecord): number => {
    if (!focusedPhaseGroup) return r.totalMs / 1000;
    const allowed = new Set(displayPhaseSequenceFor(r));
    let sum = 0;
    for (const k of keyOrder) {
      const baseKey = k.startsWith('f2l_') ? 'f2l' : k;
      if (!allowed.has(baseKey)) continue;
      sum += phaseMsForDisplay(r, k);
    }
    return sum / 1000;
  };
  const totals = slice.map(recordTotalSec);

  // Missing-data overlay: when the sum of a record's phase bands is
  // less than its totalMs (e.g., a phase predicate never fired during
  // the solve, so r.phases is incomplete), append a synthetic band
  // that fills the gap up to totalMs. Rendered as a diagonal-stripe
  // pattern so the user reads it as "missing data" rather than mis-
  // interpreting a short stack as a faster solve. The stripe sits on
  // top of the last phase band; when sum >= totalMs the gap is 0 and
  // the band collapses invisibly.
  const isDark = document.documentElement.classList.contains('dark');
  const missingTopSec: number[] = slice.map((r, idx) => {
    if (focusedPhaseGroup) return totals[idx];  // focused mode: no gap overlay
    const lastBand = cumulative[idx][cumulative[idx].length - 1] ?? 0;
    const goal = r.totalMs / 1000;
    return Math.max(lastBand, goal);
  });
  const hasAnyGap = missingTopSec.some((v, i) =>
    v - (cumulative[i][cumulative[i].length - 1] ?? 0) > 1e-3);
  if (hasAnyGap) {
    const stripePattern = makeStripePattern(isDark);
    const stripeStroke = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)';
    datasets.push({
      type: 'line' as const,
      label: '(missing data)',
      data: missingTopSec,
      backgroundColor: stripePattern ?? 'rgba(128,128,128,0.15)',
      borderColor: stripeStroke,
      borderWidth: 1,
      borderDash: [3, 3],
      fill: '-1',
      pointRadius: 0,
      pointHoverRadius: 0,
      tension: 0.15,
      order: 2,
      clip: false,
    });
  }

  // Ao5/Ao12 are computed over ALL history, then tail-sliced to the
  // visible window. Otherwise the first few entries in the window can't
  // form a complete window of size N and the trendline would flat-line
  // at null even when prior data exists to compute it from.
  // AoX uses the FILTERED history, so the trendlines reflect only
  // solves matching the active tag filter — and recompute when the
  // filter changes.
  const allTotals = filtered.map(recordTotalSec);
  const tailOf = (arr: (number | null)[]) => arr.slice(-slice.length);
  const ao5Series = prefs.graphAo5 ? tailOf(rollingAverage(allTotals, 5)) : null;
  const ao12Series = prefs.graphAo12 ? tailOf(rollingAverage(allTotals, 12)) : null;
  const ao5Color = isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.75)';
  const ao12Color = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.45)';
  if (ao5Series) {
    datasets.push({
      type: 'line' as const,
      label: 'Ao5',
      data: ao5Series,
      borderColor: ao5Color,
      backgroundColor: 'transparent',
      borderDash: [4, 4],
      borderWidth: 1.5,
      pointRadius: 2,
      pointHoverRadius: 4,
      pointBackgroundColor: ao5Color,
      fill: false,
      order: 1,
      clip: false,
    });
  }
  if (ao12Series) {
    datasets.push({
      type: 'line' as const,
      label: 'Ao12',
      data: ao12Series,
      borderColor: ao12Color,
      backgroundColor: 'transparent',
      borderDash: [2, 2],
      borderWidth: 1.5,
      pointRadius: 2,
      pointHoverRadius: 4,
      pointBackgroundColor: ao12Color,
      fill: false,
      order: 1,
      clip: false,
    });
  }

  // Y-axis: since we pre-accumulated, no Chart.js stacking is needed.
  const yOpts: any = { beginAtZero: true };
  if (prefs.graphYClip === '1sd') {
    const { mean, sd } = meanAndSd(totals);
    yOpts.max = Math.max(mean + sd, 1);
  } else if (prefs.graphYClip === '2sd') {
    const { mean, sd } = meanAndSd(totals);
    yOpts.max = Math.max(mean + 2 * sd, 1);
  } else if (prefs.graphYClip === 'log') {
    yOpts.type = 'logarithmic';
    delete yOpts.beginAtZero;
  }

  // Format y-axis tick values as M:SS instead of raw seconds.
  yOpts.ticks = {
    ...(yOpts.ticks ?? {}),
    callback: (value: number | string) => {
      const total = Math.round(Number(value));
      const m = Math.floor(total / 60);
      const s = total - m * 60;
      return `${m}:${String(s).padStart(2, '0')}`;
    },
  };

  const formatSec = (sec: number) => {
    const total = Math.max(0, sec);
    if (total >= 60) {
      const m = Math.floor(total / 60);
      const s = total - m * 60;
      return `${m}:${s.toFixed(2).padStart(5, '0')}`;
    }
    return total.toFixed(2);
  };
  const trendlineLabels = new Set(['Ao5', 'Ao12']);
  const isDarkNow = document.documentElement.classList.contains('dark');
  // Match the legend's body text color (text-gray-900 / dark:text-white).
  const labelTextColor = isDarkNow ? '#ffffff' : '#111827';
  const pillBg = isDarkNow ? 'rgba(0,0,0,0.72)' : 'rgba(255,255,255,0.92)';

  // (Idle shading is now achieved by inserting an "idle:<phase>" dataset
  // before each phase's dataset in focus views — those phantom datasets
  // share the bands' `tension: 0.15` so the shading curves match the
  // band edges automatically. See keyOrder construction above.)

  // Custom plugin: on hover, draw per-phase split times at each line's data
  // point — vertically de-overlapped, edge-flipped to stay inside the chart,
  // and prefixed with a legend-style color chit.
  const inlineSplitLabels = {
    id: 'inlineSplitLabels',
    afterDatasetsDraw(chart: any) {
      const idx = chart.$activeIndex;
      if (typeof idx !== 'number' || idx < 0) return;
      // Two-stage hover: when the cursor is inside the canvas but outside
      // the plot axes, show only aggregate (chit-less) labels and the
      // guide line; suppress the chit-bearing per-phase labels. Default to
      // true if the flag has never been written.
      const inAxes: boolean = chart.$inAxes !== false;
      const c2d: CanvasRenderingContext2D = chart.ctx;
      c2d.save();
      c2d.font = '11px ui-sans-serif, system-ui, sans-serif';
      c2d.textBaseline = 'middle';
      const padX = 4;
      const padY = 2;
      const chitSize = 10;
      const chitGap = 4;
      const lineHeight = 14;
      const pillH = lineHeight + padY * 2;
      const minSpacing = pillH + 2;

      // First pass: collect the labels we intend to draw.
      type Entry = {
        text: string;
        color: string;
        isTrendline: boolean;
        noChit: boolean;
        point: { x: number; y: number };
        textW: number;
      };
      const entries: Entry[] = [];
      let topY = Infinity;
      let topX = 0;
      chart.data.datasets.forEach((ds: any, dsIdx: number) => {
        const meta = chart.getDatasetMeta(dsIdx);
        const point = meta.data[idx];
        if (!point) return;
        const label = String(ds.label ?? '');
        const isTrendline = trendlineLabels.has(label);
        let valueSec: number | null = null;
        if (isTrendline) {
          const v = ds.data[idx];
          if (typeof v !== 'number' || !Number.isFinite(v)) return;
          valueSec = v;
        } else {
          const r = slice[idx];
          const k = keyOrder[dsIdx];
          if (!r || !k) return;
          // Phantom "idle:<phase>" datasets exist only to draw the idle
          // shading stripe inside each focused phase band; they're not
          // meaningful entries for the hover label stack.
          if (k.startsWith('idle:')) return;
          // In F2L focus, emit a chit per sub-band (labelled 1P/2P/3P/4P
          // via labelForKey); the F2L total is added separately as a
          // chit-less entry. In any other view, collapse the 4 sub-bands
          // into one "F2L" chit at the topmost sub-band's point and skip
          // the lone 'f2l' chit entirely when focused (the chit-less
          // total covers it).
          const collapseF2lSubBands = focusedPhaseGroup !== 'f2l';
          if (collapseF2lSubBands && k.startsWith('f2l_') && k !== 'f2l_4') return;
          if (focusedPhaseGroup === 'f2l' && k === 'f2l') return;
          const ms = (collapseF2lSubBands && k === 'f2l_4')
            ? phaseMsForDisplay(r, 'f2l')
            : phaseMsForDisplay(r, k);
          if (ms <= 0) return; // skip 0-duration phases
          valueSec = ms / 1000;
          // Track the topmost (smallest y) phase point — that's where the
          // total cumulative line ends, and where the "Total" label belongs.
          if (point.y < topY) { topY = point.y; topX = point.x; }
        }
        const text = `${label} ${formatSec(valueSec)}`;
        const textW = c2d.measureText(text).width;
        entries.push({
          text,
          color: String(ds.borderColor ?? '#000'),
          isTrendline,
          // Trendlines drop the chit and instead colour the value text in
          // the line's colour — keeps them the same width as phase labels
          // while still distinguishing Ao5 vs Ao12 visually.
          noChit: isTrendline,
          point: { x: point.x, y: point.y },
          textW,
        });
      });

      // Synthetic total-time entry — no color chit, anchored just above
      // the topmost cumulative point. Its meaning depends on focus:
      //   - Unfocused: "Solve TT.tt" = full solve time.
      //   - F2L-focused: "F2L TT.tt" = sum of the visible F2L bands
      //     (alongside per-pair 1P/2P/3P/4P chits below).
      //   - LL-focused: "LL TT.tt" = sum of the visible LL bands.
      const r = slice[idx];
      if (r && Number.isFinite(topY)) {
        let totalLabel: string;
        let totalSec: number;
        if (focusedPhaseGroup === 'f2l') {
          totalLabel = 'F2L';
          const allowed = new Set(displayPhaseSequenceFor(r));
          let sumMs = 0;
          for (const k of keyOrder) {
            const baseKey = k.startsWith('f2l_') ? 'f2l' : k;
            if (!allowed.has(baseKey)) continue;
            sumMs += phaseMsForDisplay(r, k);
          }
          totalSec = sumMs / 1000;
        } else if (focusedPhaseGroup === 'll') {
          totalLabel = 'LL';
          const allowed = new Set(displayPhaseSequenceFor(r));
          let sumMs = 0;
          for (const k of keyOrder) {
            const baseKey = k.startsWith('f2l_') ? 'f2l' : k;
            if (!allowed.has(baseKey)) continue;
            sumMs += phaseMsForDisplay(r, k);
          }
          totalSec = sumMs / 1000;
        } else {
          totalLabel = 'Solve';
          totalSec = r.totalMs / 1000;
        }
        const text = `${totalLabel} ${formatSec(totalSec)}`;
        entries.push({
          text,
          color: '',
          isTrendline: false,
          noChit: true,
          // Place 1 px above the topmost phase so the de-overlap algorithm
          // sorts the total to the top of the stack.
          point: { x: topX, y: topY - 1 },
          textW: c2d.measureText(text).width,
        });
      }

      if (entries.length === 0) { c2d.restore(); return; }

      // Split entries into two groups for two-sided layout: phase labels
      // (with color chits) and chit-less labels (Solve total + Ao5/Ao12).
      // Each group de-overlaps independently so they form their own tidy
      // vertical stack on each side of the column guide.
      const phaseEntries = entries.filter(e => !e.noChit);
      const chitlessEntries = entries.filter(e => e.noChit);

      const chartArea = chart.chartArea;
      // For labels whose data point sits ABOVE the plot area (the solve's
      // cumulative phase total exceeds the y-axis clip), remap each
      // clipped target to a fixed slot just inside the top of the chart,
      // ranked by original stacking order (topmost phase first). Labels
      // for unclipped phases keep their natural y so they stay visually
      // anchored to their data points; the subsequent de-overlap pass
      // resolves any collision between the clipped stack and a nearby
      // unclipped label.
      const phaseY = placeLabelsAvoidOverlap(
        remapClippedTargets(phaseEntries.map(e => e.point.y), chartArea.top, pillH / 2, minSpacing),
        minSpacing,
      );
      const chitlessY = placeLabelsAvoidOverlap(
        remapClippedTargets(chitlessEntries.map(e => e.point.y), chartArea.top, pillH / 2, minSpacing),
        minSpacing,
      );

      const hoverX = (phaseEntries[0] ?? chitlessEntries[0])?.point.x;

      // Subtle vertical guide on the hovered column so the labels on each
      // side of it are unambiguously anchored to this solve.
      if (typeof hoverX === 'number') {
        c2d.save();
        c2d.strokeStyle = isDarkNow ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.22)';
        c2d.lineWidth = 1;
        c2d.setLineDash([3, 3]);
        c2d.beginPath();
        c2d.moveTo(hoverX, chartArea.top);
        c2d.lineTo(hoverX, chartArea.bottom);
        c2d.stroke();
        c2d.setLineDash([]);
        c2d.restore();
      }

      // Side selection. Default split: phase labels on whichever side has
      // more horizontal room; chit-less labels on the opposite side. If
      // there isn't enough room on the chit-less side, stack chit-less
      // OUTBOARD of phase (i.e., further from the data point) on the same
      // side. Phase always wins the closer-to-data-point side.
      const padOuter = 10;
      const rightAvail = (hoverX !== undefined) ? (chartArea.right - hoverX - padOuter) : 0;
      const leftAvail = (hoverX !== undefined) ? (hoverX - chartArea.left - padOuter) : 0;
      const phaseMaxW = phaseEntries.length
        ? Math.max(...phaseEntries.map(e => chitSize + chitGap + e.textW))
        : 0;
      const chitlessMaxW = chitlessEntries.length
        ? Math.max(...chitlessEntries.map(e => e.textW))
        : 0;

      let phaseSide: 'L' | 'R' = rightAvail >= leftAvail ? 'R' : 'L';
      let chitlessSide: 'L' | 'R' = phaseSide === 'R' ? 'L' : 'R';
      let chitlessOffset = 0;
      const sideAvail = (s: 'L' | 'R') => (s === 'R' ? rightAvail : leftAvail);
      if (chitlessMaxW > sideAvail(chitlessSide)) {
        // Not enough room on the opposite side — fall back to the same side
        // as phase, outboard (further out from the data point).
        chitlessSide = phaseSide;
        chitlessOffset = phaseMaxW + 8;
      }

      const renderEntry = (e: Entry, labelY: number, side: 'L' | 'R', extra: number) => {
        const totalW = e.noChit ? e.textW : chitSize + chitGap + e.textW;
        let labelX: number;
        let chitOnLeft: boolean;
        if (side === 'R') {
          labelX = e.point.x + 8 + extra;
          chitOnLeft = true;
        } else {
          labelX = e.point.x - 8 - extra - totalW;
          chitOnLeft = false;
        }

        // Pill background.
        c2d.fillStyle = pillBg;
        c2d.fillRect(labelX - padX, labelY - pillH / 2, totalW + padX * 2, pillH);

        let textX = labelX;
        if (!e.noChit) {
          const chitX = chitOnLeft ? labelX : labelX + e.textW + chitGap;
          textX = chitOnLeft ? labelX + chitSize + chitGap : labelX;
          if (e.isTrendline) {
            c2d.strokeStyle = e.color;
            c2d.lineWidth = 2;
            c2d.setLineDash([4, 2]);
            c2d.beginPath();
            c2d.moveTo(chitX, labelY);
            c2d.lineTo(chitX + chitSize, labelY);
            c2d.stroke();
            c2d.setLineDash([]);
          } else {
            c2d.fillStyle = e.color;
            c2d.fillRect(chitX, labelY - chitSize / 2, chitSize, chitSize);
          }
        }

        if (e.isTrendline) {
          const sp = e.text.lastIndexOf(' ');
          const labelPart = sp >= 0 ? e.text.slice(0, sp + 1) : '';
          const valuePart = sp >= 0 ? e.text.slice(sp + 1) : e.text;
          c2d.fillStyle = labelTextColor;
          c2d.fillText(labelPart, textX, labelY);
          const labelW = c2d.measureText(labelPart).width;
          c2d.fillStyle = e.color;
          c2d.fillText(valuePart, textX + labelW, labelY);
        } else {
          c2d.fillStyle = labelTextColor;
          c2d.fillText(e.text, textX, labelY);
        }
      };

      if (inAxes) phaseEntries.forEach((e, i) => renderEntry(e, phaseY[i], phaseSide, 0));
      chitlessEntries.forEach((e, i) => renderEntry(e, chitlessY[i], chitlessSide, chitlessOffset));

      c2d.restore();
    },
  };

  if (graphChart) graphChart.destroy();
  graphChart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    plugins: [inlineSplitLabels],
    options: {
      responsive: true,
      animation: false,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      events: ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove'],
      onClick: (e, _elements, chart) => {
        // Map the click to a phase group via cumulative heights at the
        // clicked column. Clicking on a F2L or LL band TOGGLES that focus
        // (so the same band is the on-switch AND the off-switch). Clicks
        // on cross / above the stack / outside the plot area also clear.
        const ca = chart.chartArea;
        const ex = (e as any)?.x;
        const ey = (e as any)?.y;
        const hasXY = typeof ex === 'number' && typeof ey === 'number';
        const inAxes = hasXY &&
          ex >= ca.left && ex <= ca.right && ey >= ca.top && ey <= ca.bottom;
        let clickedGroup: 'f2l' | 'll' | null = null;
        if (inAxes) {
          const xScale: any = chart.scales.x;
          const yScale: any = chart.scales.y;
          const rawX = xScale?.getValueForPixel?.(ex);
          const yValueSec = yScale?.getValueForPixel?.(ey);
          if (typeof rawX === 'number' && typeof yValueSec === 'number') {
            const colIdx = Math.max(0, Math.min(slice.length - 1, Math.round(rawX)));
            const colCum = cumulative[colIdx];
            let hitKey: string | null = null;
            for (let i = 0; i < colCum.length; i++) {
              if (yValueSec <= colCum[i]) { hitKey = keyOrder[i]; break; }
            }
            const grp = hitKey ? groupOfKey(hitKey) : null;
            if (grp === 'f2l' || grp === 'll') clickedGroup = grp;
          }
        }
        // Toggle if clicking the currently-focused group; otherwise set
        // to the new group (or clear if click landed outside).
        const next: typeof focusedPhaseGroup = clickedGroup === focusedPhaseGroup
          ? null
          : clickedGroup;
        if (focusedPhaseGroup !== next) {
          focusedPhaseGroup = next;
          renderGraph();
        }
      },
      onHover: (e, elements, chart) => {
        // Two-stage hover: full chit + aggregate labels when the cursor is
        // inside the plot axes; aggregate-only when the cursor is inside the
        // canvas but outside the axes. Even outside the axes, horizontal
        // cursor motion still updates the active column so the aggregate
        // labels and guide line track the nearest x value.
        const ca = chart.chartArea;
        const ex = (e as any)?.x;
        const ey = (e as any)?.y;
        const hasXY = typeof ex === 'number' && typeof ey === 'number';
        const inAxes = hasXY &&
          ex >= ca.left && ex <= ca.right && ey >= ca.top && ey <= ca.bottom;
        const ch = chart as any;
        const hoveredIdx = elements && elements.length > 0 ? elements[0].index : -1;
        let newIdx: number;
        if (inAxes) {
          newIdx = hoveredIdx;
        } else if (hasXY) {
          // Outside axes but still within the canvas: snap to the closest
          // column by x. Chart.js's category x-scale maps pixel → index via
          // getValueForPixel; clamp to valid range.
          const xScale: any = chart.scales.x;
          const labels: any[] = (chart.data.labels as any[]) ?? [];
          const raw = xScale?.getValueForPixel?.(ex);
          if (typeof raw === 'number' && labels.length > 0) {
            newIdx = Math.max(0, Math.min(labels.length - 1, Math.round(raw)));
          } else {
            newIdx = ch.$activeIndex ?? -1;
          }
        } else {
          newIdx = ch.$activeIndex ?? -1;
        }
        if (ch.$activeIndex !== newIdx || ch.$inAxes !== inAxes) {
          ch.$activeIndex = newIdx;
          ch.$inAxes = inAxes;
          chart.draw();
        }

        // Focus-hover: when the cursor is over a F2L or LL band (inside
        // the plot area), switch the cursor to `pointer` and show a
        // delayed "Focus on …" / "Focus out" label near the pointer.
        // Chart.js fires onHover with type === 'mouseout' when the cursor
        // leaves the canvas — treat that as "left the focus area".
        const cv = (chart.canvas as HTMLCanvasElement | undefined);
        const isLeave = (e as any)?.type === 'mouseout';
        if (isLeave || !inAxes) {
          if (cv) cv.style.cursor = '';
        } else {
          // Same band-detection logic as the click handler.
          let hoverGroup: 'f2l' | 'll' | null = null;
          const xScale: any = chart.scales.x;
          const yScale: any = chart.scales.y;
          const rawX = xScale?.getValueForPixel?.(ex);
          const yValueSec = yScale?.getValueForPixel?.(ey);
          if (typeof rawX === 'number' && typeof yValueSec === 'number') {
            const colIdx = Math.max(0, Math.min(slice.length - 1, Math.round(rawX)));
            const colCum = cumulative[colIdx];
            let hitKey: string | null = null;
            for (let i = 0; i < colCum.length; i++) {
              if (yValueSec <= colCum[i]) { hitKey = keyOrder[i]; break; }
            }
            const grp = hitKey ? groupOfKey(hitKey) : null;
            if (grp === 'f2l' || grp === 'll') hoverGroup = grp;
          }
          if (cv) cv.style.cursor = hoverGroup ? 'pointer' : '';
        }
      },
      // Suppress the chart-internal legend (we render our own) and the
      // built-in tooltip block (replaced by the inline-label plugin).
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
      },
      scales: {
        y: yOpts,
        x: { ticks: { autoSkip: true, maxRotation: 0 } },
      },
    },
  });

  // Belt-and-braces: Chart.js's `mouseout` interaction event doesn't always
  // fire when the cursor leaves the canvas, so the inline labels and guide
  // line can stick around. We attach mousemove and leave handlers on the
  // outer #alg-stats wrapper so the guide + aggregate labels keep updating
  // as the cursor moves anywhere within the stats area (chart + metric
  // boxes), and only clear when the cursor leaves the wrapper entirely.
  const clearHover = () => {
    if (!graphChart) return;
    const ch = graphChart as any;
    if (ch.$activeIndex !== -1 || ch.$inAxes !== false) {
      ch.$activeIndex = -1;
      ch.$inAxes = false;
      graphChart.draw();
    }
    // Also reset the focus-hover cursor when the pointer leaves the
    // stats area entirely.
    if (graphChart.canvas) (graphChart.canvas as HTMLCanvasElement).style.cursor = '';
  };
  const algStatsEl = document.getElementById('alg-stats');
  if (algStatsEl) {
    algStatsEl.onmousemove = (ev) => {
      if (!graphChart) return;
      const rect = canvas.getBoundingClientRect();
      const cx = ev.clientX - rect.left;
      const cy = ev.clientY - rect.top;
      const ca = graphChart.chartArea;
      const xScale: any = graphChart.scales.x;
      const labels: any[] = (graphChart.data.labels as any[]) ?? [];
      if (!labels.length) return;
      // If the cursor wandered off the canvas (into the metric boxes or
      // padding within #alg-stats), drop the focus-cursor affordance.
      const offCanvas = cx < 0 || cx > rect.width || cy < 0 || cy > rect.height;
      if (offCanvas && graphChart.canvas) {
        (graphChart.canvas as HTMLCanvasElement).style.cursor = '';
      }
      const inAxes = cx >= ca.left && cx <= ca.right && cy >= ca.top && cy <= ca.bottom;
      const raw = xScale?.getValueForPixel?.(cx);
      const ch = graphChart as any;
      let newIdx = ch.$activeIndex ?? -1;
      if (typeof raw === 'number') {
        newIdx = Math.max(0, Math.min(labels.length - 1, Math.round(raw)));
      }
      if (ch.$activeIndex !== newIdx || ch.$inAxes !== inAxes) {
        ch.$activeIndex = newIdx;
        ch.$inAxes = inAxes;
        graphChart.draw();
      }
    };
    algStatsEl.onmouseleave = clearHover;
    algStatsEl.onpointerleave = clearHover;
    algStatsEl.onpointercancel = clearHover;
  }
}

// ---------- Solve list ----------

// Replace the contents of `target` with a chunked move display: each
// 4-move chunk is wrapped in a .turn-group span, and each move inside
// gets one of .clock / .c-clock / .double. A regular space separates
// chunks; intra-chunk spacing comes from the .turn-group CSS rule.
function setFormattedMoves(target: HTMLElement, seq: string): void {
  target.replaceChildren();
  const moves = seq.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < moves.length; i += 4) {
    const group = document.createElement('span');
    group.className = 'turn-group';
    for (const m of moves.slice(i, i + 4)) {
      const span = document.createElement('span');
      span.className = moveClass(m);
      span.textContent = m;
      group.appendChild(span);
    }
    target.appendChild(group);
    if (i + 4 < moves.length) target.appendChild(document.createTextNode(' '));
  }
}

// Render a stored solve into the past-solves DOM, applying same-face
// reduction. Two display modes:
//   showStrikes = false (collapsed / accordion folded — default):
//     redundant moves are HIDDEN entirely. Only "real" moves and italic
//     equivalent-turn replacements are shown.
//   showStrikes = true  (expanded / accordion open):
//     redundant moves are shown with strike-through, alongside the
//     same reals and replacements.
//
// Chunking is a fixed 4 RELEVANT moves per .turn-group regardless of
// mode (relevant = real + italic-replacement; strikes are decorative
// and never counted), so chunk-spaces sit at the same logical position
// in both modes.
function renderSolutionView(target: HTMLElement, moves: string[], showStrikes: boolean): void {
  target.replaceChildren();

  // Pass 1: classify each storage move (pure, see fullSolve/classify.ts).
  //   strike      → cancelled; rendered struck-through (or hidden if !showStrikes)
  //   replacement → if set, append an italic equivalent-turn move after this
  //                 storage move (used when no original in a same-face group
  //                 already equals the group's net rotation)
  const renders = classifyMoves(moves);

  // Pass 2: emit tokens (real / strike / italic) in storage order; chunk
  // by 4 RELEVANT (real + italic) tokens. Strikes are passed through but
  // never increment the chunk count — when !showStrikes they're skipped
  // entirely.
  let group: HTMLElement | null = null;
  let countInChunk = 0;
  const ensureGroup = () => {
    if (!group) {
      if (target.childNodes.length > 0) target.appendChild(document.createTextNode(' '));
      group = document.createElement('span');
      group.className = 'turn-group';
      target.appendChild(group);
      countInChunk = 0;
    }
  };

  for (let k = 0; k < moves.length; k++) {
    const m = moves[k];
    const r = renders[k];
    if (r.strike) {
      if (showStrikes) {
        ensureGroup();
        const span = document.createElement('span');
        span.className = `${moveClass(m)} line-through text-gray-400 dark:text-gray-500`;
        span.textContent = m;
        group!.appendChild(span);
      }
    } else {
      ensureGroup();
      const span = document.createElement('span');
      span.className = moveClass(m);
      span.textContent = m;
      group!.appendChild(span);
      countInChunk++;
      if (countInChunk >= 4) group = null;
    }
    if (r.replacement) {
      ensureGroup();
      const repSpan = document.createElement('span');
      repSpan.className = `${moveClass(r.replacement)} equivalent-turn`;
      repSpan.title = 'Collapsed into Equivalent Turn';
      repSpan.textContent = r.replacement;
      group!.appendChild(repSpan);
      countInChunk++;
      if (countInChunk >= 4) group = null;
    }
  }
}

// ---------- Turn-progression popup ----------
// A minimal pop-up chart triggered by the 📈 button on a past-solves row.
// One data point per physical turn at (elapsed seconds, turn number) so
// pauses read as flat sections and bursts as steep slope. No metrics or
// labels are overlaid — the slope itself encodes pace.

// Canonical phase order for a stored solve, used by the phase color bands
// behind the line. Follows the current 2-look display toggles so the
// popup's banding matches the main graph: when the user has 2-look OLL
// on AND the record has the split fields, render eoll + ocll; otherwise
// fold to a single oll band. Same for PLL. phaseMsForDisplay handles the
// underlying ms aggregation either way.
function phaseOrderForRecord(r: SolveRecord): string[] {
  if (r.process === 'beginner') return ['setup', 'll'];
  const out: string[] = ['cross', 'f2l'];
  const hasOllSplit = typeof r.phases?.eoll === 'number' && typeof r.phases?.ocll === 'number';
  const hasOllAny = hasOllSplit || typeof r.phases?.oll === 'number';
  if (prefs.twoLookOll && hasOllSplit) out.push('eoll', 'ocll');
  else if (hasOllAny) out.push('oll');
  const hasPllSplit = typeof r.phases?.cpll === 'number' && typeof r.phases?.epll === 'number';
  const hasPllAny = hasPllSplit || typeof r.phases?.pll === 'number';
  if (prefs.twoLookPll && hasPllSplit) out.push('cpll', 'epll');
  else if (hasPllAny) out.push('pll');
  return out;
}

// Color per phase key. Mirrors the choices made in currentPhaseSequence()
// — notably aggregate OLL uses OCLL's color (orange) so it matches the
// top of the EOLL+OCLL stack when the toggle is on.
const PHASE_COLOR_BY_KEY: Record<string, string> = {
  cross: PHASE_COLORS[0],
  f2l:   PHASE_COLORS[1],
  eoll:  PHASE_COLORS[2],
  ocll:  PHASE_COLORS[3],
  oll:   PHASE_COLORS[3],
  cpll:  PHASE_COLORS[4],
  epll:  PHASE_COLORS[5],
  pll:   PHASE_COLORS[5],
  setup: PHASE_COLORS[0],
  ll:    PHASE_COLORS[4],
  // Roux / F3uL
  f1b:   PHASE_COLORS[0],
  f2b:   PHASE_COLORS[7],   // green-light — 2nd F2L sub-band shade
  fml:   PHASE_COLORS[1],   // same green as F2L — F3uL's FML lands in F2L-done state
  // Block-stage shades. Scheme 1 = b1_pre → b1_done → b2_pre → b2_done.
  // Scheme 2 = rp1 → rp2 → rp3 → rp4. Same colors slot-for-slot:
  // light pink → cross-pink → light green → medium green. 1st-block
  // shades are pink so Roux/F3uL's first stage visually parallels
  // CFOP's cross. F3uL adds FML (dark green) on top; Roux records end
  // at medium green per "darker for 2nd block done, darkest for FML".
  b1_pre:   PHASE_COLORS[8],   // light pink
  b1_done:  PHASE_COLORS[0],   // cross pink (intentional reuse of CFOP cross color)
  b2_pre:   PHASE_COLORS[9],   // light green
  b2_done:  PHASE_COLORS[7],   // medium green (= existing F2B color)
  rp1:      PHASE_COLORS[8],
  rp2:      PHASE_COLORS[0],
  rp3:      PHASE_COLORS[9],
  rp4:      PHASE_COLORS[7],
  opll:  PHASE_COLORS[4],
  cmll:  PHASE_COLORS[4],   // aggregate uses OPLL's color (top of stack)
  lseo:  PHASE_COLORS[2],
  lre:   PHASE_COLORS[6],
  opme:  PHASE_COLORS[5],
  lse:   PHASE_COLORS[5],   // aggregate uses OPME's color
};

let turnGraphPopupChart: Chart | null = null;

function closeTurnGraphPopup() {
  const el = document.getElementById('fs-turn-graph-popup');
  if (!el) return;
  document.removeEventListener('keydown', onTurnGraphPopupKey);
  if (turnGraphPopupChart) { turnGraphPopupChart.destroy(); turnGraphPopupChart = null; }
  const opener = (el as any)._opener as HTMLElement | undefined;
  el.remove();
  // Restore focus to the 📈 button the user clicked, so keyboard nav lands
  // back where they started.
  if (opener && document.body.contains(opener)) opener.focus();
}

function onTurnGraphPopupKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); closeTurnGraphPopup(); }
}

function openTurnGraphPopup(r: SolveRecord, opener: HTMLElement) {
  if (!r.turns || r.turns.length < 2) return;
  closeTurnGraphPopup();

  const backdrop = document.createElement('div');
  backdrop.id = 'fs-turn-graph-popup';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.className = 'fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4';
  (backdrop as any)._opener = opener;
  backdrop.addEventListener('click', (e) => {
    // Backdrop click closes; clicks inside the card don't bubble out as
    // backdrop clicks because of stopPropagation below.
    if (e.target === backdrop) closeTurnGraphPopup();
  });

  const card = document.createElement('div');
  card.className = 'relative bg-white dark:bg-gray-800 rounded-lg shadow-xl p-4 max-w-2xl w-full';
  card.addEventListener('click', (e) => e.stopPropagation());

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.className = 'absolute top-2 right-2 leading-none px-2 py-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => closeTurnGraphPopup());

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'relative w-full h-[60vh] sm:h-[420px] mt-4';
  const canvas = document.createElement('canvas');
  canvas.className = 'w-full h-full';
  canvasWrap.appendChild(canvas);

  card.appendChild(closeBtn);
  card.appendChild(canvasWrap);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  document.addEventListener('keydown', onTurnGraphPopupKey);
  closeBtn.focus();

  // Build phase-band x-extents (in seconds) from r.phases in canonical
  // order. Falls back to no bands if r.phases is empty. When the F2L
  // splits toggle is on and the record has f2lSplits, the F2L band is
  // subdivided into up to 4 alpha-scaled sub-bands matching the main
  // graph's visual decomposition.
  const order = phaseOrderForRecord(r);
  const splitF2l = prefs.f2lSplits && Array.isArray(r.f2lSplits) && r.f2lSplits.length > 0;
  let acc = 0;
  const bands: { start: number; end: number; color: string }[] = [];
  for (const key of order) {
    // Use phaseMsForDisplay so aggregate keys ('oll'/'pll') pick up split
    // fields when the record has them but the toggle is off.
    const ms = phaseMsForDisplay(r, key);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    const start = acc / 1000;
    acc += ms;
    const end = acc / 1000;
    if (key === 'f2l' && splitF2l) {
      // Sub-band boundaries inside the F2L window, in seconds.
      // splits[i] is ms-from-solve-start at slot count i+1. Clamp into
      // the F2L window and enforce monotonicity.
      const splits = r.f2lSplits!;
      const f2lStartSec = start;
      const f2lEndSec = end;
      const bounds: number[] = [f2lStartSec];
      for (let i = 0; i < 4; i++) {
        const tSec = i < splits.length ? splits[i] / 1000 : f2lEndSec;
        const clamped = Math.max(bounds[bounds.length - 1], Math.min(tSec, f2lEndSec));
        bounds.push(clamped);
      }
      bounds[bounds.length - 1] = f2lEndSec; // pin the last bound
      const ALPHAS = [0.30, 0.45, 0.60, 0.75];
      for (let i = 0; i < 4; i++) {
        const s = bounds[i];
        const e = bounds[i + 1];
        if (e <= s) continue; // skip 0-width sub-bands
        const color = PHASE_COLORS[1].replace(/,\s*[\d.]+\)\s*$/, `, ${ALPHAS[i]})`);
        bands.push({ start: s, end: e, color });
      }
    } else {
      const color = PHASE_COLOR_BY_KEY[key] ?? PHASE_COLORS[0];
      bands.push({ start, end, color });
    }
  }

  const isDark = document.documentElement.classList.contains('dark');
  const axisColor = isDark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.7)';
  const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const lineColor = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.85)';

  const phaseBandsPlugin = {
    id: 'turnGraphPhaseBands',
    // `beforeDraw` runs BEFORE the chart's grid lines are drawn, so the
    // grid (and axis tick lines) end up rendered on top of the bands
    // instead of underneath them. `beforeDatasetsDraw` would put the
    // bands on top of the grid — wrong for this use.
    beforeDraw(chart: any) {
      if (bands.length === 0) return;
      const ctx: CanvasRenderingContext2D = chart.ctx;
      const xs = chart.scales.x;
      const ca = chart.chartArea;
      ctx.save();
      for (const b of bands) {
        const x0 = xs.getPixelForValue(b.start);
        const x1 = xs.getPixelForValue(b.end);
        ctx.fillStyle = b.color;
        ctx.fillRect(x0, ca.top, x1 - x0, ca.bottom - ca.top);
      }
      ctx.restore();
    },
  };

  turnGraphPopupChart = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [{
        data: r.turns.map((t, i) => ({ x: t, y: i + 1 })),
        showLine: true,
        borderColor: lineColor,
        borderWidth: 1,
        pointRadius: 2,
        pointBackgroundColor: lineColor,
        tension: 0,
      }],
    },
    plugins: [phaseBandsPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'elapsed (s)', color: axisColor },
          ticks: { color: axisColor },
          grid: { color: gridColor },
          min: 0,
          max: Math.max(...r.turns) + 0.5,
        },
        y: {
          type: 'linear',
          title: { display: true, text: 'turn', color: axisColor },
          ticks: { color: axisColor, precision: 0 },
          grid: { color: gridColor },
          min: 0,
          max: r.turns.length + 1,
        },
      },
    },
  });
}

function renderSolveList() {
  const listEl = fsSolveListEl();
  if (!listEl) return;
  listEl.innerHTML = '';
  const rev = [...history].reverse();
  if (rev.length === 0) {
    listEl.innerHTML = '<div class="p-3 text-xs text-gray-500 dark:text-gray-400">No solves yet.</div>';
    const hint = fsSolveListHintEl();
    if (hint) hint.textContent = '';
    return;
  }
  const hint = fsSolveListHintEl();
  if (hint) hint.textContent = '';
  rev.forEach((r, idx) => {
    const originalIndex = history.length - idx; // 1-based
    const realIdx = history.length - 1 - idx;
    const row = document.createElement('div');
    row.className = 'px-2 py-1 flex items-center gap-2 text-xs sm:text-sm';
    row.dataset.solveIdx = String(realIdx);

    const num = document.createElement('div');
    num.className = 'w-8 text-right text-gray-400 tabular-nums';
    num.textContent = String(originalIndex);
    row.appendChild(num);

    const time = document.createElement('div');
    time.className = 'w-16 tabular-nums font-mono font-semibold';
    time.textContent = formatTime(r.totalMs);
    row.appendChild(time);

    const scramble = document.createElement('div');
    scramble.className = 'flex-1 font-mono text-gray-600 dark:text-gray-300 truncate';
    scramble.title = r.scramble;
    setFormattedMoves(scramble, r.scramble);
    row.appendChild(scramble);

    // Tag chips for this solve. flex-shrink-0 so the chips display
    // their natural width while the scramble column absorbs the
    // squeeze. Empty when the solve has no tags.
    const tagChips = document.createElement('div');
    tagChips.className = 'flex items-center gap-1 flex-shrink-0';
    // User tags first; process chip last (right-most). Every solve has
    // a process, so anchoring it at the right edge keeps method labels
    // roughly columnar across rows, regardless of how many tags each
    // solve has.
    if (r.tags && r.tags.length > 0) {
      for (const t of r.tags) {
        const chip = document.createElement('span');
        chip.className = 'px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-100 text-[10px] sm:text-xs';
        chip.textContent = t;
        tagChips.appendChild(chip);
      }
    }
    if (r.process) {
      const chip = document.createElement('span');
      chip.className = 'px-2 py-0.5 rounded-full border border-gray-400 dark:border-gray-500 text-gray-700 dark:text-gray-200 text-[10px] sm:text-xs italic';
      chip.textContent = r.process;
      tagChips.appendChild(chip);
    }
    row.appendChild(tagChips);

    // Action icons: pack tightly with no inter-button gap; rely on px padding inside each.
    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-0';
    const iconBtnClass = 'leading-none px-1 py-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed';

    // 📈 opens the turn-progression popup for this solve. Placed first so
    // it's visually grouped with the row's time/scramble (which is what
    // it visualises) rather than with the destructive/mutating buttons on
    // the right. Disabled when the record lacks per-turn timestamps
    // (pre-feature solves) or has too few points to plot meaningfully.
    const turnGraphBtn = document.createElement('button');
    turnGraphBtn.className = iconBtnClass;
    turnGraphBtn.textContent = '📈';
    const hasEnoughTurns = !!r.turns && r.turns.length >= 2;
    turnGraphBtn.title = hasEnoughTurns ? 'Show turn-progression graph' : 'No turn data for this solve';
    turnGraphBtn.disabled = !hasEnoughTurns;
    turnGraphBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTurnGraphPopup(r, turnGraphBtn);
    });
    actions.appendChild(turnGraphBtn);

    const copyBtn = document.createElement('button');
    copyBtn.className = iconBtnClass;
    copyBtn.textContent = '📋';
    copyBtn.title = 'Copy scramble';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void navigator.clipboard?.writeText(r.scramble).then(() => {
        copyBtn.textContent = '✅';
        setTimeout(() => { copyBtn.textContent = '📋'; }, 900);
      });
    });
    actions.appendChild(copyBtn);

    const targetBtn = document.createElement('button');
    targetBtn.className = iconBtnClass;
    targetBtn.textContent = '🎯';
    targetBtn.title = cubeIsSolved ? 'Use this scramble next' : 'Solve cube first to reuse a scramble';
    targetBtn.disabled = !cubeIsSolved;
    targetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pendingScramble = r.scramble;
      void newScramble();
    });
    actions.appendChild(targetBtn);

    // 👀 / 🙈 toggles whether this row's recorded solution is shown below.
    // Each row starts hidden; click reveals.
    const eyeBtn = document.createElement('button');
    const isRevealed = revealedSolveTimestamps.has(r.ts);
    eyeBtn.className = iconBtnClass;
    eyeBtn.textContent = isRevealed ? '🫣' : '👀';
    eyeBtn.title = isRevealed ? 'Hide solution' : 'Show solution';
    eyeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (revealedSolveTimestamps.has(r.ts)) revealedSolveTimestamps.delete(r.ts);
      else revealedSolveTimestamps.add(r.ts);
      renderSolveList();
    });
    actions.appendChild(eyeBtn);

    // ✏️ opens the edit-solve dialog: method dropdown + tag editor.
    // Tag chips already render inline on each row, so the user can
    // see what's on the solve without opening this. Changing the
    // method triggers a replay-based phase recompute so the graph
    // and CSV reflect the new method's phase breakdown.
    const editBtn = document.createElement('button');
    editBtn.className = iconBtnClass;
    editBtn.textContent = '✏️';
    editBtn.title = 'Edit solve (method, tags)';
    editBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const next = await openEditSolveDialog(history[realIdx], `Edit · ${formatTime(r.totalMs)}`);
      if (next === null) return;
      const rec = history[realIdx];
      // Tags.
      if (next.tags.length > 0) rec.tags = next.tags;
      else delete rec.tags;
      // Method change → replay to recompute phases under the new process.
      // We also sync the Roux-only toggles to the current global prefs
      // when switching INTO Roux (so the new record looks like a fresh
      // Roux record) and drop them when switching AWAY.
      if (next.process !== rec.process) {
        const replayed = replayPhasesForProcess(rec, next.process);
        rec.process = next.process;
        if (replayed) rec.phases = replayed;
        else rec.phases = {};
        if (next.process === 'roux') {
          rec.twoLookCmll = prefs.twoLookCmll;
          rec.threeLookLse = prefs.threeLookLse;
        } else {
          delete rec.twoLookCmll;
          delete rec.threeLookLse;
        }
        // F2L-slot data is CFOP-only; drop it on any switch away from CFOP.
        if (next.process !== 'cfop') delete rec.f2lSplits;
      }
      saveHistory();
      renderAllFilterDependent();
    });
    actions.appendChild(editBtn);

    // 🪗 toggles between the default (storage-form) display and the
    // expanded view that strikes through same-face groups and italicises
    // their net-equivalent move. The accordion icon itself is shown
    // strike-through when collapsed (squished, hiding the redundancies)
    // and unstruck when expanded (the bellows are open).
    const expandBtn = document.createElement('button');
    const isExpanded = expandedSolveTimestamps.has(r.ts);
    expandBtn.className = `${iconBtnClass}${isExpanded ? '' : ' line-through'}`;
    expandBtn.textContent = '🪗';
    expandBtn.title = 'expand/collapse redundant turns';
    expandBtn.disabled = !isRevealed;
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (expandedSolveTimestamps.has(r.ts)) expandedSolveTimestamps.delete(r.ts);
      else expandedSolveTimestamps.add(r.ts);
      renderSolveList();
    });
    actions.appendChild(expandBtn);

    const trashBtn = document.createElement('button');
    trashBtn.className = iconBtnClass;
    trashBtn.textContent = '🗑️';
    trashBtn.title = 'Delete this solve';
    trashBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Inline confirm: replace the icon row with a "Delete?" prompt for THIS row.
      actions.innerHTML = '';
      const prompt = document.createElement('span');
      prompt.className = 'text-xs text-red-600 mr-1';
      prompt.textContent = 'Delete?';
      const yes = document.createElement('button');
      yes.className = 'text-xs font-bold text-red-600 hover:text-red-800 px-1';
      yes.textContent = 'Yes';
      yes.addEventListener('click', (ev) => {
        ev.stopPropagation();
        history.splice(realIdx, 1);
        saveHistory();
        const gr = fsGraphRangeEl();
        if (gr) gr.max = String(Math.max(20, history.length));
        renderGraph();
        renderStatsBoxes();
        renderSolveList();
      });
      const no = document.createElement('button');
      no.className = 'text-xs text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white px-1';
      no.textContent = 'No';
      no.addEventListener('click', (ev) => {
        ev.stopPropagation();
        renderSolveList();
      });
      actions.appendChild(prompt);
      actions.appendChild(yes);
      actions.appendChild(no);
    });
    actions.appendChild(trashBtn);

    row.appendChild(actions);
    listEl.appendChild(row);

    if (revealedSolveTimestamps.has(r.ts) && r.solution) {
      const sol = document.createElement('div');
      sol.className = 'pl-10 pr-2 pb-2 font-mono text-[11px] text-gray-500 dark:text-gray-400 break-words';
      // Always feed the renderer a pair-collapsed move list — new records
      // are stored that way; older records may still be raw, in which case
      // we collapse on the fly so both views look consistent.
      const collapsed = collapseDoubles(r.solution.trim().split(/\s+/).filter(Boolean));
      // Same renderer for both modes: the accordion icon controls whether
      // the redundant moves are visible (struck through) or hidden.
      renderSolutionView(sol, collapsed, expandedSolveTimestamps.has(r.ts));
      listEl.appendChild(sol);
    }
  });
}

// ---------- Event wiring ----------

function wireEvents() {
  fullSolveToggleEl()?.addEventListener('change', () => {
    prefs.enabled = !!fullSolveToggleEl()?.checked;
    savePrefs();
    applyFullSolveMode();
    if (prefs.enabled && cubeConnected && mode === 'idle') {
      void newScramble();
    }
  });

  fsProcessEl()?.addEventListener('change', () => {
    prefs.process = (fsProcessEl()?.value as Process) || 'cfop';
    savePrefs();
    updateCfopOptionsVisibility();
    resetSolveState();
    renderStatsLegend();
    renderStatsBoxes();
    renderGraph();
  });

  fsInspectionEl()?.addEventListener('change', () => {
    prefs.inspection = (fsInspectionEl()?.value as Inspection) || '15';
    savePrefs();
  });

  // 2-look toggles are display-only: splits are always recorded into the
  // SolveRecord; the toggles just choose whether the legend/graph collapses
  // EOLL+OCLL into one OLL band (and CPLL+EPLL into one PLL band).
  fsTwoLookOllEl()?.addEventListener('change', () => {
    prefs.twoLookOll = !!fsTwoLookOllEl()?.checked;
    savePrefs();
    renderStatsLegend();
    renderStatsBoxes();
    renderGraph();
  });

  fsTwoLookPllEl()?.addEventListener('change', () => {
    prefs.twoLookPll = !!fsTwoLookPllEl()?.checked;
    savePrefs();
    renderStatsLegend();
    renderStatsBoxes();
    renderGraph();
  });

  fsTwoLookCmllEl()?.addEventListener('change', () => {
    prefs.twoLookCmll = !!fsTwoLookCmllEl()?.checked;
    savePrefs();
    renderStatsLegend();
    renderStatsBoxes();
    renderGraph();
  });

  fsThreeLookLseEl()?.addEventListener('change', () => {
    prefs.threeLookLse = !!fsThreeLookLseEl()?.checked;
    savePrefs();
    renderStatsLegend();
    renderStatsBoxes();
    renderGraph();
  });

  // "Share scrambles" — toggling on broadcasts our current + future
  // scrambles to the partner. The setter handles "claim" semantics and
  // also kicks off an immediate broadcast of currentScramble so the
  // partner syncs without waiting for the next scramble change.
  const shareScramblesCb = document.getElementById('fs-share-scrambles') as HTMLInputElement | null;
  shareScramblesCb?.addEventListener('change', () => {
    if (peerSharingScrambles) {
      // Greyed out — guard against any path that bypasses `disabled`.
      shareScramblesCb.checked = false;
      return;
    }
    setSharingScrambles(!!shareScramblesCb.checked);
  });

  fsNewScrambleBtnEl()?.addEventListener('click', () => {
    void newScramble();
  });

  fsCopyScrambleBtnEl()?.addEventListener('click', async () => {
    if (!currentScramble) {
      alert('No scramble loaded yet.');
      return;
    }
    try {
      await navigator.clipboard.writeText(currentScramble);
      renderStatus('Scramble copied to clipboard.');
    } catch {
      alert('Clipboard access denied. Allow clipboard write in your browser settings to copy scrambles.');
    }
  });

  fsPasteScrambleBtnEl()?.addEventListener('click', async () => {
    // alert() rather than renderStatus(): the latter is suppressed while
    // the "Connect a smart cube…" banner is up, but paste should give
    // feedback even when no cube is connected.
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      alert('Clipboard access denied. Allow clipboard read in your browser settings to paste scrambles.');
      return;
    }
    const cleaned = parseScramble(text);
    if (!cleaned) {
      alert('Clipboard content is not a valid scramble. Expected space-separated moves like "R U R\' U\'".');
      return;
    }
    pendingScramble = cleaned;
    void newScramble();
  });

  fsPendingTagsBtnEl()?.addEventListener('click', () => {
    void openPendingTagsEditor();
  });

  fsTagsFilterMenuEl()?.addEventListener('change', () => {
    const sel = fsTagsFilterMenuEl();
    if (!sel) return;
    void onTagsFilterMenuChange(sel.value);
  });

  fsRouxSchemeEl()?.addEventListener('change', () => {
    const sel = fsRouxSchemeEl();
    if (!sel) return;
    prefs.rouxColorScheme = (sel.value === '2' ? 2 : 1);
    savePrefs();
    renderGraph();
    renderStatsBoxes();
    renderStatsLegend();
  });

  wireTagEditorDialog();
  wireAdvancedFilterDialog();

  fsPauseBtnEl()?.addEventListener('click', () => {
    togglePause();
  });

  fsAbortBtnEl()?.addEventListener('click', () => {
    // Abort only applies to an active run; in 'scrambling' there's
    // nothing to abort (button is also visually disabled there).
    if (mode === 'idle' || mode === 'scrambling' || mode === 'done') return;
    abortSolve();
  });

  fsGraphRangeEl()?.addEventListener('input', () => {
    const raw = fsGraphRangeEl()?.value;
    prefs.graphRange = raw ? parseInt(raw, 10) : 20;
    savePrefs();
    const v = fsGraphRangeValueEl();
    if (v) v.textContent = String(prefs.graphRange);
    renderGraph();
  });

  fsGraphYClipEl()?.addEventListener('change', () => {
    prefs.graphYClip = (fsGraphYClipEl()?.value as FullSolvePrefs['graphYClip']) || '1sd';
    savePrefs();
    renderGraph();
  });

  fsGraphAo5El()?.addEventListener('change', () => {
    prefs.graphAo5 = !!fsGraphAo5El()?.checked;
    savePrefs();
    renderGraph();
    renderStatsLegend();
  });

  fsGraphAo12El()?.addEventListener('change', () => {
    prefs.graphAo12 = !!fsGraphAo12El()?.checked;
    savePrefs();
    renderGraph();
    renderStatsLegend();
  });

  fsGraphF2lSplitsEl()?.addEventListener('change', () => {
    prefs.f2lSplits = !!fsGraphF2lSplitsEl()?.checked;
    savePrefs();
    renderGraph();
  });

  fsExportHistoryCsvBtnEl()?.addEventListener('click', () => {
    exportHistoryAsCsvFile();
  });

  fsExportHistoryBtnEl()?.addEventListener('click', () => {
    exportHistoryAsJson();
  });

  fsImportHistoryBtnEl()?.addEventListener('click', () => {
    fsImportHistoryInputEl()?.click();
  });

  fsImportHistoryInputEl()?.addEventListener('change', async (ev) => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      importHistoryFromText(text);
    } finally {
      // Allow re-importing the same file by clearing the value.
      input.value = '';
    }
  });
}

function applyPrefsToUI() {
  const t = fullSolveToggleEl(); if (t) t.checked = prefs.enabled;
  const p = fsProcessEl(); if (p) p.value = prefs.process;
  const i = fsInspectionEl(); if (i) i.value = prefs.inspection;
  const ol = fsTwoLookOllEl(); if (ol) ol.checked = prefs.twoLookOll;
  const pl = fsTwoLookPllEl(); if (pl) pl.checked = prefs.twoLookPll;
  const cm = fsTwoLookCmllEl(); if (cm) cm.checked = prefs.twoLookCmll;
  const ls = fsThreeLookLseEl(); if (ls) ls.checked = prefs.threeLookLse;
  const rs = fsRouxSchemeEl(); if (rs) rs.value = String(prefs.rouxColorScheme);
  // Slider range is fixed: 20 (min) to 500 (HISTORY_CAP). When history is
  // shorter than the chosen range, renderGraph() clamps to history.length.
  if (prefs.graphRange < 10 || prefs.graphRange > 500) {
    prefs.graphRange = Math.max(10, Math.min(500, prefs.graphRange));
    savePrefs();
  }
  const gr = fsGraphRangeEl(); if (gr) {
    gr.min = '10';
    gr.max = '500';
    gr.value = String(prefs.graphRange);
  }
  const grv = fsGraphRangeValueEl(); if (grv) grv.textContent = String(prefs.graphRange);
  const gyc = fsGraphYClipEl(); if (gyc) gyc.value = prefs.graphYClip;
  const ga5 = fsGraphAo5El(); if (ga5) ga5.checked = prefs.graphAo5;
  const ga12 = fsGraphAo12El(); if (ga12) ga12.checked = prefs.graphAo12;
  const f2ls = fsGraphF2lSplitsEl(); if (f2ls) f2ls.checked = prefs.f2lSplits;
  renderPendingTagsDisplay();
  renderTagsFilterMenu();
}

// ---------- Tags (dialogs, filter menu, per-row UI) ----------

// Apply the active tag filter to the history before any render
// (graph, stats boxes, legend, etc.). Calling this through the
// renderers keeps the displayed view internally consistent.
function filteredHistory(): SolveRecord[] {
  return applyTagFilter(history, prefs.graphTagFilter);
}

// Trigger every renderer that reads from history. Used after a tag
// edit, a filter change, or anything else that affects the active
// slice.
function renderAllFilterDependent() {
  renderGraph();
  renderStatsBoxes();
  renderStatsLegend();
  renderSolveList();
  renderTagsFilterMenu();
}

// --- Tag editor dialog ------------------------------------------------

// In-flight resolver: openTagEditor returns a promise that the
// dialog's Cancel/Save handlers settle.
let tagEditorResolve: ((tags: string[] | null) => void) | null = null;
let tagEditorSelected: string[] = [];
let tagEditorInitial: string[] = []; // snapshot at open, for has-changes detection
// When non-null, the dialog is in "edit solve" mode: method row is
// visible, the resolver returns method-and-tags instead of just tags.
let editSolveResolve: ((result: { tags: string[]; process: Process } | null) => void) | null = null;
let editSolveInitialProcess: Process | null = null;

function openTagEditor(initial: string[], title = 'Tags'): Promise<string[] | null> {
  const dlg = fsTagEditorDialogEl();
  if (!dlg) return Promise.resolve(null);
  if (tagEditorResolve) { tagEditorResolve(null); tagEditorResolve = null; }
  if (editSolveResolve)  { editSolveResolve(null);  editSolveResolve  = null; }
  tagEditorSelected = initial.slice();
  tagEditorInitial = initial.slice();
  editSolveInitialProcess = null;
  // Tag-only mode: hide the method row.
  fsTagEditorMethodRowEl()?.classList.add('hidden');
  fsTagEditorMethodRowEl()?.classList.remove('flex');
  const titleEl = fsTagEditorTitleEl();
  if (titleEl) titleEl.textContent = title;
  const input = fsTagEditorInputEl();
  if (input) input.value = '';
  renderTagEditorSelected();
  renderTagEditorList('');
  refreshTagEditorButtons();
  dlg.showModal();
  if (input) input.focus();
  return new Promise<string[] | null>(resolve => { tagEditorResolve = resolve; });
}

// Per-row edit dialog: tags + method dropdown. Caller decides what to
// do with method changes (typically: replay phases under the new
// process and persist).
function openEditSolveDialog(record: SolveRecord, title: string): Promise<{ tags: string[]; process: Process } | null> {
  const dlg = fsTagEditorDialogEl();
  if (!dlg) return Promise.resolve(null);
  if (tagEditorResolve) { tagEditorResolve(null); tagEditorResolve = null; }
  if (editSolveResolve)  { editSolveResolve(null);  editSolveResolve  = null; }
  tagEditorSelected = (record.tags ?? []).slice();
  tagEditorInitial = (record.tags ?? []).slice();
  editSolveInitialProcess = record.process;
  // Show method row + sync the select to the record's current method.
  fsTagEditorMethodRowEl()?.classList.remove('hidden');
  fsTagEditorMethodRowEl()?.classList.add('flex');
  const methodSel = fsTagEditorMethodEl();
  if (methodSel) methodSel.value = record.process;
  const titleEl = fsTagEditorTitleEl();
  if (titleEl) titleEl.textContent = title;
  const input = fsTagEditorInputEl();
  if (input) input.value = '';
  renderTagEditorSelected();
  renderTagEditorList('');
  refreshTagEditorButtons();
  dlg.showModal();
  if (input) input.focus();
  return new Promise(resolve => { editSolveResolve = resolve; });
}

// Sort-insensitive comparison: tag order within a solve is not
// meaningful, so re-adding the same set in a different order doesn't
// count as a change.
function tagSetsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = a.slice().sort();
  const sb = b.slice().sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

// Style a button as either the active default (blue) or a
// secondary action (border). When disabled, primary buttons render
// gray-bg via the `disabled:bg-gray-300` rule; secondary buttons
// dim via opacity. Tailwind regenerates these utility classes at
// build time as long as the source string contains them.
const BUTTON_PRIMARY_CLASSES = ['bg-blue-500', 'text-white', 'hover:bg-blue-600', 'disabled:bg-gray-300', 'disabled:cursor-not-allowed'];
const BUTTON_SECONDARY_CLASSES = ['border', 'border-gray-300', 'dark:border-gray-600', 'hover:bg-gray-100', 'dark:hover:bg-gray-700', 'disabled:opacity-40', 'disabled:cursor-not-allowed'];

function setButtonRole(btn: HTMLButtonElement, role: 'primary' | 'secondary') {
  for (const c of BUTTON_PRIMARY_CLASSES) btn.classList.remove(c);
  for (const c of BUTTON_SECONDARY_CLASSES) btn.classList.remove(c);
  const next = role === 'primary' ? BUTTON_PRIMARY_CLASSES : BUTTON_SECONDARY_CLASSES;
  for (const c of next) btn.classList.add(c);
}

// Drive the enabled state AND the primary/secondary role of the Add
// and Save buttons. Whichever is the active "default" (the action
// Enter would trigger) renders as the blue primary button; the other
// uses the secondary border treatment.
//
// Default-button priority:
//   1. Add — whenever the input has text (i.e., a tag can be added).
//   2. Save — when Add is inactive AND the selection has changed
//      from the initial set.
function refreshTagEditorButtons() {
  const input = fsTagEditorInputEl();
  const addBtn = fsTagEditorAddEl();
  const saveBtn = fsTagEditorConfirmEl();
  const normalized = normalizeTag(input?.value ?? '');
  const hasInput = !!normalized;
  // Process names (cfop/roux/f3ul/beginner) can't be added as literal
  // tags — they're already a first-class field on every record (and
  // surface as virtual auto-tags in the filter UI). Disable Add for
  // these so users don't end up with redundant "cfop" tags.
  const isReserved = !!normalized && isProcessName(normalized);
  let hasChanges = !tagSetsEqual(tagEditorSelected, tagEditorInitial);
  // In edit-solve mode, a method change also counts as "has changes".
  if (editSolveResolve && editSolveInitialProcess) {
    const cur = fsTagEditorMethodEl()?.value;
    if (cur && cur !== editSolveInitialProcess) hasChanges = true;
  }
  if (addBtn) {
    addBtn.disabled = !hasInput || isReserved;
    addBtn.title = isReserved
      ? `"${normalized}" is a method name — change it in the Method dropdown instead.`
      : '';
    // Add owns the default slot whenever it's enabled.
    setButtonRole(addBtn, !addBtn.disabled ? 'primary' : 'secondary');
  }
  if (saveBtn) {
    saveBtn.disabled = !hasChanges;
    // Save is primary only when Add isn't claiming the default slot.
    setButtonRole(saveBtn, addBtn?.disabled ? 'primary' : 'secondary');
  }
}

function renderTagEditorSelected() {
  const el = fsTagEditorSelectedEl();
  if (!el) return;
  el.replaceChildren();
  for (const t of tagEditorSelected) {
    const chip = document.createElement('span');
    chip.className = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-100 text-xs';
    chip.textContent = t;
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.className = 'leading-none text-blue-800 dark:text-blue-100 hover:text-red-600';
    x.addEventListener('click', () => {
      tagEditorSelected = tagEditorSelected.filter(s => s !== t);
      renderTagEditorSelected();
      renderTagEditorList(fsTagEditorInputEl()?.value ?? '');
      refreshTagEditorButtons();
    });
    chip.appendChild(x);
    el.appendChild(chip);
  }
}

function renderTagEditorList(filter: string) {
  const el = fsTagEditorListEl();
  if (!el) return;
  const counts = allTagsWithCounts(history);
  const f = normalizeTag(filter) ?? '';
  const all = sortedTagsForDialog(counts, f);
  el.replaceChildren();
  for (const t of all) {
    if (tagEditorSelected.includes(t)) continue;
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between px-2 py-1 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer';
    const label = document.createElement('span');
    label.textContent = t;
    const count = document.createElement('span');
    count.className = 'text-xs text-gray-500';
    count.textContent = String(counts.get(t) ?? 0);
    row.appendChild(label);
    row.appendChild(count);
    row.addEventListener('click', () => addCurrentInputAsTag(t));
    el.appendChild(row);
  }
}

function addCurrentInputAsTag(value: string) {
  const t = normalizeTag(value);
  if (!t) return;
  if (!tagEditorSelected.includes(t)) tagEditorSelected.push(t);
  const input = fsTagEditorInputEl();
  if (input) {
    input.value = '';
    input.focus();
  }
  renderTagEditorSelected();
  renderTagEditorList('');
  refreshTagEditorButtons();
}

function wireTagEditorDialog() {
  const dlg = fsTagEditorDialogEl();
  const input = fsTagEditorInputEl();
  if (!dlg || !input) return;
  fsTagEditorCancelEl()?.addEventListener('click', () => {
    dlg.close();
    if (tagEditorResolve) { tagEditorResolve(null); tagEditorResolve = null; }
    if (editSolveResolve)  { editSolveResolve(null);  editSolveResolve  = null; }
  });
  fsTagEditorAddEl()?.addEventListener('click', () => {
    const i = fsTagEditorInputEl();
    if (i) addCurrentInputAsTag(i.value);
  });
  // Method dropdown (visible only in edit-solve mode) — flip Save's
  // enabled state when the user picks a different process.
  fsTagEditorMethodEl()?.addEventListener('change', () => {
    refreshTagEditorButtons();
  });
  fsTagEditorConfirmEl()?.addEventListener('click', () => {
    // Defensive: if there's uncommitted text in the input, fold it into
    // the selection before saving. The button is already disabled when
    // the selection equals the initial set; this just stops the rare
    // case where the user typed something, didn't press Add, but did
    // change the selection some other way (e.g. removed a chip).
    if (fsTagEditorAddEl() && !fsTagEditorAddEl()!.disabled) {
      const i = fsTagEditorInputEl();
      if (i && normalizeTag(i.value)) addCurrentInputAsTag(i.value);
    }
    dlg.close();
    if (tagEditorResolve) {
      tagEditorResolve(tagEditorSelected.slice());
      tagEditorResolve = null;
    }
    if (editSolveResolve) {
      const method = (fsTagEditorMethodEl()?.value as Process) ?? editSolveInitialProcess!;
      editSolveResolve({ tags: tagEditorSelected.slice(), process: method });
      editSolveResolve = null;
    }
  });
  // ESC closes via native dialog behavior — handle it as cancel.
  dlg.addEventListener('close', () => {
    if (tagEditorResolve) { tagEditorResolve(null); tagEditorResolve = null; }
    if (editSolveResolve)  { editSolveResolve(null);  editSolveResolve  = null; }
  });

  input.addEventListener('input', (e) => {
    // Skip auto-fill on backspace / delete so the user can edit
    // the suffix without it being instantly re-filled.
    const inputType = (e as InputEvent).inputType ?? '';
    const isBackspace = inputType.startsWith('delete');
    const typed = input.value;
    const filter = normalizeTag(typed) ?? '';
    renderTagEditorList(typed);
    refreshTagEditorButtons();
    if (isBackspace || !filter) return;
    const counts = allTagsWithCounts(history);
    const matches = sortedTagsForDialog(counts, filter);
    const top = matches.find(t => !tagEditorSelected.includes(t));
    if (top && top.length > typed.length && top.startsWith(filter)) {
      // Preserve the user's actual capitalization in the typed prefix
      // (normalization is lowercase, but the suffix is appended as-is
      // from the corpus). Then select the suffix so the next keystroke
      // overwrites it.
      const beforeLen = typed.length;
      input.value = typed + top.slice(filter.length);
      input.setSelectionRange(beforeLen, input.value.length);
    }
  });

  // Enter triggers the active default button regardless of where
  // focus currently lives. The listener has to be at the document
  // level (not dialog level) to catch the case where the focused
  // element gets removed by a re-render — at that point the browser
  // moves focus to <body>, which is OUTSIDE the dialog's subtree, so
  // a dialog-bound listener would never fire. The `dlg.open` check
  // scopes us to "tag editor is currently open" so this doesn't
  // intercept Enter anywhere else on the page.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (!dlg.open) return;
    const target = e.target as HTMLElement | null;
    // Let native click fire when Enter is pressed on a focused
    // button inside this dialog (would otherwise double-fire).
    if (target && target.tagName === 'BUTTON' && dlg.contains(target)) return;
    e.preventDefault();
    const addBtn = fsTagEditorAddEl();
    const saveBtn = fsTagEditorConfirmEl();
    if (addBtn && !addBtn.disabled) {
      const i = fsTagEditorInputEl();
      if (i) addCurrentInputAsTag(i.value);
    } else if (saveBtn && !saveBtn.disabled) {
      saveBtn.click();
    }
  });
}

// --- Pre-solve tag UI -------------------------------------------------

function renderPendingTagsDisplay() {
  const el = fsPendingTagsDisplayEl();
  if (!el) return;
  el.textContent = prefs.pendingSolveTags.length > 0
    ? prefs.pendingSolveTags.join(', ')
    : '';
}

async function openPendingTagsEditor() {
  const next = await openTagEditor(prefs.pendingSolveTags, 'Tags for next solve');
  if (next === null) return;
  prefs.pendingSolveTags = next;
  savePrefs();
  renderPendingTagsDisplay();
}

// --- Filter dropdown menu --------------------------------------------

function renderTagsFilterMenu() {
  const sel = fsTagsFilterMenuEl();
  if (!sel) return;
  const current = prefs.graphTagFilter;
  const currentKey = JSON.stringify(current);
  sel.replaceChildren();
  const addOpt = (value: string, label: string, selected: boolean) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (selected) opt.selected = true;
    sel.appendChild(opt);
  };
  const isEmpty = current.include.length === 0 && current.exclude.length === 0;
  addOpt('__all__', 'All Solves', isEmpty);
  for (const r of prefs.recentTagSets) {
    addOpt(JSON.stringify(r), tagFilterLabel(r), JSON.stringify(r) === currentKey);
  }
  addOpt('__select__', 'Select…', false);
}

async function onTagsFilterMenuChange(value: string) {
  if (value === '__select__') {
    await openAdvancedFilterDialog();
    renderTagsFilterMenu();
    return;
  }
  if (value === '__all__') {
    prefs.graphTagFilter = { include: [], exclude: [] };
  } else {
    try {
      prefs.graphTagFilter = JSON.parse(value) as TagFilter;
    } catch {
      prefs.graphTagFilter = { include: [], exclude: [] };
    }
  }
  savePrefs();
  renderTagsFilterMenu();
  renderAllFilterDependent();
}

// --- Advanced filter dialog (3 columns) ------------------------------

type FilterColumn = 'inc' | 'un' | 'exc';

let filterDialogIncl: string[] = [];
let filterDialogExcl: string[] = [];
let filterDialogResolve: (() => void) | null = null;
// The currently-selected tag (any column) — click a chip to select it,
// click it again to deselect. The header + buttons in other columns
// become enabled while a tag is selected.
let filterDialogSelected: string | null = null;

function openAdvancedFilterDialog(): Promise<void> {
  const dlg = fsTagsFilterDialogEl();
  if (!dlg) return Promise.resolve();
  filterDialogIncl = prefs.graphTagFilter.include.slice();
  filterDialogExcl = prefs.graphTagFilter.exclude.slice();
  filterDialogSelected = null;
  renderAdvancedFilterDialog();
  dlg.showModal();
  return new Promise<void>(resolve => { filterDialogResolve = resolve; });
}

// Where does a tag live right now? Used both for + button enablement
// (must be a different column than the one offering the move) and for
// the drag-and-drop "no-op when dropped on its own column" case.
function columnOfTag(tag: string): FilterColumn {
  if (filterDialogIncl.includes(tag)) return 'inc';
  if (filterDialogExcl.includes(tag)) return 'exc';
  return 'un';
}

function moveTagToColumn(tag: string, target: FilterColumn) {
  filterDialogIncl = filterDialogIncl.filter(t => t !== tag);
  filterDialogExcl = filterDialogExcl.filter(t => t !== tag);
  if (target === 'inc') filterDialogIncl.push(tag);
  else if (target === 'exc') filterDialogExcl.push(tag);
  // 'un' is implicit — not in either list.
  renderAdvancedFilterDialog();
}

function renderAdvancedFilterDialog() {
  const incEl = fsFilterIncludeEl();
  const unEl = fsFilterUnselectedEl();
  const excEl = fsFilterExcludeEl();
  if (!incEl || !unEl || !excEl) return;
  const counts = allTagsWithCounts(history);
  const allTags = Array.from(counts.keys()).sort();
  const unselected = allTags.filter(t => !filterDialogIncl.includes(t) && !filterDialogExcl.includes(t));

  const makeChip = (tag: string) => {
    const chip = document.createElement('div');
    const selected = filterDialogSelected === tag;
    const reserved = isProcessName(tag);
    // Process names (virtual auto-tags) get italic + neutral border to
    // match the row-chip style; selected state still uses blue ring.
    const base = reserved
      ? 'border-gray-400 dark:border-gray-500 text-gray-700 dark:text-gray-200 italic hover:bg-gray-50 dark:hover:bg-gray-700'
      : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700';
    chip.className = `flex items-center px-3 py-1 rounded-full border text-xs cursor-pointer select-none ${
      selected ? 'border-blue-500 bg-blue-50 dark:bg-blue-900 ring-2 ring-blue-400' : base
    }`;
    chip.draggable = true;
    chip.textContent = tag;
    chip.addEventListener('click', () => {
      filterDialogSelected = filterDialogSelected === tag ? null : tag;
      renderAdvancedFilterDialog();
    });
    chip.addEventListener('dragstart', (e) => {
      filterDialogSelected = tag;
      if (e.dataTransfer) {
        e.dataTransfer.setData('text/plain', tag);
        e.dataTransfer.effectAllowed = 'move';
      }
    });
    return chip;
  };

  incEl.replaceChildren(...filterDialogIncl.map(makeChip));
  excEl.replaceChildren(...filterDialogExcl.map(makeChip));
  unEl.replaceChildren(...unselected.map(makeChip));

  // + buttons: enabled only when a tag is selected AND it currently
  // lives in a DIFFERENT column. (Moving a tag to its current column
  // would be a no-op.)
  const selected = filterDialogSelected;
  const sourceCol = selected ? columnOfTag(selected) : null;
  const setMoveBtn = (btn: HTMLButtonElement | null, col: FilterColumn) => {
    if (!btn) return;
    btn.disabled = !selected || sourceCol === col;
  };
  setMoveBtn(fsFilterMoveIncludeEl(), 'inc');
  setMoveBtn(fsFilterMoveUnselectedEl(), 'un');
  setMoveBtn(fsFilterMoveExcludeEl(), 'exc');
}

function wireAdvancedFilterDialog() {
  const dlg = fsTagsFilterDialogEl();
  if (!dlg) return;
  fsFilterClearEl()?.addEventListener('click', () => {
    filterDialogIncl = [];
    filterDialogExcl = [];
    filterDialogSelected = null;
    renderAdvancedFilterDialog();
  });
  fsFilterCancelEl()?.addEventListener('click', () => {
    dlg.close();
  });
  fsFilterConfirmEl()?.addEventListener('click', () => {
    const next: TagFilter = {
      include: filterDialogIncl.slice(),
      exclude: filterDialogExcl.slice(),
    };
    prefs.graphTagFilter = next;
    prefs.recentTagSets = pushRecentTagSet(prefs.recentTagSets, next);
    savePrefs();
    dlg.close();
    renderAllFilterDependent();
  });

  // + button per column: move the selected tag here. The buttons are
  // disabled in renderAdvancedFilterDialog whenever the move would be
  // a no-op (no selection / same column).
  const wireMove = (btn: HTMLButtonElement | null, target: FilterColumn) => {
    btn?.addEventListener('click', () => {
      if (filterDialogSelected) moveTagToColumn(filterDialogSelected, target);
    });
  };
  wireMove(fsFilterMoveIncludeEl(), 'inc');
  wireMove(fsFilterMoveUnselectedEl(), 'un');
  wireMove(fsFilterMoveExcludeEl(), 'exc');

  // Drag-and-drop targets: each column accepts drops of any chip.
  const wireDrop = (el: HTMLElement | null, target: FilterColumn) => {
    if (!el) return;
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const tag = e.dataTransfer?.getData('text/plain') ?? '';
      if (!tag) return;
      if (columnOfTag(tag) === target) return;  // no-op
      moveTagToColumn(tag, target);
    });
  };
  wireDrop(fsFilterIncludeEl(), 'inc');
  wireDrop(fsFilterUnselectedEl(), 'un');
  wireDrop(fsFilterExcludeEl(), 'exc');

  dlg.addEventListener('close', () => {
    if (filterDialogResolve) { filterDialogResolve(); filterDialogResolve = null; }
  });
}

// ---------- Public API ----------

export function initFullSolve() {
  wireEvents();
  applyPrefsToUI();
  // phaseSeq must be initialised BEFORE applyFullSolveMode, since the latter
  // calls renderStatsLegend which builds the per-phase color key from phaseSeq.
  phaseSeq = currentPhaseSequence();
  phaseTimestamps = phaseSeq.map(() => null);
  phaseReachedAtMoveIdx = phaseSeq.map(() => -1);
  applyFullSolveMode();
  renderGraph();
  renderSolveList();
  // Re-render the chart + legend when the user toggles dark mode so the
  // Ao5/Ao12 trendlines pick up the new contrast colors.
  new MutationObserver(() => {
    if (!prefs.enabled) return;
    renderGraph();
    renderStatsLegend();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
}

export function fsOnPhysicalMove(move: string) {
  if (!prefs.enabled) return;
  if (!move) return;

  // Apply the move to our internal pattern first so all downstream checks
  // (scramble-progress, phase transitions) use a freshly-computed state.
  // Using our own pattern here avoids missing phase transitions when the
  // tracker's pattern-change stream drops intermediates on fast solves.
  if (myPattern) {
    try { myPattern = myPattern.applyMove(move); } catch { /* ignore unknown moves */ }
  }
  let myFacelets: string | null = null;
  if (myPattern) {
    try { myFacelets = patternToFacelets(myPattern); } catch { /* ignore */ }
  }

  if (mode === 'scrambling') {
    onScrambleMove(move);
    if (myFacelets) resolveScrambleProgressFromPattern(myFacelets);
  } else if (mode === 'inspection') {
    // First solving move starts the solve timer, whether in 'pause' mode or
    // during a countdown inspection (WCA-style early start).
    if (inspectionTimeoutHandle !== null) {
      clearTimeout(inspectionTimeoutHandle);
      inspectionTimeoutHandle = null;
    }
    startSolving();
    onSolveMove(move);
    if (myFacelets) evaluatePhaseTransitions(myFacelets);
  } else if (mode === 'solving') {
    onSolveMove(move);
    if (myFacelets) evaluatePhaseTransitions(myFacelets);
  } else if (mode === 'paused') {
    // During pause the timer is frozen but the cube is still being
    // turned — let the pause state machine classify the move (reverse /
    // redo / wayward) and re-render the investigation surface.
    onSolveMove(move);
  }
}

export function fsOnPattern(pattern: KPattern) {
  lastPattern = pattern;
  // Resync our internal pattern from the tracker. fsOnPhysicalMove applies
  // moves synchronously, but the tracker's pattern listener is the source
  // of truth — adopting it here lets us recover if applyMove ever rejected
  // a move or drifted for any other reason.
  if (mode === 'scrambling' || mode === 'inspection' || mode === 'solving' || mode === 'paused') {
    myPattern = pattern;
  }
  let facelets: string;
  try { facelets = patternToFacelets(pattern); } catch { return; }
  const wasSolved = cubeIsSolved;
  cubeIsSolved = isSolved(facelets);
  if (prefs.enabled && wasSolved !== cubeIsSolved) {
    renderSolveList();
  }
  if (!prefs.enabled) return;
  if (mode === 'scrambling') {
    resolveScrambleProgressFromPattern(facelets);
  } else if (mode === 'solving') {
    evaluatePhaseTransitions(facelets);
  }
}

export function fsSetCubeConnected(connected: boolean) {
  cubeConnected = connected;
  updateCubeGate();
  if (connected && prefs.enabled && mode === 'idle') {
    // Cube just connected — kick off a scramble to solve.
    void newScramble();
  }
  if (!connected && (mode === 'scrambling' || mode === 'inspection' || mode === 'solving' || mode === 'paused')) {
    // Cube disconnected mid-flow; abort and return to idle. The status
    // line shows the "Connect a smart cube…" banner via updateCubeGate.
    resetSolveState();
  }
}

export function isFullSolveModeEnabled(): boolean {
  return prefs.enabled;
}

// ---------- Peer scramble-sharing API ----------
// index.ts owns the network connection; it bridges Full Solve to the
// peer by registering a callback that fires on every local scramble
// change (when sharing is on), and by calling applyRemoteFsScramble when
// a remote scramble arrives.

export function setOnLocalScrambleChange(cb: ((scramble: string) => void) | null): void {
  onLocalScrambleChange = cb;
}

// Fires when the local share switch toggles. index.ts broadcasts the new
// state to the peer via 'fs-share' so its UI greys/un-greys appropriately.
export function setOnShareStateChange(cb: ((sharing: boolean) => void) | null): void {
  onShareStateChange = cb;
}

// Local switch: are WE the active sharer? Sender side broadcasts on
// every scramble change.
export function setSharingScrambles(on: boolean): void {
  sharingScrambles = on;
  updateShareScramblesUi();
  // Notify the network bridge so the peer's UI can update + grey out.
  if (onShareStateChange) onShareStateChange(on);
  // When we start sharing, also broadcast our current scramble so the
  // peer's UI immediately syncs.
  if (on && currentScramble && onLocalScrambleChange) {
    onLocalScrambleChange(currentScramble);
  }
}
export function isSharingScrambles(): boolean { return sharingScrambles; }

// Read-only accessor used by index.ts so a freshly-connected peer can be
// sent the current FS scramble in the initial 'state' message.
export function getCurrentFsScramble(): string { return currentScramble; }

// Tracks whether the PEER is currently sharing. When true, our local
// switch is greyed out (per the "only one at a time" rule).
export function setPeerSharingScrambles(on: boolean): void {
  peerSharingScrambles = on;
  // If the peer just claimed sharing, give up our own claim (race).
  if (on && sharingScrambles) {
    sharingScrambles = false;
  }
  updateShareScramblesUi();
}

// Apply a scramble received from the peer. Routes through newScramble
// so all the usual scramble-setup happens, but suppresses the local-
// change callback to prevent an echo back to the sender.
export function applyRemoteFsScramble(scramble: string): void {
  if (!prefs.enabled) return;  // Full Solve isn't on locally — ignore.
  pendingScramble = scramble;
  applyingRemoteScramble = true;
  void newScramble().finally(() => { applyingRemoteScramble = false; });
}

// Net connection state. When disconnected, force the share switch off
// and clear peer state so the UI returns to single-user mode.
export function setNetConnected(connected: boolean): void {
  if (!connected) {
    if (sharingScrambles) sharingScrambles = false;
    peerSharingScrambles = false;
  }
  updateShareScramblesUi();
}

function updateShareScramblesUi(): void {
  const wrap = document.getElementById('fs-share-scrambles-wrap');
  const cb = document.getElementById('fs-share-scrambles') as HTMLInputElement | null;
  if (!wrap || !cb) return;
  // Visible only when Full Solve is on AND the peer is connected.
  // (index.ts sets the peer-connection state on us via setNetConnected.)
  const netConnected = wrap.dataset.netConnected === '1';
  const visible = prefs.enabled && netConnected;
  wrap.classList.toggle('hidden', !visible);
  wrap.classList.toggle('flex', visible);
  cb.checked = sharingScrambles;
  cb.disabled = peerSharingScrambles;
  wrap.title = peerSharingScrambles ? 'Partner is currently sharing scrambles' : '';
}

// Called by index.ts on connection state change. Sets the data
// attribute the visibility check reads, then re-runs the UI sync.
export function setShareScramblesNetVisible(netConnected: boolean): void {
  const wrap = document.getElementById('fs-share-scrambles-wrap');
  if (wrap) wrap.dataset.netConnected = netConnected ? '1' : '0';
  setNetConnected(netConnected);
}
