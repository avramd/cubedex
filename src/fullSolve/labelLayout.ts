// Vertical label layout for inline hover labels on the history graph.
// Pure function: given a list of target Y positions and a minimum spacing
// between labels, returns the adjusted Y for each label (preserving the
// input order's correspondence) such that no two labels overlap.
//
// Algorithm: each label starts as a size-1 cluster anchored at its target.
// Adjacent (sorted-by-Y) clusters that would overlap merge into a single
// cluster centered around the centroid of original positions, distributed
// at exactly `spacing` apart. Repeats until no more merges. Result is the
// Pool-Adjacent-Violators / partition-by-centroid solution to the 1D
// no-overlap layout problem.
export function placeLabelsAvoidOverlap(yTargets: number[], spacing: number): number[] {
  const n = yTargets.length;
  if (n === 0) return [];
  const indices = yTargets.map((_, i) => i).sort((a, b) => yTargets[a] - yTargets[b]);
  type Cluster = { ys: number[]; p: number; size: number };
  const clusters: Cluster[] = indices.map(i => ({ ys: [yTargets[i]], p: yTargets[i], size: 1 }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < clusters.length - 1; i++) {
      const a = clusters[i];
      const b = clusters[i + 1];
      // a occupies [a.p, a.p + (a.size - 1) * spacing]; require
      // b.p >= a.p + a.size * spacing for non-overlap.
      if (b.p < a.p + a.size * spacing) {
        const ys = a.ys.concat(b.ys);
        const size = a.size + b.size;
        let maxD = -Infinity, minD = Infinity;
        for (let r = 0; r < size; r++) {
          const d = ys[r] - r * spacing;
          if (d > maxD) maxD = d;
          if (d < minD) minD = d;
        }
        const p = (maxD + minD) / 2;
        clusters.splice(i, 2, { ys, p, size });
        merged = true;
        break;
      }
    }
  }
  const out = new Array<number>(n);
  let cursor = 0;
  for (const c of clusters) {
    for (let r = 0; r < c.size; r++) {
      out[indices[cursor + r]] = c.p + r * spacing;
    }
    cursor += c.size;
  }
  return out;
}

// For labels whose data point sits ABOVE the plot area (i.e., the solve's
// cumulative phase total exceeds the y-axis clip), produce a remapped
// target-y array where each clipped target is bumped to a fixed slot
// just inside the top of the chart, ranked by original stacking order
// (topmost phase = rank 0). Unclipped targets are returned unchanged so
// they stay anchored to their data points.
//
// `pointYs[i] < chartTop` is the clipped condition; clipped entries are
// sorted by their original y ascending and assigned slots
//   chartTop + pillHalf, chartTop + pillHalf + spacing, ...
//
// Pass the result to placeLabelsAvoidOverlap to resolve any collision
// between the bottom of the clipped stack and the top of the unclipped
// labels.
export function remapClippedTargets(
  pointYs: number[],
  chartTop: number,
  pillHalf: number,
  spacing: number,
): number[] {
  const targets = pointYs.slice();
  const clipMin = chartTop + pillHalf;
  const clippedIdxs: number[] = [];
  pointYs.forEach((y, i) => { if (y < chartTop) clippedIdxs.push(i); });
  clippedIdxs.sort((a, b) => pointYs[a] - pointYs[b]);
  clippedIdxs.forEach((idx, rank) => { targets[idx] = clipMin + rank * spacing; });
  return targets;
}
