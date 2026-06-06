import './style.css'
import './pwa-register'

import $ from 'jquery';
import { Subscription, interval } from 'rxjs';
import { TwistyPlayer } from 'cubing/twisty';
import { Alg } from "cubing/alg";
import { cube3x3x3 } from "cubing/puzzles";
import { KPattern } from 'cubing/kpuzzle';
import min2phase from './lib/min2phase';

min2phase.initFull();

import * as THREE from 'three';

import {
  now,
  connectSmartCube,
  getCachedMacForDevice,
  SmartCubeConnection,
  SmartCubeEvent,
  MacAddressProvider,
  makeTimeFromTimestamp,
  cubeTimestampCalcSkew,
  cubeTimestampLinearFit
} from 'smartcube-web-bluetooth';

import { faceletsToPattern, patternToFacelets } from './utils';
import { COPY_ICON } from './icons';
import { isSliceCandidate, getSliceForPair, SLICE_TOLERANCE_MS } from './fullSolve/moves';
import {
  initFullSolve, fsOnPhysicalMove, fsOnPattern, fsOnRawGyro, fsSetCubeConnected, fsSetConnectStatus, isFullSolveModeEnabled,
} from './fullSolve';
import { initReplay, isReplayActive } from './replay';
import {
  setOnLocalScrambleChange, setOnShareStateChange, isSharingScrambles,
  setPeerSharingScrambles, applyRemoteFsScramble, setShareScramblesNetVisible,
  getCurrentFsScramble,
} from './fullSolve';
import { expandNotation, fixOrientation, getInverseMove, getOppositeMove, requestWakeLock, releaseWakeLock, initializeDefaultAlgorithms, saveAlgorithm, deleteAlgorithm, exportAlgorithms, importAlgorithms, loadAlgorithms, loadCategories, isSymmetricOLL, algToId, setStickering, setCategoryStickeringDeferred, loadSubsets, bestTimeString, bestTimeNumber, averageTimeString, averageOfFiveTimeNumber, learnedStatus, createTimeGraph, createStatsGraph, countMovesETM, getLastTimes, trailingWholeCubeRotationMoveCount, fullStickeringEnabled, setFullStickeringEnabled } from './functions';
import { NetPeer, NetMessage } from './network';

const SOLVED_STATE = "UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB";

var twistyPlayer = new TwistyPlayer({
  puzzle: '3x3x3',
  visualization: 'PG3D',
  alg: '',
  experimentalSetupAnchor: 'start',
  background: 'none',
  controlPanel: 'none',
  viewerLink: 'none',
  hintFacelets: 'floating',
  experimentalDragInput: 'none',
  cameraLatitude: 0,
  cameraLongitude: 0,
  tempoScale: 5,
  experimentalStickering: 'full'
});

var twistyTracker = new TwistyPlayer({
  puzzle: '3x3x3',
  visualization: 'PG3D',
  alg: '',
  experimentalSetupAnchor: 'start',
  background: 'none',
  controlPanel: 'none',
  hintFacelets: 'none',
  experimentalDragInput: 'none',
  cameraLatitude: 0,
  cameraLongitude: 0,
  cameraLatitudeLimit: 0,
  tempoScale: 5
});

const containerEl = document.getElementById('container') as HTMLElement | null;
const cubeCellEl = document.getElementById('cube') as HTMLElement | null;

$('#cube').append(twistyPlayer);

// Track the last alg string we set on twistyPlayer — its `.alg` is a
// write-only setter (the getter throws), and `experimentalModel.alg`
// resolves asynchronously, but the replay overlay needs a synchronous
// snapshot to restore on close. Every assignment to `twistyPlayer.alg`
// goes through setTwistyAlg() so this stays in sync.
let lastTwistyAlg = '';
function setTwistyAlg(alg: string): void {
  lastTwistyAlg = alg;
  twistyPlayer.alg = alg;
}

// Arcball drag: Points inside the unit circle map to the front hemisphere;
// outside maps to the rim (giving roll when dragging at the edges).
function arcballProject(nx: number, ny: number): THREE.Vector3 {
  const r2 = nx * nx + ny * ny;
  if (r2 <= 1.0) return new THREE.Vector3(nx, ny, Math.sqrt(1.0 - r2));
  const r = Math.sqrt(r2);
  return new THREE.Vector3(nx / r, ny / r, 0);
}

if (cubeCellEl) {
  cubeCellEl.style.touchAction = 'none';
  (twistyPlayer as HTMLElement).style.cursor = 'grab';
  let dragAnchor: THREE.Vector3 | null = null;

  function pointerToArcball(e: PointerEvent): THREE.Vector3 {
    const rect = cubeCellEl!.getBoundingClientRect();
    const radius = Math.min(rect.width, rect.height) / 2;
    const nx =  (e.clientX - rect.left - rect.width  / 2) / radius;
    const ny = -((e.clientY - rect.top  - rect.height / 2) / radius);
    return arcballProject(nx, ny);
  }

  cubeCellEl.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragAnchor = pointerToArcball(e);
    cubeCellEl!.setPointerCapture(e.pointerId);
    (twistyPlayer as HTMLElement).style.cursor = 'grabbing';
  });

  cubeCellEl.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragAnchor || !(e.buttons & 1)) return;
    const end = pointerToArcball(e);
    const axis = new THREE.Vector3().crossVectors(dragAnchor, end);
    if (axis.lengthSq() < 1e-14) { dragAnchor = end; return; }
    const angle = Math.acos(Math.max(-1, Math.min(1, dragAnchor.dot(end))));
    const delta = new THREE.Quaternion().setFromAxisAngle(axis.normalize(), angle);
    orientAdjust.premultiply(delta);
    dragAnchor = end;
    try { localStorage.setItem(ORIENT_ADJUST_KEY, JSON.stringify(orientAdjust)); } catch { /**/ }
  });

  cubeCellEl.addEventListener('pointerup', (e: PointerEvent) => {
    cubeCellEl!.releasePointerCapture(e.pointerId);
    (twistyPlayer as HTMLElement).style.cursor = 'grab';
    dragAnchor = null;
    // CF-2: drag is purely view-space tweak (orientAdjust), NOT a
    // gyro-frame update. Orientation identification (F/U declarations)
    // and basis live entirely in the Sync ⚙️ panel + gyro stream;
    // dragging is for "I want to see the cube differently than I'm
    // holding it" and for compensating gyro drift, neither of which
    // should touch basis or the detected U face.
  });

  cubeCellEl.addEventListener('pointercancel', () => {
    dragAnchor = null;
    (twistyPlayer as HTMLElement).style.cursor = 'grab';
  });
}

// Remote peer's cube (only appended to DOM when in split mode).
// experimentalDragInput is 'none' because we attach our OWN arcball
// drag handler on the wrapper element below — that lets the drag-to-
// reorient region cover the whole cube cell instead of being clipped
// to cubing.js's internal canvas bounds.
var twistyPlayerRemote = new TwistyPlayer({
  puzzle: '3x3x3',
  visualization: 'PG3D',
  alg: '',
  experimentalSetupAnchor: 'start',
  background: 'none',
  controlPanel: 'none',
  viewerLink: 'none',
  hintFacelets: 'floating',
  experimentalDragInput: 'none',
  cameraLatitude: 0,
  cameraLongitude: 0,
  tempoScale: 5,
  experimentalStickering: 'full',
});

// Local user-rotation offset applied to the remote cube's scene. Drag
// pre-multiplies a delta onto this; the remote animation loop slerps the
// scene toward `remoteOrientAdjust * remoteGyroTarget` so the partner's
// reported gyro orientation is preserved on top of our manual rotation.
const remoteOrientAdjust = new THREE.Quaternion();

// Same arcball drag for the remote cube. Attached to the wrapper around
// the twisty-player rather than the player itself, so the draggable
// region is the whole cube cell (matching the local cube). Modifies
// remoteOrientAdjust; the remote animation loop applies it.
const remoteCubePlayerEl = document.getElementById('remote-cube-player');
if (remoteCubePlayerEl) {
  remoteCubePlayerEl.style.touchAction = 'none';
  (twistyPlayerRemote as HTMLElement).style.cursor = 'grab';
  let remoteDragAnchor: THREE.Vector3 | null = null;

  function remotePointerToArcball(e: PointerEvent): THREE.Vector3 {
    const rect = remoteCubePlayerEl!.getBoundingClientRect();
    const radius = Math.min(rect.width, rect.height) / 2;
    const nx =  (e.clientX - rect.left - rect.width  / 2) / radius;
    const ny = -((e.clientY - rect.top  - rect.height / 2) / radius);
    return arcballProject(nx, ny);
  }

  remoteCubePlayerEl.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    remoteDragAnchor = remotePointerToArcball(e);
    remoteCubePlayerEl!.setPointerCapture(e.pointerId);
    (twistyPlayerRemote as HTMLElement).style.cursor = 'grabbing';
    // Decouple from peer's reported camera so dragging doesn't fight
    // any incoming 'camera' broadcasts. Surface the Sync View button
    // so the user can snap back.
    if (netPeer.connected) {
      remoteCameraSynced = false;
      $('#sync-camera-btn').show();
    }
  });

  remoteCubePlayerEl.addEventListener('pointermove', (e: PointerEvent) => {
    if (!remoteDragAnchor || !(e.buttons & 1)) return;
    const end = remotePointerToArcball(e);
    const axis = new THREE.Vector3().crossVectors(remoteDragAnchor, end);
    if (axis.lengthSq() < 1e-14) { remoteDragAnchor = end; return; }
    const angle = Math.acos(Math.max(-1, Math.min(1, remoteDragAnchor.dot(end))));
    const delta = new THREE.Quaternion().setFromAxisAngle(axis.normalize(), angle);
    remoteOrientAdjust.premultiply(delta);
    remoteDragAnchor = end;
  });

  remoteCubePlayerEl.addEventListener('pointerup', (e: PointerEvent) => {
    remoteCubePlayerEl!.releasePointerCapture(e.pointerId);
    (twistyPlayerRemote as HTMLElement).style.cursor = 'grab';
    remoteDragAnchor = null;
  });

  remoteCubePlayerEl.addEventListener('pointercancel', () => {
    remoteDragAnchor = null;
    (twistyPlayerRemote as HTMLElement).style.cursor = 'grab';
  });
}

var conn: SmartCubeConnection | null;

const SMARTCUBE_DEVICE_SELECTION_KEY = 'smartcubeDeviceSelection';

function storedSmartCubeDeviceSelection(): 'filtered' | 'any' {
  return localStorage.getItem(SMARTCUBE_DEVICE_SELECTION_KEY) === 'any' ? 'any' : 'filtered';
}

let connectAbort: AbortController | null = null;
let connectInFlight = false;

window.addEventListener('resize', () => requestAnimationFrame(applyCubeSizing));
window.addEventListener('pagehide', () => {
  if (connectInFlight && !conn) {
    connectAbort?.abort();
  }
});

let cubeSizePx: number = 400;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : (typeof value === 'number' ? value : Number.NaN);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function applyCubeSizing() {
  const preferredSizePx = clampInt(cubeSizePx, 240, 600, 400);
  const inSplitMode = $('#remote-cube').is(':visible');
  const cubeAreaEl = document.getElementById('cube-area');
  const remoteCubeEl = document.getElementById('remote-cube');
  const remoteCubePlayerEl = document.getElementById('remote-cube-player');

  let sizePx: number;
  if (inSplitMode && containerEl && containerEl.offsetWidth > 0) {
    const gapPx = Math.max(16, Math.round(containerEl.offsetWidth * 0.04));
    const halfWidth = Math.floor((containerEl.offsetWidth - gapPx) / 2);
    sizePx = Math.max(120, Math.min(preferredSizePx, halfWidth));

    // Give #cube-area an explicit width that exactly fits both cubes + gap,
    // then centre it within its grid column via justify-self.  This avoids the
    // overflow/flex-centering tricks that made hit-areas unreliable.
    const totalWidth = 2 * sizePx + gapPx;
    if (cubeAreaEl) {
      cubeAreaEl.style.width = `${totalWidth}px`;
      cubeAreaEl.style.justifySelf = 'center';
      cubeAreaEl.style.justifyContent = 'flex-start';
      cubeAreaEl.style.gap = `${gapPx}px`;
      cubeAreaEl.style.overflow = 'visible';
    }
    // flex:none = flex: 0 0 auto so explicit width is authoritative
    if (cubeCellEl) {
      cubeCellEl.style.flex = 'none';
      cubeCellEl.style.width = `${sizePx}px`;
      cubeCellEl.style.overflow = 'hidden'; // clip hint facelets at cube boundary
    }
    if (remoteCubeEl) {
      remoteCubeEl.style.flex = 'none';
      remoteCubeEl.style.width = `${sizePx}px`;
    }
  } else {
    sizePx = preferredSizePx;
    if (cubeAreaEl) {
      cubeAreaEl.style.width = '';
      cubeAreaEl.style.justifySelf = '';
      cubeAreaEl.style.justifyContent = '';
      cubeAreaEl.style.gap = '';
    }
    if (cubeCellEl) {
      cubeCellEl.style.flex = '1 1 0%';
      cubeCellEl.style.width = '';
      cubeCellEl.style.overflow = 'visible';
    }
  }

  const playersToSize: HTMLElement[] = [twistyPlayer as unknown as HTMLElement];
  if (inSplitMode) playersToSize.push(twistyPlayerRemote as unknown as HTMLElement);
  for (const player of playersToSize) {
    player.style.width = `${sizePx}px`;
    player.style.height = `${sizePx}px`;
    player.style.flexShrink = '0';
    player.style.maxWidth = 'none';
    player.style.maxHeight = 'none';
    player.style.overflow = 'visible';
  }

  // Ensure grid container and remote wrappers don't clip overflow.
  if (containerEl) containerEl.style.overflow = 'visible';
  if (remoteCubeEl) remoteCubeEl.style.overflow = 'visible';
  if (remoteCubePlayerEl) remoteCubePlayerEl.style.overflow = 'visible';
}

type SmartCubeMove = {
  face: number;
  direction: number;
  move: string;
  localTimestamp: number | null;
  cubeTimestamp: number | null;
};

var lastMoves: SmartCubeMove[] = [];
var solutionMoves: SmartCubeMove[] = [];

var twistyScene: THREE.Scene | null = null;
var twistyVantage: any;
var plasticMaterial: THREE.MeshBasicMaterial | null = null;

function applyPlasticColor() {
  if (!plasticMaterial) return;
  const isDark = document.documentElement.classList.contains('dark');
  (plasticMaterial as THREE.MeshBasicMaterial).color.set(isDark ? 0xffffff : 0x000000);
  plasticMaterial.needsUpdate = true;
}

function cachePlasticMaterial() {
  if (!twistyScene || plasticMaterial) return;
  twistyScene.traverse((obj: any) => {
    if (plasticMaterial) return;
    if (obj.isMesh) {
      const mat = obj.material as THREE.MeshBasicMaterial;
      if (mat?.transparent && Math.abs((mat.opacity ?? 1) - 0.3) < 0.01 &&
          mat.color?.r < 0.01 && mat.color?.g < 0.01 && mat.color?.b < 0.01) {
        plasticMaterial = mat;
      }
    }
  });
  applyPlasticColor();
}

const HOME_ORIENTATION = new THREE.Quaternion().setFromEuler(new THREE.Euler(15 * Math.PI / 180, -5 * Math.PI / 180, 0));
var cubeQuaternion: THREE.Quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(15 * Math.PI / 180, -20 * Math.PI / 180, 0));

// Default locked orientation used when gyroscope is disabled.
const DR_LOCK_BASE = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(15 * Math.PI / 180, -20 * Math.PI / 180, 0)
);

// Persistent user orientation adjustment, modified by arcball drag.
const ORIENT_ADJUST_KEY = 'orientAdjust';
let orientAdjust: THREE.Quaternion = (() => {
  try {
    const s = localStorage.getItem(ORIENT_ADJUST_KEY);
    if (s) {
      const { x, y, z, w } = JSON.parse(s);
      return new THREE.Quaternion(x, y, z, w).normalize();
    }
  } catch { /**/ }
  return new THREE.Quaternion();
})();


async function amimateCubeOrientation() {
  try {
    if (!twistyScene || !twistyVantage || forceFix) {
      const vantageList = await twistyPlayer.experimentalCurrentVantages();
      twistyVantage = [...vantageList][0];

      if (!twistyVantage) {
        requestAnimationFrame(amimateCubeOrientation);
        return;
      }

      twistyScene = await twistyVantage.scene.scene();
      cachePlasticMaterial();

      if (forceFix) forceFix = false;
    }

    // During replay, ignore live gyro orientation — the smartcube isn't
    // controlling what's on screen, and we want the user's arc-ball
    // drag to actually reorient the playback view instead of getting
    // immediately overwritten by the next gyro frame.
    if (gyroscopeEnabled && !isReplayActive()) {
      twistyScene?.quaternion.slerp(cubeQuaternion, 0.25);
    } else {
      twistyScene?.quaternion.slerp(orientAdjust.clone().multiply(DR_LOCK_BASE).multiply(viewFRotation), 0.25);
    }

    twistyVantage.render();
  } catch {
    // On any error, clear cached state so the next frame re-acquires
    twistyScene = null;
    twistyVantage = null;
  }
  requestAnimationFrame(amimateCubeOrientation);
}
requestAnimationFrame(amimateCubeOrientation);

var basis: THREE.Quaternion | null;

// CF-2: F= and U= face mappings. The smartcube reports orientation in
// its own internal world frame (gravity-aligned + cube-body labelled
// axes), but the user's POV is unknown to the app. The pickers let the
// user declare which colour is on F and U. Together they uniquely
// orient the rest pose; the gyro tracks deltas from there.
//
// U= 'gravity' means "use whichever body face the cube reports as up at
// connect time" — detected from the first gyro reading by finding the
// body axis closest to world +Y. Once detected, the value is locked
// (stable visuals even if the user tilts the cube mid-session). To
// re-detect, the user clicks Sync or Reset in the panel.
//
// Composition: scene = orientAdjust · HOME · viewFURotation · basis · quat.
// viewFURotation is a body-to-visual rotation derived from (F, U).
type FColor = 'white' | 'yellow' | 'red' | 'orange' | 'green' | 'blue';
type UColor = FColor | 'gravity';
const F_COLORS: readonly FColor[] = ['white', 'yellow', 'red', 'orange', 'green', 'blue'];
const U_COLORS: readonly UColor[] = ['gravity', ...F_COLORS];
const F_FACE_KEY = 'syncFFace';
const U_FACE_KEY = 'syncUFace';

// Body-frame axis for each colour, AFTER the (qx, qz, -qy, qw) swap
// applied in handleGyroEvent. Post-swap convention: +X=red, +Y=white,
// +Z=green (so the default rest pose with all axes identity has green
// at F, white on top, red on the right).
const COLOR_TO_BODY_AXIS: Record<FColor, THREE.Vector3> = {
  red:    new THREE.Vector3( 1,  0,  0),
  orange: new THREE.Vector3(-1,  0,  0),
  white:  new THREE.Vector3( 0,  1,  0),
  yellow: new THREE.Vector3( 0, -1,  0),
  green:  new THREE.Vector3( 0,  0,  1),
  blue:   new THREE.Vector3( 0,  0, -1),
};

