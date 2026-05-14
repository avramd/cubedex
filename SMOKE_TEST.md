# Full Solve manual smoke test

A short walkthrough that covers the wiring + UI behavior the unit suite (`npm test`) can't reach. Run after a port to upstream changes, after touching the Chart.js plugin, or after edits to `src/fullSolve.ts` / `index.html` / `src/tailwind.css`.

Should take ~10 minutes. Use a **smartcube** (gan-web-bluetooth) — most checks aren't testable without one.

## Setup

```
npm install
npm run dev
```

Open the URL Vite prints. Connect your smartcube via the existing connect button before starting.

If you want to start with a clean slate, in DevTools console:

```js
localStorage.removeItem('fullSolveHistory');
localStorage.removeItem('fullSolvePrefs');
location.reload();
```

If you want to keep your existing data, **Export** first (📤 button next to "Past Solves" once Full Solve is on) and re-Import after.

## Mode toggle

- [ ] Toggle "Full Solve" off → training-mode UI shown, big graph hidden.
- [ ] Toggle on → training UI hidden, Full Solve UI shown, big graph re-renders. Graph controls (View last / Y-axis / Ao5 / Ao12) appear on the same row as the toggle.
- [ ] Reload — toggle state persists.

## No-cube banner

- [ ] With Full Solve on, disconnect the cube → status line under the scramble shows **"Connect a smart cube to track your solves."** with a dashed border.
- [ ] Reconnect → banner disappears, normal status text resumes (e.g., "Scramble your cube to match.").
- [ ] Toggle Full Solve off while no cube → no banner anywhere; toggle back on while still no cube → banner reappears.

## Settings persistence

- [ ] Change Process (CFOP / Beginner), Inspection (3/5/10/15/Pause), 2-look OLL, 2-look PLL — reload — all persist.
- [ ] CFOP-only options (2-look toggles) hide when Process = Beginner.

## Scramble + inspection + solve flow (CFOP)

- [ ] Pressing **New Scramble** generates 25-ish moves, all single-face, no two consecutive same-face moves.
- [ ] Apply the scramble. Status shifts through "Scramble your cube to match." → inspection countdown → "Solving — phase: Cross".
- [ ] Phase status advances on each transition: Cross → F2L → OLL/EOLL → OCLL → CPLL → EPLL (subset depending on 2-look toggles).
- [ ] On solve, status shows "Solved!", timer freezes, a row appears at the top of **Past Solves**, the graph adds a column, and the three stat boxes update.

## Pause / Abort

- [ ] During a solve, **Pause** disables timer accumulation. Resume → timer continues.
- [ ] **Abort** discards the run (no row added) and queues a new scramble.
- [ ] Both buttons are disabled in idle / done states.

## Color neutrality

- [ ] Do at least one solve with cross on white (D) and one with cross on yellow (U). Both should record correctly with all phase transitions detected. If you're cross-color-neutral, also try one on green/blue/red/orange.

## 2-look toggle aggregation (no data loss)

Make sure history has at least one solve recorded with 2-look OLL ON (split EOLL+OCLL) and at least one with 2-look OLL OFF (combined OLL).

- [ ] Toggle 2-look OLL **off** → graph shows a single OLL band (orange). Total stack height per solve unchanged.
- [ ] Toggle 2-look OLL **on** → graph splits into EOLL (yellow) + OCLL (orange). Total stack height per solve unchanged.
- [ ] Same dance for 2-look PLL → CPLL (blue) / EPLL (purple) split vs combined PLL (purple).

## F2L slot splits

Make sure history has at least one fresh solve (recorded after this feature shipped — will have `f2lSplits` in localStorage) and ideally one legacy solve (no `f2lSplits`).

- [ ] Toggle **F2L slots** on → the F2L band of fresh solves splits into up to 4 alpha-scaled sub-bands of the same green (lighter at the bottom, darker at the top). Total stack height per solve unchanged.
- [ ] Legacy solves (no `f2lSplits`) keep a single full-alpha F2L band even with the toggle on.
- [ ] Hover a column → still shows exactly **one** F2L line in the chits (not four).
- [ ] Toggle off → single solid F2L band for all solves.

## Turn-progression popup (📈)

- [ ] Click 📈 on a fresh solve → modal opens with a rising line plot. No metric text on the card; just the chart and ✕.
- [ ] Phase color bands sit behind the line; their boundaries roughly line up with where slope changes (intuitive sanity check).
- [ ] ESC, backdrop click, and ✕ all close. Focus returns to the 📈 button.
- [ ] 📈 on an old solve without turn data is disabled with the right tooltip.

## Graph hover (two-stage)

- [ ] Hover a column inside the plot axes → guide line + per-phase chits + chitless aggregates (Ao5, Ao12, Solve).
- [ ] Move cursor outside the axes but still inside the chart canvas → chits disappear; guide + aggregates remain and track horizontally.
- [ ] Move further into the metrics boxes (Average Time / TPS / Single PB) → guide + aggregates still update; column snaps to the nearest x.
- [ ] Move cursor outside `#alg-stats` entirely → guide + aggregates clear.

## Clipped-solve labels

- [ ] Set Y-axis to "Clip at mean + 1σ" so at least one slow solve is clipped.
- [ ] Hover a clipped column → the off-screen labels appear stacked at the very top of the chart, in stacking order (top phase highest). Unclipped labels in the same hover keep their natural y.

## Past Solves list

For at least one row in the list:

- [ ] 📋 Copy → scramble lands on clipboard.
- [ ] 🎯 Set as next → scramble applied as the current scramble.
- [ ] 👀 / 🫣 → toggles solution visibility for that row only.
- [ ] 🪗 → expands; redundant moves appear with strikethrough; italic equivalent-turn replacements appear in their own slot. Re-collapse hides redundant moves entirely (no strike, just gone).
- [ ] 🗑️ → confirms then deletes the row; graph + stats update.
- [ ] Move display: chunked into groups of 4 *relevant* moves; redundant moves don't count toward the chunk size; clockwise/half-turn moves get a small right-pad inside a chunk; counter-clockwise moves don't (the apostrophe gives spacing).

## Import / Export round-trip

- [ ] Click **Export** → JSON file downloads, named `cubedex-solve-history-YYYY-MM-DDTHH-MM-SS.json`.
- [ ] Click **Import**, pick the file you just exported → alert says "Imported 0 new solves… history size: N → N." (Idempotent on the same data.)
- [ ] Edit the file: bump one record's `totalMs` higher, save, re-Import → "replaced 0" (same-or-longer doesn't replace).
- [ ] Edit again: drop one record's `totalMs` lower, re-Import → "replaced 1 with shorter time".
- [ ] Replace the JSON contents with `null` or `"not an array"` and re-Import → alert about invalid JSON / expected array; existing history untouched.

## Graph range slider

- [ ] Slider min is 20, max is 500, default 20. Drag to a higher value → graph extends back through history; if history is shorter than the value, all of history is shown.
- [ ] With < 20 solves recorded, slider sits at 20 but graph shows only what exists.

## PWA refresh prompt (production-build only)

- [ ] `npm run build && npm run preview`, open in a fresh tab.
- [ ] Make a small visible change in the source, rebuild, refresh the preview tab → banner appears: "A new version of Cubedex is available. Refresh now?"
- [ ] Click **Refresh** → page reloads and shows the new version. (Should never hang spinning, including with `clientsClaim: false` in workbox config.)
- [ ] Click **Later** → banner dismisses; no automatic reload.

## Wrap-up

If everything passes and `npm test` is green: ship it.

If a step fails, capture the failing step number/name when reporting back — that's enough to scope the regression.
