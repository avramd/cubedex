import { describe, expect, it } from 'vitest';
import {
  type Face, FACE_OFFSET, FACES, OPPOSITE,
  faceStickers, isFaceMono, isSolved,
} from './facelets';

// Standard 6-color solved cube using Kociemba sticker letters: face IDs
// (U/R/F/D/L/B) double as the colors of those faces. Each face is 9
// stickers, in URFDLB order — 54 chars total.
const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';

// Replace a single sticker on `face` at `index` (0..8) with `to`.
function mutate(facelets: string, face: Face, index: number, to: string): string {
  const o = FACE_OFFSET[face] + index;
  return facelets.slice(0, o) + to + facelets.slice(o + 1);
}

describe('FACE_OFFSET', () => {
  it('lays out URFDLB at 9-sticker boundaries', () => {
    expect(FACE_OFFSET).toEqual({ U: 0, R: 9, F: 18, D: 27, L: 36, B: 45 });
  });
});

describe('FACES / OPPOSITE', () => {
  it('covers every face exactly once', () => {
    expect([...FACES].sort().join('')).toBe('BDFLRU');
  });

  it('OPPOSITE is an involution', () => {
    for (const f of FACES) expect(OPPOSITE[OPPOSITE[f]]).toBe(f);
  });

  it('opposite pairs are U/D, F/B, R/L', () => {
    expect(OPPOSITE.U).toBe('D');
    expect(OPPOSITE.F).toBe('B');
    expect(OPPOSITE.R).toBe('L');
  });
});

describe('faceStickers', () => {
  it('returns the 9 stickers of the requested face', () => {
    expect(faceStickers(SOLVED, 'U')).toEqual(['U','U','U','U','U','U','U','U','U']);
    expect(faceStickers(SOLVED, 'B')).toEqual(['B','B','B','B','B','B','B','B','B']);
  });

  it('reads from the correct offset', () => {
    const mixed = mutate(SOLVED, 'F', 4, 'X');
    expect(faceStickers(mixed, 'F')[4]).toBe('X');
    expect(faceStickers(mixed, 'U')[4]).toBe('U'); // unaffected
  });
});

describe('isFaceMono', () => {
  it('true on a solved face', () => {
    for (const f of FACES) expect(isFaceMono(SOLVED, f)).toBe(true);
  });

  it('false when one sticker differs from the center', () => {
    expect(isFaceMono(mutate(SOLVED, 'U', 0, 'X'), 'U')).toBe(false);
    expect(isFaceMono(mutate(SOLVED, 'U', 4, 'X'), 'U')).toBe(false); // center
    expect(isFaceMono(mutate(SOLVED, 'U', 8, 'X'), 'U')).toBe(false);
  });

  it('only checks the requested face', () => {
    const m = mutate(SOLVED, 'R', 0, 'X');
    expect(isFaceMono(m, 'R')).toBe(false);
    expect(isFaceMono(m, 'U')).toBe(true);
  });
});

describe('isSolved', () => {
  it('true on the canonical solved string', () => {
    expect(isSolved(SOLVED)).toBe(true);
  });

  it('false if any single sticker is wrong', () => {
    expect(isSolved(mutate(SOLVED, 'F', 7, 'X'))).toBe(false);
  });
});
