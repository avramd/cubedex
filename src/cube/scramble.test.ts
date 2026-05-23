import { describe, expect, it } from 'vitest';
import { generateRandomScramble3x3 } from './scramble';

describe('generateRandomScramble3x3', () => {
  it('produces 20 moves by default (5 turn-groups of 4)', () => {
    const moves = generateRandomScramble3x3().split(/\s+/);
    expect(moves).toHaveLength(20);
  });

  it('honors the requested length', () => {
    expect(generateRandomScramble3x3(10).split(/\s+/)).toHaveLength(10);
    expect(generateRandomScramble3x3(40).split(/\s+/)).toHaveLength(40);
  });

  it('returns the empty string for length 0', () => {
    expect(generateRandomScramble3x3(0)).toBe('');
  });

  it('every move has shape <face><suffix?> with face in U/D/L/R/F/B', () => {
    const moves = generateRandomScramble3x3(50).split(/\s+/);
    for (const m of moves) {
      expect(m).toMatch(/^[UDLRFB]('|2)?$/);
    }
  });

  it('never emits two consecutive same-face moves', () => {
    // Run several scrambles to amplify the chance of catching a violation.
    for (let trial = 0; trial < 50; trial++) {
      const moves = generateRandomScramble3x3(50).split(/\s+/);
      for (let i = 1; i < moves.length; i++) {
        const prevFace = moves[i - 1].replace(/[^A-Za-z]/g, '');
        const face    = moves[i].replace(/[^A-Za-z]/g, '');
        expect(face, `move ${i}: ${moves[i - 1]} ${moves[i]}`).not.toBe(prevFace);
      }
    }
  });

  it('uses all 6 faces over a long scramble (sanity)', () => {
    const moves = generateRandomScramble3x3(200).split(/\s+/);
    const faces = new Set(moves.map(m => m.replace(/[^A-Za-z]/g, '')));
    // With 200 moves and uniform sampling among 5 non-prev faces, all 6
    // faces should appear with probability >> 1 - 1e-6.
    expect(faces.size).toBe(6);
  });
});
