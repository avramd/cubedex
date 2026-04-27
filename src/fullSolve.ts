import { Alg } from 'cubing/alg';
import { cube3x3x3 } from 'cubing/puzzles';
import { KPattern, KPuzzle } from 'cubing/kpuzzle';
import { randomScrambleForEvent } from 'cubing/scramble';
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
const fsNoCubeEl = () => $$('fs-no-cube');
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

function updateCubeGate() {
  // The no-cube notice sits next to the Full Solve toggle. Only show it when
  // Full Solve is enabled (the toggle is meaningful) AND no cube is connected.
  const showNotice = prefs.enabled && !cubeConnected;
  fsNoCubeEl()?.classList.toggle('hidden', !showNotice);
}

function updateCfopOptionsVisibility() {
  fsCfopOptionsEl()?.classList.toggle('hidden', prefs.process !== 'cfop');
  fsCfopOptionsEl()?.classList.toggle('flex', prefs.process === 'cfop');
}

// ---------- Scramble display ----------

function renderScrambleDisplay() {
  const el = fsScrambleEl();
  if (!el) return;
  el.innerHTML = '';
  scrambleMoves.forEach((m, i) => {
    if (i < scrambleProgress) {
      const span = document.createElement('span');
      span.textContent = m + ' ';
      span.className = 'text-gray-400 line-through';
      el.appendChild(span);
      return;
    }
    if (i === scrambleProgress && halfwayActive && isHalfTurn(m)) {
      // Render "~~U~~2": strikethrough only on the letter portion, keep
      // the trailing 2 normal. Whole token stays blue+bold to mark it as
      // the current move.
      const wrapper = document.createElement('span');
      wrapper.className = 'font-bold text-blue-600 dark:text-blue-300';
      const letterSpan = document.createElement('span');
      letterSpan.textContent = m.slice(0, -1);
      letterSpan.className = 'line-through';
      wrapper.appendChild(letterSpan);
      const numSpan = document.createElement('span');
      numSpan.textContent = m.slice(-1) + ' ';
      wrapper.appendChild(numSpan);
      el.appendChild(wrapper);
      return;
    }
    const span = document.createElement('span');
    span.textContent = m + ' ';
    span.className = i === scrambleProgress ? 'font-bold text-blue-600 dark:text-blue-300' : '';
    el.appendChild(span);
  });
  if (deviationMoves.length > 0) {
    const corr = document.createElement('span');
    const inv = invertMoves(deviationMoves).join(' ');
    corr.className = 'text-red-500 font-bold ml-2';
    corr.textContent = '— undo: ' + inv;
    el.appendChild(corr);
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
  const el = fsStatusEl();
  if (el) el.textContent = text;
}

function renderSolutionMoves() {
  const el = fsSolutionMovesEl();
  if (el) el.textContent = formatMoveGroups(solveMoves.join(' '));
}

function renderRetraceHint() {
  // The hint shows the inverse of moves taken since the most recent passed phase boundary
  // (or since solve start), so the user can step back to that checkpoint.
  const el = fsRetraceHintEl();
  if (!el) return;
  if (mode !== 'paused') { el.textContent = ''; return; }
  const checkpointIdx = lastReachedPhaseMoveIndex();
  const recent = solveMoves.slice(checkpointIdx);
  el.textContent = formatMoveGroups(invertMoves(recent).join(' '));
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
    try {
      const alg: Alg = await randomScrambleForEvent('333');
      currentScramble = alg.toString();
    } catch {
      renderStatus('Scramble generation failed.');
      return;
    }
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
    solution: solveMoves.join(' '),
    totalMs,
    phases,
    process: prefs.process,
    twoLookOll: prefs.twoLookOll,
    twoLookPll: prefs.twoLookPll,
  };
  history.push(record);
  saveHistory();
  // Refresh slider max now that we have one more solve.
  const gr = fsGraphRangeEl();
  if (gr) gr.max = String(Math.max(20, history.length));
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

      // De-overlap the y positions, centered to minimise max displacement.
      const adjustedY = placeLabelsAvoidOverlap(entries.map(e => e.point.y), minSpacing);

      const chartArea = chart.chartArea;
      const chartMidX = (chartArea.left + chartArea.right) / 2;

      // Subtle vertical guide on the hovered column so it's unambiguous
      // which solve the inline labels belong to (especially helpful for
      // the second-to-last column where labels otherwise sit between
      // this solve's points and the next solve's points).
      const hoverX = entries[0]?.point.x;
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

      entries.forEach((e, i) => {
        const totalW = e.noChit ? e.textW : chitSize + chitGap + e.textW;
        const labelY = adjustedY[i];
        // Default to the side of the data point that has more chart space:
        // labels go right when the point is in the LEFT half of the chart,
        // and left when in the right half. This keeps labels for the
        // second-to-last solve from spilling toward the last solve's
        // column. Each direction has a fallback to the other side if it
        // would overflow the chart area.
        const preferRight = e.point.x < chartMidX;
        let labelX: number;
        let chitOnLeft: boolean;
        if (preferRight) {
          labelX = e.point.x + 8;
          chitOnLeft = true;
          if (labelX + totalW + padX > chartArea.right - 2) {
            labelX = e.point.x - 8 - totalW;
            chitOnLeft = false;
          }
        } else {
          labelX = e.point.x - 8 - totalW;
          chitOnLeft = false;
          if (labelX - padX < chartArea.left + 2) {
            labelX = e.point.x + 8;
            chitOnLeft = true;
          }
        }

        // Pill background.
        c2d.fillStyle = pillBg;
        c2d.fillRect(labelX - padX, labelY - pillH / 2, totalW + padX * 2, pillH);

        let textX = labelX;
        if (!e.noChit) {
          const chitX = chitOnLeft ? labelX : labelX + e.textW + chitGap;
          textX = chitOnLeft ? labelX + chitSize + chitGap : labelX;
          // Color chit (matches the legend representation).
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

        // Text. Default in the legend's body color (theme-aware). For
        // trendlines (no chit), colour just the numeric value with the
        // line's colour so it doubles as the line indicator.
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
      });
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
      onHover: (_e, elements, chart) => {
        const newIdx = elements && elements.length > 0 ? elements[0].index : -1;
        if ((chart as any).$activeIndex !== newIdx) {
          (chart as any).$activeIndex = newIdx;
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

// Format a move sequence into groups of 4: spaces only between groups,
// no spaces within a group. e.g.  "R U R' U' F2 R F'"  →  "RUR'U' F2RF'"
function formatMoveGroups(seq: string): string {
  const moves = seq.trim().split(/\s+/).filter(Boolean);
  const groups: string[] = [];
  for (let i = 0; i < moves.length; i += 4) {
    groups.push(moves.slice(i, i + 4).join(''));
  }
  return groups.join(' ');
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
  if (hint) {
    hint.textContent = cubeIsSolved
      ? 'Cube solved — solutions visible below.'
      : 'Solve your cube to reveal solutions.';
  }
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
    scramble.textContent = formatMoveGroups(r.scramble);
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

    if (cubeIsSolved && r.solution) {
      const sol = document.createElement('div');
      sol.className = 'pl-10 pr-2 pb-2 font-mono text-[11px] text-gray-500 dark:text-gray-400 break-words';
      sol.textContent = formatMoveGroups(r.solution);
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
}

function applyPrefsToUI() {
  const t = fullSolveToggleEl(); if (t) t.checked = prefs.enabled;
  const p = fsProcessEl(); if (p) p.value = prefs.process;
  const i = fsInspectionEl(); if (i) i.value = prefs.inspection;
  const ol = fsTwoLookOllEl(); if (ol) ol.checked = prefs.twoLookOll;
  const pl = fsTwoLookPllEl(); if (pl) pl.checked = prefs.twoLookPll;
  const gr = fsGraphRangeEl(); if (gr) {
    gr.max = String(Math.max(20, history.length));
    gr.value = String(Math.min(prefs.graphRange, parseInt(gr.max, 10)));
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
    // Cube disconnected mid-flow; abort and return to idle.
    resetSolveState();
    renderStatus('Cube disconnected — connect again to start a new solve.');
  }
}

export function isFullSolveModeEnabled(): boolean {
  return prefs.enabled;
}
