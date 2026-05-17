import type { SolveRecord } from './types';

// CSV export for Full Solve history. Format: `timestamp,move,phase`.
// Short phase labels (cross / f2l[1-4] / eoll / ocll / oll / cpll /
// epll / pll / setup / ll) plus the pseudo-phases (scramble /
// inspection / start / abort) for non-move rows. Timestamps are
// fractional seconds from solve start (negative during inspection,
// blank during scramble). Solves are concatenated WITHOUT blank-row
// separators: a completed solve ends naturally at its final move
// (which puts the cube into the solved state), and an incomplete one
// ends with an explicit `abort` row, so the boundary is unambiguous.
// Whole module is pure so it can be unit-tested without DOM.

// Return the short phase label active at the given ms-from-solve-start
// instant, based on the record's stored phase durations + f2lSplits.
export function phaseAtMs(r: SolveRecord, t_ms: number): string {
  const p = r.phases || {};
  if (r.process === 'beginner') {
    const setupMs = p.setup ?? 0;
    if (t_ms < setupMs) return 'setup';
    const llMs = p.ll ?? 0;
    if (t_ms < setupMs + llMs) return 'll';
    return 'solved';
  }
  const crossMs = p.cross ?? 0;
  if (t_ms < crossMs) return 'cross';
  const f2lMs = p.f2l ?? 0;
  const f2lEndMs = crossMs + f2lMs;
  if (t_ms < f2lEndMs) {
    const splits = r.f2lSplits;
    if (splits && splits.length >= 4) {
      if (t_ms < splits[0]) return 'f2l1';
      if (t_ms < splits[1]) return 'f2l2';
      if (t_ms < splits[2]) return 'f2l3';
      return 'f2l4';
    }
    return 'f2l';
  }
  // LL: prefer split keys (eoll/ocll, cpll/epll) when present in the
  // record; fall back to the aggregate (oll, pll) otherwise. Same
  // resolution logic as phaseMsForDisplay.
  const eollMs = p.eoll ?? 0;
  const ocllMs = p.ocll ?? 0;
  const cpllMs = p.cpll ?? 0;
  const epllMs = p.epll ?? 0;
  const ollSplit = eollMs > 0 || ocllMs > 0;
  const pllSplit = cpllMs > 0 || epllMs > 0;

  let cursor = f2lEndMs;
  if (ollSplit) {
    if (t_ms < cursor + eollMs) return 'eoll';
    cursor += eollMs;
    if (t_ms < cursor + ocllMs) return 'ocll';
    cursor += ocllMs;
  } else {
    const ollMs = p.oll ?? 0;
    if (t_ms < cursor + ollMs) return 'oll';
    cursor += ollMs;
  }
  if (pllSplit) {
    if (t_ms < cursor + cpllMs) return 'cpll';
    cursor += cpllMs;
    if (t_ms < cursor + epllMs) return 'epll';
    cursor += epllMs;
  } else {
    const pllMs = p.pll ?? 0;
    if (t_ms < cursor + pllMs) return 'pll';
    cursor += pllMs;
  }
  return 'solved';
}

// Re-expand a stored (collapsed) solution into per-physical-move tokens.
// Each half-turn token (e.g. "R2") expands to two quarter-turns so the
// length matches r.turns. The direction of the original physical pair
// is ambiguous (R+R vs R'+R' both collapse to R2 at save time); we emit
// the un-primed quarter-turn for both, which is approximate but keeps
// the move column readable and aligned to the timing column.
export function expandSolution(solution: string): string[] {
  const tokens = solution.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const t of tokens) {
    if (t.endsWith('2')) {
      const base = t.slice(0, -1);
      out.push(base);
      out.push(base);
    } else {
      out.push(t);
    }
  }
  return out;
}

function csvEscape(s: string): string {
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Build the CSV rows for a single solve. Rows are emitted in the order
// the user lived them: scramble moves → optional inspection row →
// optional auto-expire `start` row → solve moves → solved row.
export function solveToCsvRows(r: SolveRecord): string[][] {
  const rows: string[][] = [];

  // Scramble moves.
  for (const m of r.scramble.split(/\s+/).filter(Boolean)) {
    rows.push(['', m, 'scramble']);
  }

  // Inspection row — only when we captured the duration. Old records
  // (pre-inspection-capture feature) omit it; the CSV jumps straight
  // from scramble to first move.
  if (typeof r.inspectionMs === 'number' && r.inspectionMs > 0) {
    rows.push([(-(r.inspectionMs / 1000)).toFixed(3), '', 'inspection']);
  }

  // Auto-expire start row — only when the inspection countdown actually
  // ran out (not when the user started early by making a move).
  if (r.inspectionAutoExpired) {
    rows.push(['0.000', '', 'start']);
  }

  // Solve moves. Use r.turns for accurate per-physical-move timing;
  // expand the collapsed solution to recover per-physical-move tokens.
  const turns = r.turns ?? [];
  const moves = expandSolution(r.solution);
  const moveCount = Math.min(turns.length, moves.length);
  for (let i = 0; i < moveCount; i++) {
    const t_sec = turns[i];
    rows.push([t_sec.toFixed(3), moves[i], phaseAtMs(r, t_sec * 1000)]);
  }

  // Aborted solves get an explicit `abort` terminator because no move
  // row marks the end. Completed solves need no terminator — the final
  // solving move IS the cube reaching the solved state. Explicit
  // aborts include their ms-from-start timestamp; records that are
  // merely incomplete (e.g., imported from a future version or
  // corrupted partial state) leave the timestamp blank.
  if (r.aborted) {
    const ts = typeof r.abortedAtMs === 'number'
      ? (r.abortedAtMs / 1000).toFixed(3)
      : '';
    rows.push([ts, '', 'abort']);
  }

  return rows;
}

// Serialise rows to CSV text.
export function rowsToCsv(rows: string[][]): string {
  return rows.map(row => row.map(csvEscape).join(',')).join('\n');
}

// Build the full history CSV: one header row, then each solve's rows
// concatenated back-to-back. Each solve ends with a `solved` or `abort`
// row, so the next solve's `scramble` row marks the boundary.
export function historyToCsv(records: SolveRecord[]): string {
  const out: string[][] = [['timestamp', 'move', 'phase']];
  for (const r of records) {
    for (const row of solveToCsvRows(r)) out.push(row);
  }
  return rowsToCsv(out);
}
