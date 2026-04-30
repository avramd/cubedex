import type { SolveRecord } from './types';

// Human-readable label for a phase key; used by the graph legend/list across solves.
export const PHASE_KEY_LABELS: Record<string, string> = {
  cross: 'Cross', f2l: 'F2L', oll: 'OLL', pll: 'PLL',
  eoll: 'EOLL', ocll: 'OCLL', cpll: 'CPLL', epll: 'EPLL',
  setup: 'Setup', ll: 'LL',
};

// Look up a phase's milliseconds from a stored record, given the *display*
// key currently being rendered. Toggling 2-look OLL/PLL only changes how
// the stack is split visually — the underlying data is preserved:
//   - When showing the aggregate ('oll'/'pll'), sum any matching split
//     subphases from the record (so a 2-look-on solve still contributes).
//   - When showing a split subphase ('eoll'/'ocll'/'cpll'/'epll') against
//     a record that only has the aggregate, fold the aggregate into the
//     dominant ("higher stacked") subphase — OCLL absorbs `oll`, EPLL
//     absorbs `pll` — and the other subphase stays at 0. Total per-solve
//     time is preserved either way.
export function phaseMsForDisplay(r: SolveRecord, displayKey: string): number {
  const p = r.phases || {};
  switch (displayKey) {
    case 'oll':  return (p.oll  ?? 0) + (p.eoll ?? 0) + (p.ocll ?? 0);
    case 'pll':  return (p.pll  ?? 0) + (p.cpll ?? 0) + (p.epll ?? 0);
    case 'ocll': return (p.ocll ?? p.oll ?? 0);
    case 'eoll': return (p.eoll ?? 0);
    case 'epll': return (p.epll ?? p.pll ?? 0);
    case 'cpll': return (p.cpll ?? 0);
    default:     return p[displayKey] ?? 0;
  }
}
