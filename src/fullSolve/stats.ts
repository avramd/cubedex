// WCA-style trim-mean Ao_n: drop the best AND worst time, average the rest.
// Returns `null` for the first n-1 entries (insufficient data to compute
// the window) and for the no-trimmed-data degenerate case (n < 3, where
// dropping best+worst would leave nothing).
export function rollingAverage(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i + 1 < n) { out.push(null); continue; }
    const window = values.slice(i + 1 - n, i + 1).slice().sort((a, b) => a - b);
    const trimmed = window.slice(1, -1);
    if (trimmed.length === 0) { out.push(null); continue; }
    out.push(trimmed.reduce((s, v) => s + v, 0) / trimmed.length);
  }
  return out;
}

// Population mean and (population) standard deviation. Used to compute
// the "clip at mean ± 1σ / 2σ" y-axis cap on the history graph.
export function meanAndSd(values: number[]): { mean: number; sd: number } {
  if (values.length === 0) return { mean: 0, sd: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  return { mean, sd };
}
