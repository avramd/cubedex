import { describe, it, expect } from 'vitest';
import { formatShareText, parseShareText } from './share';

describe('formatShareText', () => {
  it('emits the 3-line magic-header format when no turns', () => {
    const out = formatShareText({ scramble: "R U R' U'", solution: "R U R'" });
    expect(out).toBe("🧩 Cubedex solve\nScramble: R U R' U'\nSolution: R U R'");
  });

  it('appends a Turns: line when turns are provided', () => {
    const out = formatShareText({
      scramble: 'R',
      solution: 'U',
      turns: [0.001, 1.5, 2],
    });
    expect(out).toBe("🧩 Cubedex solve\nScramble: R\nSolution: U\nTurns: 0.001 1.5 2");
  });

  it('omits Turns when the array is empty', () => {
    const out = formatShareText({ scramble: 'R', solution: 'U', turns: [] });
    expect(out).not.toContain('Turns:');
  });
});

describe('parseShareText', () => {
  it('round-trips a formatted share without turns', () => {
    const original = { scramble: "F R U R' U' F'", solution: "R U R' U' R U R'" };
    expect(parseShareText(formatShareText(original))).toEqual(original);
  });

  it('round-trips a formatted share WITH turns', () => {
    const original = { scramble: 'R', solution: 'U', turns: [0.001, 1.5, 2] };
    expect(parseShareText(formatShareText(original))).toEqual(original);
  });

  it('tolerates leading + trailing whitespace and CRLF line endings', () => {
    const text = "\r\n\r\n🧩 Cubedex solve\r\nScramble: R U\r\nSolution: U R\r\n\r\n";
    expect(parseShareText(text)).toEqual({ scramble: 'R U', solution: 'U R' });
  });

  it('ignores extra trailing lines', () => {
    const text = "🧩 Cubedex solve\nScramble: R\nSolution: R'\n— from Avram, nice solve!";
    expect(parseShareText(text)).toEqual({ scramble: 'R', solution: "R'" });
  });

  it('returns null when the magic header is missing', () => {
    expect(parseShareText("Scramble: R\nSolution: R'")).toBeNull();
  });

  it('returns null when scramble line is missing', () => {
    expect(parseShareText("🧩 Cubedex solve\nSolution: R'")).toBeNull();
  });

  it('returns null when solution line is missing', () => {
    expect(parseShareText("🧩 Cubedex solve\nScramble: R")).toBeNull();
  });

  it('returns null when either side is empty', () => {
    expect(parseShareText("🧩 Cubedex solve\nScramble: \nSolution: R'")).toBeNull();
    expect(parseShareText("🧩 Cubedex solve\nScramble: R\nSolution: ")).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(parseShareText('')).toBeNull();
  });

  it('rejects arbitrary text that happens to contain Scramble:', () => {
    expect(parseShareText('Scramble: R\nSolution: R')).toBeNull();
  });

  it('drops malformed turns silently', () => {
    const result = parseShareText("🧩 Cubedex solve\nScramble: R\nSolution: U\nTurns: 0.1 bad 1.0");
    expect(result).toEqual({ scramble: 'R', solution: 'U' });
  });
});
