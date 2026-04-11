## Cubedex
[Cubedex](https://cubedex.app) is an alg trainer that helps you drill, time, and master Rubik's Cube algorithm sets like OLL and PLL, building them into your muscle memory more quickly and effectively.

📱 How to Get Started:

✅ Visit [CubeDex.app](https://cubedex.app) in your browser
✅ Add Cubedex to your home screen for an app-like experience
✅ You can use it offline - Cubedex works perfectly without an internet connection
✅ Compatible with smartcubes and regular non-Bluetooth cubes!

📺 Watch the Tutorial Video:
[![Watch the Tutorial Video](https://img.youtube.com/vi/AZcFMiT2Vm0/hqdefault.jpg)](https://www.youtube.com/watch?v=AZcFMiT2Vm0)

Cubedex has been created with ♥ by [Pau Oliva Fora](https://twitter.com/pof) using [smartcube-web-bluetooth](https://github.com/poliva/smartcube-web-bluetooth) and [cubing.js](https://github.com/cubing/cubing.js).

If you enjoy using Cubedex, please consider supporting the development on [Ko-fi](https://ko-fi.com/cubedex).
[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/H2H6132Z3Z)

**Building:**
```
$ npm install
$ npm run build && npm run preview
```
**Publish gh-page:**
```
$ rm -rf docs && mv dist docs
```

## Testing

The Full Solve mode's pure logic (cube predicates, scrambler, phase aggregation, history merge, label layout, etc.) lives in `src/cube/` and `src/fullSolve/` and has unit tests via [vitest](https://vitest.dev/).

```
$ npm test           # one-shot run (used in CI / pre-port verification)
$ npm run test:watch # watch mode for active development
```

After a port to upstream changes, a green `npm test` confirms the logic islands are intact. Wiring/UI is verified separately via [`SMOKE_TEST.md`](./SMOKE_TEST.md).

## Deploying

If the app is hosted at a path other than the domain root (e.g. `https://example.com/cubedex/`), set `BASE_PATH` at build time:

```
BASE_PATH=/cubedex/ npm run build
```

`BASE_PATH` defaults to `/`. It is prepended to all asset URLs and the PWA manifest's `start_url` and `scope`.

To serve the built output (the contents of `dist/`) from any static file server, ensure the server serves `index.html` for all routes (SPA fallback).

```
rsync -av --delete dist/ example.com:sites/example/cubedex/
```