// True if two colours are on the same body axis — i.e., same colour or
// opposite colours (which sit on opposite faces of the cube). F and U
// must be on different axes for a valid orientation; the picker rule
// auto-clears the other control when this happens, but
// makeFURotation also tolerates it via a fallback to keep the visual
// from collapsing to identity.
function isSameAxis(a: FColor, b: FColor): boolean {
  return Math.abs(COLOR_TO_BODY_AXIS[a].dot(COLOR_TO_BODY_AXIS[b])) > 0.001;
}

// Pick the first colour from `tryOrder` that isn't on the same axis as
// `against`. Used to choose a fallback when F and U conflict.
function firstNonConflicting(against: FColor, tryOrder: readonly FColor[]): FColor {
  for (const c of tryOrder) {
    if (c !== against && !isSameAxis(c, against)) return c;
  }
  return tryOrder[0];
}

// Rotation that brings body's F-axis to visual +Z (camera direction)
// and body's U-axis to visual +Y (up). The matrix has rows (rAxis,
// uAxis, fAxis) where rAxis = uAxis × fAxis. If F and U are on the
// same axis (same/opposite colour) we fall back to the first adjacent
// U so the F face still shows correctly — the picker conflict rule
// usually prevents this, but gyro-detected U + a manual F can race
// into the conflict state momentarily.
function makeFURotation(fColor: FColor, uColor: FColor): THREE.Quaternion {
  const fAxis = COLOR_TO_BODY_AXIS[fColor].clone();
  let uAxis = COLOR_TO_BODY_AXIS[uColor].clone();
  if (isSameAxis(fColor, uColor)) {
    const fallback = firstNonConflicting(fColor, ['white', 'red', 'green', 'yellow', 'orange', 'blue']);
    uAxis = COLOR_TO_BODY_AXIS[fallback].clone();
  }
  const rAxis = new THREE.Vector3().crossVectors(uAxis, fAxis).normalize();
  const m = new THREE.Matrix4().makeBasis(rAxis, uAxis, fAxis);
  m.transpose();
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

// Find which colour is currently on top, given a gyro quaternion.
// Picks the body axis whose image under quat has the largest +Y
// component (post-axis-swap, world +Y is the gravity-up direction).
function determineEffectiveU(quat: THREE.Quaternion): FColor {
  let bestColor: FColor = 'white';
  let bestDot = -Infinity;
  for (const color of F_COLORS) {
    const worldDir = COLOR_TO_BODY_AXIS[color].clone().applyQuaternion(quat);
    if (worldDir.y > bestDot) {
      bestDot = worldDir.y;
      bestColor = color;
    }
  }
  return bestColor;
}

function loadFFace(): FColor {
  try {
    const s = localStorage.getItem(F_FACE_KEY);
    if (s && (F_COLORS as readonly string[]).includes(s)) return s as FColor;
  } catch { /**/ }
  return 'green';
}

function loadUFace(): UColor {
  try {
    const s = localStorage.getItem(U_FACE_KEY);
    if (s && (U_COLORS as readonly string[]).includes(s)) return s as UColor;
  } catch { /**/ }
  return 'gravity';
}

let currentFFace: FColor = loadFFace();
let currentUFace: UColor = loadUFace();
// Cached "effective" U colour — equal to currentUFace when it's a
// specific colour; computed from the gyro when currentUFace='gravity'.
// Updated on first gyro after basis reset and on U-picker change.
let lockedEffectiveU: FColor = currentUFace === 'gravity' ? 'white' : currentUFace;
let viewFRotation: THREE.Quaternion = makeFURotation(currentFFace, lockedEffectiveU);

function refreshViewFURotation() {
  viewFRotation = makeFURotation(currentFFace, lockedEffectiveU);
}

function setFFace(color: FColor) {
  currentFFace = color;
  try { localStorage.setItem(F_FACE_KEY, color); } catch { /**/ }
  // Conflict rule: U can't be on F's axis (same or opposite colour).
  // If the existing U conflicts, clear it back to 'gravity' so it
  // re-detects from the next gyro event.
  if (currentUFace !== 'gravity' && isSameAxis(color, currentUFace)) {
    currentUFace = 'gravity';
    try { localStorage.setItem(U_FACE_KEY, 'gravity'); } catch { /**/ }
    basis = null;
    updateSyncUGridSelection();
  }
  refreshViewFURotation();
  updateSyncFGridSelection();
}

function setUFace(color: UColor) {
  // Conflict rule: F can't be on U's axis. When U is set to a specific
  // colour that's on F's axis, clear F to the first non-conflicting
  // default — green first, then red etc. if green would also conflict.
  if (color !== 'gravity' && isSameAxis(currentFFace, color)) {
    currentFFace = firstNonConflicting(color, ['green', 'red', 'white', 'yellow', 'blue', 'orange']);
    try { localStorage.setItem(F_FACE_KEY, currentFFace); } catch { /**/ }
    updateSyncFGridSelection();
  }
  currentUFace = color;
  try { localStorage.setItem(U_FACE_KEY, color); } catch { /**/ }
  if (color !== 'gravity') {
    lockedEffectiveU = color;
  } else {
    // Re-detect from the next gyro event by clearing basis. The
    // handleGyroEvent flow recomputes lockedEffectiveU before setting
    // basis when it's null.
    basis = null;
  }
  refreshViewFURotation();
  updateSyncUGridSelection();
}

function updateSyncFGridSelection() {
  $('.sync-f-chit').each((_, el) => {
    const chit = el as HTMLButtonElement;
    if (chit.dataset.color === currentFFace) chit.classList.add('sync-f-chit-selected');
    else chit.classList.remove('sync-f-chit-selected');
  });
}

function updateSyncUGridSelection() {
  $('.sync-u-chit').each((_, el) => {
    const chit = el as HTMLButtonElement;
    if (chit.dataset.color === currentUFace) chit.classList.add('sync-u-chit-selected');
    else chit.classList.remove('sync-u-chit-selected');
  });
}

async function handleGyroEvent(event: SmartCubeEvent) {
  if (event.type == "GYRO") {
    if (conn?.capabilities.gyroscope && gyroscopeToggle.disabled) {
      setGyroscopeUiFromSupported(true);
    }
    let { x: qx, y: qy, z: qz, w: qw } = event.quaternion;
    // CF-3: forward the raw (pre-swap, pre-basis) quaternion to the
    // high-res gyro recorder. No-op unless an opt-click recording is
    // active.
    fsOnRawGyro(event.quaternion);
    let quat = new THREE.Quaternion(qx, qz, -qy, qw).normalize();
    if (!basis) {
      // When U='gravity', re-detect which body face is currently up
      // from this fresh gyro reading and lock the effective U. The
      // viewFRotation is then rebuilt before composition so the rest
      // pose immediately reflects the cube's reported orientation.
      if (currentUFace === 'gravity') {
        lockedEffectiveU = determineEffectiveU(quat);
        refreshViewFURotation();
      }
      basis = quat.clone().conjugate();
    }
    cubeQuaternion.copy(quat.premultiply(basis).premultiply(viewFRotation).premultiply(HOME_ORIENTATION).premultiply(orientAdjust));
    if (netPeer.connected) {
      const now = Date.now();
      if (now - lastGyroNetTime >= 33) {
        lastGyroNetTime = now;
        netPeer.send({ type: 'gyro', x: cubeQuaternion.x, y: cubeQuaternion.y, z: cubeQuaternion.z, w: cubeQuaternion.w });
      }
    }
    $('#quaternion').val(`x: ${qx.toFixed(3)}, y: ${qy.toFixed(3)}, z: ${qz.toFixed(3)}, w: ${qw.toFixed(3)}`);
    if (event.velocity) {
      let { x: vx, y: vy, z: vz } = event.velocity;
      $('#velocity').val(`x: ${vx}, y: ${vy}, z: ${vz}`);
    }
  }
}

// Define the type of userAlg explicitly as an array of strings
var userAlg: string[] = [];
var originalUserAlg: string[] = [];
var scrambleToAlg: string[] = [];
var badAlg: string[] = [];
var patternStates: KPattern[] = [];
var algPatternStates: KPattern[] = [];
var currentMoveIndex = 0;
var inputMode: boolean = true;
var scrambleMode: boolean = false;
let scrambleOffPathMoves: string[] = [];
let scrambleDivergenceRemaining: string = '';
let scrambleHintTimeout: ReturnType<typeof setTimeout> | null = null;

let currentAnimSpeed = 1.0;

const visualMoveQueue: string[] = [];
let visualMoveTimer: ReturnType<typeof setTimeout> | null = null;

function drainVisualQueue() {
  if (visualMoveQueue.length === 0) { visualMoveTimer = null; return; }
  twistyPlayer.experimentalAddMove(visualMoveQueue.shift()!, { cancel: false });
  visualMoveTimer = setTimeout(drainVisualQueue, Math.round(100 / currentAnimSpeed));
}

function enqueueVisualMove(move: string) {
  if (currentAnimSpeed <= 0.75) {
    visualMoveQueue.push(move);
    if (!visualMoveTimer) drainVisualQueue();
  } else {
    twistyPlayer.experimentalAddMove(move, { cancel: false });
  }
}

function clearVisualQueue() {
  visualMoveQueue.length = 0;
  if (visualMoveTimer) { clearTimeout(visualMoveTimer); visualMoveTimer = null; }
}

// ── Network sharing (WebRTC / PeerJS) ─────────────────────────────────────────

const netPeer = new NetPeer();

// Bridge Full Solve scramble changes → net broadcast. fullSolve.ts calls
// this every time its currentScramble changes locally (new / paste / 🎯)
// while the user has "Share scrambles" enabled.
setOnLocalScrambleChange((scramble) => {
  if (netPeer.connected) netPeer.send({ type: 'fs-scramble', text: scramble });
});

// Bridge Full Solve share-toggle changes → net broadcast so the peer's
// switch can grey out / un-grey appropriately.
setOnShareStateChange((sharing) => {
  if (netPeer.connected) netPeer.send({ type: 'fs-share', sharing });
});
let remoteHasCube = false;
let remoteAlgName = '';
let remoteScramble = '';
let twistySceneRemote: THREE.Scene | null = null;
const remoteGyroTarget = new THREE.Quaternion().copy(HOME_ORIENTATION);
let lastGyroNetTime = 0;
let remoteAnimStarted = false;
let remoteCameraSynced = true;

const remoteVisualMoveQueue: string[] = [];
let remoteVisualMoveTimer: ReturnType<typeof setTimeout> | null = null;

// Tracks physical moves applied since the last alg reset so they can be
// replayed on a newly-connected viewer via the 'state' message.
let appliedPhysicalMoves: string[] = [];

function drainRemoteVisualQueue() {
  if (remoteVisualMoveQueue.length === 0) { remoteVisualMoveTimer = null; return; }
  twistyPlayerRemote.experimentalAddMove(remoteVisualMoveQueue.shift()!, { cancel: false });
  remoteVisualMoveTimer = setTimeout(drainRemoteVisualQueue, Math.round(100 / currentAnimSpeed));
}

function enqueueRemoteVisualMove(move: string) {
  if (currentAnimSpeed <= 0.75) {
    remoteVisualMoveQueue.push(move);
    if (!remoteVisualMoveTimer) drainRemoteVisualQueue();
  } else {
    twistyPlayerRemote.experimentalAddMove(move, { cancel: false });
  }
}
let lastRemoteCameraLat = 0;
let lastRemoteCameraLon = 0;
let lastCamBroadcastTime = 0;

var twistyVantageRemote: any;
let remoteVantageReady = false;

async function animateRemoteCube() {
  try {
    if (!twistySceneRemote || !twistyVantageRemote) {
      const vantages = await twistyPlayerRemote.experimentalCurrentVantages();
      twistyVantageRemote = [...vantages][0];
      if (twistyVantageRemote?.scene) twistySceneRemote = await twistyVantageRemote.scene.scene();
      if (!remoteVantageReady && twistySceneRemote) {
        remoteVantageReady = true;
        // TwistyPlayer sizes its canvas via ResizeObserver. Calling applyCubeSizing
        // here (after init) ensures the canvas is set to the correct dimensions
        // rather than whatever size it read at connection time.
        applyCubeSizing();
      }
    }
    if (twistySceneRemote) {
      // Compose the partner's reported orientation with our local drag
      // offset so manual drag-to-reorient persists across gyro frames
      // from the partner.
      const target = remoteOrientAdjust.clone().multiply(remoteGyroTarget);
      twistySceneRemote.quaternion.slerp(target, 0.25);
    }
    if (twistyVantageRemote) {
      twistyVantageRemote.render();
    }
  } catch {
    twistySceneRemote = null;
    twistyVantageRemote = null;
  }
  requestAnimationFrame(animateRemoteCube);
}

function updateSplitMode() {
  const split = netPeer.connected && remoteHasCube;
  // Show/hide remote-cube FIRST so applyCubeSizing can see the correct visibility.
  $('#remote-cube').toggle(split);
  $('#sync-steps-btn').toggle(split && !!conn);
  if (split) {
    // Size containers synchronously so TwistyPlayer initialises its canvas at the
    // right dimensions (canvas size is fixed at initialisation time).
    applyCubeSizing();
    if (!$('#remote-cube-player').children().length) {
      $('#remote-cube-player').append(twistyPlayerRemote);
    }
    if (!remoteAnimStarted) {
      remoteAnimStarted = true;
      requestAnimationFrame(animateRemoteCube);
    }
  }
  // Also schedule a second pass in case the first-pass layout was slightly stale.
  requestAnimationFrame(applyCubeSizing);
}

function updateRemoteDisplay() {
  if (!netPeer.connected) {
    $('#remote-info').hide();
    $('#send-scramble-btn').hide();
    return;
  }
  $('#remote-alg-name').text(remoteAlgName);
  $('#remote-scramble-display').text(remoteScramble);
  $('#remote-info').show();
  $('#send-scramble-btn').toggle(userAlg.length > 0);
}

netPeer.onMessage = (msg: NetMessage) => {
  switch (msg.type) {
    case 'gyro':
      remoteGyroTarget.set(msg.x, msg.y, msg.z, msg.w);
      break;
    case 'move':
      enqueueRemoteVisualMove(msg.move);
      break;
    case 'alg':
      remoteVisualMoveQueue.length = 0;
      if (remoteVisualMoveTimer) { clearTimeout(remoteVisualMoveTimer); remoteVisualMoveTimer = null; }
      twistyPlayerRemote.alg = msg.alg.join(' ');
      remoteAlgName = msg.name;
      updateRemoteDisplay();
      break;
    case 'scramble':
      remoteScramble = msg.text;
      updateRemoteDisplay();
      break;
    case 'state':
      remoteVisualMoveQueue.length = 0;
      if (remoteVisualMoveTimer) { clearTimeout(remoteVisualMoveTimer); remoteVisualMoveTimer = null; }
      // Prefer the host's facelets when present — that's the
      // authoritative current state and works even when the cube was
      // already scrambled before the app saw it (no logged moves).
      // Fall back to alg + post-alg moves concatenated for compatibility
      // with peers that don't send facelets.
      if (msg.facelets) {
        try {
          const setupAlg = min2phase.solve(msg.facelets);
          // min2phase returns the SOLUTION (moves to solve the cube); to
          // reproduce the scrambled state from solved we invert it.
          twistyPlayerRemote.alg = setupAlg
            ? Alg.fromString(setupAlg).invert().toString()
            : '';
        } catch {
          twistyPlayerRemote.alg = [...(msg.alg || []), ...(msg.moves || [])].join(' ');
        }
      } else {
        twistyPlayerRemote.alg = [...(msg.alg || []), ...(msg.moves || [])].join(' ');
      }
      remoteAlgName = msg.name;
      remoteScramble = msg.scramble;
      remoteHasCube = msg.hasCube;
      // Initial Full Solve sync: if the peer is the active scramble
      // sharer when we join, grey out our switch and adopt their current
      // FS scramble.
      if (msg.fsSharing) {
        setPeerSharingScrambles(true);
        if (typeof msg.fsScramble === 'string' && msg.fsScramble.length > 0) {
          applyRemoteFsScramble(msg.fsScramble);
        }
      } else {
        setPeerSharingScrambles(false);
      }
      updateSplitMode();
      updateRemoteDisplay();
      break;
    case 'cube-connected':
      remoteHasCube = msg.connected;
      updateSplitMode();
      break;
    case 'camera':
      lastRemoteCameraLat = msg.lat;
      lastRemoteCameraLon = msg.lon;
      if (remoteCameraSynced) {
        twistyPlayerRemote.cameraLatitude = msg.lat;
        twistyPlayerRemote.cameraLongitude = msg.lon;
      }
      break;
    case 'request-state-sync':
      // Partner asked for a fresh snapshot — refresh from the smartcube
      // first to catch any drift, then send our 'state' message.
      void sendStateSnapshot(true);
      break;
    case 'fs-scramble':
      // Partner is the active scramble-sharer; apply their scramble to
      // our Full Solve mode. Echo suppression is handled inside
      // applyRemoteFsScramble.
      applyRemoteFsScramble(msg.text);
      break;
    case 'fs-share':
      // Partner toggled their share switch. Update local state — when
      // they're sharing, our switch greys out (the "only one at a time"
      // constraint).
      setPeerSharingScrambles(msg.sharing);
      break;
    case 'challenge-scramble':
      (async () => {
        const algStr = msg.alg.join(' ');
        const currentPattern = await twistyTracker.experimentalModel.currentPattern.get();
        // Compute moves from current physical state to the challenge case.
        // getScrambleToSolution gives the scramble needed to reach the alg's case from currentPattern.
        const scramble = getScrambleToSolution(algStr, currentPattern);
        const label = msg.name ? `Partner's case (${msg.name}): ` : 'Partner\'s case: ';
        $('#alg-scramble-text').text(label + (scramble || '(already there!)'));
        $('#alg-scramble').show();
      })();
      break;
  }
};

// Build and send the local 'state' snapshot to the peer. Extracted so
// both the initial onConnected handshake AND the manual Sync State
// button can use the same code path. Optionally requests fresh facelets
// from the smartcube first — even when twistyTracker thinks it knows
// the pattern, asking the cube directly avoids drift from missed events.
async function sendStateSnapshot(refreshFromCube: boolean): Promise<void> {
  if (!netPeer.connected) return;
  // Ask the cube for current facelets first; the resulting FACELETS event
  // updates twistyTracker before we read its pattern below. If the cube
  // doesn't expose this capability (or isn't connected), we just read
  // whatever twistyTracker has.
  if (refreshFromCube && conn?.capabilities.facelets) {
    try { await conn.sendCommand({ type: 'REQUEST_FACELETS' }); } catch { /* ignore */ }
  }
  let facelets: string | undefined;
  try {
    const p = await twistyTracker.experimentalModel.currentPattern.get();
    facelets = patternToFacelets(p);
  } catch { /* ignore */ }
  netPeer.send({
    type: 'state',
    alg: userAlg,
    name: currentAlgName,
    scramble: $('#alg-scramble-text').text(),
    scrambleMode,
    hasCube: !!conn,
    moves: appliedPhysicalMoves.slice(),
    facelets,
    fsSharing: isSharingScrambles(),
    fsScramble: isSharingScrambles() ? (getCurrentFsScramble() || undefined) : undefined,
  });
}

netPeer.onConnected = () => {
  $('#net-waiting').hide();
  $('#net-status').text('Connected ✓').show();
  $('#net-disconnect-btn').show();
  $('#net-hosting-area').hide();
  $('#net-join-area').hide();
  $('#net-main-btns').hide();
  // Show the Full Solve "Share scrambles" switch (visible only while
  // connected to a peer).
  setShareScramblesNetVisible(true);
  // Push our current state to the freshly-connected peer.
  void sendStateSnapshot(true);
  // Send current camera orientation
  (async () => {
    const coords = await (twistyPlayer.experimentalModel as any)?.twistySceneModel?.orbitCoordinates?.get();
    if (coords && netPeer.connected) {
      netPeer.send({ type: 'camera', lat: coords.latitude, lon: coords.longitude });
    }
  })();
  updateSplitMode();
  updateRemoteDisplay();
};

netPeer.onDisconnected = () => {
  // Hide the FS "Share scrambles" switch and reset its state on disconnect.
  setShareScramblesNetVisible(false);
  remoteHasCube = false;
  remoteAlgName = '';
  remoteScramble = '';
  remoteVisualMoveQueue.length = 0;
  if (remoteVisualMoveTimer) { clearTimeout(remoteVisualMoveTimer); remoteVisualMoveTimer = null; }
  twistyPlayerRemote.alg = '';
  remoteCameraSynced = true;
  remoteVantageReady = false;
  $('#sync-camera-btn').hide();
  updateSplitMode();
  updateRemoteDisplay();
  $('#net-status').text('Disconnected').show();
  $('#net-disconnect-btn').hide();
  $('#net-share-btn').prop('disabled', false).text('🔗 Share');
  $('#net-join-btn').prop('disabled', false);
  $('#net-hosting-area').hide();
  $('#net-join-area').hide();
  $('#net-main-btns').show();
};

netPeer.onError = (err) => {
  $('#net-status').text(`Error: ${err}`).show();
};

// ── Net panel UI ──────────────────────────────────────────────────────────────

$('#net-share-btn').on('click', async () => {
  $('#net-share-btn').prop('disabled', true).text('…');
  try {
    const code = await netPeer.host();
    $('#net-code').text(code);
    $('#net-main-btns').hide();
    $('#net-hosting-area').show();
    $('#net-join-area').hide();
    $('#net-waiting').show();
  } catch {
    $('#net-share-btn').prop('disabled', false).text('🔗 Share');
  }
});

$('#net-join-toggle-btn').on('click', () => {
  $('#net-main-btns').hide();
  $('#net-join-area').show();
  $('#net-join-input').val('').trigger('focus');
});

$('#net-join-cancel-btn').on('click', () => {
  $('#net-join-area').hide();
  $('#net-main-btns').show();
});

$('#net-copy-btn').on('click', () => {
  const code = $('#net-code').text();
  if (!code) return;
  navigator.clipboard.writeText(code);
  // Flash the code and icon
  const $code = $('#net-code');
  const $btn = $('#net-copy-btn');
  $code.addClass('text-green-500 dark:text-green-400').removeClass('text-gray-900 dark:text-white');
  $btn.text('✓').addClass('text-green-500 dark:text-green-400').removeClass('text-gray-500');
  setTimeout(() => {
    $code.removeClass('text-green-500 dark:text-green-400').addClass('text-gray-900 dark:text-white');
    $btn.text(COPY_ICON).removeClass('text-green-500 dark:text-green-400').addClass('text-gray-500');
  }, 1000);
});

$('#net-cancel-btn').on('click', () => {
  netPeer.disconnect();
  $('#net-hosting-area').hide();
  $('#net-main-btns').show();
  $('#net-share-btn').prop('disabled', false).text('🔗 Share');
});

$('#net-paste-btn').on('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    const code = text.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (code) $('#net-join-input').val(code);
  } catch { /* clipboard read denied */ }
});

