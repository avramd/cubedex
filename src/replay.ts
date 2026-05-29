// Solve replay: step through a stored solve's scramble + solution on
// the virtual cube, with play / pause / step / scrub controls. While
// replay is active the smartcube + Full Solve handlers are blocked so
// the cube on screen represents the replay, not live input.

import type { SolveRecord } from './fullSolve/types';
import { invertMove } from './fullSolve/moves';
import { phaseAtMs } from './fullSolve/csvExport';
import { PHASE_COLOR_BY_KEY, PHASE_COLORS } from './fullSolve';

interface ReplayState {
  active: boolean;
  record: SolveRecord | null;
  moves: string[];            // solution tokens, whitespace-split
  // Per-token "physical-move counts" — for `R2`, two physical events so
  // turn timing should advance by two indices in r.turns.
  tokenPhysCount: number[];
  // Cumulative ms from solve start at which each token "lands". Built
  // from r.turns; for tokens without timing data, even-spaced. Length
  // === moves.length; entry [i] is the ms at which moves[0..=i] are
  // applied.
  tokenMs: number[];
  position: number;           // current token index, 0 = scramble only
  playing: boolean;
  // 'time'  — use recorded solve timing. Fast turns (interval < anim
  //           duration) play back-to-back at the cube animation's
  //           natural speed; slow turns are delayed so the animation
  //           ENDS at the recorded timestamp.
  // 'turns' — ignore solve timing, advance one move at the user's
  //           Animation Speed slider rate.
  mode: 'time' | 'turns';
  // Animation handle + wall-clock anchors driving the rAF play loop.
  rafHandle: number;
  startedAtWallMs: number;     // performance.now() when play started
  startedFromMs: number;       // tokenMs[position - 1] (or 0) when play started
  startedFromPosition: number; // position at play start (for 'turns' mode)
  preReplayAlg: string;
  // Saved display value of #alg-bar (the practice "Enter alg" row),
  // restored on stopReplay. We hide it while the solve display takes
  // its visual slot. Empty string means "wasn't visible / no save".
  algBarPrevDisplay: string;
  // Cached phase segments + per-move phase keys for the active solve —
  // computed once at startReplay and reused for token coloring and the
  // scrubber gradient (which switches between time / turns scales on
  // mode flip). `perMovePhase` uses *detailed* keys (cross_N, f2l_N,
  // eoll, ocll, cpll, epll, etc.) — same vocabulary as the graph's
  // colorForKey, so the colors line up across views.
  segments: PhaseSegment[];
  perMovePhase: string[];
}

interface PhaseSegment {
  phase: string;
  color: string;
  startIdx: number; // inclusive
  endIdx: number;   // exclusive
  startMs: number;
  endMs: number;
}

const state: ReplayState = {
  active: false,
  record: null,
  moves: [],
  tokenPhysCount: [],
  tokenMs: [],
  position: 0,
  playing: false,
  mode: 'time',
  rafHandle: 0,
  startedAtWallMs: 0,
  startedFromMs: 0,
  startedFromPosition: 0,
  preReplayAlg: '',
  algBarPrevDisplay: '',
  segments: [],
  perMovePhase: [],
};

interface Hooks {
  setCubeAlg: (alg: string) => void;   // instant jump (rewind / step back / scrub)
  applyMove: (move: string) => void;   // animated single-move advance (play / step fwd)
  saveCurrentAlg: () => string;
  // Current per-move animation duration in ms — derived from the user's
  // Animation Speed slider in index.ts. Read on every tick so changes
  // mid-replay take effect immediately.
  getAnimMsPerMove: () => number;
}
let hooks: Hooks | null = null;

function animMs(): number { return hooks ? hooks.getAnimMsPerMove() : 150; }

export function initReplay(h: Hooks) { hooks = h; }

export function isReplayActive(): boolean { return state.active; }

