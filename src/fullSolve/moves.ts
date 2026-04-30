// Pure move-string helpers. Used both at storage time (collapsing pairs of
// quarter-turns into half-turns) and at display time (chunking, classing).

// Move-token typology. Used as a CSS class so the stylesheet can give
// .clock and .double a tiny right-padding when they aren't the last
// child of a .turn-group; .c-clock's apostrophe already provides its
// own visual separation, so it gets no padding.
export function moveClass(m: string): 'clock' | 'c-clock' | 'double' {
  if (m.endsWith('2')) return 'double';
  if (m.endsWith("'")) return 'c-clock';
  return 'clock';
}

// The face component of a move ("R", "Rw", "U", etc.) — i.e., everything
// before the optional "'" / "2" suffix. Same-face moves can be merged
// algebraically modulo 4 quarter-turns.
export function getFace(m: string): string {
  const match = m.match(/^[A-Za-z]+/);
  return match ? match[0] : m;
}

// Sum the quarter-turn count of a same-face move sequence, mod 4.
//   R = +1, R2 = +2, R' = -1
export function sumQuarters(moves: string[]): number {
  let n = 0;
  for (const m of moves) {
    if (m.endsWith('2')) n += 2;
    else if (m.endsWith("'")) n -= 1;
    else n += 1;
  }
  return ((n % 4) + 4) % 4;
}

// Collapse adjacent quarter-turn pairs of the same move into a single
// half-turn. Smartcubes report half-turns as two consecutive quarter-
// turn events (so a user U2 lands as ['U', 'U']) — collapsing gives a
// readable display without affecting how solves are stored. Already-
// collapsed half-turns and mixed pairs (e.g., R R') are left alone.
export function collapseDoubles(moves: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    if (i + 1 < moves.length && m === moves[i + 1] && !m.endsWith('2')) {
      // R + R = R2;  R' + R' = R2 (also written R'2 but R2 is canonical).
      const face = m.endsWith("'") ? m.slice(0, -1) : m;
      out.push(face + '2');
      i++; // skip the second of the pair
    } else {
      out.push(m);
    }
  }
  return out;
}
