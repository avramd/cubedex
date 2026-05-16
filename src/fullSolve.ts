import { Alg } from 'cubing/alg';
import { cube3x3x3 } from 'cubing/puzzles';
import { KPattern, KPuzzle } from 'cubing/kpuzzle';
import { Chart, registerables } from 'chart.js';
import { patternToFacelets } from './utils';
import { type Face, FACES, faceStickers, isSolved } from './cube/facelets';
import {
  isCrossDoneOn, isF2LDoneOn, isEOLLDoneOn, isOllDoneOn, isHeadlightsDoneOn,
  f2lSlotsDoneOn,
} from './cube/predicates';
import { generateRandomScramble3x3 } from './cube/scramble';
import { type Process, type SolveRecord } from './fullSolve/types';
import { moveClass, collapseDoubles, parseScramble } from './fullSolve/moves';
import { classifyMoves } from './fullSolve/classify';
import { PHASE_KEY_LABELS, phaseMsForDisplay } from './fullSolve/aggregate';
import { mergeImportedHistory as mergeHistoryPure } from './fullSolve/historyMerge';
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
  if (r.process === 'beginner') return null;
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

function importHistoryFromText(text: string) {
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { alert('Import failed: invalid JSON.'); return; }
  if (!Array.isArray(parsed)) { alert('Import failed: expected a JSON array of solves.'); return; }
  const before = history.length;
  const { added, replaced, skipped } = mergeImportedHistory(parsed);
  // Imported records may have `turns` but no `f2lSplits`; replay them so
  // the F2L-slots toggle has data to show.
  backfillF2lSplits();
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

// ---------- Phase sequences ----------

// Index 0 (cross) and index 4 (CPLL) are swapped from a natural rainbow
// so the two 2-look pairs sit adjacent on the colour wheel:
//   2-look OLL:  yellow (EOLL) → orange (OCLL)
//   2-look PLL:  blue (CPLL)   → purple (EPLL)
const PHASE_COLORS = [
  'rgba(236, 72, 153, 0.6)',   // pink — cross
  // F2L runs at alpha 0.75 so the unsplit / no-data band reads at the
  // same saturation as the topmost sub-band when the F2L-slots toggle is
  // on. F2L is usually the largest phase by far, so its higher contrast
  // is also visually appropriate.
  'rgba(16, 185, 129, 0.75)',  // green — F2L
  'rgba(234, 179, 8, 0.6)',    // yellow — yellow-cross (2-look OLL) / OLL
  'rgba(249, 115, 22, 0.6)',   // orange — full OLL (2-look OLL) / headlights (2-look PLL)
  'rgba(59, 130, 246, 0.6)',   // blue — CPLL (2-look PLL)
  'rgba(139, 92, 246, 0.6)',   // purple — EPLL / PLL
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
  return [
    { key: 'cross', label: 'Cross', predicate: isCrossDone, color: PHASE_COLORS[0] },
    { key: 'f2l',   label: 'F2L',   predicate: isF2LDone,   color: PHASE_COLORS[1] },
    { key: 'eoll',  label: 'EOLL',  predicate: isYellowCrossDone, color: PHASE_COLORS[2] },
    { key: 'ocll',  label: 'OCLL',  predicate: isOllDone,   color: PHASE_COLORS[3] },
    { key: 'cpll',  label: 'CPLL',  predicate: (f) => isOllDone(f) && isHeadlightsDone(f), color: PHASE_COLORS[4] },
    { key: 'epll',  label: 'EPLL',  predicate: isSolved,    color: PHASE_COLORS[5] },
  ];
}

// What the legend and stacked-area graph show. Collapses EOLL+OCLL into
// a single OLL band (and CPLL+EPLL into PLL) when the respective 2-look
// toggle is off, taking the higher-stacked subphase's color so the
// aggregate visually matches the top of the split stack.
function displayPhaseSequence(): PhaseDef[] {
  const seq = currentPhaseSequence();
  if (prefs.process !== 'cfop') return seq;
  const out: PhaseDef[] = [];
  for (let i = 0; i < seq.length; i++) {
    const p = seq[i];
    if (!prefs.twoLookOll && p.key === 'eoll' && seq[i + 1]?.key === 'ocll') {
      out.push({ key: 'oll', label: 'OLL', predicate: seq[i + 1].predicate, color: seq[i + 1].color });
      i++;
    } else if (!prefs.twoLookPll && p.key === 'cpll' && seq[i + 1]?.key === 'epll') {
      out.push({ key: 'pll', label: 'PLL', predicate: seq[i + 1].predicate, color: seq[i + 1].color });
      i++;
    } else {
      out.push(p);
    }
  }
  return out;
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
const fsCfopOptionsEl = () => $$('fs-cfop-options');
const fsScrambleEl = () => $$('fs-scramble-display');
const fsTimerEl = () => $$('fs-timer');
const fsStatusEl = () => $$('fs-status');
const fsSolutionMovesEl = () => $$('fs-solution-moves');
const fsRetraceHintEl = () => $$('fs-retrace-hint');
const fsPauseBtnEl = () => $$<HTMLButtonElement>('fs-pause-btn');
const fsAbortBtnEl = () => $$<HTMLButtonElement>('fs-abort-btn');
const fsNewScrambleBtnEl = () => $$<HTMLButtonElement>('fs-new-scramble-btn');
const fsPasteScrambleBtnEl = () => $$<HTMLButtonElement>('fs-paste-scramble-btn');
const fsSolveListEl = () => $$('fs-solve-list');
const fsSolveListHintEl = () => $$('fs-solve-list-hint');
const fsExportHistoryBtnEl = () => $$<HTMLButtonElement>('fs-export-history');
const fsImportHistoryBtnEl = () => $$<HTMLButtonElement>('fs-import-history');
const fsImportHistoryInputEl = () => $$<HTMLInputElement>('fs-import-history-input');
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
let inspectionStartMs = 0;
let inspectionTimeoutHandle: number | null = null;
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

// Graph
let graphChart: Chart | null = null;

// Click-to-focus on a phase group in the main history graph. null = no
// focus (full stack visible). Set by a click within a phase band; cleared
// by a click outside the focused band (or on the cross / empty space).
let focusedPhaseGroup: 'f2l' | 'll' | null = null;

const F2L_KEYS = new Set(['f2l', 'f2l_1', 'f2l_2', 'f2l_3', 'f2l_4']);
const LL_KEYS  = new Set(['oll', 'pll', 'eoll', 'ocll', 'cpll', 'epll', 'll']);

function groupOfKey(k: string): 'cross' | 'f2l' | 'll' | null {
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
  // Build a per-phase legend that matches the stacked-area dataset colors
  // currently in `phaseSeq`. Trendlines (Ao5/Ao12) get appended.
  const el = statsLegendEl();
  if (!el) return;
  const items: string[] = [];
  displayPhaseSequence().forEach((p) => {
    // Legend swatches use the phase's hue at full opacity (regardless of
    // the band's stacked-area alpha). Match-and-replace the alpha value.
    const color = p.color.replace(/,\s*[\d.]+\)\s*$/, ', 1)');
    items.push(`<span class="flex items-center gap-1"><span style="display:inline-block;width:14px;height:10px;border-radius:2px;background-color:${color};flex-shrink:0"></span>${p.label}</span>`);
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
  const totals = history.map(r => r.totalMs);
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
  const recentRecords = history.slice(-12);
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
  fsCfopOptionsEl()?.classList.toggle('hidden', prefs.process !== 'cfop');
  fsCfopOptionsEl()?.classList.toggle('flex', prefs.process === 'cfop');
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

function invertMoves(moves: string[]): string[] {
  return moves.slice().reverse().map(invertMove);
}

function invertMove(m: string): string {
  if (m.endsWith("'")) return m.slice(0, -1);
  if (m.endsWith('2')) return m;
  return m + "'";
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
  if (el) setFormattedMoves(el, collapseDoubles(solveMoves).join(' '));
}

function renderRetraceHint() {
  // The hint shows the inverse of moves taken since the most recent passed phase boundary
  // (or since solve start), so the user can step back to that checkpoint.
  const el = fsRetraceHintEl();
  if (!el) return;
  if (mode !== 'paused') { el.replaceChildren(); return; }
  const checkpointIdx = lastReachedPhaseMoveIndex();
  const recent = solveMoves.slice(checkpointIdx);
  setFormattedMoves(el, collapseDoubles(invertMoves(recent)).join(' '));
}

function lastReachedPhaseMoveIndex(): number {
  // Find the move index at which the most recent phase was completed.
  // phaseTimestamps[i] is the timestamp when phase[i] was reached; we also store
  // a parallel array of move indices so we know where each phase ended.
  // For simplicity (and since we only need "last passed boundary"), look backwards
  // through phaseReachedAtMoveIdx.
  for (let i = phaseReachedAtMoveIdx.length - 1; i >= 0; i--) {
    if (phaseReachedAtMoveIdx[i] >= 0) return phaseReachedAtMoveIdx[i];
  }
  return 0;
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
  const abortBtn = fsAbortBtnEl();
  if (abortBtn) abortBtn.disabled = false;
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
  solveMoves = [];
  solveTurns = [];
  solveF2lSplits = [];
  f2lSlotsEverDone = 0;
  halfwayActive = false;
  detectedCrossFace = null;
  phaseSeq = currentPhaseSequence();
  phaseTimestamps = phaseSeq.map(() => null);
  phaseReachedAtMoveIdx = phaseSeq.map(() => -1);
  const pauseBtn = fsPauseBtnEl();
  if (pauseBtn) { pauseBtn.disabled = true; pauseBtn.textContent = 'Pause'; }
  const abortBtn = fsAbortBtnEl();
  if (abortBtn) abortBtn.disabled = true;
  renderTimer();
  renderSolutionMoves();
  renderRetraceHint();
}

function abortSolve() {
  // Discard the current run (not recorded) and queue a new scramble.
  renderStatus('Run aborted — new scramble coming up…');
  void newScramble();
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
      if (mode === 'inspection') startSolving();
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
  if (mode === 'paused') return; // moves ignored while paused, but still added to history if user wants? For now, ignore.
  solveMoves.push(move);
  solveTurns.push((Date.now() - solveStartMs - pausedAccumMs) / 1000);
  renderSolutionMoves();
}

// Sample the F2L slot-count progression. Each strict increase in slot
// count pushes one entry to solveF2lSplits (ms since solveStart). Bounded
// to 4 entries (the 4 F2L slots). Skipped for beginner mode (no F2L
// phase) and before cross has been detected.
function sampleF2lSlotProgression(facelets: string, now: number) {
  if (prefs.process === 'beginner') return;
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

function evaluatePhaseTransitions(facelets: string) {
  if (mode !== 'solving') return;
  const now = Date.now() - pausedAccumMs;
  const fired: string[] = [];
  for (let i = 0; i < phaseSeq.length; i++) {
    if (phaseTimestamps[i] !== null) continue;
    if (i > 0 && phaseTimestamps[i - 1] === null) continue;
    if (phaseSeq[i].predicate(facelets)) {
      phaseTimestamps[i] = now;
      phaseReachedAtMoveIdx[i] = solveMoves.length;
      fired.push(phaseSeq[i].label);
      renderStatus(`Phase reached: ${phaseSeq[i].label}`);
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
    turns: solveTurns.slice(),
    // Only attach when we actually recorded splits — keeps records small
    // for runs that didn't hit the F2L phase (e.g. beginner mode).
    ...(solveF2lSplits.length > 0 ? { f2lSplits: solveF2lSplits.slice() } : {}),
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
    renderTimer();
    renderRetraceHint();
    const pauseBtn = fsPauseBtnEl();
    if (pauseBtn) pauseBtn.textContent = 'Resume';
    renderStatus('Paused — retrace or investigate, then resume.');
  } else if (mode === 'paused') {
    pausedAccumMs += Date.now() - pauseStartedAtMs;
    pauseStartedAtMs = 0;
    mode = 'solving';
    renderRetraceHint();
    startTimerLoop();
    const pauseBtn = fsPauseBtnEl();
    if (pauseBtn) pauseBtn.textContent = 'Pause';
    renderStatus('Solving…');
  }
}

// ---------- Graph ----------

function renderGraph() {
  const canvas = fsGraphCanvasEl();
  if (!canvas) return;
  const range = Math.max(1, Math.min(history.length, prefs.graphRange));
  const slice = history.slice(-range);
  if (slice.length === 0) {
    if (graphChart) { graphChart.destroy(); graphChart = null; }
    return;
  }
  // The graph reflects the CURRENT phase sequence only — so 2-look modes
  // hide the combined 'oll'/'pll' labels even if past solves recorded them
  // and vice versa. Solves that lack a key default to 0 duration (the band
  // for that phase sits on top of the band below).
  //
  // When the "F2L slots" toggle is on, expand the F2L key into 4 sub-band
  // keys (f2l_1..f2l_4) so each renders as a separately-coloured stacked
  // band. phaseMsForDisplay handles the per-record split using r.f2lSplits.
  const displaySeq = displayPhaseSequence();
  let keyOrder = displaySeq.map(p => p.key);
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
      keyOrder = displaySeq.map(p => p.key);
    }
  }
  const labels = slice.map((_, i) => `${history.length - slice.length + i + 1}`);

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
    const def = displaySeq.find(p => p.key === k);
    return def?.color ?? PHASE_COLORS[0];
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
  // per solve and let each dataset fill down to the previous one.
  const cumulative: number[][] = slice.map(() => []);
  slice.forEach((r, solveIdx) => {
    let acc = 0;
    for (const k of keyOrder) {
      acc += phaseMsForDisplay(r, k) / 1000;
      cumulative[solveIdx].push(acc);
    }
  });

  const datasets: any[] = keyOrder.map((k, kIdx) => {
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
    let sum = 0;
    for (const k of keyOrder) sum += phaseMsForDisplay(r, k);
    return sum / 1000;
  };
  const totals = slice.map(recordTotalSec);
  // Ao5/Ao12 are computed over ALL history, then tail-sliced to the
  // visible window. Otherwise the first few entries in the window can't
  // form a complete window of size N and the trendline would flat-line
  // at null even when prior data exists to compute it from.
  const allTotals = history.map(recordTotalSec);
  const tailOf = (arr: (number | null)[]) => arr.slice(-slice.length);
  const ao5Series = prefs.graphAo5 ? tailOf(rollingAverage(allTotals, 5)) : null;
  const ao12Series = prefs.graphAo12 ? tailOf(rollingAverage(allTotals, 12)) : null;
  const isDark = document.documentElement.classList.contains('dark');
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

  // Plugin: shade the initial idle period of each visible phase. The
  // shaded area is a continuous polygon between two lines, one solve to
  // the next: the bottom edge follows the end of the previous phase
  // (i.e. the band's lower boundary) and the top edge follows that line
  // raised by the idle ms (the gap before the first turn of the phase).
  // Only renders in focus views — F2L or LL — where the rebaseline-from-
  // zero view makes the idle stripe legible.
  const idleShadingPlugin = {
    id: 'idleShading',
    afterDatasetsDraw(chart: any) {
      if (!focusedPhaseGroup) return;
      if (slice.length === 0) return;
      const xScale = chart.scales.x;
      const yScale = chart.scales.y;
      const ctx: CanvasRenderingContext2D = chart.ctx;
      const xs = slice.map((_, i) => xScale.getPixelForValue(i));
      const isDark = document.documentElement.classList.contains('dark');
      ctx.save();
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.20)';
      // Track the "previous phase top" line as we walk keyOrder; for the
      // first key it's just 0 (chart origin).
      let prevValuesSec: number[] = slice.map(() => 0);
      for (let i = 0; i < keyOrder.length; i++) {
        const key = keyOrder[i];
        const currentValuesSec = slice.map((_, col) => cumulative[col][i]);
        const idleTopsSec = slice.map((r, col) => {
          const phaseSec = currentValuesSec[col] - prevValuesSec[col];
          if (phaseSec <= 0) return prevValuesSec[col];
          const idleMs = phaseIdleMsFor(r, key);
          const idleSec = Math.min(idleMs / 1000, phaseSec);
          return prevValuesSec[col] + idleSec;
        });
        const anyIdle = idleTopsSec.some((v, col) => v > prevValuesSec[col]);
        if (anyIdle) {
          ctx.beginPath();
          // Left-to-right along the bottom edge (previous phase top).
          for (let col = 0; col < slice.length; col++) {
            const x = xs[col];
            const y = yScale.getPixelForValue(prevValuesSec[col]);
            if (col === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          // Right-to-left along the top edge (first-turn line). Columns
          // with zero idle naturally collapse the polygon onto its
          // bottom edge there, so the shaded region tapers correctly.
          for (let col = slice.length - 1; col >= 0; col--) {
            const x = xs[col];
            const y = yScale.getPixelForValue(idleTopsSec[col]);
            ctx.lineTo(x, y);
          }
          ctx.closePath();
          ctx.fill();
        }
        prevValuesSec = currentValuesSec;
      }
      ctx.restore();
    },
  };

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
          let sumMs = 0;
          for (const k of keyOrder) sumMs += phaseMsForDisplay(r, k);
          totalSec = sumMs / 1000;
        } else if (focusedPhaseGroup === 'll') {
          totalLabel = 'LL';
          let sumMs = 0;
          for (const k of keyOrder) sumMs += phaseMsForDisplay(r, k);
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
    plugins: [idleShadingPlugin, inlineSplitLabels],
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

  fsPauseBtnEl()?.addEventListener('click', () => {
    togglePause();
  });

  fsAbortBtnEl()?.addEventListener('click', () => {
    if (mode === 'idle' || mode === 'done') return;
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
    // Moves while paused are ignored (user is investigating / retracing).
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