export function startReplay(r: SolveRecord) {
  if (!hooks) return;
  if (state.active) stopReplay();
  state.active = true;
  state.record = r;
  state.moves = (r.solution ?? '').split(/\s+/).filter(Boolean);
  state.tokenPhysCount = state.moves.map(m => m.endsWith('2') ? 2 : 1);
  state.tokenMs = buildTokenMs(r, state.moves, state.tokenPhysCount);
  state.perMovePhase = state.moves.map((_, i) => detailedPhaseAt(r, state.tokenMs[i]));
  state.segments = buildPhaseSegments();
  state.position = 0;
  state.playing = false;
  state.preReplayAlg = hooks.saveCurrentAlg();
  applyPositionSnap();
  injectReplayStyles();
  hideAlgBar();
  buildSolveDisplay();
  showOverlay();
  // Scroll the page to the top so the cube + replay controls are
  // in view — kicking off replay from a row deep in the solve list
  // would otherwise leave the user staring at the list, not the cube.
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

export function stopReplay() {
  if (!state.active) return;
  pause();
  state.active = false;
  hideOverlay();
  removeSolveDisplay();
  restoreAlgBar();
  if (hooks) hooks.setCubeAlg(state.preReplayAlg);
  state.record = null;
  state.moves = [];
  state.tokenPhysCount = [];
  state.tokenMs = [];
  state.perMovePhase = [];
  state.segments = [];
  state.position = 0;
  state.preReplayAlg = '';
}

// ---------- Playback ----------

function play() {
  if (!state.active) return;
  if (state.position >= state.moves.length) seekSnap(0);
  state.playing = true;
  state.startedAtWallMs = performance.now();
  state.startedFromMs = state.position === 0 ? 0 : state.tokenMs[state.position - 1];
  state.startedFromPosition = state.position;
  updatePlayButton();
  tick();
}

function pause() {
  state.playing = false;
  if (state.rafHandle) { cancelAnimationFrame(state.rafHandle); state.rafHandle = 0; }
  updatePlayButton();
}

function togglePlay() { state.playing ? pause() : play(); }

function tick() {
  if (!state.active || !state.playing || !hooks) return;
  const elapsed = performance.now() - state.startedAtWallMs;
  let advanced = false;

  const animDur = animMs();
  if (state.mode === 'time') {
    // Fire each move when the wall-clock target reaches its scheduled
    // animation-start. Schedule for a slow turn (interval >= animDur)
    // shifts the start back by animDur so the animation ENDS at the
    // recorded timestamp; for a fast turn we fire at the recorded
    // timestamp itself and TwistyPlayer queues the animation at its
    // natural pace.
    const targetSolveMs = state.startedFromMs + elapsed;
    while (state.position < state.moves.length) {
      const moveAt = state.tokenMs[state.position];
      const prevAt = state.position === 0 ? 0 : state.tokenMs[state.position - 1];
      const interval = moveAt - prevAt;
      const triggerAt = interval >= animDur ? moveAt - animDur : moveAt;
      if (targetSolveMs < triggerAt) break;
      hooks.applyMove(state.moves[state.position]);
      state.position++;
      advanced = true;
    }
  } else {
    // 'turns' mode: one move per animDur regardless of recorded timing.
    const targetPos = state.startedFromPosition + Math.floor(elapsed / animDur);
    while (state.position < Math.min(targetPos, state.moves.length)) {
      hooks.applyMove(state.moves[state.position]);
      state.position++;
      advanced = true;
    }
  }

  if (advanced) { updateScrubber(); updateCounter(); }
  if (state.position >= state.moves.length) { pause(); return; }
  state.rafHandle = requestAnimationFrame(tick);
}

// Instant jump — snap the cube to the alg at `pos` with no animation.
// Used for the slider, step-back, rewind, and play-from-end re-seek.
function seekSnap(pos: number) {
  const clamped = Math.max(0, Math.min(state.moves.length, pos));
  state.position = clamped;
  applyPositionSnap();
  updateScrubber();
  updateCounter();
  if (state.playing) {
    state.startedAtWallMs = performance.now();
    state.startedFromMs = state.position === 0 ? 0 : state.tokenMs[state.position - 1];
    state.startedFromPosition = state.position;
  }
}

// Animated single-step forward — TwistyPlayer animates the move.
function stepForward() {
  if (!hooks || state.position >= state.moves.length) return;
  hooks.applyMove(state.moves[state.position]);
  state.position++;
  updateScrubber();
  updateCounter();
}

// Animated single-step backward — apply the inverse of the move that
// brought us TO the current position, animating the undo. Snap-based
// for scrub/rewind is fine because those are arbitrary jumps, but the
// single-step buttons benefit from animation in both directions so the
// user can see exactly what each move did.
function stepBack() {
  if (!hooks || state.position <= 0) return;
  const undo = invertMove(state.moves[state.position - 1]);
  hooks.applyMove(undo);
  state.position--;
  updateScrubber();
  updateCounter();
}

function applyPositionSnap() {
  if (!hooks || !state.record) return;
  const prefix = state.moves.slice(0, state.position).join(' ');
  const alg = `${state.record.scramble} ${prefix}`.trim();
  hooks.setCubeAlg(alg);
}

// ---------- Helpers ----------

function buildTokenMs(r: SolveRecord, moves: string[], phys: number[]): number[] {
  const out: number[] = [];
  const turns = r.turns;
  if (turns && turns.length > 0) {
    let physIdx = 0;
    for (let i = 0; i < moves.length; i++) {
      physIdx += phys[i];
      const idx = Math.min(physIdx, turns.length) - 1;
      out.push(Math.round((turns[idx] ?? 0) * 1000));
    }
    return out;
  }
  const step = moves.length > 0 ? (r.totalMs || 1) / moves.length : 0;
  for (let i = 0; i < moves.length; i++) out.push(Math.round((i + 1) * step));
  return out;
}

// ---------- DOM overlay ----------

const OVERLAY_ID = 'replay-controls';

function showOverlay() {
  let el = document.getElementById(OVERLAY_ID);
  if (el) { el.remove(); el = null; }
  el = buildOverlay();
  // Inline mount: the controls live between the virtual cube and the
  // training scramble field via the dedicated slot in index.html. Fall
  // back to body-append on the off chance the slot isn't found.
  const slot = document.getElementById('replay-controls-slot');
  (slot ?? document.body).appendChild(el);
  document.addEventListener('keydown', onKey);
  updateScrubber();
  updateScrubberGradient();
  updateCounter();
  updatePlayButton();
  updateModeToggle();
}

function hideOverlay() {
  const el = document.getElementById(OVERLAY_ID);
  if (el) el.remove();
  document.removeEventListener('keydown', onKey);
}

function onKey(e: KeyboardEvent) {
  if (!state.active) return;
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
  if (e.key === 'Escape')      { e.preventDefault(); stopReplay(); }
  else if (e.key === ' ')      { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); stepForward(); }
  else if (e.key === 'ArrowLeft')  { e.preventDefault(); stepBack(); }
  else if (e.key === 'Home')   { e.preventDefault(); seekSnap(0); }
  else if (e.key === 'End')    { e.preventDefault(); seekSnap(state.moves.length); }
}

