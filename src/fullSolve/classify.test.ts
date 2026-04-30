import { describe, expect, it } from 'vitest';
import { classifyMoves } from './classify';

describe('classifyMoves', () => {
  it('leaves single-move runs alone', () => {
    expect(classifyMoves(['R', 'U', 'F'])).toEqual([
      { strike: false, replacement: null },
      { strike: false, replacement: null },
      { strike: false, replacement: null },
    ]);
  });

  it('strikes a same-face cancellation pair (R R\') and adds no replacement', () => {
    // Net rotation = 0, no equivalent move to render.
    const r = classifyMoves(['R', "R'"]);
    expect(r[0].strike).toBe(true);
    expect(r[1].strike).toBe(true);
    expect(r[0].replacement).toBeNull();
    expect(r[1].replacement).toBeNull();
  });

  it('keeps a member of a same-face group whose net rotation already matches it (R R R, net = R\'-equivalent rank 3)', () => {
    // Three R's = net 3 quarter-turns clockwise = R'. None of the originals
    // is "R'", so all strike + replacement R' on the last move.
    const r = classifyMoves(['R', 'R', 'R']);
    expect(r.every(x => x.strike)).toBe(true);
    expect(r[2].replacement).toBe("R'");
    expect(r[0].replacement).toBeNull();
    expect(r[1].replacement).toBeNull();
  });

  it('self-replacement: U U\' U leaves the LAST U as real, strikes the rest, no italic', () => {
    // Net = 1 = U; the last U matches that net, so keep it.
    const r = classifyMoves(['U', "U'", 'U']);
    expect(r[0].strike).toBe(true);
    expect(r[1].strike).toBe(true);
    expect(r[2].strike).toBe(false);
    expect(r[2].replacement).toBeNull();
  });

  it('chooses the LAST occurrence as the keep-target when multiple match', () => {
    // R R2 R: net 1+2+1 = 4 mod 4 = 0 → not 1/2/3, so no self-replacement.
    // Use R R R R R (5 = 1) — net = R; keep the last R.
    const r = classifyMoves(['R', 'R', 'R', 'R', 'R']);
    expect(r[0].strike).toBe(true);
    expect(r[1].strike).toBe(true);
    expect(r[2].strike).toBe(true);
    expect(r[3].strike).toBe(true);
    expect(r[4].strike).toBe(false); // last R survives
    expect(r[4].replacement).toBeNull();
  });

  it('groups end at the first non-same-face move (R U R does NOT count as a same-face group)', () => {
    expect(classifyMoves(['R', 'U', 'R'])).toEqual([
      { strike: false, replacement: null },
      { strike: false, replacement: null },
      { strike: false, replacement: null },
    ]);
  });

  it('handles back-to-back groups separately', () => {
    // First group: U U → R2 in net. Equivalent move is U2; no original is U2,
    // so strike + replacement.
    // Second group: R R' → net 0, strike + no replacement.
    const r = classifyMoves(['U', 'U', 'R', "R'"]);
    expect(r[0].strike).toBe(true);
    expect(r[1].strike).toBe(true);
    expect(r[1].replacement).toBe('U2');
    expect(r[2].strike).toBe(true);
    expect(r[3].strike).toBe(true);
    expect(r[3].replacement).toBeNull();
  });

  it('treats wide-turn faces as their own group key (R vs Rw do NOT merge)', () => {
    expect(classifyMoves(['R', 'Rw'])).toEqual([
      { strike: false, replacement: null },
      { strike: false, replacement: null },
    ]);
  });

  it('returns an empty array for an empty input', () => {
    expect(classifyMoves([])).toEqual([]);
  });
});
