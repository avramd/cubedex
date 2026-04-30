// Facelet string order (Kociemba): URFDLB, 9 stickers per face, each face
// in reading order:
//   0 1 2
//   3 4 5    (index 4 is the center)
//   6 7 8

export type Face = 'U' | 'R' | 'F' | 'D' | 'L' | 'B';

export const FACES: readonly Face[] = ['U', 'D', 'F', 'B', 'R', 'L'] as const;

export const FACE_OFFSET: Record<Face, number> = {
  U: 0, R: 9, F: 18, D: 27, L: 36, B: 45,
};

export const OPPOSITE: Record<Face, Face> = {
  U: 'D', D: 'U', F: 'B', B: 'F', R: 'L', L: 'R',
};

export function faceStickers(facelets: string, face: Face): string[] {
  const o = FACE_OFFSET[face];
  return facelets.slice(o, o + 9).split('');
}

export function isFaceMono(facelets: string, face: Face): boolean {
  const s = faceStickers(facelets, face);
  return s.every(c => c === s[4]);
}

export function isSolved(facelets: string): boolean {
  return (['U', 'R', 'F', 'D', 'L', 'B'] as const).every(f => isFaceMono(facelets, f));
}
