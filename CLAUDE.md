# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Vite dev server (hot module reload)
npm run build     # tsc + vite build + tailwind CSS
npm run preview   # preview production build locally
```

No test suite exists. Deploy by running `npm run build`, then `rm -rf docs && mv dist docs` and pushing to GitHub Pages.

## What This Is

Cubedex is a Rubik's Cube algorithm trainer — a PWA where users drill OLL, PLL, ZBLS, and other algorithm sets, with optional GAN smartcube integration via Web Bluetooth. It runs entirely in the browser; all state is in localStorage.

## Architecture

The app is vanilla TypeScript + jQuery with no framework. Three main source files:

**`src/index.ts`** (~1800 lines) — main app. Owns the DOM, event handlers, and all runtime state. Integrates:
- `TwistyPlayer` (cubing.js) for 3D cube visualization
- `gan-web-bluetooth` for smartcube Bluetooth connection
- Gyroscope handling and move tracking against practiced algorithms
- Wake lock management

**`src/functions.ts`** (~730 lines) — pure logic layer. Algorithm notation parsing/expansion, localStorage read/write for alg sets and timing stats, Chart.js performance graphs, category/subset management.

**`src/utils.ts`** (~210 lines) — cube state conversion. Bridges cubing.js `KPattern` ↔ Reid/Kociemba notation used by the min2phase solver and GAN cube facelets.

**`src/lib/min2phase/`** — embedded Kociemba two-phase solver for generating scramble solutions.

**`src/defaultAlgs.json`** — bundled algorithm database (OLL, PLL, ZBLS, etc.).

## Key Patterns

- Algorithm sets are stored in localStorage as JSON; `defaultAlgs.json` is the fallback.
- Cube orientation from the gyroscope is tracked separately from move state; gyro re-zeroing happens on Bluetooth reconnect.
- `TwistyPlayer` is manipulated imperatively (`.experimentalModel`, `.experimentalAddMove`) rather than via reactive props.
