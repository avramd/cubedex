// Pure pass-1 classifier for the past-solves expanded view. Walks runs of
// same-face moves and decides, for each storage move, whether it should
// render struck-through, and whether to append an italic "equivalent
// turn" replacement after a same-face group.
//
// Self-replacement: if a same-face group's net rotation already matches
// one of its own moves, that move stays real (the LAST occurrence wins,
// to keep cancelled moves visually contiguous on the left of the chunk),
// and the rest in the group are struck. Otherwise the whole group is
// struck and an italic replacement is appended after the last move.

import { getFace, sumQuarters } from './moves';

export type Render = { strike: boolean; replacement: string | null };

export function classifyMoves(moves: string[]): Render[] {
  const renders: Render[] = moves.map(() => ({ strike: false, replacement: null }));

  let i = 0;
  while (i < moves.length) {
    const face = getFace(moves[i]);
    let j = i;
    while (j < moves.length && getFace(moves[j]) === face) j++;
    if (j - i >= 2) {
      const groupMoves = moves.slice(i, j);
      const netCount = sumQuarters(groupMoves);
      const netMove = netCount === 1 ? face
                    : netCount === 2 ? face + '2'
                    : netCount === 3 ? face + "'"
                    : null;

      let keepAt = -1;
      if (netMove !== null) {
        for (let k = j - 1; k >= i; k--) {
          if (moves[k] === netMove) { keepAt = k; break; }
        }
      }

      if (keepAt >= 0) {
        for (let k = i; k < j; k++) {
          if (k !== keepAt) renders[k].strike = true;
        }
      } else {
        for (let k = i; k < j; k++) renders[k].strike = true;
        if (netMove !== null) renders[j - 1].replacement = netMove;
      }
    }
    i = j;
  }

  return renders;
}
