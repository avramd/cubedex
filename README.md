# Cubedex — Avram Dorfman's Fork

This is a fork of [Cubedex](https://github.com/poliva/cubedex) by [Pau Oliva Fora](https://twitter.com/pof) — a browser-based Rubik's Cube algorithm trainer with smartcube (Bluetooth) support. See [README-poliva.md](README-poliva.md) for the original documentation, including how to get started and how to support Pau's work.

---

## My Branches

### [`agd-ui-improvements`](https://github.com/avramd/cubedex/tree/agd-ui-improvements) · [▶ Live demo](https://avramd.github.io/cubedex/branch/agd-ui-improvements/)

A collection of UI and UX improvements on top of the upstream codebase:

- Quick-access controls: Add control strip w/ common/smaller controls to main page so navigating away from main cube view is not needed
- Friendly scramble/alg helper warning - doesn't bounce whole page, delayed display in case you fix it yourself
- Shortened case scrambles — capped length so long scrambles are more approachable
- Compact results graph view with a redesigned layout
- Animation speed control for smartcube move playback
- Training options toggles and settings persisted across reloads

### [`agd-peer-to-peer-cubing`](https://github.com/avramd/cubedex/tree/agd-peer-to-peer-cubing) · [▶ Live demo](https://avramd.github.io/cubedex/branch/agd-peer-to-peer-cubing/)

Builds on `agd-ui-improvements`. Adds real-time P2P cube sharing over WebRTC (via PeerJS). Two people connect using a short room code and see each other's cube live — gyroscope orientation, physical moves, and camera angle all stream to the partner in real time.

- Generate a room code and share it, or enter a partner's code to join
- Both cubes appear side by side in split-screen when connected.
- Only one user needs a smart-cube to share, but if both have one, both are shared.
- **Send Case**: push your current scramble to your partner so they can practice the same case — move instructions are computed from wherever their cube currently is
- **Sync Steps**: get the moves needed to match your partner's current cube state
- State is replayed on connect/reconnect so the remote cube always shows the correct position

### [`white-d-layer-option`](https://github.com/avramd/cubedex/tree/white-d-layer-option) · [▶ Live demo](https://avramd.github.io/cubedex/branch/white-d-layer-option/)

Adds a **D=White** reference frame option for solvers who hold the cube with white on the bottom (D face) rather than the white-on-top (U face) that is original to cubedex. When enabled:

- The virtual cube renders in the correct orientation for D=white solving
- Added 3D inertia-based cube-drag reorientation (so you can fix the cube tilting sideways)
- Gyroscope tracking is remapped so physical orientation matches the display
- Move detection and scramble generation account for the rotated reference frame
- Algorithm hints and stickering update to match the new orientation
