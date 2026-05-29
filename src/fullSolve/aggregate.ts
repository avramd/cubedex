import type { SolveRecord } from './types';

// Human-readable label for a phase key; used by the graph legend/list across solves.
export const PHASE_KEY_LABELS: Record<string, string> = {
  cross: 'Cross', f2l: 'F2L', oll: 'OLL', pll: 'PLL',
  eoll: 'EOLL', ocll: 'OCLL', cpll: 'CPLL', epll: 'EPLL',
  setup: 'Setup', ll: 'LL',
  // Roux / F3uL
  f1b: '1st Block', f2b: '2nd Block', fml: 'FML',
  cmll: 'CMLL', opll: 'OPLL',
  lse: 'LSE', lseo: 'LSEO', lre: 'LRE', opme: 'OPME',
  // Block-stage sub-shades — block-aware (scheme 1) labels mix pair
  // counts with block-completion milestones; pair-count (scheme 2)
  // labels are uniformly chronological.
  b1_pre: '1pr', b1_done: '1blk',
  b2_pre: '3pr', b2_done: '2blk',
  rp1: '1pr', rp2: '2pr', rp3: '3pr', rp4: '4pr',
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
  // F2L sub-band keys: split p.f2l into 4 buckets using r.f2lSplits. Pre-
  // feature records (no f2lSplits) fold the whole F2L into f2l_4 so the
  // band renders at the topmost (darkest) sub-band's saturation, matching
  // the visual prominence of the original single F2L band; the other
  // sub-bands return 0 (invisible).
  if (displayKey === 'f2l_1' || displayKey === 'f2l_2'
      || displayKey === 'f2l_3' || displayKey === 'f2l_4') {
    return f2lSubBandMs(r, displayKey);
  }
  switch (displayKey) {
    // Aggregate OLL prefers the split (eoll + ocll) when present; falls
    // back to the unsplit `oll` field. Same for PLL. This lets the backfill
    // freely add split keys to records that already have the aggregate
    // without double-counting.
    case 'oll':  {
      const split = (p.eoll ?? 0) + (p.ocll ?? 0);
      return split > 0 ? split : (p.oll ?? 0);
    }
    case 'pll':  {
      const split = (p.cpll ?? 0) + (p.epll ?? 0);
      return split > 0 ? split : (p.pll ?? 0);
    }
    case 'ocll': return (p.ocll ?? p.oll ?? 0);
    case 'eoll': return (p.eoll ?? 0);
    case 'epll': return (p.epll ?? p.pll ?? 0);
    case 'cpll': return (p.cpll ?? 0);
    // Roux's CMLL aggregate prefers the split (ocll + opll) when
    // present; falls back to the unsplit `cmll` field. Mirrors OLL/PLL.
    case 'cmll': {
      const split = (p.ocll ?? 0) + (p.opll ?? 0);
      return split > 0 ? split : (p.cmll ?? 0);
    }
    // OPLL absorbs the CMLL aggregate when only the aggregate is stored
    // (mirrors OCLL absorbing OLL): puts the whole CMLL band at the
    // higher-stacked position when displayed split.
    case 'opll': return (p.opll ?? p.cmll ?? 0);
    // Roux's LSE aggregate prefers the 3-way split (lseo + lre + opme)
    // when present; falls back to the unsplit `lse` field.
    case 'lse': {
      const split = (p.lseo ?? 0) + (p.lre ?? 0) + (p.opme ?? 0);
      return split > 0 ? split : (p.lse ?? 0);
    }
    case 'lseo': return (p.lseo ?? 0);
    case 'lre':  return (p.lre ?? 0);
    // OPME (3rd LSE sub-phase) absorbs LSE aggregate when displayed split.
    case 'opme': return (p.opme ?? p.lse ?? 0);
    // Roux/F3uL block-stage sub-shade durations. Each is derived from
    // r.rouxPairTimingsMs (chronological pair completions) and the
    // block-completion anchors r.rouxBlock{1,2}FirstPairMs plus the
    // existing cumulative phase durations p.f1b / p.f2b. All Math.max
    // guards because of rounding.
    //
    // Scheme 1: block-aware. Anchors are clamped to enforce the invariants
    //   b1_pre + b1_done === f1b
    //   b2_pre + b2_done === f2b
    // even when blocks are solved interleaved (e.g., 1 pair of block 2 done
    // BEFORE block 1 is complete). Without clamping, the "block 2 first
    // pair" anchor can sit BEFORE f1b, making b2_done overcount by the
    // (already-attributed-to-block-1) interleaving time.
    case 'b1_pre': {
      const f1b = p.f1b ?? 0;
      const anchor = r.rouxBlock1FirstPairMs ?? 0;
      return Math.min(f1b, Math.max(0, anchor));
    }
    case 'b1_done': {
      const f1b = p.f1b ?? 0;
      const anchor = Math.min(f1b, Math.max(0, r.rouxBlock1FirstPairMs ?? 0));
      return Math.max(0, f1b - anchor);
    }
    case 'b2_pre': {
      const f1b = p.f1b ?? 0;
      const f2b = p.f2b ?? 0;
      const anchor = Math.max(f1b, r.rouxBlock2FirstPairMs ?? 0);
      return Math.max(0, Math.min(f2b, anchor - f1b));
    }
    case 'b2_done': {
      const f1b = p.f1b ?? 0;
      const f2b = p.f2b ?? 0;
      const anchor = Math.max(f1b, r.rouxBlock2FirstPairMs ?? 0);
      return Math.max(0, (f1b + f2b) - anchor);
    }
    // Scheme 2: chronological pair count. Anchor for rp4 is the
    // sum of f1b + f2b (= 2nd block done = 4 pairs done by definition).
    case 'rp1': return r.rouxPairTimingsMs?.[0] ?? 0;
    case 'rp2': return Math.max(0, (r.rouxPairTimingsMs?.[1] ?? 0) - (r.rouxPairTimingsMs?.[0] ?? 0));
    case 'rp3': return Math.max(0, (r.rouxPairTimingsMs?.[2] ?? 0) - (r.rouxPairTimingsMs?.[1] ?? 0));
    case 'rp4': return Math.max(0, ((p.f1b ?? 0) + (p.f2b ?? 0)) - (r.rouxPairTimingsMs?.[2] ?? 0));
    default:     return p[displayKey] ?? 0;
  }
}