// Auto-insert the dash when the user types the first digit (e.g. "TIGER4" → "TIGER-4").
$('#net-join-input').on('input', function () {
  const input = this as HTMLInputElement;
  let val = input.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  // If there's no dash yet and we see a digit after letters, insert it
  if (!val.includes('-')) {
    const firstDigit = val.search(/[0-9]/);
    if (firstDigit > 0) {
      val = val.slice(0, firstDigit) + '-' + val.slice(firstDigit);
    }
  }
  if (input.value !== val) input.value = val;
});

$('#net-join-btn').on('click', async () => {
  const code = ($('#net-join-input').val() as string).trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (!code) return;
  $('#net-status').text('Connecting…').show();
  $('#net-join-btn').prop('disabled', true);
  try {
    await netPeer.join(code);
    // onConnected fires via the data connection open event
  } catch {
    $('#net-status').text('Failed to connect').show();
    $('#net-join-btn').prop('disabled', false);
  }
});

$('#net-disconnect-btn').on('click', () => {
  netPeer.disconnect();
});

$('#send-scramble-btn').on('click', () => {
  if (netPeer.connected && userAlg.length > 0) {
    netPeer.send({ type: 'challenge-scramble', alg: userAlg, name: currentAlgName });
    $('#send-scramble-btn').text('📤 Sent!');
    setTimeout(() => $('#send-scramble-btn').text('📤 Send Case'), 1500);
  }
});

// Manual remote-state refresh. Useful when the auto-sync on connect
// missed the host's actual cube state (e.g., the cube was already
// scrambled before the app saw it, so twistyTracker started from solved
// and there were no logged moves to replay).
$('#sync-state-btn').on('click', () => {
  if (!netPeer.connected) return;
  netPeer.send({ type: 'request-state-sync' });
  $('#sync-state-btn').text('🔄 Syncing…');
  setTimeout(() => $('#sync-state-btn').text('🔄 Sync State'), 1200);
});

$('#sync-steps-btn').on('click', async () => {
  // Compute moves to get from viewer's physical cube state to sharer's current cube state.
  const myPattern = await twistyTracker.experimentalModel.currentPattern.get();
  const remotePattern = await twistyPlayerRemote.experimentalModel.currentPattern.get();
  const mySolve = min2phase.solve(patternToFacelets(fixOrientation(myPattern)));
  const remoteSolve = min2phase.solve(patternToFacelets(fixOrientation(remotePattern)));
  const inverseRemoteSolve = Alg.fromString(remoteSolve).invert().toString();
  const combined = (mySolve + ' ' + inverseRemoteSolve).trim();
  const syncScramble = Alg.fromString(combined).experimentalSimplify({ cancel: true, puzzleLoader: cube3x3x3 }).toString().trim();
  if (syncScramble) {
    $('#alg-scramble-text').text('Sync: ' + syncScramble);
  } else {
    $('#alg-scramble-text').text('Already in sync!');
  }
  $('#alg-scramble').show();
});

$('#sync-camera-btn').on('click', () => {
  remoteCameraSynced = true;
  twistyPlayerRemote.cameraLatitude = lastRemoteCameraLat;
  twistyPlayerRemote.cameraLongitude = lastRemoteCameraLon;
  // Also clear any local drag offset so the cube fully snaps back to
  // what the partner is showing.
  remoteOrientAdjust.identity();
  $('#sync-camera-btn').hide();
});

twistyPlayerRemote.addEventListener('pointerdown', () => {
  if (netPeer.connected) {
    remoteCameraSynced = false;
    $('#sync-camera-btn').show();
  }
});

// Subscribe to local cube camera changes to broadcast to peer.
// orbitCoordinates lives on TwistySceneModel, not TwistyPlayerModel.
{
  const sceneModel = (twistyPlayer.experimentalModel as any)?.twistySceneModel;
  sceneModel?.orbitCoordinates?.addFreshListener?.((coords: any) => {
    if (!netPeer.connected) return;
    const now = Date.now();
    if (now - lastCamBroadcastTime < 100) return; // 10 fps cap
    lastCamBroadcastTime = now;
    netPeer.send({ type: 'camera', lat: coords.latitude, lon: coords.longitude });
  });
}

// ── End network sharing ───────────────────────────────────────────────────────

function resetAlg() {
  currentMoveIndex = -1; // Reset the move index
  badAlg = [];
  sliceOrientation = { ...IDENTITY };
  hideMistakes();
  clearVisualQueue();
}

$('#train-alg').on('click', () => {
  const algInput = $('#alg-input').val()?.toString().trim();
  if (algInput) {
    inputMode = false;
    userAlg = expandNotation(algInput).split(/\s+/); // Split the input string into moves
    currentAlgName = checkedAlgorithms[0]?.name || '';
    $('#alg-display').text(userAlg.join(' ')); // Display the alg
    appliedPhysicalMoves = [];
    if (netPeer.connected) netPeer.send({ type: 'alg', alg: userAlg, name: currentAlgName });
    updateRemoteDisplay();
    $('#alg-display-container').show();
    $('#timer').show();
    $('#alg-input').hide();
    $('#save-container').hide();
    $('#alg-stats').show();
    hideMistakes();
    if (scrambleMode && !alwaysScrambleTo) {
      $('#alg-scramble').hide();
      $('#alg-help-info').hide();
      scrambleMode = false;
    }
    hasFailedAlg = false;
    patternStates = [];
    algPatternStates = [];
    fetchNextPatterns();
    setTimerState("READY");
    updateTimesDisplay();
    scrambleToAlg = [];
    if (alwaysScrambleTo) {
      $('#scramble-to').trigger('click');
    }
    $("#toggle-display").css("display", "inline-flex");
    $('#left-side-inner').show();
  } else {
    $('#alg-input').show();
    $('#left-side-inner').hide();
    $('#alg-input').get(0)?.focus();
  }
  resetAlg();
  if ($('#alg-display').text() !== '') {
    updateAlgDisplay();
  }
});

function fetchNextPatterns() {
  drawAlgInCube();
  if (keepInitialState) {
    keepInitialState = false;
  } else {
    initialstate = patternStates.length === 0 ? myKpattern : patternStates[patternStates.length - 1];
  }
  userAlg.forEach((move, index) => {
    move = move.replace(/[()]/g, "");
    if (index === 0) patternStates[index] = initialstate.applyMove(move);
    else patternStates[index] = algPatternStates[index - 1].applyMove(move);
    algPatternStates[index]=patternStates[index];
    patternStates[index]=fixOrientation(patternStates[index]);
    //console.log("patternStates[" + index + "]=" + JSON.stringify(patternStates[index].patternData));
  });
}

function drawAlgInCube() {
  originalUserAlg = [...userAlg];
  if (randomizeAUF && scrambleToAlg.length === 0) {
    let AUF = ["U", "U'", "U2", ""];
    let randomAUF = AUF[Math.floor(Math.random() * AUF.length)];
    if (randomAUF.length > 0) {
      // check if we can add randomAUF to the beginning of the alg, as there are some tricky cases like Na, Nb, E, OLL-21, OLL-57, etc..
      // Eg: Na + U' == U + Na but Sune + U' != U + Sune
      let kpattern = faceletsToPattern(SOLVED_STATE);

      let algWithStartU = Alg.fromString("U " + userAlg.join(' '));
      let resultWithStartU = kpattern.applyAlg(algWithStartU);

      let algWithEndU = Alg.fromString(userAlg.join(' ') + " U'");
      let resultWithEndU = kpattern.applyAlg(algWithEndU);

      let algWithStartU2 = Alg.fromString("U2 " + userAlg.join(' '));
      let resultWithStartU2 = kpattern.applyAlg(algWithStartU2);

      let algWithEndU2 = Alg.fromString(userAlg.join(' ') + " U2'");
      let resultWithEndU2 = kpattern.applyAlg(algWithEndU2);

      let category = $('#category-select').val()?.toString().toLowerCase();
      let isOLL = category?.includes("oll");
      let areNotIdentical = !resultWithStartU.isIdentical(resultWithEndU) && !resultWithStartU2.isIdentical(resultWithEndU2);

      // post AUF for pll and zbll
      if (category?.includes("pll") || category?.includes("zbll")) {
        let randomPostAUF = AUF[Math.floor(Math.random() * AUF.length)];
        if (randomPostAUF.length > 0) {
          userAlg.push(randomPostAUF);
        }
      }

      if ((areNotIdentical && !isOLL) || isOLL && !isSymmetricOLL(userAlg.join(' '))) {
        userAlg.unshift(randomAUF); // add randomAUF to the beginning of the alg
        userAlg = Alg.fromString(userAlg.join(' ')).experimentalSimplify({ cancel: true, puzzleLoader: cube3x3x3 }).toString().split(/\s+/); // simplify alg by cancelling possible U moves at the beginning
        $('#alg-display').text(userAlg.join(' '));
      }
    }
  }
  if (randomizeAUF && scrambleToAlg.length > 0) {
    userAlg = [...scrambleToAlg];
    $('#alg-display').text(userAlg.join(' '));
    scrambleToAlg = [];
  }
  appliedPhysicalMoves = [];
  setTwistyAlg(Alg.fromString(userAlg.join(' ')).invert().toString());
}

var showMistakesTimeout: NodeJS.Timeout;
let hasShownFlashingIndicator = false;
let hasFailedAlg = false;
let previousFixHtmlLength = 0;

function showMistakesWithDelay(fixHtml: string) {
  if (fixHtml.length > 0) {
    $('#alg-fix').html(fixHtml);
    clearTimeout(showMistakesTimeout);
    showMistakesTimeout = setTimeout(function() {
      $('#alg-fix').show();
      // Only show #alg-help-info if the current fixHtml length is greater than the previous length
      let fixHtmlLength = countMovesETM(fixHtml);
      if (fixHtmlLength > previousFixHtmlLength && fixHtmlLength > 1) {
        $('#alg-help-info').removeClass('text-green-400 dark:text-green-500').addClass('text-red-400 dark:text-red-500').show();
      } else {
        $('#alg-help-info').hide();
      }
      previousFixHtmlLength = fixHtmlLength;
      // Show the red flashing indicator if enabled and not already shown
      if (!hasShownFlashingIndicator) {
        showFlashingIndicator('red', 300);
        hasShownFlashingIndicator = true;
      }
      // if the user fails the current alg, make the case appear more often
      if (checkedAlgorithms.length > 0) {
        if (prioritizeFailedAlgs && !checkedAlgorithmsCopy.includes(checkedAlgorithms[0])) {
          checkedAlgorithmsCopy.push(checkedAlgorithms[0]);
          //console.log("+++ Pushing failed alg " + checkedAlgorithms[0].name + " to checkedAlgorithmsCopy: " + JSON.stringify(checkedAlgorithmsCopy));
        }
        // mark the failed alg in red
        if (checkedAlgorithms[0].algorithm) {
          let algId = algToId(checkedAlgorithms[0].algorithm);
          if (algId && !hasFailedAlg) {
            // defined in loadAlgorithms()
            $('#' + algId).removeClass('bg-gray-50 bg-gray-400 dark:bg-gray-600 dark:bg-gray-800');
            $('#' + algId).addClass('bg-red-400 dark:bg-red-400');
            // Increase the data-failed count
            let failedCount = parseInt($('#' + algId).data('failed')) || 0;
            //console.log("+++ failedCount for " + algId + " is " + failedCount + " at currentMoveIndex: " + currentMoveIndex);
            $('#' + algId).data('failed', failedCount + 1);
            hasFailedAlg = true;
          }
        }
      }
    }, 300);  // 0.3 second
  } else {
    hideMistakes();
  }
}

function hideMistakes() {
  // Clear the timeout if hide is called before the div is shown
  clearTimeout(showMistakesTimeout);
  $('#alg-help-info').hide();
  $('#alg-fix').hide();
  $('#alg-fix').html("");
  hasShownFlashingIndicator = false; // Reset the flag
}

