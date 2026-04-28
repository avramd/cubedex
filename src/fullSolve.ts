import { Alg } from 'cubing/alg';
import { cube3x3x3 } from 'cubing/puzzles';
import { KPattern, KPuzzle } from 'cubing/kpuzzle';
import { Chart, registerables } from 'chart.js';
import { patternToFacelets } from './utils';

Chart.register(...registerables);

// ---------- Types ----------

export type Process = 'cfop' | 'beginner';
export type Inspection = '3' | '5' | '10' | '15' | 'pause';

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
}

interface PhaseDef {
  key: string;
  label: string;
  // Check whether this phase's target state has been reached, given the current facelets string.
  predicate: (facelets: string) => boolean;
  color: string;
}

interface SolveRecord {
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

// Merge `incoming` into `history`, deduping by `ts`. On collision, keep the
// shorter `totalMs` (treats the same physical solve recorded twice as the
// canonical one — slower duplicates are usually re-derivations or imports
// from a less-trimmed copy). Returns counts for an after-the-fact summary.
function mergeImportedHistory(incoming: any[]): { added: number; replaced: number; skipped: number } {
  const byTs = new Map<number, SolveRecord>();
  for (const r of history) byTs.set(r.ts, r);
  let added = 0, replaced = 0, skipped = 0;
  for (const r of incoming) {
    if (!r || typeof r.ts !== 'number' || typeof r.totalMs !== 'number' ||
        typeof r.scramble !== 'string' || typeof r.solution !== 'string' ||
        !r.phases || typeof r.process !== 'string') {
      skipped++;
      continue;
    }
    const existing = byTs.get(r.ts);
    if (!existing) {
      byTs.set(r.ts, r as SolveRecord);
      added++;
    } else if (r.totalMs < existing.totalMs) {
      byTs.set(r.ts, r as SolveRecord);
      replaced++;
    }
  }
  history = Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
  while (history.length > HISTORY_CAP) history.shift();
  saveHistory();
  return { added, replaced, skipped };
}

function importHistoryFromText(text: string) {
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { alert('Import failed: invalid JSON.'); return; }
  if (!Array.isArray(parsed)) { alert('Import failed: expected a JSON array of solves.'); return; }
  const before = history.length;
  const { added, replaced, skipped } = mergeImportedHistory(parsed);
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

// ---------- Facelet helpers & phase predicates ----------
// Facelet string order (Kociemba): URFDLB, 9 stickers per face, each face in reading order.
//   0 1 2
//   3 4 5    (index 4 is the center)
//   6 7 8

const FACE_OFFSET: Record<'U'|'R'|'F'|'D'|'L'|'B', number> = {
  U: 0, R: 9, F: 18, D: 27, L: 36, B: 45,
};

function faceStickers(facelets: string, face: 'U'|'R'|'F'|'D'|'L'|'B'): string[] {
  const o = FACE_OFFSET[face];
  return facelets.slice(o, o + 9).split('');
}

function isFaceMono(facelets: string, face: 'U'|'R'|'F'|'D'|'L'|'B'): boolean {
  const s = faceStickers(facelets, face);
  return s.every(c => c === s[4]);
}

function isSolved(facelets: string): boolean {
  return (['U','R','F','D','L','B'] as const).every(f => isFaceMono(facelets, f));
}

// ---- Color-neutral cube geometry ----
// Speedcubers solve color-neutral: the "cross face" is whichever face the
// cuber chose to put on the bottom for this solve. We don't know which until
// it shows up in the cube state, so each phase predicate dispatches over all
// 6 candidates until one matches; that face is then locked for the rest of
// the solve via `detectedCrossFace`.

type Face = 'U'|'R'|'F'|'D'|'L'|'B';
const FACES: readonly Face[] = ['U','D','F','B','R','L'] as const;
const OPPOSITE: Record<Face, Face> = { U:'D', D:'U', F:'B', B:'F', R:'L', L:'R' };

// For each cross face X, the 4 (sideFace, stickerIndexOnSide) pairs that
// touch X's edge stickers — i.e., for cross to be done, every side face's
// adjacent middle-edge sticker must match its center.
const CROSS_ADJ: Record<Face, [Face, number][]> = {
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
const F2L_BAND: Record<Face, [Face, number[]][]> = {
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
const HEADLIGHT: Record<Face, [Face, [number, number]][]> = {
  U: [['F',[6,8]],['R',[6,8]],['B',[6,8]],['L',[6,8]]],
  D: [['F',[0,2]],['R',[0,2]],['B',[0,2]],['L',[0,2]]],
  F: [['U',[0,2]],['R',[2,8]],['D',[6,8]],['L',[0,6]]],
  B: [['U',[6,8]],['R',[0,6]],['D',[0,2]],['L',[2,8]]],
  R: [['U',[0,6]],['F',[0,6]],['D',[0,6]],['B',[2,8]]],
  L: [['U',[2,8]],['F',[2,8]],['D',[2,8]],['B',[0,6]]],
};

function isCrossDoneOn(face: Face, facelets: string): boolean {
  const X = faceStickers(facelets, face);
  if (X[1] !== X[4] || X[3] !== X[4] || X[5] !== X[4] || X[7] !== X[4]) return false;
  for (const [side, idx] of CROSS_ADJ[face]) {
    const s = faceStickers(facelets, side);
    if (s[idx] !== s[4]) return false;
  }
  return true;
}

function isF2LDoneOn(face: Face, facelets: string): boolean {
  if (!isFaceMono(facelets, face)) return false;
  for (const [side, indices] of F2L_BAND[face]) {
    const s = faceStickers(facelets, side);
    const c = s[4];
    for (const i of indices) if (s[i] !== c) return false;
  }
  return true;
}

// EOLL: 4 edges of the OLL (= opposite-of-cross) face match that face's center.
function isEOLLDoneOn(face: Face, facelets: string): boolean {
  const opp = faceStickers(facelets, OPPOSITE[face]);
  return opp[1] === opp[4] && opp[3] === opp[4] && opp[5] === opp[4] && opp[7] === opp[4];
}

// OLL: opposite face is monochrome.
function isOllDoneOn(face: Face, facelets: string): boolean {
  return isFaceMono(facelets, OPPOSITE[face]);
}

// Headlights: each side face's 2 OLL-side corners match each other.
function isHeadlightsDoneOn(face: Face, facelets: string): boolean {
  for (const [side, [a, b]] of HEADLIGHT[face]) {
    const s = faceStickers(facelets, side);
    if (s[a] !== s[b]) return false;
  }
  return true;
}

// ---- Cross-face detection (locked once detected per solve) ----

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
  'rgba(16, 185, 129, 0.6)',   // green — F2L
  'rgba(234, 179, 8, 0.6)',    // yellow — yellow-cross (2-look OLL) / OLL
  'rgba(249, 115, 22, 0.6)',   // orange — full OLL (2-look OLL) / headlights (2-look PLL)
  'rgba(59, 130, 246, 0.6)',   // blue — CPLL (2-look PLL)
  'rgba(139, 92, 246, 0.6)',   // purple — EPLL / PLL
];

function currentPhaseSequence(): PhaseDef[] {
  if (prefs.process === 'beginner') {
    // Until beginner intermediate phases are defined, track 2 buckets:
    // everything up to yellow-cross, and yellow-cross → solved.
    return [
      { key: 'setup', label: 'Setup', predicate: isYellowCrossDone, color: PHASE_COLORS[0] },
      { key: 'll', label: 'LL', predicate: isSolved, color: PHASE_COLORS[4] },
    ];
  }
  const seq: PhaseDef[] = [
    { key: 'cross', label: 'Cross', predicate: isCrossDone, color: PHASE_COLORS[0] },
    { key: 'f2l', label: 'F2L', predicate: isF2LDone, color: PHASE_COLORS[1] },
  ];
  if (prefs.twoLookOll) {
    seq.push({ key: 'eoll', label: 'EOLL', predicate: isYellowCrossDone, color: PHASE_COLORS[2] });
    seq.push({ key: 'ocll', label: 'OCLL', predicate: isOllDone, color: PHASE_COLORS[3] });
  } else {
    seq.push({ key: 'oll', label: 'OLL', predicate: isOllDone, color: PHASE_COLORS[2] });
  }
  if (prefs.twoLookPll) {
    seq.push({ key: 'cpll', label: 'CPLL', predicate: (f) => isOllDone(f) && isHeadlightsDone(f), color: PHASE_COLORS[4] });
    seq.push({ key: 'epll', label: 'EPLL', predicate: isSolved, color: PHASE_COLORS[5] });
  } else {
    seq.push({ key: 'pll', label: 'PLL', predicate: isSolved, color: PHASE_COLORS[5] });
  }
  return seq;
}

// Human-readable label for a phase key; used by the graph legend/list across solves.
const PHASE_KEY_LABELS: Record<string, string> = {
  cross: 'Cross', f2l: 'F2L', oll: 'OLL', pll: 'PLL',
  eoll: 'EOLL', ocll: 'OCLL', cpll: 'CPLL', epll: 'EPLL',
  setup: 'Setup', ll: 'LL',
};

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

// ---------- Runtime state ----------

let kpuzzle: KPuzzle | null = null;
let lastPattern: KPattern | null = null;   // most recent pattern from twistyTracker
let myPattern: KPattern | null = null;     // internally-maintained; applyMove on each physical move
cube3x3x3.kpuzzle().then(kp => { kpuzzle = kp; });

let mode: Mode = 'idle';
let cubeConnected = false;
let cubeIsSolved = false;
let pendingScramble: string | null = null;  // set by 🎯 install-as-next
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

// Graph
let graphChart: Chart | null = null;

// ---------- Scramble precompute ----------

// Generate a random-move 3x3 scramble locally (no Web Worker). Chooses
// faces such that no two consecutive moves share a face, which avoids
// trivial cancellations. Not random-state (true uniform distribution
// requires a Kociemba-style solver, which cubing.js runs in a Worker —
// avoided here because Vite's worker bundle pulls in DOM-touching code
// from the main app and crashes with "document is not defined").
function generateRandomScramble3x3(length = 25): string {
  const faces = ['U', 'D', 'L', 'R', 'F', 'B'];
  const suffixes = ['', "'", '2'];
  const moves: string[] = [];
  let prevFace = '';
  for (let i = 0; i < length; i++) {
    let face: string;
    do { face = faces[Math.floor(Math.random() * 6)]; } while (face === prevFace);
    moves.push(face + suffixes[Math.floor(Math.random() * 3)]);
    prevFace = face;
  }
  return moves.join(' ');
}

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
  phaseSeq.forEach((p, idx) => {
    const color = PHASE_COLORS[idx % PHASE_COLORS.length].replace('0.6', '1');
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
  renderStatus(`Solving — phase: ${phaseSeq[0]?.label ?? '?'}`);
  const pauseBtn = fsPauseBtnEl();
  if (pauseBtn) pauseBtn.disabled = false;
  const abortBtn = fsAbortBtnEl();
  if (abortBtn) abortBtn.disabled = false;
  startTimerLoop();
}

function onSolveMove(move: string) {
  if (mode === 'paused') return; // moves ignored while paused, but still added to history if user wants? For now, ignore.
  solveMoves.push(move);
  renderSolutionMoves();
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
        if (fired.length > 0) console.log('[fs-phase] fired:', fired.join(','), 'crossFace=', detectedCrossFace);
        finishSolve();
        return;
      }
    }
  }
  if (fired.length > 0) console.log('[fs-phase] fired:', fired.join(','), 'crossFace=', detectedCrossFace);
}

function finishSolve() {
  if (mode !== 'solving') return;
  mode = 'done';
  solveEndMs = Date.now();
  cancelAnimationFrame(timerRafHandle);
  renderTimer();
  renderStatus('Solved!');
  const pauseBtn = fsPauseBtnEl();
  if (pauseBtn) pauseBtn.disabled = true;
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
  const keyOrder = phaseSeq.map(p => p.key);
  const labels = slice.map((_, i) => `${history.length - slice.length + i + 1}`);

  // For a stacked-area chart without activating Chart.js's scale-level stacking
  // (which would also stack the Ao5/Ao12 trendlines), compute cumulative values
  // per solve and let each dataset fill down to the previous one.
  const cumulative: number[][] = slice.map(() => []);
  slice.forEach((r, solveIdx) => {
    let acc = 0;
    for (const k of keyOrder) {
      acc += (r.phases[k] ?? 0) / 1000;
      cumulative[solveIdx].push(acc);
    }
  });

  const datasets: any[] = keyOrder.map((k, kIdx) => ({
    type: 'line' as const,
    label: PHASE_KEY_LABELS[k] ?? k,
    data: cumulative.map(row => row[kIdx]),
    backgroundColor: PHASE_COLORS[kIdx % PHASE_COLORS.length],
    borderColor: PHASE_COLORS[kIdx % PHASE_COLORS.length].replace('0.6', '1'),
    borderWidth: 1,
    fill: kIdx === 0 ? 'origin' : '-1',
    pointRadius: 2,
    pointHoverRadius: 4,
    pointBackgroundColor: PHASE_COLORS[kIdx % PHASE_COLORS.length].replace('0.6', '1'),
    tension: 0.15,
    order: 2,
    // Allow point circles at data[0] and data[n-1] to render fully even
    // though their centers sit at the chart-area edges.
    clip: false,
  }));

  const totals = slice.map(r => r.totalMs / 1000);
  const isDark = document.documentElement.classList.contains('dark');
  const ao5Color = isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.75)';
  const ao12Color = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.45)';
  if (prefs.graphAo5) {
    datasets.push({
      type: 'line' as const,
      label: 'Ao5',
      data: rollingAverage(totals, 5),
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
  if (prefs.graphAo12) {
    datasets.push({
      type: 'line' as const,
      label: 'Ao12',
      data: rollingAverage(totals, 12),
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

  // Place label anchor y's such that no two are within `spacing` px, while
  // keeping each label as close to its data-point y as possible. Labels that
  // don't conflict with anyone (singletons in the merge graph) STAY at their
  // exact y. Conflicting labels form clusters that get spread evenly with
  // each cluster's offset chosen to minimise its max |displacement|.
  // Pool-Adjacent-Violators with per-cluster centering.
  const placeLabelsAvoidOverlap = (yTargets: number[], spacing: number): number[] => {
    const n = yTargets.length;
    if (n === 0) return [];
    const indices = yTargets.map((_, i) => i).sort((a, b) => yTargets[a] - yTargets[b]);
    type Cluster = { ys: number[]; p: number; size: number };
    // Each label starts as its own cluster anchored at its exact y.
    const clusters: Cluster[] = indices.map(i => ({ ys: [yTargets[i]], p: yTargets[i], size: 1 }));
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < clusters.length - 1; i++) {
        const a = clusters[i];
        const b = clusters[i + 1];
        // a occupies [a.p, a.p + (a.size - 1) * spacing]; require
        // b.p >= a.p + a.size * spacing for non-overlap.
        if (b.p < a.p + a.size * spacing) {
          const ys = a.ys.concat(b.ys);
          const size = a.size + b.size;
          let maxD = -Infinity, minD = Infinity;
          for (let r = 0; r < size; r++) {
            const d = ys[r] - r * spacing;
            if (d > maxD) maxD = d;
            if (d < minD) minD = d;
          }
          const p = (maxD + minD) / 2;
          clusters.splice(i, 2, { ys, p, size });
          merged = true;
          break;
        }
      }
    }
    const out = new Array<number>(n);
    let cursor = 0;
    for (const c of clusters) {
      for (let r = 0; r < c.size; r++) {
        out[indices[cursor + r]] = c.p + r * spacing;
      }
      cursor += c.size;
    }
    return out;
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
          const ms = r.phases[k] ?? 0;
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

      // Synthetic "Solve" entry — no color chit, anchored just above the
      // topmost cumulative point (the total of all phases for this solve).
      const r = slice[idx];
      if (r && Number.isFinite(topY)) {
        const text = `Solve ${formatSec(r.totalMs / 1000)}`;
        entries.push({
          text,
          color: '',
          isTrendline: false,
          noChit: true,
          // Place 1 px above the topmost phase so the de-overlap algorithm
          // sorts Solve to the top of the stack.
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
      const phaseY = placeLabelsAvoidOverlap(phaseEntries.map(e => e.point.y), minSpacing);
      const chitlessY = placeLabelsAvoidOverlap(chitlessEntries.map(e => e.point.y), minSpacing);

      const chartArea = chart.chartArea;
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

function rollingAverage(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i + 1 < n) { out.push(null); continue; }
    const window = values.slice(i + 1 - n, i + 1).slice().sort((a, b) => a - b);
    // WCA-style: drop best and worst, average the rest.
    const trimmed = window.slice(1, -1);
    if (trimmed.length === 0) { out.push(null); continue; }
    out.push(trimmed.reduce((s, v) => s + v, 0) / trimmed.length);
  }
  return out;
}

function meanAndSd(values: number[]): { mean: number; sd: number } {
  if (values.length === 0) return { mean: 0, sd: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  return { mean, sd };
}

// ---------- Solve list ----------


// Move-token typology. Used as a CSS class so the stylesheet can give
// .clock and .double a tiny right-padding when they aren't the last
// child of a .turn-group; .c-clock's apostrophe already provides its
// own visual separation, so it gets no padding.
function moveClass(m: string): 'clock' | 'c-clock' | 'double' {
  if (m.endsWith('2')) return 'double';
  if (m.endsWith("'")) return 'c-clock';
  return 'clock';
}

// The face component of a move ("R", "Rw", "U", etc.) — i.e., everything
// before the optional "'" / "2" suffix. Same-face moves can be merged
// algebraically modulo 4 quarter-turns.
function getFace(m: string): string {
  const match = m.match(/^[A-Za-z]+/);
  return match ? match[0] : m;
}

// Sum the quarter-turn count of a same-face move sequence, mod 4.
//   R = +1, R2 = +2, R' = -1
function sumQuarters(moves: string[]): number {
  let n = 0;
  for (const m of moves) {
    if (m.endsWith('2')) n += 2;
    else if (m.endsWith("'")) n -= 1;
    else n += 1;
  }
  return ((n % 4) + 4) % 4;
}

// Collapse adjacent quarter-turn pairs of the same move into a single
// half-turn. Smartcubes report half-turns as two consecutive quarter-
// turn events (so a user U2 lands as ['U', 'U']) — collapsing gives a
// readable display without affecting how solves are stored. Already-
// collapsed half-turns and mixed pairs (e.g., R R') are left alone.
function collapseDoubles(moves: string[]): string[] {
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

  // Pass 1: classify each storage move.
  //   strike      → cancelled; rendered struck-through (or hidden if !showStrikes)
  //   replacement → if set, append an italic equivalent-turn move after this
  //                 storage move (used when no original in a same-face group
  //                 already equals the group's net rotation)
  type Render = { strike: boolean; replacement: string | null };
  const renders: Render[] = moves.map(() => ({ strike: false, replacement: null }));

  let i = 0;
  while (i < moves.length) {
    const face = getFace(moves[i]);
    let j = i;
    while (j < moves.length && getFace(moves[j]) === face) j++;
    if (j - i >= 2) {
      const groupMoves = moves.slice(i, j);
      const netCount = sumQuarters(groupMoves);
      const netMove = netCount === 1 ? face : netCount === 2 ? face + '2' : netCount === 3 ? face + "'" : null;

      // Self-replacement: prefer keeping a move that already equals the
      // net rotation (LAST occurrence) instead of striking everything and
      // adding an italic duplicate. Strikes the rest.
      let keepAt = -1;
      if (netMove !== null) {
        for (let k = j - 1; k >= i; k--) {
          if (moves[k] === netMove) { keepAt = k; break; }
        }
      }

      if (keepAt >= 0) {
        for (let k = i; k < j; k++) {
          if (k !== keepAt) renders[k].strike = true;
        }
      } else {
        for (let k = i; k < j; k++) renders[k].strike = true;
        if (netMove !== null) renders[j - 1].replacement = netMove;
      }
    }
    i = j;
  }

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

  fsTwoLookOllEl()?.addEventListener('change', () => {
    prefs.twoLookOll = !!fsTwoLookOllEl()?.checked;
    savePrefs();
    resetSolveState();
    renderStatsLegend();
    renderStatsBoxes();
    renderGraph();
  });

  fsTwoLookPllEl()?.addEventListener('change', () => {
    prefs.twoLookPll = !!fsTwoLookPllEl()?.checked;
    savePrefs();
    resetSolveState();
    renderStatsLegend();
    renderStatsBoxes();
    renderGraph();
  });

  fsNewScrambleBtnEl()?.addEventListener('click', () => {
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
  if (prefs.graphRange < 20 || prefs.graphRange > 500) {
    prefs.graphRange = Math.max(20, Math.min(500, prefs.graphRange));
    savePrefs();
  }
  const gr = fsGraphRangeEl(); if (gr) {
    gr.min = '20';
    gr.max = '500';
    gr.value = String(prefs.graphRange);
  }
  const grv = fsGraphRangeValueEl(); if (grv) grv.textContent = String(prefs.graphRange);
  const gyc = fsGraphYClipEl(); if (gyc) gyc.value = prefs.graphYClip;
  const ga5 = fsGraphAo5El(); if (ga5) ga5.checked = prefs.graphAo5;
  const ga12 = fsGraphAo12El(); if (ga12) ga12.checked = prefs.graphAo12;
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
