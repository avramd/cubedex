// Local random-move scrambler. Avoids consecutive same-face turns to skip
// trivial cancellations. Not random-state (true uniform distribution
// requires a Kociemba-style solver, which cubing.js runs in a Worker —
// avoided here because Vite's worker bundle pulls in DOM-touching code
// from the main app and crashes with "document is not defined").
export function generateRandomScramble3x3(length = 25): string {
  const faces = ['U', 'D', 'L', 'R', 'F', 'B'];
  const suffixes = ['', "'", '2'];
  const moves: string[] = [];
  let prevFace = '';
  for (let i = 0; i < length; i++) {
    let face: string;
    do { face = faces[Math.floor(Math.random() * 6)]; } while (face === prevFace);
    moves.push(face + suffixes[Math.floor(Math.random() * 3)]);
    prevFace = face;
  }
  return moves.join(' ');
}