function updateAlgDisplay() {
  let displayHtml = '';
  let color = '';
  let previousColor = '';
  let simplifiedBadAlg: string[] = [];
  let fixHtml  = '';

  if (badAlg.length > 0) {
    for (let i=0 ; i < badAlg.length; i++){
      fixHtml += getInverseMove(badAlg[badAlg.length - 1 - i])+" ";
    }

    // simplfy badAlg
    simplifiedBadAlg = Alg.fromString(fixHtml).experimentalSimplify({ cancel: true, puzzleLoader: cube3x3x3 }).toString().split(/\s+/);
    fixHtml = simplifiedBadAlg.join(' ').trim();
    if (fixHtml.length === 0) {
      badAlg = [];
    }
  }

  let parenthesisColor = darkModeToggle.checked ? 'white' : 'black';
  var isDoubleTurn = false;
  var isOppositeMove = false;
  var isAUF = false;
  userAlg.forEach((move, index) => {
    color = darkModeToggle.checked ? 'white' : 'black'; // Default color

    // Determine the color based on the move index
    if (index <= currentMoveIndex) {
      color = 'green'; // Correct moves
    } else if (index < 1 + currentMoveIndex + simplifiedBadAlg.length) {
      color = 'red'; // Incorrect moves
    }

    // Highlight the next move
    if (index === currentMoveIndex + 1 && color !== 'red') {
      color = 'white';
    }

    let cleanMove = move.replace(/[()']/g, "").trim();

    // don't mark initial AUF as incorrect when randomAUF is enabled
    if (index === 0 && currentMoveIndex === -1 && randomizeAUF){
      if (simplifiedBadAlg.length === 1 && simplifiedBadAlg[0][0] === 'U' && cleanMove.length > 0 && cleanMove[0].charAt(0) === 'U') {
        color = 'blue';
        isAUF = true;
      }
    }

    // Don't mark double turns and slices as errors when they are not yet completed
    if (index === currentMoveIndex + 1 && cleanMove.length > 1) {
        const isSingleBadAlg = simplifiedBadAlg.length === 1;
        const isDoubleBadAlg = simplifiedBadAlg.length === 2;
        const isTripleBadAlg = simplifiedBadAlg.length === 3;
        const rawExpected = cleanMove[0];
        const expectedFace = rawExpected.toUpperCase();
        const isWideMove = rawExpected >= 'a' && rawExpected <= 'z';
        const OPPOSITE_FACE: Record<string,string> = {R:'L',L:'R',U:'D',D:'U',F:'B',B:'F'};
        let localOrientation: FacePerm = { ...IDENTITY };
        for (let i = 0; i <= currentMoveIndex; i++) {
          const m = userAlg[i].replace(/[()]/g, '').trim();
          const rot = SLICE_ROTATION[m];
          if (rot) localOrientation = composePerm(localOrientation, rot);
        }
        const inv = invertPerm(localOrientation);
        const remappedBadFace = FACES.includes(simplifiedBadAlg[0]?.[0] as Face)
          ? inv[simplifiedBadAlg[0][0] as Face]
          : simplifiedBadAlg[0]?.[0];
        const badFace = simplifiedBadAlg[0]?.[0];
        const faceMatch = badFace === expectedFace || remappedBadFace === expectedFace
          || (isWideMove && (badFace === OPPOSITE_FACE[expectedFace] || remappedBadFace === OPPOSITE_FACE[expectedFace]));

        if ((isSingleBadAlg && faceMatch) ||
            (isDoubleBadAlg && 'MES'.includes(cleanMove[0])) ||
            (isTripleBadAlg && 'MES'.includes(cleanMove[0]))) {
            color = 'blue';
            isDoubleTurn = true;
        }
    }

    // don't mark a R as incorrect if it's followed by a L move, or a U as incorrect if it's followed by a D move
    let inverseMove = getInverseMove(simplifiedBadAlg[0]);
    let currentMove = userAlg[index]?.replace(/[()']/g, "");
    if (index === currentMoveIndex + 1 && simplifiedBadAlg.length === 1) {
      //console.log("inverseMove=" + inverseMove + " == nextMove=" + nextMove + " && oppositeMove=" + oppositeMove + " == currentMove=" + currentMove);
      let oppositeMove = getOppositeMove(inverseMove?.replace(/[()'2]/g, ""));
      let nextMove = userAlg[index + 1]?.replace(/[()]/g, "");
      if ((inverseMove === nextMove || (inverseMove?.charAt(0) === nextMove?.charAt(0) && nextMove?.charAt(1)=='2')) &&
          (oppositeMove === currentMove || (oppositeMove === currentMove?.charAt(0) && currentMove?.charAt(1)=='2'))) {
          color = 'white';
          isOppositeMove = true;
      }
    }
    if (index === currentMoveIndex + 2 && isOppositeMove) color = move.endsWith('2') && inverseMove != currentMove ? 'blue' : 'green';
    if (previousColor === 'blue' || (previousColor !== 'blue' && color !== 'blue' && isDoubleTurn)) color = darkModeToggle.checked ? 'white' : 'black';

    // Build moveHtml excluding parentheses
    let circleHtml = '';
    let preCircleHtml = '';
    let postCircleHtml = '';

    for (let char of move) {
      if (char === '(') {
        preCircleHtml += `<span style="color: ${parenthesisColor};">${char}</span>`;
      } else if (char === ')') {
        postCircleHtml += `<span style="color: ${parenthesisColor};">${char}</span>`;
      } else {
        circleHtml += `<span class="move" style="color: ${color}; -webkit-text-security: ${isMoveMasked ? 'disc' : 'none'};">${char}</span>`;
      }
    }

    // Wrap non-parenthesis characters in circle class if it's the current move
    if (index === currentMoveIndex + 1) {
      displayHtml += `${preCircleHtml}<span class="circle">${circleHtml}</span>${postCircleHtml} `;
    } else {
      displayHtml += `${preCircleHtml}${circleHtml}${postCircleHtml} `;
    }
    previousColor = color;
  });

  // Update the display with the constructed HTML
  $('#alg-display').html(displayHtml);

  if (isDoubleTurn || isAUF || isOppositeMove) fixHtml = '';
  if (fixHtml.length > 0) {
    showMistakesWithDelay(fixHtml);
  } else {
    hideMistakes();
  }

  // set the index to 0 when the alg is finished, displays the circle on the first move
  if (currentMoveIndex === userAlg.length - 1) currentMoveIndex = 0;
}

let keepInitialState: boolean = false;
let previousFacelets: string = '';
let isBugged = false;

let sliceBuffer: { event: SmartCubeEvent; timer: ReturnType<typeof setTimeout> } | null = null;

type Face = 'U' | 'D' | 'F' | 'B' | 'R' | 'L';
type FacePerm = Record<Face, Face>;
const FACES: Face[] = ['U', 'D', 'F', 'B', 'R', 'L'];
const IDENTITY: FacePerm = { U:'U', D:'D', F:'F', B:'B', R:'R', L:'L' };

function composePerm(a: FacePerm, b: FacePerm): FacePerm {
  const r = {} as FacePerm;
  for (const f of FACES) r[f] = b[a[f]];
  return r;
}
function invertPerm(p: FacePerm): FacePerm {
  const r = {} as FacePerm;
  for (const f of FACES) r[p[f]] = f;
  return r;
}

const ROT_X: FacePerm  = { U:'F', F:'D', D:'B', B:'U', R:'R', L:'L' };
const ROT_X2: FacePerm = composePerm(ROT_X, ROT_X);
const ROT_XI: FacePerm = invertPerm(ROT_X);
const ROT_Y: FacePerm  = { F:'R', R:'B', B:'L', L:'F', U:'U', D:'D' };
const ROT_Y2: FacePerm = composePerm(ROT_Y, ROT_Y);
const ROT_YI: FacePerm = invertPerm(ROT_Y);
const ROT_Z: FacePerm  = { U:'R', R:'D', D:'L', L:'U', F:'F', B:'B' };
const ROT_Z2: FacePerm = composePerm(ROT_Z, ROT_Z);
const ROT_ZI: FacePerm = invertPerm(ROT_Z);

const SLICE_ROTATION: Record<string, FacePerm> = {
  "M'": ROT_X, "M": ROT_XI, "M2": ROT_X2,
  "S": ROT_ZI, "S'": ROT_Z,  "S2": ROT_Z2,
  "E": ROT_YI, "E'": ROT_Y,  "E2": ROT_Y2,
  "r": ROT_X,  "r'": ROT_XI, "r2": ROT_X2,
  "l": ROT_XI, "l'": ROT_X,  "l2": ROT_X2,
  "u": ROT_Y,  "u'": ROT_YI, "u2": ROT_Y2,
  "d": ROT_YI, "d'": ROT_Y,  "d2": ROT_Y2,
  "f": ROT_ZI, "f'": ROT_Z,  "f2": ROT_Z2,
  "b": ROT_Z,  "b'": ROT_ZI, "b2": ROT_Z2,
  "x": ROT_X,  "x'": ROT_XI, "x2": ROT_X2,
  "y": ROT_Y,  "y'": ROT_YI, "y2": ROT_Y2,
  "z": ROT_ZI, "z'": ROT_Z,  "z2": ROT_Z2,
};

let sliceOrientation: FacePerm = { ...IDENTITY };

function updateSliceOrientation(sliceMove: string) {
  const rot = SLICE_ROTATION[sliceMove];
  if (rot) sliceOrientation = composePerm(sliceOrientation, rot);
}

function remapMoveForPlayer(move: string): string {
  const face = move.charAt(0) as Face;
  if (!FACES.includes(face)) return move;
  const inv = invertPerm(sliceOrientation);
  const mapped = inv[face];
  return mapped === face ? move : mapped + move.slice(1);
}

async function handleMoveEvent(event: SmartCubeEvent) {
  if (event.type !== "MOVE") return;

  // Slice-pair buffer-and-decide: runs regardless of gyro state. (Was
  // previously gyro-gated, but nothing inside touches gyro and gyro-on
  // is the typical state — gating meant slices never collapsed in
  // normal use.)
  const moveStr = event.move;
  if (isSliceCandidate(moveStr)) {
    if (sliceBuffer) {
      clearTimeout(sliceBuffer.timer);
      const bufferedEvent = sliceBuffer.event;
      sliceBuffer = null;
      const bufferedMove = bufferedEvent.type === "MOVE" ? bufferedEvent.move : '';
      const sliceMove = getSliceForPair(bufferedMove, moveStr);
      if (sliceMove) {
        twistyTracker.experimentalAddMove(bufferedMove, { cancel: false });
        return processMoveEvent(event, sliceMove, bufferedEvent);
      } else {
        await processMoveEvent(bufferedEvent);
        return processMoveEvent(event);
      }
    } else {
      sliceBuffer = {
        event,
        timer: setTimeout(() => {
          if (sliceBuffer) {
            const ev = sliceBuffer.event;
            sliceBuffer = null;
            processMoveEvent(ev);
          }
        }, SLICE_TOLERANCE_MS),
      };
      return;
    }
  }
  if (sliceBuffer) {
    clearTimeout(sliceBuffer.timer);
    const bufferedEvent = sliceBuffer.event;
    sliceBuffer = null;
    await processMoveEvent(bufferedEvent);
  }

  return processMoveEvent(event);
}

async function processMoveEvent(event: SmartCubeEvent, visualMove?: string, slicePairedFirst?: SmartCubeEvent) {
  if (event.type === "MOVE") {
    const logicalMove = event.move;

    // Replay overrides the cube display: while a stored solve is being
    // played back, live smartcube events must NOT animate the visual
    // cube, advance the tracker, or feed Full Solve. The event is
    // dropped — the user's physical moves will resume affecting things
    // as soon as they close replay.
    if (isReplayActive()) return;

    if (visualMove) {
      updateSliceOrientation(visualMove);
      enqueueVisualMove(visualMove);
    } else {
      enqueueVisualMove(remapMoveForPlayer(logicalMove));
    }
    twistyTracker.experimentalAddMove(event.move, { cancel: false });
    appliedPhysicalMoves.push(logicalMove);
    if (netPeer.connected) netPeer.send({ type: 'move', move: logicalMove });

    if (isFullSolveModeEnabled()) {
      // CF-4: pass the cube's own internal timestamp (when present) so
      // solveTurns reflects cube-clock seconds, not host-clock-with-BLE-
      // jitter seconds. Slice/wide-turn detection collapses on this
      // series. For paired pseudo-moves (slice detected at the index.ts
      // buffer), use the FIRST move's cubeTimestamp so the saved time
      // corresponds to when the user actually started the slice. AND
      // pass the slice token (visualMove) rather than the second face
      // turn — otherwise solveMoves would contain only one of the two
      // face turns that comprise the slice, losing the slice notation
      // even though twistyTracker correctly applied both layers
      // upstream. This is the fix for the bug where the live virtual
      // cube stayed in sync but the saved Solution: line showed face-
      // turn pairs (e.g. R' L) instead of slice tokens (M').
      const ts = (slicePairedFirst && slicePairedFirst.type === 'MOVE')
        ? slicePairedFirst.cubeTimestamp
        : (event.type === 'MOVE' ? event.cubeTimestamp : null);
      fsOnPhysicalMove(visualMove ?? logicalMove, ts);
    }

    if (scrambleMode) {

      const cubePattern = await twistyTracker.experimentalModel.currentPattern.get();
      const resolvedScramble = getScrambleToSolution(userAlg.join(' '), cubePattern)!;
      const currentScramble = $('#alg-scramble-text').text().trim();
      const resolvedMoves = resolvedScramble ? resolvedScramble.split(' ').filter(Boolean) : [];
      const currentMoves  = currentScramble  ? currentScramble.split(' ').filter(Boolean)  : [];
      const firstCurrent  = currentMoves[0] ?? '';
      const isDoubleTurn  = firstCurrent.charAt(1) === '2';
      const isMidDoubleTurn = isDoubleTurn && logicalMove.charAt(0) === firstCurrent.charAt(0);
      const isDiverging   = resolvedMoves.length > currentMoves.length;

      // Undo-stack tracking
      if (isMidDoubleTurn) {
        // no change during first half of a ?2 move
      } else if (isDiverging) {
        if (scrambleOffPathMoves.length === 0) {
          scrambleDivergenceRemaining = currentScramble;
        }
        scrambleOffPathMoves.push(logicalMove);
      } else if (scrambleOffPathMoves.length > 0) {
        const lastWrong = scrambleOffPathMoves[scrambleOffPathMoves.length - 1];
        if (logicalMove === getInverseMove(lastWrong)) {
          scrambleOffPathMoves.pop();
          if (scrambleOffPathMoves.length === 0) scrambleDivergenceRemaining = '';
        } else {
          // took a different route; trust re-solve
          scrambleOffPathMoves = [];
          scrambleDivergenceRemaining = '';
        }
      }

      // Choose display scramble: undo+continue vs re-solve (use shorter)
      let scramble: string;
      if (scrambleOffPathMoves.length > 0) {
        const undoMoves = [...scrambleOffPathMoves].reverse().map(getInverseMove);
        const divMoves  = scrambleDivergenceRemaining.split(' ').filter(Boolean);
        const undoContinue = Alg.fromString([...undoMoves, ...divMoves].join(' '))
          .experimentalSimplify({ cancel: true, puzzleLoader: cube3x3x3 }).toString().trim();
        const undoLen = undoContinue ? undoContinue.split(' ').filter(Boolean).length : 0;
        if (resolvedMoves.length < undoLen) {
          scramble = resolvedScramble;
          scrambleOffPathMoves = [];
          scrambleDivergenceRemaining = '';
        } else {
          scramble = undoContinue;
        }
      } else {
        scramble = resolvedScramble;
      }

      // Existing double-turn adjustment
      const scrambleMoves = scramble ? scramble.split(' ').filter(Boolean) : [];
      if (scrambleMoves.length >= currentMoves.length && scrambleMoves.length > 2) {
        if (logicalMove === firstCurrent || (logicalMove.charAt(0) === firstCurrent.charAt(0) && isDoubleTurn)) {
          // Remove the first move from the scramble if not a double turn
          scramble = currentMoves.slice(1).join(' ');
          if (isDoubleTurn) {
            scramble = logicalMove + ' ' + scramble;
          }
        }
      }
      // fix for opposite moves in different order, eg: U' D2 F2 -> D2 U' F2
      if (scrambleMoves.length === currentMoves.length - 1 && scrambleMoves.length > 2 && logicalMove === firstCurrent) {
        scramble = currentMoves.slice(1).join(' ');
      }

      // Hint with 2-second delay
      const isOffPath = scrambleOffPathMoves.length > 0;
      if (isOffPath && !isMidDoubleTurn) {
        if (!scrambleHintTimeout) {
          $('#alg-scramble-hint-text').text(
            `Ensure the cube is oriented with WHITE center on top and GREEN center on front.`
          );
          scrambleHintTimeout = setTimeout(() => {
            scrambleHintTimeout = null;
            if (scrambleOffPathMoves.length > 0) $('#alg-scramble-hint').show();
          }, 2000);
        }
      } else {
        if (scrambleHintTimeout) { clearTimeout(scrambleHintTimeout); scrambleHintTimeout = null; }
        $('#alg-scramble-hint').hide();
      }

      $('#alg-scramble-text').text(scramble);
      if (netPeer.connected) netPeer.send({ type: 'scramble', text: scramble, mode: !!scramble });

      if (!scramble) {
        $('#alg-scramble').hide();
        $('#alg-help-info').hide();
        scrambleOffPathMoves = [];
        scrambleDivergenceRemaining = '';
        if (scrambleHintTimeout) { clearTimeout(scrambleHintTimeout); scrambleHintTimeout = null; }
        scrambleMode = false;

        // this is the initial state for the new algorithm
        initialstate = cubePattern;
        keepInitialState = true;
        $('#train-alg').trigger('click');
      }
      return;
    }

    if (timerState === "READY") {
      setTimerState("RUNNING");
    }
    if (timerState === "STOPPED") {
      setTimerState("RUNNING");
    }
    if (slicePairedFirst?.type === "MOVE") {
      const firstData: SmartCubeMove = {
        face: slicePairedFirst.face,
        direction: slicePairedFirst.direction,
        move: slicePairedFirst.move,
        localTimestamp: slicePairedFirst.localTimestamp,
        cubeTimestamp: slicePairedFirst.cubeTimestamp,
      };
      lastMoves.push(firstData);
      if (timerState === "RUNNING") {
        solutionMoves.push(firstData);
      }
    }
    const moveData: SmartCubeMove = {
      face: event.face,
      direction: event.direction,
      move: event.move,
      localTimestamp: event.localTimestamp,
      cubeTimestamp: event.cubeTimestamp
    };
    lastMoves.push(moveData);
    if (timerState === "RUNNING") {
      solutionMoves.push(moveData);
    }
    if (lastMoves.length > 256) {
      lastMoves = lastMoves.slice(-256);
    }
    if (lastMoves.length > 10) {
      var skew = cubeTimestampCalcSkew(lastMoves);
      $('#skew').val(skew + '%');
    }

    //console.log("MOVE: " + event.move + " currentMoveIndex: " + currentMoveIndex + " currentValue: " + userAlg[currentMoveIndex]);
    if (patternToFacelets(myKpattern) === previousFacelets && !isBugged) {
      // we hit a bug when doing a slice we get the same myKpattern twice, so we need to retrieve a new myKpattern to fix the state
      myKpattern = await twistyTracker.experimentalModel.currentPattern.get();
      isBugged = true;
    }

    if (inputMode) {
      previousFacelets = patternToFacelets(myKpattern);
      const appended =
        slicePairedFirst?.type === "MOVE"
          ? slicePairedFirst.move + " " + event.move
          : lastMoves[lastMoves.length - 1].move;
      $('#alg-input').val(function(_, currentValue) {
        return Alg.fromString(currentValue + " " + appended).experimentalSimplify({ cancel: true, puzzleLoader: cube3x3x3 }).toString();
      });
      return;
    };

    // experimentalAddMove already updated the tracker; use it as the only post-move state (avoids
    // double-apply when addFreshListener and myKpattern disagree on timing).
    const trackerPattern = await twistyTracker.experimentalModel.currentPattern.get();
    const patternAfterMove = trackerPattern;
    const nextExpectedIdx = currentMoveIndex + 1;
    myKpattern = trackerPattern;
    previousFacelets = patternToFacelets(myKpattern);

    // Check if the current move matches the user's alg (prefer the next sequential index so earlier
    // patternStates that are identical do not steal the match after slice / sync quirks).
    var found: boolean = false;
    let matchedIndex: number | null = null;
    if (nextExpectedIdx >= 0 && nextExpectedIdx < userAlg.length && patternAfterMove.isIdentical(patternStates[nextExpectedIdx])) {
      matchedIndex = nextExpectedIdx;
    } else {
      patternStates.forEach((pattern, index) => {
        if (matchedIndex !== null) return;
        if (patternAfterMove.isIdentical(pattern)) {
          matchedIndex = index;
        }
      });
    }
    if (matchedIndex !== null) {
      const pattern = patternStates[matchedIndex];
      isBugged = false;
      currentMoveIndex = matchedIndex;
      found = true;
      badAlg = [];
      const tailRotations = trailingWholeCubeRotationMoveCount(userAlg);
      const lastLayerMoveIndex = userAlg.length - 1 - tailRotations;
      const finishedIncludingIgnoredRotations =
        tailRotations > 0 &&
        lastLayerMoveIndex >= 0 &&
        matchedIndex === lastLayerMoveIndex;
      if (currentMoveIndex === userAlg.length - 1 || finishedIncludingIgnoredRotations) {
        setTimerState("STOPPED");
        resetAlg();
        fetchNextPatterns();
        currentMoveIndex = userAlg.length - 1;

        // Switch to next algorithm
        switchToNextAlgorithm();

        // this is the initial state for the new algorithm
        initialstate = pattern;
        keepInitialState = true;
        if (checkedAlgorithms.length > 0) {
          $('#alg-input').val(checkedAlgorithms[0].algorithm);
        }
        $('#train-alg').trigger('click');
      }
    }
    if (!found) {
      if (slicePairedFirst?.type === "MOVE") {
        badAlg.push(slicePairedFirst.move);
      }
      badAlg.push(event.move);
      //console.log("Pushing 1 incorrect move. badAlg: " + badAlg)

      if (currentMoveIndex === 0 && badAlg.length === 1 && lastMoves[lastMoves.length - 1].move === getInverseMove(userAlg[currentMoveIndex].replace(/[()]/g, ""))) {
        currentMoveIndex--;
        badAlg.pop();
        //console.log("Cancelling first correct move");
      }  else if (lastMoves[lastMoves.length - 1].move === getInverseMove(badAlg[badAlg.length -2])) {
        badAlg.pop();
        badAlg.pop();
        //console.log("Popping last incorrect move. badAlg=" + badAlg);
      } else if (badAlg.length > 3 && lastMoves.length > 3 && lastMoves[lastMoves.length - 1].move === lastMoves[lastMoves.length - 2].move && lastMoves[lastMoves.length - 2].move === lastMoves[lastMoves.length - 3].move && lastMoves[lastMoves.length - 3].move === lastMoves[lastMoves.length - 4].move ) {
        badAlg.pop();
        badAlg.pop();
        badAlg.pop();
        badAlg.pop();
        //console.log("Popping a turn (4 incorrect moves)");
      }
    }
    updateAlgDisplay();
  }
}

function showFlashingIndicator(color: string, duration: number) {
  // Show the flashing indicator
  const flashingIndicator = document.getElementById('flashing-indicator');
  if (flashingIndicator && flashingIndicatorEnabled) {
    flashingIndicator.style.backgroundColor = color;
    flashingIndicator.classList.remove('hidden');
    setTimeout(() => {
      flashingIndicator.classList.add('hidden');
    }, duration); // Hide after duration in milliseconds
  }
}

function switchToNextAlgorithm() {
  // Show the flashing indicator
  showFlashingIndicator('green', 200);

  // switch to next algorithm
  if (checkedAlgorithms.length + checkedAlgorithmsCopy.length > 1) {
    const currentAlg = checkedAlgorithms.shift(); // Remove the first algorithm
    if (checkedAlgorithms.length === 0) {
      checkedAlgorithms = [...checkedAlgorithmsCopy]; // Copy remaining algorithms
      checkedAlgorithmsCopy = [];
      if (prioritizeSlowAlgs) {
        checkedAlgorithms.sort((a, b) => b.bestTime - a.bestTime);
      }
    }
    // Randomize checkedAlgorithms if random is enabled
    if (randomAlgorithms) {
      checkedAlgorithms.sort(() => Math.random() - 0.5);
    }
    if (currentAlg) {
      checkedAlgorithmsCopy.push(currentAlg); // Add current algorithm to the copy
    }
  }
}

var cubeStateInitialized = false;

/** Solution alg from current 3×3 pattern to solved (min2phase + fixOrientation). */
function solutionAlgFrom333Pattern(pattern: KPattern): Alg | null {
  const oriented = fixOrientation(pattern);
  const faceCube = patternToFacelets(oriented);
  const solvedStr = min2phase.solve(faceCube);
  if (solvedStr.startsWith('Error')) {
    console.warn('min2phase solve failed:', solvedStr);
    return null;
  }
  return Alg.fromString(expandNotation(solvedStr.trim()).replace(/[()]/g, ''));
}

// When the user clicks "Sync Cube", we send REQUEST_FACELETS and arm
// this flag so the NEXT incoming FACELETS event re-aligns the local
// virtual cube with the physical state (rather than being ignored
// because cubeStateInitialized is true).
let resyncFromNextFacelets = false;

function handleFaceletsEvent(event: SmartCubeEvent) {
  if (event.type !== "FACELETS") return;
  if (!cubeStateInitialized) {
    // First FACELETS event after connect. Adopt the cube's state into
    // the tracker AND — when no training-mode alg is loaded — also
    // into the visible twistyPlayer so a pre-scrambled cube doesn't
    // appear solved on screen. If userAlg IS set, leave the visible
    // cube alone: training mode is deliberately showing the alg's
    // case (the user is expected to scramble TO it).
    sliceOrientation = { ...IDENTITY };
    let setupAlg = '';
    if (event.facelets != SOLVED_STATE) {
      const kpattern = faceletsToPattern(event.facelets);
      const solution = solutionAlgFrom333Pattern(kpattern);
      setupAlg = solution ? solution.invert().toString() : '';
    }
    twistyTracker.alg = setupAlg;
    if (userAlg.length === 0) {
      setTwistyAlg(setupAlg);
    }
    applyWhiteOnBottomState({ persist: false });
    cubeStateInitialized = true;
    console.log("Initial cube state is applied successfully", event.facelets);
  } else if (resyncFromNextFacelets) {
    // Manual sync mid-session: also update the VISIBLE twistyPlayer and
    // reset the move log so subsequent peer broadcasts compute from a
    // known baseline.
    sliceOrientation = { ...IDENTITY };
    let setupAlg = '';
    if (event.facelets !== SOLVED_STATE) {
      const kpattern = faceletsToPattern(event.facelets);
      const solution = solutionAlgFrom333Pattern(kpattern);
      setupAlg = solution ? solution.invert().toString() : '';
    }
    twistyTracker.alg = setupAlg;
    setTwistyAlg(setupAlg);
    appliedPhysicalMoves = [];
    applyWhiteOnBottomState({ persist: false });
    resyncFromNextFacelets = false;
    console.log("Manual sync applied", event.facelets);
  }
}

function updateHeaderSyncBtnState() {
  const btn = $('#header-sync-btn');
  if (conn) {
    btn.removeClass('hidden');
    btn.prop('disabled', false);
  } else {
    btn.addClass('hidden');
    btn.prop('disabled', true);
    // Close panel if cube disconnects while it was open.
    $('#sync-panel').addClass('hidden');
    $('#header-sync-btn').attr('aria-expanded', 'false');
  }
}

function handleCubeEvent(event: SmartCubeEvent) {
  //if (event.type != "GYRO") console.log("GanCubeEvent", event);
  if (event.type == "GYRO") {
    handleGyroEvent(event);
  } else if (event.type == "MOVE") {
    handleMoveEvent(event);
  } else if (event.type == "FACELETS") {
    handleFaceletsEvent(event);
  } else if (event.type == "HARDWARE") {
    $('#deviceProtocol').val(conn?.protocol.name || '- n/a -');
    $('#hardwareName').val(event.hardwareName || '- n/a -');
    $('#hardwareVersion').val(event.hardwareVersion || '- n/a -');
    $('#softwareVersion').val(event.softwareVersion || '- n/a -');
    $('#productDate').val(event.productDate || '- n/a -');
    setGyroscopeUiFromSupported(event.gyroSupported === true);
  } else if (event.type == "BATTERY") {
    $('#batteryLevel').val(event.batteryLevel + '%');
    $('#bluetooth-indicator').hide();
    $('#battery-indicator').attr('title', event.batteryLevel + '%');
    if (event.batteryLevel >= 75) {
      $('#battery-indicator').html('<svg fill="none" class="h-8 w-8 inline-block" viewBox="0 0 24 24" version="1.1" xmlns="http://www.w3.org/2000/svg"><path d="M18.5 7.5L3.5 7.50001V16.5L18.5 16.5V14.3571H20.5V9.21429H18.5V7.5Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 10.5C5.5 9.94772 5.94772 9.5 6.5 9.5H7.5C8.05228 9.5 8.5 9.94772 8.5 10.5V13.5C8.5 14.0523 8.05228 14.5 7.5 14.5H6.5C5.94772 14.5 5.5 14.0523 5.5 13.5V10.5Z" fill="currentColor"/><path d="M9.5 10.5C9.5 9.94772 9.94772 9.5 10.5 9.5H11.5C12.0523 9.5 12.5 9.94772 12.5 10.5V13.5C12.5 14.0523 12.0523 14.5 11.5 14.5H10.5C9.94772 14.5 9.5 14.0523 9.5 13.5V10.5Z" fill="currentColor"/><path d="M13.5 10.5C13.5 9.94772 13.9477 9.5 14.5 9.5H15.5C16.0523 9.5 16.5 9.94772 16.5 10.5V13.5C16.5 14.0523 16.0523 14.5 15.5 14.5H14.5C13.9477 14.5 13.5 14.0523 13.5 13.5V10.5Z" fill="currentColor"/></svg>');
      $('#battery-indicator').css('color', 'green');
    }
    else if (event.batteryLevel >= 50) {
      $('#battery-indicator').html('<svg fill="none" class="h-8 w-8 inline-block" viewBox="0 0 24 24" version="1.1" xmlns="http://www.w3.org/2000/svg"><path d="M18.5 7.5L3.5 7.50001V16.5L18.5 16.5V14.3571H20.5V9.21429H18.5V7.5Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 10.5C5.5 9.94772 5.94772 9.5 6.5 9.5H7.5C8.05228 9.5 8.5 9.94772 8.5 10.5V13.5C8.5 14.0523 8.05228 14.5 7.5 14.5H6.5C5.94772 14.5 5.5 14.0523 5.5 13.5V10.5Z" fill="currentColor"/><path d="M9.5 10.5C9.5 9.94772 9.94772 9.5 10.5 9.5H11.5C12.0523 9.5 12.5 9.94772 12.5 10.5V13.5C12.5 14.0523 12.0523 14.5 11.5 14.5H10.5C9.94772 14.5 9.5 14.0523 9.5 13.5V10.5Z" fill="currentColor"/></svg>');
      $('#battery-indicator').css('color', 'yellow');
    }
    else if (event.batteryLevel >= 20) {
      $('#battery-indicator').html('<svg fill="none" class="h-8 w-8 inline-block" viewBox="0 0 24 24" version="1.1" xmlns="http://www.w3.org/2000/svg"><path d="M18.5 7.5L3.5 7.50001V16.5L18.5 16.5V14.3571H20.5V9.21429H18.5V7.5Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 10.5C5.5 9.94772 5.94772 9.5 6.5 9.5H7.5C8.05228 9.5 8.5 9.94772 8.5 10.5V13.5C8.5 14.0523 8.05228 14.5 7.5 14.5H6.5C5.94772 14.5 5.5 14.0523 5.5 13.5V10.5Z" fill="currentColor"/></svg>');
      $('#battery-indicator').css('color', 'orange');
    }
    else if (event.batteryLevel < 20) {
      $('#battery-indicator').html('<svg fill="none" class="h-8 w-8 inline-block" viewBox="0 0 24 24" version="1.1" xmlns="http://www.w3.org/2000/svg"><path d="M18.5 7.5L3.5 7.50001V16.5L18.5 16.5V14.3571H20.5V9.21429H18.5V7.5Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M11 10V12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.75 14.25C11.75 14.6642 11.4142 15 11 15C10.5858 15 10.25 14.6642 10.25 14.25C10.25 13.8358 10.5858 13.5 11 13.5C11.4142 13.5 11.75 13.8358 11.75 14.25Z" fill="currentColor"/></svg>');
      $('#battery-indicator').css('color', 'red');
    }
  } else if (event.type == "DISCONNECT") {
    deviceDisconnected();
  }
}

const customMacAddressProvider: MacAddressProvider = async (device, isFallbackCall): Promise<string | null> => {
  const promptDefault = getCachedMacForDevice(device) ?? '';
  if (!isFallbackCall) {
    // Let the library try cache, request-device advertisement data, waitForAdvertisements,
    // and MoYu32/QiYi MAC candidate probing (enableAddressSeasch) first.
    return null;
  }
  const flagHint =
    typeof device.watchAdvertisements !== 'function'
      ? `\n\nOn Chrome, automatic discovery may work if you enable\nchrome://flags/#enable-experimental-web-platform-features`
      : '';
  return prompt(
    `Unable to determine cube MAC address!\nPlease enter MAC address manually:${flagHint}`,
    promptDefault
  );
};

$('#alg-display').on('click', () => {
  inputMode = true;
  $('#alg-display-container').hide();
  $('#alg-input').show();
  $('#left-side-inner').hide();
  $('#alg-input').get(0)?.focus();
  $('#app-top').show();
  $('#alg-stats').show();
  $('#save-success').hide();
  $('#save-error').hide();
  let currentAlgName = checkedAlgorithms[0]?.name || '';
  let algId = algToId(checkedAlgorithms[0]?.algorithm) || algToId($('#alg-input').val() as string);
  let subset = $('#' + algId).data('subset') || '';
  let category = $('#' + algId).data('category') || '';
  $('#subset-input').val(subset);
  $('#category-input').val(category);
  $('#alg-name-input').val(currentAlgName);
  $('#save-container').show();
});

$('#input-alg').on('click', () => {
  twistyPlayer.experimentalStickering = 'full';
  appliedPhysicalMoves = [];
  setTwistyAlg('');
  resetAlg();
  $('#alg-input').val('');
  inputMode = true;
  checkedAlgorithms = [];
  checkedAlgorithmsCopy = [];
  updateTimesDisplay();
  hideMistakes();
  scrambleMode = false;
  $('#alg-scramble').hide();
  $('#alg-help-info').hide();
  $('#alg-display-container').hide();
  $('#times-display').html('');
  $('#timer').hide();
  $('#left-side-inner').hide();
  $('#alg-input').show();
  $('#alg-input').get(0)?.focus();
  $('#app-top').show();
  $('#alg-stats').show();
  $('#help').hide();
  $('#options-container').hide();
  $('#load-container').hide();
  $('#save-container').hide();
  $('#info').hide();
});

$('#show-help').on('click', () => {
  $('#help').show();
  $('#app-top').hide();
  $('#options-container').hide();
  $('#load-container').hide();
  $('#save-container').hide();
  $('#info').hide();
  $('#left-side-inner').hide();
});

$('#device-info').on('click', () => {
  const infoDiv = $('#info');
  if (infoDiv.css('display') === 'none') {
    infoDiv.css('display', 'grid');
    $('#options-container').hide();
    $('#load-container').hide();
    $('#save-container').hide();
    $('#help').hide();
  } else {
    infoDiv.css('display', 'none');
  }
});

// CF-2: Sync ⚙️ panel — replaces the standalone Sync Cube / Match Cube
// header buttons with a single dropdown housing F=, Reset, Sync, Undo.

// Snapshot of the virtual cube's facelets right before the most recent
// Reset or Sync action. Used by Undo to restore the visible state. Note
// that this CANNOT revert the smartcube's internal reference state —
// after a Reset, the cube still thinks "I am solved" until physically
// re-solved and Reset again, or until Sync is performed at a known
// state. Undo only undoes the on-screen consequences.
let syncUndoFacelets: string | null = null;

function setSyncUndoAvailable(facelets: string | null) {
  syncUndoFacelets = facelets;
  $('#sync-undo-btn').prop('disabled', facelets === null);
}

async function captureFaceletsForUndo(): Promise<string | null> {
  try {
    const pattern = await twistyTracker.experimentalModel.currentPattern.get();
    return patternToFacelets(pattern);
  } catch { return null; }
}

// Re-apply a captured facelets snapshot to the visible cube + tracker.
// Mirrors the resync path in handleFaceletsEvent so behaviour stays
// consistent across all three entry points (initial connect, Sync
// button, Undo).
function applyFaceletsSnapshot(facelets: string) {
  sliceOrientation = { ...IDENTITY };
  let setupAlg = '';
  if (facelets !== SOLVED_STATE) {
    const kpattern = faceletsToPattern(facelets);
    const solution = solutionAlgFrom333Pattern(kpattern);
    setupAlg = solution ? solution.invert().toString() : '';
  }
  twistyTracker.alg = setupAlg;
  setTwistyAlg(setupAlg);
  appliedPhysicalMoves = [];
  applyWhiteOnBottomState({ persist: false });
}

// Toggle the panel open/closed. Click outside dismisses (handler below).
$('#header-sync-btn').on('click', (e) => {
  e.stopPropagation();
  const panel = $('#sync-panel');
  const isOpen = !panel.hasClass('hidden');
  if (isOpen) {
    panel.addClass('hidden');
    $('#header-sync-btn').attr('aria-expanded', 'false');
  } else {
    panel.removeClass('hidden');
    $('#header-sync-btn').attr('aria-expanded', 'true');
    updateSyncFGridSelection();
  }
});

// Click-outside dismissal. Bound at document level; ignores clicks
// inside the panel or on the toggle button itself.
$(document).on('click', (e) => {
  const target = e.target as unknown as HTMLElement;
  if (!target || typeof target.closest !== 'function') return;
  if (target.closest('#sync-panel') || target.closest('#header-sync-btn')) return;
  if (!$('#sync-panel').hasClass('hidden')) {
    $('#sync-panel').addClass('hidden');
    $('#header-sync-btn').attr('aria-expanded', 'false');
  }
});

// F= colour row — clicking a chit sets that colour as F.
$('#sync-f-row').on('click', '.sync-f-chit', (e) => {
  const chit = e.currentTarget as HTMLButtonElement;
  const color = chit.dataset.color as FColor | undefined;
  if (!color || !(F_COLORS as readonly string[]).includes(color)) return;
  setFFace(color);
});

// U= colour row — including the "gravity" chit (slash-through) which
// reverts to auto-detect-from-gyro behaviour.
$('#sync-u-row').on('click', '.sync-u-chit', (e) => {
  const chit = e.currentTarget as HTMLButtonElement;
  const color = chit.dataset.color as UColor | undefined;
  if (!color || !(U_COLORS as readonly string[]).includes(color)) return;
  setUFace(color);
});

updateSyncFGridSelection();
updateSyncUGridSelection();

// Reset: tell the cube it's solved AND reset the virtual cube. Captures
// the previous facelets snapshot for Undo.
$('#sync-reset-btn').on('click', async () => {
  if (!conn) return;
  const before = await captureFaceletsForUndo();
  try { await conn.sendCommand({ type: 'REQUEST_RESET' }); } catch { /* ignore */ }
  appliedPhysicalMoves = [];
  setTwistyAlg('');
  twistyTracker.alg = '';
  drawAlgInCube();
  setSyncUndoAvailable(before);
  // Clear basis so the next gyro event re-detects U if U='gravity'.
  // User may have re-oriented the cube in their hands before Reset.
  basis = null;
});

// Sync: read the cube's current facelet state and align the virtual
// cube to match. Captures the previous facelets snapshot for Undo.
$('#sync-sync-btn').on('click', async () => {
  if (!conn || !conn.capabilities.facelets) return;
  const before = await captureFaceletsForUndo();
  resyncFromNextFacelets = true;
  try {
    await conn.sendCommand({ type: 'REQUEST_FACELETS' });
    setSyncUndoAvailable(before);
  } catch {
    resyncFromNextFacelets = false;
  }
  // Same re-detect logic as Reset — user likely pressed Sync after
  // a re-orientation.
  basis = null;
});

// Undo: restore the captured facelets snapshot. The physical cube's
// internal reference state cannot be unset, so Undo only affects the
// virtual cube. After Undo, the snapshot is consumed (one-shot).
$('#sync-undo-btn').on('click', () => {
  if (!syncUndoFacelets) return;
  applyFaceletsSnapshot(syncUndoFacelets);
  setSyncUndoAvailable(null);
});

// Settings-panel Reset State button: same effect as the panel's Reset
// (REQUEST_RESET + clear virtual). Routes through the panel handler
// for consistency.
$('#reset-state').on('click', () => {
  $('#sync-reset-btn').trigger('click');
});

function deviceDisconnected() {
  conn = null;
  if (netPeer.connected) netPeer.send({ type: 'cube-connected', connected: false });
  cubeStateInitialized = false;
  appliedPhysicalMoves = [];
  setTwistyAlg('');
  twistyTracker.alg = '';
  fsSetCubeConnected(false);
  releaseWakeLock();
  $('#reset-state').prop('disabled', true);
  $('#device-info').prop('disabled', true);
  updateHeaderSyncBtnState();
  $('.info input').val('- n/a -');
  setGyroscopeToggleDisabled(false);
  $('#connect').html('Connect');
  $('#battery-indicator').hide();
  $('#bluetooth-indicator').show();
}

$('#connect-button').on('click', async () => {
  if (conn) {
    conn.disconnect();
    deviceDisconnected();
    return;
  }
  if (connectInFlight) {
    connectAbort?.abort();
    $('#connect').html('Connect');
    fsSetConnectStatus(null);
    connectInFlight = false;
    connectAbort = null;
    return;
  }

  connectAbort = new AbortController();
  connectInFlight = true;

  let newConn: SmartCubeConnection | undefined;
  try {
    newConn = await connectSmartCube({
      macAddressProvider: customMacAddressProvider,
      enableAddressSearch: true,
      deviceSelection: storedSmartCubeDeviceSelection(),
      signal: connectAbort.signal,
      onStatus: (msg) => {
        $('#connect').html(msg);
        fsSetConnectStatus({ text: msg, error: false });
      },
    });
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    if (aborted) {
      fsSetConnectStatus(null);
    } else {
      console.error(e);
      const msg = e instanceof Error ? e.message : String(e);
      window.alert(msg);
      fsSetConnectStatus({ text: msg, error: true });
    }
    $('#connect').html('Connect');
  } finally {
    connectInFlight = false;
    connectAbort = null;
  }

  if (!newConn) {
    return;
  }

  conn = newConn;
  conn.events$.subscribe(handleCubeEvent);
  fsSetCubeConnected(true);
  if (netPeer.connected) netPeer.send({ type: 'cube-connected', connected: true });
  if (conn.capabilities.hardware) {
    await conn.sendCommand({ type: "REQUEST_HARDWARE" });
  }
  if (conn.capabilities.facelets) {
    await conn.sendCommand({ type: "REQUEST_FACELETS" });
  }
  if (conn.capabilities.battery) {
    await conn.sendCommand({ type: "REQUEST_BATTERY" });
  }
  $('#deviceName').val(conn.deviceName);
  $('#deviceMAC').val(conn.deviceMAC);
  $('#deviceProtocol').val(conn.protocol.name);
  if (!conn.capabilities.hardware) {
    setGyroscopeUiFromSupported(conn.capabilities.gyroscope);
  }
  $('#connect').html('Disconnect');
  $('#bluetooth-indicator').hide();
  $('#battery-indicator').show();
  $('#reset-state').prop('disabled', false);
  $('#device-info').prop('disabled', false);
  $('#alg-input').attr('placeholder', "Enter alg e.g., (R U R' U) (R U2' R')");
  requestWakeLock();
  forceFix = true;
  requestAnimationFrame(amimateCubeOrientation);
  updateHeaderSyncBtnState();
});

var timerState: "IDLE" | "READY" | "RUNNING" | "STOPPED" = "IDLE";

function updateTimesDisplay() {
  const timesDisplay = $('#times-display');
  const algNameDisplay = $('#alg-name-display');
  const algNameDisplay2 = $('#alg-name-display2');
  const algId = algToId(originalUserAlg.join(' '));

  // Use the new function to get last times
  const lastTimes = getLastTimes(algId);
  const bestTime = bestTimeNumber(algId);

  algNameDisplay.text(showAlgNameEnabled ? currentAlgName : '');
  algNameDisplay2.text(showAlgNameEnabled ? currentAlgName : '');

  createTimeGraph(lastTimes.slice(-5));
  createStatsGraph(lastTimes);

  // Calculate average time
  const averageTime = lastTimes.reduce((a: number, b: number) => a + b, 0) / lastTimes.length;
  $('#average-time-box').html(`Average Time<br />${averageTimeString(averageTime)}`);

  // Calculate average TPS
  const moveCount = countMovesETM(userAlg.join(' '));
  const averageTPS = averageTime ? (moveCount / (averageTime / 1000)).toFixed(2) : '-';
  $('#average-tps-box').html(`Average TPS<br />${averageTPS}`);

  // check if the last item added to lastTimes is a PB
  const lastTime = lastTimes.slice(-1)[0];
  const isPB = lastTime === bestTime;

  // Get single PB
  const singlePB = isPB ? `${bestTimeString(bestTime)} 🎉` : bestTimeString(bestTime);
  $('#single-pb-box').html(`Single PB<br />${singlePB}`);


  if (lastTimes.length === 0) {
    timesDisplay.html('');
    $('#average-time-box').html('Average Time<br />--');
    $('#average-tps-box').html('Average TPS<br />--');
    $('#single-pb-box').html('Single PB<br />--');
    $('#left-side-inner').hide();
    return;
  }

  const practiceCount: number = $('#' + algId).data('count') || 0;
  const timesHtml = lastTimes.slice(-5).map((time: number, index: number) => {
    const t = makeTimeFromTimestamp(time);
    let number = practiceCount < 5 ? index + 1 : practiceCount - 5 + index + 1;
    // Add emoji if the time is a PB
    const emojiPB = time === bestTime ? ' 🎉' : '';
    const minutesPart = t.minutes > 0 ? `${t.minutes}:` : '';
    return `<div class="text-right">Time ${number}:</div><div class="text-left">${minutesPart}${t.seconds.toString(10).padStart(2, '0')}.${t.milliseconds.toString(10).padStart(3, '0')}${emojiPB}</div>`;
  }).join('');

  const avgTime = averageOfFiveTimeNumber(algId) ?? 0;
  let averageHtml = '';
  if (avgTime > 0) {
    const avg = makeTimeFromTimestamp(avgTime);
    const avgMinutesPart = avg.minutes > 0 ? `${avg.minutes}:` : '';
    averageHtml = `<div id="average" class="font-bold text-right">Ao5:</div><div class="font-bold text-left">${avgMinutesPart}${avg.seconds.toString(10).padStart(2, '0')}.${avg.milliseconds.toString(10).padStart(3, '0')}</div>`;
  } else {
    averageHtml = `<div id="average" class="font-bold text-right">Ao5:</div><div class="font-bold text-left">-</div>`;
  }

  let bestTimeHtml = '';
  if (bestTime) {
    const best = makeTimeFromTimestamp(bestTime);
    const bestMinutesPart = best.minutes > 0 ? `${best.minutes}:` : '';
    bestTimeHtml = `<div id="best" class="text-right">Best:</div><div class="text-left">${bestMinutesPart}${best.seconds.toString(10).padStart(2, '0')}.${best.milliseconds.toString(10).padStart(3, '0')}</div>`;
  }

  const displayHtml = `<div class="grid grid-cols-2 items-center gap-1 pt-2">${timesHtml}${averageHtml}${bestTimeHtml}</div>`;
  timesDisplay.html(displayHtml);
}

function setTimerState(state: typeof timerState) {
  timerState = state;
  const algId = algToId(originalUserAlg.join(' '));
  // check if the algId exists in the DOM, create it if it doesn't
  if ($('#' + algId).length === 0) {
    $('#default-alg-id').append(`<div id="${algId}" class="hidden"></div>`);
  }
  let practiceCount = $('#' + algId).data('count') || 0;

  switch (state) {
    case "IDLE":
      stopLocalTimer();
      $('#timer').hide();
      $('#train-alg').html('<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>');
      break;
    case 'READY':
      stopLocalTimer();
      let timerText = $('#timer').text();
      if (timerText === '') {
        setTimerValue(0);
      }
      $('#timer').show();
      $('#timer').css('color', '#080');
      $('#train-alg').html('<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>');
      break;
    case 'RUNNING':
      solutionMoves = [];
      startLocalTimer();
      $('#timer').css('color', '#999');
      $('#train-alg').html('<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="currentColor" viewBox="0 0 32 32"><path d="M8 8h16v16H8z"/></svg>');
      break;
    case 'STOPPED':
      const localElapsed = currentTimerValue;
      stopLocalTimer();
      let finalTime = localElapsed;
      let stoppedcolor = darkModeToggle.checked ? '#ccc' : '#333';
      $('#timer').css('color', stoppedcolor);
      if (conn) {
        var fittedMoves = cubeTimestampLinearFit(solutionMoves);
        var lastMove = fittedMoves.slice(-1).pop();
        const fitted =
          lastMove != null &&
          lastMove.cubeTimestamp != null &&
          Number.isFinite(lastMove.cubeTimestamp)
            ? lastMove.cubeTimestamp
            : 0;
        if (fitted > 0) {
          finalTime = fitted;
        }
      }
      setTimerValue(finalTime);
      $('#train-alg').html('<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>');

      // Store the time and update the display
      if (finalTime > 0) {
        const lastTimesStorage = localStorage.getItem('LastTimes-' + algId);
        var lastTimes: number[] = []
        if (lastTimesStorage) {
          lastTimes = lastTimesStorage.split(',').map(num => Number(num.trim()));
        }
        lastTimes.push(finalTime);
        if (lastTimes.length > 100) {
          lastTimes.shift(); // Keep only the last 100 times
        }
        practiceCount++; // Increment the practice count

        localStorage.setItem('LastTimes-' + algId, lastTimes.join(','));
        $('#' + algId).data('count', practiceCount);

        const bestTime = localStorage.getItem('Best-' + algId);
        if (!bestTime || finalTime < Number(bestTime)) {
          localStorage.setItem('Best-' + algId, String(finalTime));
          $('#best-time-' + algId).html(`Best: ${bestTimeString(finalTime)}`);
        }
        $('#ao5-time-' + algId).html(`Ao5: ${averageTimeString(averageOfFiveTimeNumber(algId))}`);

        //console.log("[setTimerState] Setting lastTimes to " + lastTimes + " for algId " + algId);
        //console.log("[setTimerState] Setting practiceCount to " + practiceCount + " for algId " + algId);

        let failedCount: number = $('#' + algId).data('failed') || 0;
        if (failedCount < 0) failedCount = 0;
        if (practiceCount < failedCount) failedCount = practiceCount;
        let successCount: number = practiceCount - failedCount;
        $('#' + algId + '-success').html(`✅: ${successCount}`);
        if (failedCount > 0) $('#' + algId + '-failed').html(`❌: ${failedCount}`);

        if (!conn) {
          updateTimesDisplay();
          switchToNextAlgorithm();
          if (checkedAlgorithms.length > 0) {
            $('#alg-input').val(checkedAlgorithms[0].algorithm);
          }
          $('#train-alg').trigger('click');
        }
      }
      break;
  }
}

var myKpattern: KPattern;
var initialstate: KPattern;

twistyTracker.experimentalModel.currentPattern.addFreshListener(async (kpattern) => {
  // Replay drives twistyPlayer (the visible cube), not twistyTracker
  // (the live-event tracker), so this listener firing during replay
  // means a stale smartcube event slipped through; ignore it.
  if (isReplayActive()) return;
  myKpattern = kpattern;
  if (patternStates.length > 0 && currentMoveIndex === 0 && myKpattern.isIdentical(initialstate)) {
    console.log("Returning to initial state")
    resetAlg();
    updateAlgDisplay();
  }
  fsOnPattern(kpattern);
});

function setTimerValue(timestamp: number) {
  let t = makeTimeFromTimestamp(timestamp);
  $('#timer').html(`${t.minutes}:${t.seconds.toString(10).padStart(2, '0')}.${t.milliseconds.toString(10).padStart(3, '0')}`);
}

let currentTimerValue = 0;
var localTimer: Subscription | null = null;
function startLocalTimer() {
  var startTime = now();
  localTimer = interval(30).subscribe(() => {
    currentTimerValue = now() - startTime;
    setTimerValue(currentTimerValue);
  });
}

function stopLocalTimer() {
  localTimer?.unsubscribe();
  localTimer = null;
}

// Call the function to initialize default algorithms
initializeDefaultAlgorithms();

interface Algorithm {
  algorithm: string;
  name: string;
  bestTime: number;
}

let checkedAlgorithms: Algorithm[] = [];
let checkedAlgorithmsCopy: Algorithm[] = [];
let currentAlgName: string = '';

// Collect checked algorithms using event delegation
$('#alg-cases').on('change', 'input[type="checkbox"]', function() {
  const algorithm = $(this).data('algorithm');
  const name = $(this).data('name');
  const bestTime = $(this).data('best');
  if ((this as HTMLInputElement).checked) {
    setCategoryStickeringDeferred(false);
    setStickering($('#category-select').val()?.toString() || '');
    const currentAlg: Algorithm = { algorithm, name, bestTime };
    if (prioritizeSlowAlgs) {
      const index = (!bestTime)
        ? checkedAlgorithms.reduceRight((lastIndex, alg, i) => !alg.bestTime ? lastIndex : i, -1)
        : checkedAlgorithms.findIndex(alg => alg.bestTime && alg.bestTime < bestTime);
      if (index === -1) {
        checkedAlgorithms.push(currentAlg);
      } else {
        checkedAlgorithms.splice(index, 0, currentAlg);
      }
    } else {
      checkedAlgorithms.push(currentAlg);
    }
  } else {
    // remove all occurrences of this algorithm from checkedAlgorithms and checkedAlgorithmsCopy
    checkedAlgorithms = checkedAlgorithms.filter(alg => alg.algorithm !== algorithm || alg.name !== name);
    checkedAlgorithmsCopy = checkedAlgorithmsCopy.filter(alg => alg.algorithm !== algorithm || alg.name !== name);
  }
  if (checkedAlgorithms.length > 0) {
    $('#alg-input').val(checkedAlgorithms[0].algorithm);
    if (algorithm === checkedAlgorithms[0].algorithm) {
      $('#train-alg').trigger('click');
    }
    // if the checkbox has been unchecked trigger a click on the train button
    if (!((this as HTMLInputElement).checked)) {
      $('#train-alg').trigger('click');
    }
  } else {
    resetDrill();
  }
  //console.log("checkedAlgorithms: " + JSON.stringify(checkedAlgorithms));
  //console.log("checkedAlgorithmsCopy: " + JSON.stringify(checkedAlgorithmsCopy));
});

// Event listener for Delete Mode toggle
$('#delete-mode-toggle').on('change', () => {
  const isDeleteModeOn = $('#delete-mode-toggle').is(':checked');
  $('#delete-alg').prop('disabled', !isDeleteModeOn);
  $('#delete-times').prop('disabled', !isDeleteModeOn);
});

$('#delete-times').on('click', () => {
  if (confirm('Are you sure you want to remove the times for the selected algorithms?')) {
    const category = $('#category-select').val()?.toString() || '';
    for (const algorithm of checkedAlgorithms) {
      if (algorithm) {
        const algId = algToId(algorithm.algorithm);
        localStorage.removeItem('Best-' + algId);
        localStorage.removeItem('LastTimes-' + algId);
      }
    }
    loadAlgorithms(category); // Refresh the algorithm list
    updateTimesDisplay();
  }
});

// Event listener for Delete button
$('#delete-alg').on('click', () => {
  const category = $('#category-select').val()?.toString() || '';
  if (checkedAlgorithms.length > 0) {
    if (confirm('Are you sure you want to delete the selected algorithms?')) {
      for (const algorithm of checkedAlgorithms) {
        if (algorithm && category) {
          deleteAlgorithm(category, algorithm.algorithm);
        }
      }
      loadAlgorithms(category); // Refresh the algorithm list
      // make sure delete mode is off
      const deleteModeToggle = $('#delete-mode-toggle');
      deleteModeToggle.prop('checked', false);
      deleteModeToggle.toggle();
      $('#delete-alg').prop('disabled', true);
      $('#delete-times').prop('disabled', true);
      checkedAlgorithms = [];
      checkedAlgorithmsCopy = [];
      // only re-load subsets if there are no more alg-cases (subset has been deleted)
      if ($('#alg-cases').children().length === 0) {
        loadSubsets(category);
      }
      // only re-load categories if there are no more subsets (category has been deleted)
      if ($('#subset-checkboxes-container').children().length === 0) {
        $('#select-all-subsets-toggle').prop('checked', false);
        loadCategories();
      }
      $('#delete-success').text('Algorithms deleted successfully');
      $('#delete-success').show();
      setTimeout(() => {
        $('#delete-success').fadeOut();
      }, 3000); // Disappears after 3 seconds
    }
  }
});

// Event listener for Cancel button
$('#cancel-save').on('click', () => {
  $('#save-container').hide();
  $('#alg-stats').show();
  $('#train-alg').trigger('click');
});

// Event listener for Confirm Save button
$('#confirm-save').on('click', () => {
  const category = $('#category-input').val()?.toString().trim() || '';
  const subset = $('#subset-input').val()?.toString().trim() || '';
  const name = $('#alg-name-input').val()?.toString().trim() || '';
  const algorithm = expandNotation($('#alg-input').val()?.toString().trim() || '');
  if (category.length > 0 && subset.length > 0 && name.length > 0 && algorithm.length > 0) {
    saveAlgorithm(category, subset, name, algorithm);
    $('#category-input').val('');
    $('#alg-name-input').val('');
    $('#subset-input').val('');
    $('#save-error').hide();
    $('#save-success').text('Algorithm saved successfully');
    $('#save-success').show();
    setTimeout(() => {
      $('#save-success').fadeOut();
    }, 3000); // Disappears after 3 seconds
    loadCategories();
    // select the new category
    $('#category-select').val(category).trigger('change');
  } else {
    $('#save-success').hide();
    $('#save-error').text('Please fill in all fields');
    $('#save-error').show();
    setTimeout(() => {
      $('#save-error').fadeOut();
    }, 3000); // Disappears after 3 seconds
  }
});

function getScrambleToSolution(alg: string, state: KPattern, maxDepth?: number): string | null {
  let faceCube = patternToFacelets(fixOrientation(state));
  var solvedcube = min2phase.solve(faceCube);
  let inverseAlg = Alg.fromString(expandNotation(alg).replace(/[()]/g, '')).invert();
  let finalState = Alg.fromString(solvedcube + ' ' + inverseAlg.toString()).experimentalSimplify({ cancel: true, puzzleLoader: cube3x3x3 });
  let targetFacelets = patternToFacelets(fixOrientation(faceletsToPattern(SOLVED_STATE).applyAlg(finalState)));
  let solveStr: string;
  if (maxDepth !== undefined) {
    solveStr = new (min2phase as any).Search().solution(targetFacelets, maxDepth);
    if (solveStr.startsWith('Error')) return null;  // null = no short path (distinct from "" = already at case)
  } else {
    solveStr = min2phase.solve(targetFacelets);
  }
  let scramble = Alg.fromString(solveStr).invert();
  let result = scramble.experimentalSimplify({ cancel: true, puzzleLoader: cube3x3x3 }).toString().trim();
  return result;
}

$('#scramble-to').on('click', () => {
  (async() => {
    const algStr = userAlg.join(' ');
    let cubePattern = await twistyTracker.experimentalModel.currentPattern.get();
    const inverseAlg = Alg.fromString(expandNotation(algStr).replace(/[()]/g, '')).invert();
    const algMoveCount = [...inverseAlg.childAlgNodes()].length;
    let scramble = getScrambleToSolution(algStr, cubePattern, algMoveCount + 6);
    let trackerReset = false;
    if (scramble === null) {
      // No short path from current state; reset tracker to solved so invAlg is the scramble
      appliedPhysicalMoves = [];
      twistyTracker.alg = '';
      setTwistyAlg(''); // sync synchronously to avoid a late async override
      trackerReset = true;
      cubePattern = await twistyTracker.experimentalModel.currentPattern.get();
      scramble = inverseAlg.experimentalSimplify({ cancel: true, puzzleLoader: cube3x3x3 }).toString().trim();
    }
    if (scramble.length > 0) {
      scrambleMode = true;
      scrambleToAlg = [...userAlg];
      resetAlg();
      scrambleOffPathMoves = [];
      scrambleDivergenceRemaining = '';
      if (scrambleHintTimeout) { clearTimeout(scrambleHintTimeout); scrambleHintTimeout = null; }
      $('#alg-scramble').show();
      $('#alg-scramble-hint').hide();
      $('#alg-scramble-text').text(scramble);
      // draw real cube state (mirror tracker; applyWhiteOnBottomState applies z2 + alg together)
      if (conn && !trackerReset) {
        applyWhiteOnBottomState({ persist: false });
      }
    } else {
      scrambleMode = false;
      $('#alg-scramble').hide();
      $('#alg-help-info').hide();
    }
  })();
});

// Event listener for Load button
$('#load-alg').on('click', () => {
  $('#app-top').show();
  $('#alg-stats').show();
  const categorySelect = $('#category-select');
  if (categorySelect.val() === null || categorySelect.val() === '') {
    loadCategories();
  }
  $('#load-container').show();
  $('#save-container').hide();
  $('#options-container').hide();
  $('#help').hide();
  $('#info').hide();
  $('#left-side-inner').hide();
  $('#train-alg').trigger('click');
});

// Event listener for Save button
$('#save-alg').on('click', () => {
  inputMode = true;
  $('#alg-display-container').hide();
  $('#times-display').html('');
  $('#timer').hide();
  $('#left-side-inner').hide();
  $('#alg-scramble').hide();
  $('#alg-help-info').hide();
  $('#alg-input').show();
  $('#alg-input').get(0)?.focus();
  $('#app-top').show();
  $('#alg-stats').hide();
  $('#save-success').hide();
  $('#save-error').hide();
  $('#save-container').show();
  $('#load-container').hide();
  $('#options-container').hide();
  $('#help').hide();
  $('#info').hide();
});

function resetDrill() {
  // reset the current practice drill
  $('#timer').hide();
  $('#timer').text('');
  $('#times-display').html('');
  $('#alg-display-container').hide();
  $('#alg-display').html('');
  $('#alg-scramble').hide();
  $('#alg-help-info').hide();
  $('#alg-scramble-text').text('');
  inputMode = true;
  $('#alg-input').val('');
  $('#alg-input').show();
  $('#left-side-inner').hide();
}

// Event listener for Category select change
$('#category-select').on('change', () => {
  const category = $('#category-select').val()?.toString();
  setCategoryStickeringDeferred(false);
  if (category) {
    loadSubsets(category);
    restoreSubsetSelections(category);
  }
  // uncheck all checkboxes
  checkedAlgorithms = [];
  checkedAlgorithmsCopy = [];
  $('#select-all-subsets-toggle').prop('checked', false);
  // reset cube alg
  appliedPhysicalMoves = [];
  setTwistyAlg('');
  // selecting a new category should reset the current practice drill
  resetDrill();
});

// Add event listener for subset checkboxes
$('#subset-checkboxes').on('change', 'input[type="checkbox"]', () => {
  saveSubsetSelections();
  const selectedCategory = $('#category-select').val() as string;
  loadAlgorithms(selectedCategory);
  checkedAlgorithms = [];
  checkedAlgorithmsCopy = [];
  // if select all toggle is checked select all alg-cases, if select learning toggle is checked select learning alg-cases
  const selectAllToggle = $('#select-all-toggle');
  const selectLearningToggle = $('#select-learning-toggle');
  if (selectAllToggle.is(':checked')) {
    $('#alg-cases input[type="checkbox"]').prop('checked', true).trigger('change');
  } else if (selectLearningToggle.is(':checked')) {
    $('#alg-cases input[type="checkbox"]').each(function() {
      const algId = algToId($(this).data('algorithm'));
      if (learnedStatus(algId) === 1) {
        $(this).prop('checked', true).trigger('change');
      } else {
        $(this).prop('checked', false).trigger('change');
      }
    });
  }
});

// Event listener for Export button
$('#export-algs').on('click', () => {
  exportAlgorithms();
});

// Event listener for Import button
$('#import-algs').on('click', () => {
  $('#import-file').trigger('click');
});

// Event listener for file input change
$('#import-file').on('change', (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) {
    importAlgorithms(file);
  }
});

$('#show-options').on('click', () => {
  $('#app-top').hide();
  $('#alg-stats').hide();
  $('#load-container').hide();
  $('#save-container').hide();
  $('#info').hide();
  $('#help').hide();
  $('#left-side-inner').hide();
  $('#options-container').show();
});

const smartcubeShowAllBleToggle = document.getElementById('smartcube-show-all-ble-toggle') as HTMLInputElement;
smartcubeShowAllBleToggle.addEventListener('change', () => {
  localStorage.setItem(
    SMARTCUBE_DEVICE_SELECTION_KEY,
    smartcubeShowAllBleToggle.checked ? 'any' : 'filtered'
  );
});

$(function() {
  renameOldKeys();
  loadConfiguration();
  initQuickBar();
});

function renameOldKeys() {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('LastFiveTimes-')) {
      const newKey = key.replace('LastFiveTimes-', 'LastTimes-');
      localStorage.setItem(newKey, localStorage.getItem(key) ?? '');
      localStorage.removeItem(key);
    }
  }
}

function loadConfiguration() {
  const visualization = localStorage.getItem('visualization');
  if (visualization) {
    $('#visualization-select').val(visualization).trigger('change');
  }

  const hintFacelets = localStorage.getItem('hintFacelets');
  if (hintFacelets) {
    hintFaceletsToggle.checked = hintFacelets === 'floating';
    twistyPlayer.hintFacelets = hintFacelets === 'floating' ? 'floating' : 'none';
    twistyPlayerRemote.hintFacelets = hintFacelets === 'floating' ? 'floating' : 'none';
  } else {
    hintFaceletsToggle.checked = false;
    twistyPlayer.hintFacelets = 'none';
    twistyPlayerRemote.hintFacelets = 'none';
  }

  const fullStickering = localStorage.getItem('fullStickering');
  if (fullStickering) {
    fullStickeringToggle.checked = fullStickering === 'true';
    setFullStickeringEnabled(fullStickering === 'true');
  } else {
    fullStickeringToggle.checked = false;
    setFullStickeringEnabled(false);
  }

  const whiteOnBottom = localStorage.getItem('whiteOnBottom');
  if (whiteOnBottom) {
    whiteOnBottomEnabled = whiteOnBottom === 'true';
  } else {
    whiteOnBottomEnabled = false;
  }
  // Enforce dependency: white-on-bottom requires full stickering.
  if (!fullStickeringEnabled && whiteOnBottomEnabled) {
    whiteOnBottomEnabled = false;
    localStorage.setItem('whiteOnBottom', 'false');
  }
  applyWhiteOnBottomState({ persist: false });
  updateWhiteOnBottomAvailability();

  const backview = localStorage.getItem('backview');
  if (backview) {
    $('#backview-select').val(backview).trigger('change');
  }

  const gyroscopeValue = localStorage.getItem('gyroscope');
  if (gyroscopeValue) {
    gyroscopeToggle.checked = gyroscopeValue === 'enabled';
    gyroscopeEnabled = gyroscopeValue === 'enabled';
  } else {
    gyroscopeToggle.checked = true;
    gyroscopeEnabled = true;
  }

  const controlPanel = localStorage.getItem('control-panel');
  if (controlPanel) {
    controlPanelToggle.checked = controlPanel === 'bottom-row';
    twistyPlayer.controlPanel = controlPanel === 'bottom-row' ? 'bottom-row' : 'none';
  } else {
    controlPanelToggle.checked = false;
    twistyPlayer.controlPanel = 'none';
  }

  smartcubeShowAllBleToggle.checked = storedSmartCubeDeviceSelection() === 'any';

  const flashingIndicatorState = localStorage.getItem('flashingIndicatorEnabled');
  if (flashingIndicatorState) {
    flashingIndicatorToggle.checked = flashingIndicatorState === 'true';
    flashingIndicatorEnabled = flashingIndicatorState === 'true';
  } else {
    flashingIndicatorToggle.checked = true;
    flashingIndicatorEnabled = true;
  }

  const showAlgnameState = localStorage.getItem('showAlgName');
  if (showAlgnameState) {
    showAlgNameToggle.checked = showAlgnameState === 'true';
    showAlgNameEnabled = showAlgnameState === 'true';
  } else {
    showAlgNameToggle.checked = true;
    showAlgNameEnabled = true;
  }

  const alwaysScrambleToState = localStorage.getItem('alwaysScrambleTo');
  if (alwaysScrambleToState) {
    alwaysScrambleTo = alwaysScrambleToState === 'true';
  } else {
    alwaysScrambleTo = false;
  }
  $('#always-scramble-to-toggle').prop('checked', alwaysScrambleTo);

  applyQuickSettingsPanel(localStorage.getItem('quickSettingsPanel') === 'true');

  // Large cube size
  const cubeSizeStored = localStorage.getItem('cubeSizePx');
  cubeSizePx = clampInt(cubeSizeStored, 240, 600, 400);

  const cubeSizeEl = document.getElementById('cube-size') as HTMLInputElement | null;
  const cubeSizeNumberEl = document.getElementById('cube-size-number') as HTMLInputElement | null;
  if (cubeSizeEl) cubeSizeEl.value = String(cubeSizePx);
  if (cubeSizeNumberEl) cubeSizeNumberEl.value = String(cubeSizePx);

  applyCubeSizing();

  updateHeaderSyncBtnState();
}

// Add event listener for the gyroscope toggle
var gyroscopeEnabled: boolean = true;
const gyroscopeToggle = document.getElementById('gyroscope-toggle') as HTMLInputElement;

function applyGyroscopeEnabled(enabled: boolean) {
  gyroscopeEnabled = enabled;
  gyroscopeToggle.checked = enabled;
  sliceOrientation = { ...IDENTITY };
  localStorage.setItem('gyroscope', enabled ? 'enabled' : 'disabled');
  requestAnimationFrame(amimateCubeOrientation);
  updateHeaderSyncBtnState();
}

function setGyroscopeToggleDisabled(disabled: boolean) {
  gyroscopeToggle.disabled = disabled;
}

/** Sync device info field, animation toggle, and whether the toggle can be edited (off + disabled when no gyro). */
function setGyroscopeUiFromSupported(supported: boolean) {
  $('#gyroSupported').val(supported ? 'YES' : 'NO');
  applyGyroscopeEnabled(supported);
  setGyroscopeToggleDisabled(!supported);
}

gyroscopeToggle.addEventListener('change', () => {
  applyGyroscopeEnabled(gyroscopeToggle.checked);
});

// Add event listener for the control panel toggle
const controlPanelToggle = document.getElementById('control-panel-toggle') as HTMLInputElement;
controlPanelToggle.addEventListener('change', () => {
  localStorage.setItem('control-panel', controlPanelToggle.checked ? 'bottom-row' : 'none');
  twistyPlayer.controlPanel = controlPanelToggle.checked ? 'bottom-row' : 'none';
});

// Add event listener for the hint facelets toggle
const hintFaceletsToggle = document.getElementById('hintFacelets-toggle') as HTMLInputElement;
hintFaceletsToggle.addEventListener('change', () => {
  localStorage.setItem('hintFacelets', hintFaceletsToggle.checked ? 'floating' : 'none');
  twistyPlayer.hintFacelets = hintFaceletsToggle.checked ? 'floating' : 'none';
  twistyPlayerRemote.hintFacelets = hintFaceletsToggle.checked ? 'floating' : 'none';
});

// Add event listener for the full sticker toggle
const fullStickeringToggle = document.getElementById('full-stickering-toggle') as HTMLInputElement;
fullStickeringToggle.addEventListener('change', () => {
  setFullStickeringEnabled(fullStickeringToggle.checked);
  localStorage.setItem('fullStickering', fullStickeringToggle.checked.toString());
  if (fullStickeringEnabled) {
    twistyPlayer.experimentalStickering = 'full';
    twistyPlayerRemote.experimentalStickering = 'full';
  } else {
    let category = $('#category-select').val()?.toString().toLowerCase() || 'pll';
    setStickering(category);
    twistyPlayerRemote.experimentalStickering = twistyPlayer.experimentalStickering;
  }
  if (!fullStickeringEnabled) {
    // Enforce dependency: if full stickering is disabled, white-on-bottom must be off.
    setWhiteOnBottomEnabled(false, { persist: true });
  }
  updateWhiteOnBottomAvailability();
});

let whiteOnBottomEnabled: boolean = false;
const whiteOnBottomToggle = document.getElementById('white-on-bottom-toggle') as HTMLInputElement;
const whiteOnBottomHint = document.getElementById('white-on-bottom-hint') as HTMLElement | null;

function applyWhiteOnBottomState(options?: { persist?: boolean }) {
  const persist = options?.persist ?? false;
  whiteOnBottomToggle.checked = whiteOnBottomEnabled;
  if (persist) {
    localStorage.setItem('whiteOnBottom', whiteOnBottomEnabled.toString());
  }
  twistyPlayer.experimentalSetupAlg = whiteOnBottomEnabled ? 'z2' : '';
  if (conn) {
    void twistyTracker.experimentalGet.alg().then((alg) => {
      setTwistyAlg(alg.toString());
    }).catch((err) => console.warn('twisty alg sync failed', err));
  }
}

function updateWhiteOnBottomAvailability() {
  const available = fullStickeringEnabled;
  whiteOnBottomToggle.disabled = !available;
  if (whiteOnBottomHint) {
    whiteOnBottomHint.classList.toggle('hidden', available);
  }
}

function setWhiteOnBottomEnabled(enabled: boolean, options?: { persist?: boolean }) {
  whiteOnBottomEnabled = enabled;
  applyWhiteOnBottomState({ persist: options?.persist ?? false });
}

whiteOnBottomToggle.addEventListener('change', () => {
  const enabled = whiteOnBottomToggle.checked;
  if (enabled && !fullStickeringEnabled) {
    // Should be unreachable when disabled, but enforce anyway.
    fullStickeringToggle.checked = true;
    fullStickeringToggle.dispatchEvent(new Event('change'));
  }
  setWhiteOnBottomEnabled(whiteOnBottomToggle.checked, { persist: true });
  updateWhiteOnBottomAvailability();
});

var flashingIndicatorEnabled: boolean = true;
const flashingIndicatorToggle = document.getElementById('flashing-indicator-toggle') as HTMLInputElement;
flashingIndicatorToggle.addEventListener('change', () => {
  flashingIndicatorEnabled = flashingIndicatorToggle.checked;
  localStorage.setItem('flashingIndicatorEnabled', flashingIndicatorToggle.checked.toString());
});

var showAlgNameEnabled: boolean = true;
const showAlgNameToggle = document.getElementById('show-alg-name-toggle') as HTMLInputElement;
showAlgNameToggle.addEventListener('change', () => {
  showAlgNameEnabled = showAlgNameToggle.checked;
  localStorage.setItem('showAlgName', showAlgNameToggle.checked.toString());
  updateTimesDisplay(); // Update display immediately when toggled
});

var alwaysScrambleTo: boolean = false;
$('#always-scramble-to-toggle').on('change', () => {
  alwaysScrambleTo = $('#always-scramble-to-toggle').is(':checked');
  localStorage.setItem('alwaysScrambleTo', alwaysScrambleTo.toString());
});

// Quick Settings Bar
const quickSettingsPanelToggle = document.getElementById('quick-settings-panel-toggle') as HTMLInputElement;
const quickSettingsPanelToggleMenu = document.getElementById('quick-settings-panel-toggle-menu') as HTMLInputElement;
const quickSettingsPanel = document.getElementById('quick-settings-panel') as HTMLElement;

function applyQuickSettingsPanel(enabled: boolean) {
  quickSettingsPanelToggle.checked = enabled;
  quickSettingsPanelToggleMenu.checked = enabled;
  quickSettingsPanel.classList.toggle('hidden', !enabled);
  quickSettingsPanel.classList.toggle('flex', enabled);
  localStorage.setItem('quickSettingsPanel', enabled.toString());
}

quickSettingsPanelToggle.addEventListener('change', () => {
  applyQuickSettingsPanel(quickSettingsPanelToggle.checked);
});

quickSettingsPanelToggleMenu.addEventListener('change', () => {
  applyQuickSettingsPanel(quickSettingsPanelToggleMenu.checked);
});

/** Wire a quick-bar checkbox to its counterpart in the settings panel, keeping both in sync. */
function setupQuickToggleSync(quickId: string, originalId: string) {
  const quick = document.getElementById(quickId) as HTMLInputElement | null;
  const original = document.getElementById(originalId) as HTMLInputElement | null;
  if (!quick || !original) return;

  const syncFromOriginal = () => {
    quick.checked = original.checked;
    quick.disabled = original.disabled;
  };
  syncFromOriginal();
  original.addEventListener('change', syncFromOriginal);

  // Catch disabled attribute changes (e.g. gyro not supported)
  new MutationObserver(syncFromOriginal).observe(original, {
    attributes: true, attributeFilter: ['disabled'],
  });

  quick.addEventListener('change', () => {
    original.checked = quick.checked;
    original.dispatchEvent(new Event('change'));
  });
}

function setupQuickSelectSync(quickId: string, originalId: string) {
  const quick = document.getElementById(quickId) as HTMLSelectElement | null;
  const original = document.getElementById(originalId) as HTMLSelectElement | null;
  if (!quick || !original) return;

  quick.value = original.value;
  original.addEventListener('change', () => { quick.value = original.value; });
  quick.addEventListener('change', () => {
    original.value = quick.value;
    original.dispatchEvent(new Event('change'));
  });
}

function initQuickBar() {
  setupQuickToggleSync('quick-dark-mode',           'dark-mode-toggle');
  setupQuickToggleSync('quick-gyroscope',           'gyroscope-toggle');
  setupQuickToggleSync('quick-control-panel',       'control-panel-toggle');
  setupQuickToggleSync('quick-hint-facelets',       'hintFacelets-toggle');
  setupQuickToggleSync('quick-full-stickering',     'full-stickering-toggle');
  setupQuickToggleSync('quick-white-on-bottom',     'white-on-bottom-toggle');
  setupQuickToggleSync('quick-flashing-indicator',  'flashing-indicator-toggle');
  setupQuickToggleSync('quick-show-alg-name',       'show-alg-name-toggle');
  setupQuickToggleSync('quick-always-scramble-to',  'always-scramble-to-toggle');
  setupQuickSelectSync('quick-visualization-select', 'visualization-select');
  setupQuickSelectSync('quick-backview-select',      'backview-select');
}

// Large cube size
const cubeSizeEl = document.getElementById('cube-size') as HTMLInputElement | null;
const cubeSizeNumberEl = document.getElementById('cube-size-number') as HTMLInputElement | null;

function setCubeSize(next: number) {
  cubeSizePx = clampInt(next, 240, 600, 400);
  localStorage.setItem('cubeSizePx', String(cubeSizePx));
  if (cubeSizeEl) cubeSizeEl.value = String(cubeSizePx);
  if (cubeSizeNumberEl) cubeSizeNumberEl.value = String(cubeSizePx);
  applyCubeSizing();
}

if (cubeSizeEl) {
  cubeSizeEl.addEventListener('input', () => {
    setCubeSize(Number(cubeSizeEl.value));
  });
}
if (cubeSizeNumberEl) {
  cubeSizeNumberEl.addEventListener('input', () => {
    setCubeSize(Number(cubeSizeNumberEl.value));
  });
}

const animSpeedEl = document.getElementById('anim-speed') as HTMLInputElement | null;
const animSpeedNumberEl = document.getElementById('anim-speed-number') as HTMLInputElement | null;
const quickAnimSpeedEl = document.getElementById('quick-anim-speed') as HTMLInputElement | null;
const quickAnimSpeedNumberEl = document.getElementById('quick-anim-speed-number') as HTMLInputElement | null;

function setAnimSpeed(speed: number) {
  speed = Math.max(0.05, Math.min(1.25, speed));
  currentAnimSpeed = speed;
  localStorage.setItem('animSpeed', String(speed));
  if (animSpeedEl) animSpeedEl.value = String(speed);
  if (animSpeedNumberEl) animSpeedNumberEl.value = speed.toFixed(2);
  if (quickAnimSpeedEl) quickAnimSpeedEl.value = String(speed);
  if (quickAnimSpeedNumberEl) quickAnimSpeedNumberEl.value = speed.toFixed(2);
  twistyPlayer.tempoScale = 5 * speed;
  twistyTracker.tempoScale = 5 * speed;
  twistyPlayerRemote.tempoScale = 5 * speed;
}

const storedAnimSpeed = parseFloat(localStorage.getItem('animSpeed') ?? '1');
setAnimSpeed(isNaN(storedAnimSpeed) ? 1 : storedAnimSpeed);

if (animSpeedEl) {
  animSpeedEl.addEventListener('input', () => setAnimSpeed(Number(animSpeedEl.value)));
}
if (animSpeedNumberEl) {
  animSpeedNumberEl.addEventListener('input', () => setAnimSpeed(Number(animSpeedNumberEl.value)));
}
if (quickAnimSpeedEl) {
  quickAnimSpeedEl.addEventListener('input', () => setAnimSpeed(Number(quickAnimSpeedEl.value)));
}
if (quickAnimSpeedNumberEl) {
  quickAnimSpeedNumberEl.addEventListener('input', () => setAnimSpeed(Number(quickAnimSpeedNumberEl.value)));
}

// Add event listeners for the selectors to update twistyPlayer settings
var forceFix: boolean = false;
$('#visualization-select').on('change', () => {
  const visualizationValue = $('#visualization-select').val() || 'PG3D';
  localStorage.setItem('visualization', visualizationValue as string);
  switch (visualizationValue) {
    case '2D':
      twistyPlayer.visualization = '2D';
      twistyPlayerRemote.visualization = '2D';
      break;
    case '3D':
      twistyPlayer.visualization = '3D';
      twistyPlayerRemote.visualization = '3D';
      break;
    case 'PG3D':
      twistyPlayer.visualization = 'PG3D';
      twistyPlayerRemote.visualization = 'PG3D';
      break;
    case 'experimental-2D-LL':
      twistyPlayer.visualization = 'experimental-2D-LL';
      twistyPlayerRemote.visualization = 'experimental-2D-LL';
      break;
    case 'experimental-2D-LL-face':
      twistyPlayer.visualization = 'experimental-2D-LL-face';
      twistyPlayerRemote.visualization = 'experimental-2D-LL-face';
      break;
    default:
      twistyPlayer.visualization = 'PG3D';
      twistyPlayerRemote.visualization = 'PG3D';
  }
  // fix for 3D visualization not animating after visualization change
  if (conn && (visualizationValue as string).includes('3D')) {
    forceFix = true;
    requestAnimationFrame(amimateCubeOrientation);
  } else {
    forceFix = false;
  }
});

$('#backview-select').on('change', () => {
  const backviewValue = $('#backview-select').val();
  localStorage.setItem('backview', backviewValue as string);
  switch (backviewValue) {
    case 'none':
      twistyPlayer.backView = 'none';
      break;
    case 'side-by-side':
      twistyPlayer.backView = 'side-by-side';
      break;
    case 'top-right':
      twistyPlayer.backView = 'top-right';
      break;
    default:
      twistyPlayer.backView = 'none';
  }
});

const darkModeToggle = document.getElementById('dark-mode-toggle') as HTMLInputElement;

// Check for saved user preference
if (localStorage.getItem('theme') === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
  document.documentElement.classList.add('dark');
  darkModeToggle.checked = true; // Set checkbox to checked if dark mode is active
} else {
  document.documentElement.classList.remove('dark');
  darkModeToggle.checked = false; // Set checkbox to unchecked if dark mode is not active
}

// Add event listener for the dark mode toggle checkbox
darkModeToggle.addEventListener('change', () => {
  document.documentElement.classList.toggle('dark', darkModeToggle.checked);
  if (darkModeToggle.checked) {
    localStorage.setItem('theme', 'dark');
  } else {
    localStorage.setItem('theme', 'light');
  }
  applyPlasticColor();
  // redraw input alg
  updateAlgDisplay();
});

// Event listener for the select all subsets toggle
$('#select-all-subsets-toggle').on('change', function() {
  const selectAllToggle = $('#select-all-toggle');
  const selectLearningToggle = $('#select-learning-toggle');
  checkedAlgorithms = [];
  checkedAlgorithmsCopy = [];
  const isChecked = $(this).is(':checked');
  if (isChecked) {
    $('#subset-checkboxes-container input[type="checkbox"]').prop('checked', true);
    const selectedCategory = $('#category-select').val() as string;
    loadAlgorithms(selectedCategory);
    // if select all toggle is checked select all alg-cases, if select learning toggle is checked select learning alg-cases
    if (selectAllToggle.is(':checked')) {
      $('#alg-cases input[type="checkbox"]').prop('checked', true).trigger('change');
    } else if (selectLearningToggle.is(':checked')) {
      // check learnedStatus for each algorithm and select the ones that are learned
      $('#alg-cases input[type="checkbox"]').each(function() {
        const algId = algToId($(this).data('algorithm'));
        if (learnedStatus(algId) === 1) {
          $(this).prop('checked', true).trigger('change');
        } else {
          $(this).prop('checked', false).trigger('change');
        }
      });
    }
  } else {
    $('#subset-checkboxes-container input[type="checkbox"]').prop('checked', false);
    loadAlgorithms('');
  }
  saveSubsetSelections();
});

// Add event listener for the select all toggle
const selectAllToggle = document.getElementById('select-all-toggle') as HTMLInputElement;
selectAllToggle.addEventListener('change', () => {
  // when select all toggle is checked, uncheck the select learning toggle
  $('#select-learning-toggle').prop('checked', false);
  checkedAlgorithms = [];
  checkedAlgorithmsCopy = [];
  $('#alg-cases input[type="checkbox"]').prop('checked', selectAllToggle.checked).trigger('change');
});

function saveSubsetSelections() {
  const category = $('#category-select').val() as string;
  if (!category) return;
  const checked = $('#subset-checkboxes-container input[type="checkbox"]:checked')
    .map((_, el) => $(el).val()).get();
  const saved = JSON.parse(localStorage.getItem('savedSubsets') || '{}');
  saved[category] = checked;
  localStorage.setItem('savedSubsets', JSON.stringify(saved));
}

function restoreSubsetSelections(category: string) {
  const saved = JSON.parse(localStorage.getItem('savedSubsets') || '{}');
  const subsets: string[] = saved[category] || [];
  if (subsets.length === 0) return;
  $('#subset-checkboxes-container input[type="checkbox"]').each(function() {
    if (subsets.includes($(this).val() as string)) {
      $(this).prop('checked', true);
    }
  });
  $('#subset-checkboxes').trigger('change');
}

// Add event listener for the select learning toggle
$('#select-learning-toggle').on('change', function() {
  localStorage.setItem('selectLearning', $(this).is(':checked') ? 'true' : 'false');
  // when select learning toggle is checked, uncheck the select all toggle
  $('#select-all-toggle').prop('checked', false);
  // when select learning toggle is checked, uncheck all the selected algorithms
  $('#alg-cases input[type="checkbox"]:checked').prop('checked', false);
  const isChecked = $(this).is(':checked');
  const currentCategory = $('#category-select').val() as string;
  const checkedSubsets = $('#subset-checkboxes-container input[type="checkbox"]:checked')
    .map((_, el) => $(el).val())
    .get();

  // Clear current selections
  checkedAlgorithms = [];
  checkedAlgorithmsCopy = [];

  if (isChecked) {
    // Iterate over the current category and checked subsets
    const savedAlgorithms = JSON.parse(localStorage.getItem('savedAlgorithms') || '{}');
    if (savedAlgorithms[currentCategory]) {
      savedAlgorithms[currentCategory].forEach((subset: { subset: string, algorithms: { name: string, algorithm: string }[] }) => {
        if (checkedSubsets.includes(subset.subset)) {
          subset.algorithms.forEach(alg => {
            const algId = algToId(alg.algorithm);
            if (learnedStatus(algId) === 1) {
              // Check the checkbox for this algorithm
              $(`#alg-cases input[data-algorithm="${alg.algorithm}"][data-name="${alg.name}"]`).prop('checked', true).trigger('change');
            }
          });
        }
      });
    }
  } else {
    // Uncheck all checkboxes if the toggle is unchecked
    $('#alg-cases input[type="checkbox"]').prop('checked', false).trigger('change');
  }
});

// Add event listener for the random order toggle
let randomAlgorithms: boolean = localStorage.getItem('randomAlgorithms') === 'true';
const randomOrderToggle = document.getElementById('random-order-toggle') as HTMLInputElement;
randomOrderToggle.checked = randomAlgorithms;
randomOrderToggle.addEventListener('change', () => {
  randomAlgorithms = randomOrderToggle.checked;
  localStorage.setItem('randomAlgorithms', String(randomAlgorithms));
  if (prioritizeSlowAlgs) {
    prioritizeSlowToggle.checked = false
    prioritizeSlowAlgs = false
    localStorage.setItem('prioritizeSlowAlgs', 'false');
  }
});

// Add event listener for the random AUF toggle
let randomizeAUF: boolean = localStorage.getItem('randomizeAUF') === 'true';
const randomAUFToggle = document.getElementById('random-auf-toggle') as HTMLInputElement;
randomAUFToggle.checked = randomizeAUF;
randomAUFToggle.addEventListener('change', () => {
  randomizeAUF = randomAUFToggle.checked;
  localStorage.setItem('randomizeAUF', String(randomizeAUF));
});

// Add event listener for the prioritize slow toggle
let prioritizeSlowAlgs: boolean = localStorage.getItem('prioritizeSlowAlgs') === 'true';
const prioritizeSlowToggle = document.getElementById('prioritize-slow-toggle') as HTMLInputElement;
prioritizeSlowToggle.checked = prioritizeSlowAlgs;
prioritizeSlowToggle.addEventListener('change', () => {
  prioritizeSlowAlgs = prioritizeSlowToggle.checked;
  localStorage.setItem('prioritizeSlowAlgs', String(prioritizeSlowAlgs));
  if (randomAlgorithms) {
    randomOrderToggle.checked = false
    randomAlgorithms = false
    localStorage.setItem('randomAlgorithms', 'false');
  }
});

// Add event listener for the prioritize failed toggle
let prioritizeFailedAlgs: boolean = localStorage.getItem('prioritizeFailedAlgs') === 'true';
const prioritizeFailedToggle = document.getElementById('prioritize-failed-toggle') as HTMLInputElement;
prioritizeFailedToggle.checked = prioritizeFailedAlgs;
prioritizeFailedToggle.addEventListener('change', () => {
  prioritizeFailedAlgs = prioritizeFailedToggle.checked;
  localStorage.setItem('prioritizeFailedAlgs', String(prioritizeFailedAlgs));
});

$('#toggle-move-mask').on('click', (event) => {
  event.preventDefault();
  toggleMoveMask();
});

let isMoveMasked: boolean = false;
function toggleMoveMask() {
  isMoveMasked = !isMoveMasked; // Toggle the state
  $('.move').each(function() {
      $(this).css('-webkit-text-security', isMoveMasked ? 'disc' : 'none');
  });
  // change color of toggle-move-mask button
  $('#toggle-move-mask').toggleClass('bg-orange-500 hover:bg-orange-700', isMoveMasked).toggleClass('bg-blue-500 hover:bg-blue-700', !isMoveMasked);
  $('#toggle-move-mask').html(isMoveMasked ? '<svg fill="currentColor" class="h-6 w-6 inline-block" viewBox="-5.5 0 32 32" version="1.1" xmlns="http://www.w3.org/2000/svg"><path d="M10.32 22.32c-5.6 0-9.92-5.56-10.12-5.8-0.24-0.32-0.24-0.72 0-1.040 0.2-0.24 4.52-5.8 10.12-5.8s9.92 5.56 10.12 5.8c0.24 0.32 0.24 0.72 0 1.040-0.2 0.24-4.56 5.8-10.12 5.8zM1.96 16c1.16 1.32 4.52 4.64 8.36 4.64s7.2-3.32 8.36-4.64c-1.16-1.32-4.52-4.64-8.36-4.64s-7.2 3.32-8.36 4.64zM10.32 20c-2.2 0-4-1.8-4-4s1.8-4 4-4 4 1.8 4 4-1.84 4-4 4zM10.32 13.68c-1.28 0-2.32 1.040-2.32 2.32s1.040 2.32 2.32 2.32 2.32-1.040 2.32-2.32-1.040-2.32-2.32-2.32z"></path></svg> Unmask alg' : '<svg fill="currentColor" class="h-6 w-6 inline-block" viewBox="-5.5 0 32 32" version="1.1" xmlns="http://www.w3.org/2000/svg"><path d="M20.44 15.48c-0.12-0.16-2.28-2.92-5.48-4.56l0.92-3c0.12-0.44-0.12-0.92-0.56-1.040s-0.92 0.12-1.040 0.56l-0.88 2.8c-0.96-0.32-2-0.56-3.080-0.56-5.6 0-9.92 5.56-10.12 5.8-0.24 0.32-0.24 0.72 0 1.040 0.16 0.24 4.2 5.36 9.48 5.76l-0.56 1.8c-0.12 0.44 0.12 0.92 0.56 1.040 0.080 0.040 0.16 0.040 0.24 0.040 0.36 0 0.68-0.24 0.8-0.6l0.72-2.36c5-0.68 8.8-5.48 9-5.72 0.24-0.28 0.24-0.68 0-1zM1.96 16c1.16-1.32 4.52-4.64 8.36-4.64 0.88 0 1.76 0.2 2.6 0.48l-0.28 0.88c-0.68-0.48-1.48-0.72-2.32-0.72-2.2 0-4 1.8-4 4s1.8 4 4 4c0.040 0 0.040 0 0.080 0l-0.2 0.64c-3.8-0.080-7.080-3.36-8.24-4.64zM10.88 18.24c-0.2 0.040-0.4 0.080-0.6 0.080-1.28 0-2.32-1.040-2.32-2.32s1.040-2.32 2.32-2.32c0.68 0 1.32 0.32 1.76 0.8l-1.16 3.76zM12 20.44l2.4-7.88c1.96 1.080 3.52 2.64 4.24 3.44-0.96 1.12-3.52 3.68-6.64 4.44z"></path></svg> Mask alg');
}

const menuToggle = document.getElementById('menu-toggle');
const menuItems = document.getElementById('menu-items');
if (menuToggle && menuItems) {
  menuToggle.addEventListener('click', () => {
    menuItems.classList.toggle('hidden');
  });

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (!menuToggle.contains(target) && !menuItems.contains(target)) {
      menuItems.classList.add('hidden');
    }
  });
}

// Add event listeners to menu items
const menuButtons = document.querySelectorAll('#menu-items button');
menuButtons.forEach(item => {
  item.addEventListener('click', () => {
    // Remove 'selected' class from all menu items
    menuButtons.forEach(i => i.classList.remove('selected'));
    // Add 'selected' class to the clicked item
    item.classList.add('selected');
  });
});

const categorySelect = $('#category-select');
if (categorySelect.val() === null || categorySelect.val() === '') {
  loadCategories();
  const initialCategory = categorySelect.val() as string;
  restoreSubsetSelections(initialCategory);
  if (localStorage.getItem('selectLearning') === 'true') {
    $('#select-learning-toggle').prop('checked', true).trigger('change');
  }
}

// functions to activate timer when using a dumb cube
function activateTimer() {
  if (timerState == "STOPPED" || timerState == "IDLE" || timerState == "READY") {
    showFlashingIndicator('gray', 200);
    setTimerState("RUNNING");
  } else {
    setTimerState("STOPPED");
  }
}

let isKeyboardTimerActive: boolean = false;

$(document).on('keydown', (event) => {
  if (!conn && !inputMode && event.which === 32) {
    event.preventDefault();
    if (timerState == "STOPPED" || timerState == "IDLE") {
      setTimerValue(0);
      setTimerState("READY");
    } else if (timerState == "RUNNING") {
      setTimerState("STOPPED");
    } else if (timerState == "READY" && !isKeyboardTimerActive) {
      setTimerValue(0);
    }
  }
});

$(document).on('keyup', (event) => {
  if (!conn && !inputMode && event.which === 32) {
    event.preventDefault();
    if (timerState == "READY" && !isKeyboardTimerActive) {
      activateTimer();
      isKeyboardTimerActive = true;
    } else {
      isKeyboardTimerActive = false;
    }
  }
});

let isScrolling = false;

$(document).on('touchstart', function () {
    isScrolling = false;
});

$(document).on('touchmove', function () {
    isScrolling = true;
});

$("#touch-timer").on('touchend', () => {
  if (!conn && !inputMode && !isScrolling) {
    activateTimer();
  }
});

$("#times-display").on('touchend', () => {
  if (!conn && !inputMode && !isScrolling) {
    activateTimer();
  }
});

$("#cube").on('touchend', () => {
  if (!conn && !inputMode && !isScrolling) {
    activateTimer();
  }
});

initFullSolve();
// Wire the solve-replay overlay: the replay module needs to set the
// virtual cube's algorithm and save/restore its pre-replay state. We
// inject those via callbacks so replay.ts doesn't need to know about
// twistyPlayer directly.
initReplay({
  setCubeAlg: (alg) => { setTwistyAlg(alg); },
  applyMove: (move) => {
    // Animated single-move advance — TwistyPlayer queues consecutive
    // calls and animates at its tempoScale. Used for play + step-
    // forward; instant jumps (scrub, rewind, step-back) go through
    // setCubeAlg instead.
    twistyPlayer.experimentalAddMove(move, { cancel: false });
  },
  saveCurrentAlg: () => lastTwistyAlg,
  // Tracks the Animation Speed slider (settings panel + quick-settings).
  // Base ~150ms per move at speed=1; scales inversely with speed so
  // moving the slider to 0.5 doubles the per-move duration replay uses
  // to schedule its "end-at-recorded-time" delays.
  getAnimMsPerMove: () => Math.max(20, 150 / Math.max(0.05, currentAnimSpeed)),
});
// Seed the Full Solve module's pattern state eagerly so it doesn't have to
// wait for the next pattern-change event (addFreshListener fires on changes,
// not on subscribe). Without this, newScramble's start state can default to
// solved even when the cube is mid-state, which throws off phase detection.
twistyTracker.experimentalModel.currentPattern.get().then(p => fsOnPattern(p)).catch(() => { /* ignore */ });

// event listener for the dumbcube toggle
$('#dumbcube-toggle').on('click', () => {
  $('#help-content-smartcube').toggleClass('hidden');
  $('#help-content-dumbcube').toggleClass('hidden');
  if ($('#help-content-smartcube').hasClass('hidden')) {
    $('#help-title').text('DUMBCUBE HELP');
    $('#dumbcube-toggle').html('🛜 USING a smart cube? <a href="#" class="text-blue-500 hover:underline">CLICK HERE</a>');
  } else {
    $('#help-title').text('SMARTCUBE HELP');
    $('#dumbcube-toggle').html('🛜 NOT using a smart cube? <a href="#" class="text-blue-500 hover:underline">CLICK HERE</a>');
  }
});