function buildOverlay(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.id = OVERLAY_ID;
  // inline-flex so the bar's width is exactly its content; the slot wrapper
  // in index.html centers it horizontally via `flex justify-center`.
  // No gap on the wrap — the playback buttons should sit shoulder-to-
  // shoulder; the other elements (counters, slider, toggle, close)
  // carry their own per-element margins.
  wrap.className = 'mb-3 px-3 py-2 rounded-lg shadow-sm inline-flex items-center ' +
                   'bg-white text-gray-900 border border-gray-300 ' +
                   'dark:bg-gray-800 dark:text-white dark:border-gray-600';

  const btnClass = 'leading-none px-1 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40';

  const rewind = button('⏮', 'Rewind to start (Home)', btnClass);
  rewind.addEventListener('click', () => seekSnap(0));
  wrap.appendChild(rewind);

  const stepBackBtn = button('⏪', 'Step back one move (←)', btnClass);
  stepBackBtn.addEventListener('click', stepBack);
  wrap.appendChild(stepBackBtn);

  // '▶' + U+FE0F variation selector forces the emoji-style glyph so it
  // visually matches the neighbouring ⏮ / ⏪ / ⏩ controls (which are
  // emoji-style by default).
  const playBtn = button('▶️', 'Play / pause (space)', btnClass);
  playBtn.id = `${OVERLAY_ID}-play`;
  playBtn.addEventListener('click', togglePlay);
  wrap.appendChild(playBtn);

  const stepFwd = button('⏩', 'Step forward one move (→)', btnClass);
  stepFwd.addEventListener('click', stepForward);
  wrap.appendChild(stepFwd);

  // Current time — sits to the LEFT of the scrubber. Fixed width so the
  // bar doesn't shift as the value updates.
  const counterCurrent = document.createElement('span');
  counterCurrent.id = `${OVERLAY_ID}-counter-current`;
  counterCurrent.className = 'text-xs tabular-nums text-gray-500 dark:text-gray-400 ml-2 text-right shrink-0';
  counterCurrent.style.minWidth = '8ch';
  wrap.appendChild(counterCurrent);

  // Scrubber column: a relative-positioned wrap that fills the bar's
  // full height. Inside, a colored phase-gradient rect sits BEHIND the
  // white slider track and extends taller than the slider itself —
  // ~80% of the control bar's height — so the scrubber sits in a
  // visible halo of phase color rather than carrying the gradient on
  // its own track.
  const sliderWrap = document.createElement('div');
  sliderWrap.id = `${OVERLAY_ID}-slider-wrap`;
  sliderWrap.className = 'relative shrink-0 mx-2 self-stretch flex items-center';
  sliderWrap.style.width = '160px';

  const sliderBg = document.createElement('div');
  sliderBg.id = `${OVERLAY_ID}-slider-bg`;
  // Centered vertically. positionScrubberBg() fills in the actual top
  // + height in pixels after layout settles. The rest stays here so a
  // brief pre-measure paint doesn't flash an unstyled rect.
  sliderBg.style.cssText = 'position: absolute; top: 10%; bottom: 10%; ' +
    'left: 0; right: 0; border-radius: 4px; pointer-events: none; z-index: 0;';
  sliderWrap.appendChild(sliderBg);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.id = `${OVERLAY_ID}-slider`;
  slider.min = '0';
  slider.max = String(state.moves.length);
  slider.value = String(state.position);
  slider.step = '1';
  slider.className = 'w-full';
  slider.style.position = 'relative';
  slider.style.zIndex = '1';
  slider.addEventListener('input', () => seekSnap(parseInt(slider.value, 10)));
  sliderWrap.appendChild(slider);
  wrap.appendChild(sliderWrap);

  // Total time — sits to the RIGHT of the scrubber. Static value (only
  // changes when the record changes), but we still pin its width so any
  // hot-path reformatting can't reflow the bar.
  const counterTotal = document.createElement('span');
  counterTotal.id = `${OVERLAY_ID}-counter-total`;
  counterTotal.className = 'text-xs tabular-nums text-gray-500 dark:text-gray-400 text-left shrink-0';
  counterTotal.style.minWidth = '4.5ch';
  wrap.appendChild(counterTotal);

  // Time / Turns toggle — matches the Full Solve toggle's style (pill +
  // sliding dot) but shrunk. ON = 'time' (use recorded solve timing),
  // OFF = 'turns' (ignore solve timing, fixed per-move pace). A single
  // word to the right of the switch shows the active mode.
  const modeWrap = document.createElement('label');
  modeWrap.htmlFor = `${OVERLAY_ID}-mode`;
  modeWrap.className = 'relative inline-flex items-center cursor-pointer select-none ml-2';
  modeWrap.title = 'On = time: use solve timing (fast turns play fast, slow turns are delayed so they end at the recorded moment). Off = turns: ignore solve timing, advance one move per animation step.';
  // Pill background is driven from JS (updateModeToggle) — Tailwind's
  // peer-checked / dark: variants live in template strings here, which
  // the Tailwind scanner doesn't pick up, so the dynamic classes aren't
  // emitted into the stylesheet. Inline-color side-steps the problem.
  modeWrap.innerHTML =
    `<input type="checkbox" id="${OVERLAY_ID}-mode" class="sr-only" />` +
    `<div id="${OVERLAY_ID}-mode-pill" class="w-7 h-4 rounded-full shadow-inner transition-colors duration-200"></div>` +
    `<div id="${OVERLAY_ID}-mode-dot" class="absolute left-0.5 top-0.5 w-3 h-3 bg-white rounded-full shadow transition-transform duration-200 ease-in-out" style="transform: translateX(0)"></div>` +
    // min-w reserves space for the wider of the two words ("turns" — 5
    // chars), so flipping the toggle doesn't shift the rest of the bar.
    `<span id="${OVERLAY_ID}-mode-label" class="ml-1.5 text-xs font-semibold inline-block min-w-[2.25rem] text-left">turns</span>`;
  const cb = modeWrap.querySelector('input') as HTMLInputElement;
  cb.addEventListener('change', () => {
    state.mode = cb.checked ? 'time' : 'turns';
    updateModeToggle();
    // The scrubber's gradient stops shift between time-proportional and
    // move-count-proportional, so flipping the mode re-paints the track.
    updateScrubberGradient();
    if (state.playing) {
      state.startedAtWallMs = performance.now();
      state.startedFromMs = state.position === 0 ? 0 : state.tokenMs[state.position - 1];
      state.startedFromPosition = state.position;
    }
  });
  wrap.appendChild(modeWrap);

  const close = button('✕', 'Close replay (Esc)', btnClass + ' ml-2 text-gray-500 hover:text-red-500');
  close.addEventListener('click', stopReplay);
  wrap.appendChild(close);

  return wrap;
}

