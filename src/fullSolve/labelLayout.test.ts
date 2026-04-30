import { describe, expect, it } from 'vitest';
import { placeLabelsAvoidOverlap, remapClippedTargets } from './labelLayout';

describe('placeLabelsAvoidOverlap', () => {
  it('returns an empty array for an empty input', () => {
    expect(placeLabelsAvoidOverlap([], 10)).toEqual([]);
  });

  it('passes through a single point unchanged', () => {
    expect(placeLabelsAvoidOverlap([42], 10)).toEqual([42]);
  });

  it('leaves well-spaced points unchanged', () => {
    // 3 points, spacing 10, gaps of 20 between them — no overlap, no shift.
    expect(placeLabelsAvoidOverlap([0, 20, 40], 10)).toEqual([0, 20, 40]);
  });

  it('preserves output-position correspondence to input order', () => {
    // Input [40, 0, 20] should still return [posOf40, posOf0, posOf20].
    const out = placeLabelsAvoidOverlap([40, 0, 20], 10);
    expect(out).toHaveLength(3);
    // Sorted ascending and well-spaced, so output equals input here.
    expect(out).toEqual([40, 0, 20]);
  });

  it('spreads two coincident points symmetrically around their original y', () => {
    // Both targets at 100 — output should be 100 ± 5.
    const out = placeLabelsAvoidOverlap([100, 100], 10);
    expect(out).toHaveLength(2);
    const sorted = out.slice().sort((a, b) => a - b);
    expect(sorted[1] - sorted[0]).toBe(10);     // exactly minSpacing apart
    expect((sorted[0] + sorted[1]) / 2).toBe(100); // centered on original
  });

  it('spreads three close clustered points evenly with spacing', () => {
    const out = placeLabelsAvoidOverlap([100, 100, 100], 10);
    const sorted = out.slice().sort((a, b) => a - b);
    expect(sorted[1] - sorted[0]).toBeCloseTo(10, 9);
    expect(sorted[2] - sorted[1]).toBeCloseTo(10, 9);
    // Centered on the centroid of original positions.
    expect((sorted[0] + sorted[2]) / 2).toBeCloseTo(100, 9);
  });

  it('keeps clusters with non-overlapping ones unaffected', () => {
    // [50, 50] cluster + a singleton at 200, spacing 10. Cluster spreads to
    // [45, 55]; singleton stays at 200.
    const out = placeLabelsAvoidOverlap([50, 50, 200], 10);
    const sortedFirstTwo = [out[0], out[1]].sort((a, b) => a - b);
    expect(sortedFirstTwo).toEqual([45, 55]);
    expect(out[2]).toBe(200);
  });

  it('merges adjacent clusters that would overlap after spreading', () => {
    // [10, 10, 12, 14] with spacing 10. All four overlap → one merged
    // cluster of size 4 spread at spacing 10, centered on the centroid of
    // (10, 10, 12, 14) − (0, 1, 2, 3) × 10 = (10, 0, -8, -16); centroid p
    // = (max+min)/2 of these d's = (10 + -16)/2 = -3, so output =
    // [-3, 7, 17, 27]. Verify: spacing preserved and order preserved.
    const out = placeLabelsAvoidOverlap([10, 10, 12, 14], 10);
    expect(out).toEqual([-3, 7, 17, 27]);
  });
});

describe('remapClippedTargets', () => {
  it('returns input untouched when nothing is clipped', () => {
    const ys = [50, 100, 150];
    expect(remapClippedTargets(ys, 0, 8, 16)).toEqual([50, 100, 150]);
  });

  it('does not mutate the input array', () => {
    const ys = [-10, 50];
    const out = remapClippedTargets(ys, 0, 8, 16);
    expect(ys).toEqual([-10, 50]); // unchanged
    expect(out).not.toEqual(ys);
  });

  it('moves a single clipped entry to chartTop + pillHalf', () => {
    // chartTop 100, pillHalf 8 → clipMin = 108. Single clipped item.
    const out = remapClippedTargets([50], 100, 8, 16);
    expect(out).toEqual([108]);
  });

  it('stacks multiple clipped entries at top in original-y ascending order', () => {
    // 3 clipped entries with original y -50, -30, -10. Topmost (smallest y)
    // gets rank 0. clipMin = 100 + 8 = 108, spacing 16.
    //   rank 0 → 108     (the original -50)
    //   rank 1 → 124     (the original -30)
    //   rank 2 → 140     (the original -10)
    const out = remapClippedTargets([-50, -30, -10], 100, 8, 16);
    expect(out).toEqual([108, 124, 140]);
  });

  it('preserves natural y for unclipped entries while stacking only the clipped ones', () => {
    // Entries with y = [-50, 200, -10]. chartTop 100. Clipped: indices 0 and 2.
    // Sorted by y: 0 (-50) gets rank 0 → 108; 2 (-10) gets rank 1 → 124.
    // Index 1 (200) is unclipped → stays at 200.
    const out = remapClippedTargets([-50, 200, -10], 100, 8, 16);
    expect(out).toEqual([108, 200, 124]);
  });

  it('treats y = chartTop as not-clipped (boundary semantics)', () => {
    const out = remapClippedTargets([100, 99], 100, 8, 16);
    // 100 is not below chartTop (strict <), so unchanged.
    // 99 is below, gets clipMin = 108.
    expect(out).toEqual([100, 108]);
  });
});
