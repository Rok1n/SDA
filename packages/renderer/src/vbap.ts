/**
 * 3D Vector Base Amplitude Panning (Pulkki 1997), the same family of
 * algorithm Omniphony's liborender uses on the desktop.
 *
 * For a layout of N virtual speakers we precompute every speaker triplet
 * (with 2-speaker layouts, pairs). Panning a source at unit vector p:
 * find a triplet whose inverse basis gives all-nonnegative gains
 *   g = L⁻¹ · p,  gᵢ ≥ 0,  then normalise ‖g‖ = 1.
 *
 * Object `size` (spatial extent) is handled by spreading: the VBAP vector
 * is cross-faded toward a diffuse distribution over the nearest speakers.
 */

import type { Spherical } from "./coords.js";
import type { VirtualSpeaker } from "./layouts.js";
import { sphericalToAdm } from "./coords.js";

type Vec3 = [number, number, number];

function unit(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

function det3(m: number[][]): number {
  return (
    m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) -
    m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) +
    m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!)
  );
}

function inv3(m: number[][]): number[][] | null {
  const d = det3(m);
  if (Math.abs(d) < 1e-9) return null;
  const [a, b, c] = m[0] as [number, number, number];
  const [e, f, g] = m[1] as [number, number, number];
  const [h, i, j] = m[2] as [number, number, number];
  return [
    [(f * j - g * i) / d, -(b * j - c * i) / d, (b * g - c * f) / d],
    [-(e * j - g * h) / d, (a * j - c * h) / d, -(a * g - c * e) / d],
    [(e * i - f * h) / d, -(a * i - b * h) / d, (a * f - b * e) / d],
  ];
}

interface Triplet {
  speakers: [number, number, number];
  invBasis: number[][];
}

interface Pair {
  speakers: [number, number];
  /** 2×2 逆基（ADM x/y 水平面）。 */
  inv2: number[];
}

export class VbapSolver {
  readonly speakerCount: number;
  /** Speaker unit vectors in ADM cartesian. */
  private dirs: Vec3[];
  private lfeMask: boolean[];
  private triplets: Triplet[] = [];
  /** 纯水平布局（无顶箱，全部共面）时使用相邻声像对做 2D VBAP。 */
  private pairs: Pair[] = [];

  constructor(layout: readonly VirtualSpeaker[]) {
    this.speakerCount = layout.length;
    this.dirs = layout.map((s) => unit(sphericalToAdm(s)));
    this.lfeMask = layout.map((s) => s.isLfe === true);

    const n = layout.length;
    const coplanar = this.dirs.every((d) => Math.abs(d[2]) < 1e-3);

    if (coplanar) {
      // 2D VBAP：按方位角排序后相邻两只音箱成对（环绕一周）。
      const order = layout
        .map((s, i) => ({ az: s.azimuth, i }))
        .filter((o) => !this.lfeMask[o.i])
        .sort((a, b) => a.az - b.az);
      const m = order.length;
      for (let k = 0; k < m; k++) {
        const a = order[k]!.i;
        const b = order[(k + 1) % m]!.i;
        const [ax, ay] = [this.dirs[a]![0], this.dirs[a]![1]];
        const [bx, by] = [this.dirs[b]![0], this.dirs[b]![1]];
        const det = ax * by - bx * ay;
        if (Math.abs(det) < 1e-9) continue;
        this.pairs.push({
          speakers: [a, b],
          inv2: [by / det, -bx / det, -ay / det, ax / det],
        });
      }
      return;
    }

    for (let i = 0; i < n; i++) {
      if (this.lfeMask[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (this.lfeMask[j]) continue;
        for (let k = j + 1; k < n; k++) {
          if (this.lfeMask[k]) continue;
          // Only retain faces of the speaker-direction convex hull. Arbitrary
          // triplets can span the dome and route an elevated source through
          // unrelated floor speakers.
          const a = this.dirs[i]!;
          const b = this.dirs[j]!;
          const c = this.dirs[k]!;
          const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
          const normal: Vec3 = [
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0],
          ];
          const plane = normal[0] * a[0] + normal[1] * a[1] + normal[2] * a[2];
          if (Math.abs(plane) < 1e-9) continue; // Horizontal floor-ring base.

          let hasPositive = false;
          let hasNegative = false;
          for (let q = 0; q < n; q++) {
            if (q === i || q === j || q === k || this.lfeMask[q]) continue;
            const d = this.dirs[q]!;
            const side = normal[0] * d[0] + normal[1] * d[1] + normal[2] * d[2] - plane;
            if (side > 1e-7) hasPositive = true;
            if (side < -1e-7) hasNegative = true;
          }
          if (hasPositive && hasNegative) continue;

          // Basis columns are speaker unit vectors.
          const basis = [
            [a[0], b[0], c[0]],
            [a[1], b[1], c[1]],
            [a[2], b[2], c[2]],
          ];
          const invBasis = inv3(basis);
          if (invBasis) this.triplets.push({ speakers: [i, j, k], invBasis });
        }
      }
    }
  }