function f2lSubBandMs(r: SolveRecord, k: 'f2l_1' | 'f2l_2' | 'f2l_3' | 'f2l_4'): number {
  const p = r.phases || {};
  const f2lMs = p.f2l ?? 0;
  const splits = r.f2lSplits;
  if (!splits || splits.length === 0) {
    // Legacy record. Fold the whole F2L into sub-band 4 so the band
    // renders at the topmost (darkest) saturation — visually prominent
    // and clearly distinct from a partial split.
    return k === 'f2l_4' ? f2lMs : 0;
  }
  const crossMs = p.cross ?? 0;
  // splits[i] is ms-from-solveStart at slot count (i+1). Convert to
  // ms-from-F2L-start. Pad missing trailing entries with f2lMs (cap).
  const subEnds: number[] = [];
  for (let i = 0; i < 4; i++) {
    if (i < splits.length) subEnds.push(Math.max(0, Math.min(splits[i] - crossMs, f2lMs)));
    else subEnds.push(f2lMs);
  }
  // Ensure monotonic (defensive against same-tick recording artefacts).
  for (let i = 1; i < 4; i++) if (subEnds[i] < subEnds[i - 1]) subEnds[i] = subEnds[i - 1];
  // The 4th sub-band always ends at f2lMs — F2L done = slot 4 done by
  // predicate definition, so any short trailing recording (or buggy
  // input) shouldn't leak unaccounted ms.
  subEnds[3] = f2lMs;
  const idx = parseInt(k.slice(4), 10) - 1; // 0..3
  const start = idx === 0 ? 0 : subEnds[idx - 1];
  const end = subEnds[idx];
  return Math.max(0, end - start);
}