function button(text: string, title: string, className: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  // Skip tab order + suppress focus ring — every button here has a
  // dedicated key shortcut (space / arrows / Home / Esc), so OS-level
  // focus traversal would just leave a confusing "selected" outline
  // without adding navigation value.
  b.tabIndex = -1;
  b.style.outline = 'none';
  b.textContent = text;
  b.title = title;
  b.className = className;
  return b;
}

function updateScrubber() {
  const slider = document.getElementById(`${OVERLAY_ID}-slider`) as HTMLInputElement | null;
  if (!slider) return;
  slider.max = String(state.moves.length);
  slider.value = String(state.position);
  updateMoveHighlight();
}

function updateCounter() {
  const totalMs = state.moves.length > 0 ? state.tokenMs[state.moves.length - 1] : 0;
  const nowMs = state.position === 0 ? 0 : state.tokenMs[state.position - 1];
  const cur = document.getElementById(`${OVERLAY_ID}-counter-current`);
  if (cur) cur.textContent = `${formatTime(nowMs)} (${state.position})`;
  const tot = document.getElementById(`${OVERLAY_ID}-counter-total`);
  if (tot) tot.textContent = `${formatTime(totalMs)} (${state.moves.length})`;
}

// "12.3" under a minute (no leading "0:"), "1:23.4" over. tabular-nums
// keeps each digit a fixed width so the bar can't shift.
function formatTime(ms: number): string {
  const totalSec = Math.max(0, ms) / 1000;
  if (totalSec < 60) return totalSec.toFixed(1);
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function updatePlayButton() {
  const el = document.getElementById(`${OVERLAY_ID}-play`);
  if (!el) return;
  // Variation selector for emoji-style glyphs — see buildOverlay note.
  el.textContent = state.playing ? '⏸️' : '▶️';
}

function updateModeToggle() {
  const cb = document.getElementById(`${OVERLAY_ID}-mode`) as HTMLInputElement | null;
  if (cb) cb.checked = state.mode === 'time';
  const dot = document.getElementById(`${OVERLAY_ID}-mode-dot`);
  if (dot) dot.style.transform = state.mode === 'time' ? 'translateX(0.75rem)' : 'translateX(0)';
  const pill = document.getElementById(`${OVERLAY_ID}-mode-pill`);
  if (pill) {
    // Blue when ON (time), grey when OFF (turns); dark-mode grey is a
    // shade darker so it reads against the dark bar background.
    const isDark = document.documentElement.classList.contains('dark');
    pill.style.backgroundColor = state.mode === 'time'
      ? '#3b82f6'
      : (isDark ? '#4b5563' : '#d1d5db');
  }
  const lbl = document.getElementById(`${OVERLAY_ID}-mode-label`);
  if (lbl) lbl.textContent = state.mode === 'time' ? 'time' : 'turns';
}

// ---------- Phase coloring (solve display + scrubber gradient) ----------

// Detailed phase key for a move at ms `t`. Same vocabulary as the
// graph's `colorForKey` — cross splits into cross_1..cross_4 (when
// r.crossSplits is present), f2l splits into f2l_1..f2l_4, OLL/PLL
// into their EOLL/OCLL/CPLL/EPLL components. Falls back to the base
// key when no split data exists.
function detailedPhaseAt(r: SolveRecord, t: number): string {
  const base = phaseAtMs(r, t);
  if (base === 'cross') {
    const cs = r.crossSplits;
    if (cs && cs.length === 4) {
      if (t < cs[0]) return 'cross_1';
      if (t < cs[1]) return 'cross_2';
      if (t < cs[2]) return 'cross_3';
      return 'cross_4';
    }
    // CFOP records without per-edge cross timing render at the
    // existing pink saturation (cross_3 in the unified palette).
    return 'cross_3';
  }
  // phaseAtMs already emits f2l1..f2l4 when r.f2lSplits is present;
  // map to underscore form so it hits the same color path as the graph.
  if (/^f2l[1-4]$/.test(base)) return 'f2l_' + base.charAt(3);
  // Unsplit F2L (no f2lSplits): one band at the topmost saturation,
  // matching the graph's "legacy fallback" rendering.
  if (base === 'f2l') return 'f2l_4';
  return base;
}

// Color for a detailed phase key — keeps the alpha (area shade), so
// move letters and scrubber bands read as soft tints rather than
// fluorescent line colors.
const F2L_SUB_ALPHAS = [0.30, 0.45, 0.60, 0.75];
const CROSS_SUB_ALPHAS = [0.30, 0.45, 0.60, 0.75];
function colorForDetailedKey(k: string): string {
  if (k.startsWith('f2l_')) {
    const n = parseInt(k.slice(4), 10);
    const a = F2L_SUB_ALPHAS[n - 1] ?? 0.6;
    return PHASE_COLORS[1].replace(/,\s*[\d.]+\)\s*$/, `, ${a})`);
  }
  if (k.startsWith('cross_')) {
    const n = parseInt(k.slice(6), 10);
    const a = CROSS_SUB_ALPHAS[n - 1] ?? 0.6;
    return PHASE_COLORS[0].replace(/,\s*[\d.]+\)\s*$/, `, ${a})`);
  }
  return PHASE_COLOR_BY_KEY[k] ?? PHASE_COLORS[0];
}