  /**
   * Gain vector over all speakers for a source at `pos` with scalar
   * `spread` ∈ [0, 1] (0 = point source, 1 = fully diffuse).
   * LFE always gets 0 — low-frequency content is routed by the bed, not panned.
   */
  pan(pos: Spherical, spread = 0): Float32Array {
    const gains = new Float32Array(this.speakerCount);
    const p = unit(sphericalToAdm(pos));

    if (this.pairs.length > 0) {
      // 2D VBAP：把声源投影到水平面，选增益全为正的相邻对。
      const pn = Math.hypot(p[0], p[1]) || 1;
      const px = p[0] / pn;
      const py = p[1] / pn;
      let bestPair: { g: [number, number]; pair: Pair; minGain: number } | null = null;
      for (const pair of this.pairs) {
        const [a, b, c, d] = pair.inv2 as [number, number, number, number];
        const g: [number, number] = [a * px + b * py, c * px + d * py];
        const minGain = Math.min(g[0], g[1]);
        if (minGain >= -1e-4 && (!bestPair || minGain > bestPair.minGain)) {
          bestPair = { g, pair, minGain };
        }
      }
      if (bestPair) {
        gains[bestPair.pair.speakers[0]] = Math.max(0, bestPair.g[0]);
        gains[bestPair.pair.speakers[1]] = Math.max(0, bestPair.g[1]);
      } else {
        let bestIdx = 0;
        let bestDot = -Infinity;
        for (let i = 0; i < this.speakerCount; i++) {
          if (this.lfeMask[i]) continue;
          const d = this.dirs[i]![0] * px + this.dirs[i]![1] * py;
          if (d > bestDot) {
            bestDot = d;
            bestIdx = i;
          }
        }
        gains[bestIdx] = 1;
      }
    } else {
    let best: { g: [number, number, number]; t: Triplet; minGain: number } | null = null;
    for (const t of this.triplets) {
      const m = t.invBasis;
      const g: [number, number, number] = [
        m[0]![0]! * p[0] + m[0]![1]! * p[1] + m[0]![2]! * p[2],
        m[1]![0]! * p[0] + m[1]![1]! * p[1] + m[1]![2]! * p[2],
        m[2]![0]! * p[0] + m[2]![1]! * p[1] + m[2]![2]! * p[2],
      ];
      const minGain = Math.min(g[0], g[1], g[2]);
      // Prefer the triplet whose smallest gain is largest (most centred).
      if (minGain >= -1e-4 && (!best || minGain > best.minGain)) {
        best = { g, t, minGain };
      }
    }

    if (best) {
      const { g, t } = best;
      for (let s = 0; s < 3; s++) {
        gains[t.speakers[s]!] = Math.max(0, g[s]!);
      }
    } else {
      // Degenerate layout fallback: nearest speaker wins.
      let bestIdx = 0;
      let bestDot = -Infinity;
      for (let i = 0; i < this.speakerCount; i++) {
        if (this.lfeMask[i]) continue;
        const d = this.dirs[i]![0] * p[0] + this.dirs[i]![1] * p[1] + this.dirs[i]![2] * p[2];
        if (d > bestDot) {
          bestDot = d;
          bestIdx = i;
        }
      }
      gains[bestIdx] = 1;
    }
    }

    // Power normalise.
    let power = 0;
    for (const g of gains) power += g * g;
    const norm = power > 0 ? 1 / Math.sqrt(power) : 0;
    for (let i = 0; i < gains.length; i++) gains[i]! *= norm;

    // Spread remains local to the source direction. A global diffuse blend
    // energizes every virtual speaker and makes an enlarged object lose its
    // position after the per-bus HRTF convolutions.
    if (spread > 0) {
      const s = Math.min(1, spread);
      const nearestIndices = [-1, -1, -1, -1];
      const nearestDots = [-Infinity, -Infinity, -Infinity, -Infinity];
      for (let i = 0; i < this.speakerCount; i++) {
        if (this.lfeMask[i]) continue;
        const d = this.dirs[i]!;
        const dot = d[0] * p[0] + d[1] * p[1] + d[2] * p[2];
        for (let rank = 0; rank < nearestDots.length; rank++) {
          if (dot <= nearestDots[rank]!) continue;
          for (let move = nearestDots.length - 1; move > rank; move--) {
            nearestDots[move] = nearestDots[move - 1]!;
            nearestIndices[move] = nearestIndices[move - 1]!;
          }
          nearestDots[rank] = dot;
          nearestIndices[rank] = i;
          break;
        }
      }
      const nearestCount = nearestIndices.reduce((count, index) => count + (index >= 0 ? 1 : 0), 0);
      const local = new Float32Array(this.speakerCount);
      const diffuse = 1 / Math.sqrt(nearestCount || 1);
      for (const index of nearestIndices) {
        if (index >= 0) local[index] = diffuse;
      }
      for (let i = 0; i < gains.length; i++) gains[i] = (1 - s) * gains[i]! + s * local[i]!;

      let spreadPower = 0;
      for (const g of gains) spreadPower += g * g;
      const spreadNorm = spreadPower > 0 ? 1 / Math.sqrt(spreadPower) : 0;
      for (let i = 0; i < gains.length; i++) gains[i]! *= spreadNorm;
    }
    return gains;
  }
}
