// Clipboard share format for solves. Plain text with a magic header so
// the receiver can detect a share in arbitrary clipboard contents.
// Designed to survive copy-paste through chat apps (Slack, iMessage,
// email) without escaping or encoding.
//
// Format:
//   🧩 Cubedex solve
//   Scramble: <space-separated moves>
//   Solution: <space-separated moves>
//   Turns: <space-separated decimal seconds>      (optional)
//
// Extra trailing lines are tolerated on parse (the user can append
// their own annotations); CRLF line endings are normalised on parse.

const HEADER = '🧩 Cubedex solve';

export interface SolveShare {
  scramble: string;
  solution: string;
  // Per-move cumulative seconds-from-solve-start, parallel to the
  // solution's move sequence. Optional — the receiver can step through
  // the solve with or without timing data.
  turns?: number[];
}

export function formatShareText(share: SolveShare): string {
  const lines = [
    HEADER,
    `Scramble: ${share.scramble}`,
    `Solution: ${share.solution}`,
  ];
  if (share.turns && share.turns.length > 0) {
    // Three decimal places matches the existing solve-record turns
    // precision; trim trailing zeros so e.g. "1.000" → "1".
    lines.push('Turns: ' + share.turns.map(t => {
      const s = t.toFixed(3);
      return s.replace(/\.?0+$/, '') || '0';
    }).join(' '));
  }
  return lines.join('\n');
}

export function parseShareText(text: string): SolveShare | null {
  if (!text) return null;
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(l => l.trim());
  if (!lines.some(l => l === HEADER)) return null;
  const scrambleLine = lines.find(l => l.startsWith('Scramble:'));
  const solutionLine = lines.find(l => l.startsWith('Solution:'));
  if (!scrambleLine || !solutionLine) return null;
  const scramble = scrambleLine.slice('Scramble:'.length).trim();
  const solution = solutionLine.slice('Solution:'.length).trim();
  if (!scramble || !solution) return null;
  const out: SolveShare = { scramble, solution };
  const turnsLine = lines.find(l => l.startsWith('Turns:'));
  if (turnsLine) {
    const nums = turnsLine.slice('Turns:'.length).trim().split(/\s+/).filter(Boolean);
    const parsed = nums.map(n => Number(n));
    if (parsed.every(n => Number.isFinite(n))) out.turns = parsed;
  }
  return out;
}