// Group consecutive moves sharing the same detailed phase key.
function buildPhaseSegments(): PhaseSegment[] {
  const r = state.record;
  if (!r || state.moves.length === 0) return [];
  const segs: PhaseSegment[] = [];
  let cur: PhaseSegment | null = null;
  for (let i = 0; i < state.moves.length; i++) {
    const phase = state.perMovePhase[i];
    if (!cur || cur.phase !== phase) {
      if (cur) cur.endIdx = i;
      cur = {
        phase,
        color: colorForDetailedKey(phase),
        startIdx: i,
        endIdx: i + 1,
        startMs: i === 0 ? 0 : state.tokenMs[i - 1],
        endMs: state.tokenMs[i],
      };
      segs.push(cur);
    } else {
      cur.endIdx = i + 1;
      cur.endMs = state.tokenMs[i];
    }
  }
  return segs;
}

function buildScrubberGradient(): string {
  if (state.segments.length === 0 || state.moves.length === 0) return '';
  const totalMs = state.tokenMs[state.moves.length - 1] || 1;
  const totalMoves = state.moves.length;
  const stops: string[] = [];
  state.segments.forEach((seg) => {
    const startPct = state.mode === 'time'
      ? (seg.startMs / totalMs) * 100
      : (seg.startIdx / totalMoves) * 100;
    const endPct = state.mode === 'time'
      ? (seg.endMs / totalMs) * 100
      : (seg.endIdx / totalMoves) * 100;
    // Area alpha (per-sub-band 0.30/0.45/0.60/0.75) — the gradient is
    // now on a tall background rect, not a thin line, so soft alpha
    // reads correctly.
    stops.push(`${seg.color} ${startPct}%`, `${seg.color} ${endPct}%`);
  });
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

function updateScrubberGradient() {
  const bg = document.getElementById(`${OVERLAY_ID}-slider-bg`);
  if (!bg) return;
  bg.style.backgroundImage = buildScrubberGradient();
  positionScrubberBg();
}

// Size the gradient bg to 80% of the *toolbar's* rendered height,
// centered vertically. The slider column itself only stretches to
// items-center's content size (the tallest sibling — buttons at ~28px),
// so percentage-based top/bottom on the bg would give us 80% of THAT,
// not 80% of the toolbar including its padding. Measuring the actual
// pixel heights lets the bg overflow the slider column vertically into
// the toolbar's padding zone.
function positionScrubberBg() {
  const wrap = document.getElementById(OVERLAY_ID);
  const bg = document.getElementById(`${OVERLAY_ID}-slider-bg`);
  const sliderWrap = bg?.parentElement;
  if (!wrap || !bg || !sliderWrap) return;
  const wrapH = wrap.getBoundingClientRect().height;
  const swH = sliderWrap.getBoundingClientRect().height;
  if (wrapH === 0 || swH === 0) {
    // Toolbar not measured yet (still in initial layout). Try next
    // frame — typical on first paint.
    requestAnimationFrame(positionScrubberBg);
    return;
  }
  const bgH = Math.round(wrapH * 0.8);
  const top = Math.round((swH - bgH) / 2);
  bg.style.height = `${bgH}px`;
  bg.style.top = `${top}px`;
  bg.style.bottom = 'auto';
}

// ---------- Solve display + alg-bar swap ----------

const SOLVE_DISPLAY_ID = 'replay-solve-display';

// Per-move horizontal spacing (CSS margin between adjacent move spans).
// Tuned so the highlight outline + its offset don't overlap the
// neighbour's character box. Single knob — bump or trim a few px to
// taste.
const MOVE_GAP_PX = 4;
const MOVE_PAD_X_PX = 1;     // breathing room between character and outline
const HIGHLIGHT_OFFSET_PX = 1;
const HIGHLIGHT_WIDTH_PX = 1;

// Build the colored solve-text element and insert it immediately above
// the playback control bar. Each move is its own <span> so the play-
// head highlight can target a single token without re-rendering. Inter-
// move space is pure CSS margin (no text-node whitespace) so the gap
// is a single tunable number.
function buildSolveDisplay() {
  removeSolveDisplay();
  const slot = document.getElementById('replay-controls-slot');
  if (!slot || !slot.parentElement) return;
  const display = document.createElement('div');
  display.id = SOLVE_DISPLAY_ID;
  display.className = 'mx-auto max-w-[1032px] mb-3 px-4 py-2 font-mono ' +
                      'text-base sm:text-lg leading-relaxed break-words text-center';
  for (let i = 0; i < state.moves.length; i++) {
    const phase = state.perMovePhase[i];
    const span = document.createElement('span');
    span.dataset.replayMoveIdx = String(i);
    span.style.color = colorForDetailedKey(phase);
    span.style.fontWeight = '600';
    span.style.padding = `0 ${MOVE_PAD_X_PX}px`;
    span.style.borderRadius = '3px';
    // Keep "R'" / "R2" intact — the parent's break-words can otherwise
    // wrap between the face letter and its modifier when the move sits
    // at the end of a line.
    span.style.whiteSpace = 'nowrap';
    if (i < state.moves.length - 1) span.style.marginRight = `${MOVE_GAP_PX}px`;
    span.textContent = state.moves[i];
    display.appendChild(span);
  }
  slot.parentElement.insertBefore(display, slot);
}

function removeSolveDisplay() {
  document.getElementById(SOLVE_DISPLAY_ID)?.remove();
}

// Thin theme-aware outline around the move the play-head has just
// past (position - 1) — white in dark mode, gray-800 in light. Outline
// (not border) so toggling it doesn't reflow the row.
function updateMoveHighlight() {
  const display = document.getElementById(SOLVE_DISPLAY_ID);
  if (!display) return;
  const prev = display.querySelector('[data-replay-current="1"]') as HTMLElement | null;
  if (prev) {
    prev.removeAttribute('data-replay-current');
    prev.style.outline = '';
    prev.style.outlineOffset = '';
  }
  if (state.position === 0) return;
  const idx = state.position - 1;
  const span = display.querySelector(`[data-replay-move-idx="${idx}"]`) as HTMLElement | null;
  if (!span) return;
  span.setAttribute('data-replay-current', '1');
  // Soft outline — low alpha so the box reads as a hint rather than a
  // hard frame against the dark/light bg.
  const isDark = document.documentElement.classList.contains('dark');
  span.style.outline = isDark
    ? `${HIGHLIGHT_WIDTH_PX}px solid rgba(255,255,255,0.35)`
    : `${HIGHLIGHT_WIDTH_PX}px solid rgba(31,41,55,0.35)`;
  span.style.outlineOffset = `${HIGHLIGHT_OFFSET_PX}px`;
  // Keep the highlighted token in view if the solve wraps across many
  // lines; "nearest" avoids unnecessary scroll when it's already
  // visible.
  span.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function hideAlgBar() {
  const bar = document.getElementById('alg-bar') as HTMLElement | null;
  if (!bar) return;
  state.algBarPrevDisplay = bar.style.display || '';
  bar.style.display = 'none';
}

function restoreAlgBar() {
  const bar = document.getElementById('alg-bar') as HTMLElement | null;
  if (!bar) return;
  bar.style.display = state.algBarPrevDisplay;
  state.algBarPrevDisplay = '';
}

// Custom slider styling — appearance:none so the track + thumb pick
// up our own colors instead of the OS defaults. The phase gradient
// lives on the separate `-slider-bg` rect behind the slider, not on
// the slider's own background. Injected once globally.
function injectReplayStyles() {
  const id = 'replay-controls-style';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
    #${OVERLAY_ID}-slider {
      -webkit-appearance: none;
      appearance: none;
      height: 10px;
      border-radius: 6px;
      /* Plain white pill in both themes — the phase gradient lives on
         a separate background rect behind the slider, not the track. */
      background-color: #fff;
      cursor: pointer;
    }
    /* Border + inset shadow on the gradient rect. Border gives the
       eye a clean outline; inset shadow gives a soft "pressed-in"
       look that masks subpixel band-height jitter. Always on (the
       A/B hover toggle is gone — inset won the comparison). */
    #${OVERLAY_ID}-slider-bg {
      border: 2px solid rgba(0, 0, 0, 0.55);
      box-sizing: border-box;
      box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.45),
                  inset 0 -1px 2px rgba(0, 0, 0, 0.25);
    }
    .dark #${OVERLAY_ID}-slider-bg {
      border-color: rgba(255, 255, 255, 0.55);
    }
    #${OVERLAY_ID}-slider::-webkit-slider-runnable-track {
      height: 10px;
      border-radius: 6px;
      background: transparent;
    }
    #${OVERLAY_ID}-slider::-moz-range-track {
      height: 10px;
      border-radius: 6px;
      background: transparent;
    }
    /* Playhead: a solid dark dot with a white ring — distinct from
       the white track even when the gradient bg behind isn't carrying
       a contrasting color. */
    #${OVERLAY_ID}-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #1f2937;
      border: 2px solid #fff;
      margin-top: -2px;
      cursor: pointer;
      box-shadow: 0 0 0 1px rgba(0,0,0,0.35);
    }
    #${OVERLAY_ID}-slider::-moz-range-thumb {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #1f2937;
      border: 2px solid #fff;
      cursor: pointer;
      box-shadow: 0 0 0 1px rgba(0,0,0,0.35);
    }
  `;
  document.head.appendChild(style);
}
