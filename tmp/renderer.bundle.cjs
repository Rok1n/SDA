"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// packages/renderer/src/index.ts
var index_exports = {};
__export(index_exports, {
  BINAURAL_MODES: () => BINAURAL_MODES,
  HEADPHONE_COMPENSATION_PROFILES: () => HEADPHONE_COMPENSATION_PROFILES,
  LAYOUTS: () => LAYOUTS,
  LAYOUT_7_1_4: () => LAYOUT_7_1_4,
  SpatialRenderer: () => SpatialRenderer,
  VbapSolver: () => VbapSolver,
  admToSpherical: () => admToSpherical,
  aliasLabel: () => aliasLabel,
  buildBusIrs: () => buildBusIrs,
  detectLayoutId: () => detectLayoutId,
  getBinauralIrSet: () => getBinauralIrSet,
  getHeadphoneCompensationBuffers: () => getHeadphoneCompensationBuffers,
  headphoneProfileById: () => headphoneProfileById,
  isLfeLabel: () => isLfeLabel,
  mixIrForMode: () => mixIrForMode,
  physicalChannelOrder: () => physicalChannelOrder,
  positionForLabel: () => positionForLabel,
  sphericalToAdm: () => sphericalToAdm,
  sphericalToWebAudio: () => sphericalToWebAudio,
  validateHeadphoneProfile: () => validateHeadphoneProfile
});
module.exports = __toCommonJS(index_exports);

// packages/renderer/src/coords.ts
function admToSpherical(pos) {
  const [x, y, z] = pos;
  const distance = Math.min(4, Math.hypot(x, y, z));
  if (distance < 1e-6) return { azimuth: 0, elevation: 0, distance: 0 };
  return {
    // +az = 左 = cartesian X 负侧（EBU EAR: azimuth = -atan2(x, y)）
    azimuth: -Math.atan2(x, y) * 180 / Math.PI,
    elevation: Math.asin(Math.min(1, Math.max(-1, z / distance))) * 180 / Math.PI,
    distance
  };
}
function sphericalToAdm(s) {
  const az = s.azimuth * Math.PI / 180;
  const el = s.elevation * Math.PI / 180;
  const r = s.distance;
  return [-r * Math.cos(el) * Math.sin(az), r * Math.cos(el) * Math.cos(az), r * Math.sin(el)];
}
function sphericalToWebAudio(s) {
  const [x, y, z] = sphericalToAdm(s);
  return [x, z, -y];
}

// packages/renderer/src/layouts.ts
var FRONT = [
  { name: "FrontLeft", azimuth: 30, elevation: 0, distance: 1 },
  { name: "FrontRight", azimuth: -30, elevation: 0, distance: 1 },
  { name: "Center", azimuth: 0, elevation: 0, distance: 1 },
  { name: "LFE", azimuth: 45, elevation: 0, distance: 1, isLfe: true }
];
var SURROUND_5 = [
  { name: "SurroundLeft", azimuth: 110, elevation: 0, distance: 1 },
  { name: "SurroundRight", azimuth: -110, elevation: 0, distance: 1 }
];
var SURROUND_7 = [
  { name: "SurroundLeft", azimuth: 100, elevation: 0, distance: 1 },
  { name: "SurroundRight", azimuth: -100, elevation: 0, distance: 1 },
  { name: "RearLeft", azimuth: 140, elevation: 0, distance: 1 },
  { name: "RearRight", azimuth: -140, elevation: 0, distance: 1 }
];
var WIDE = [
  { name: "WideLeft", azimuth: 60, elevation: 0, distance: 1 },
  { name: "WideRight", azimuth: -60, elevation: 0, distance: 1 }
];
var TOP_FRONT = [
  { name: "TopFrontLeft", azimuth: 45, elevation: 45, distance: 1 },
  { name: "TopFrontRight", azimuth: -45, elevation: 45, distance: 1 }
];
var TOP_REAR = [
  { name: "TopRearLeft", azimuth: 135, elevation: 45, distance: 1 },
  { name: "TopRearRight", azimuth: -135, elevation: 45, distance: 1 }
];
var TOP_SIDE = [
  { name: "TopSideLeft", azimuth: 90, elevation: 45, distance: 1 },
  { name: "TopSideRight", azimuth: -90, elevation: 45, distance: 1 }
];
var BED_5_1 = [...FRONT, ...SURROUND_5];
var BED_7_1 = [...FRONT, ...SURROUND_7];
var BED_9_1 = [...FRONT, ...WIDE, ...SURROUND_7];
var LAYOUT_7_1_4 = [...BED_7_1, ...TOP_FRONT, ...TOP_REAR];
var LAYOUTS = {
  "5.1": BED_5_1,
  "5.1.2": [...BED_5_1, ...TOP_FRONT],
  "5.1.4": [...BED_5_1, ...TOP_FRONT, ...TOP_REAR],
  "7.1.2": [...BED_7_1, ...TOP_FRONT],
  "7.1.4": LAYOUT_7_1_4,
  "9.1.2": [...BED_9_1, ...TOP_FRONT],
  "9.1.4": [...BED_9_1, ...TOP_FRONT, ...TOP_REAR],
  "9.1.6": [...BED_9_1, ...TOP_FRONT, ...TOP_SIDE, ...TOP_REAR]
};
var LABEL_POSITIONS = {
  ...Object.fromEntries([...LAYOUTS["9.1.6"]].map((s) => [s.name, s])),
  // 6.1 后中置（eac3 channel_mode 4/5、dependent chanmap Cs 位）：正后方 180°，
  // 不属于任何布局的音箱，渲染时由 VBAP 平移到后环/环绕对之间。
  RearCenter: { azimuth: 180, elevation: 0, distance: 1 }
};
var LABEL_ALIASES = {
  // truehd ChannelLabel variants
  Left: "FrontLeft",
  Right: "FrontRight",
  Ls: "SurroundLeft",
  Rs: "SurroundRight",
  Lrs: "RearLeft",
  Rrs: "RearRight",
  Ltf: "TopFrontLeft",
  Rtf: "TopFrontRight",
  Ltr: "TopRearLeft",
  Rtr: "TopRearRight",
  // 顶侧（TrueHD 常写作 Ltm/Rtm "top middle"，ADM 写作 Tsl/Tsr）
  Lts: "TopSideLeft",
  Rts: "TopSideRight",
  Ltm: "TopSideLeft",
  Rtm: "TopSideRight",
  Tsl: "TopSideLeft",
  Tsr: "TopSideRight",
  Tfl: "TopFrontLeft",
  Tfr: "TopFrontRight",
  Trl: "TopRearLeft",
  Trr: "TopRearRight",
  Lfe: "LFE",
  LFE2: "LFE",
  // TrueHD / harletty 原生前宽标签（不可只依赖已经归一的 WideLeft/Right）。
  Lw: "WideLeft",
  Rw: "WideRight",
  // eac3 BedChannel Debug 全名（lfe_channel 通常单列 "LFE"，此处防御性覆盖）
  LowFrequencyEffects: "LFE",
  LowFrequencyEffects2: "LFE",
  // eac3/dca BedChannel variants
  SurroundLeftRear: "RearLeft",
  SurroundRightRear: "RearRight",
  RearLeftSurround: "RearLeft",
  RearRightSurround: "RearRight",
  TopSurroundLeft: "TopSideLeft",
  // eac3 BedChannel::TopSurround* = 顶侧
  TopSurroundRight: "TopSideRight",
  TopLeft: "TopFrontLeft",
  TopRight: "TopFrontRight",
  WideLeft: "WideLeft",
  // 9.1 前宽 ±60°
  WideRight: "WideRight",
  TopCenter: "TopFrontLeft",
  CenterSurround: "RearCenter",
  RearCenter: "RearCenter"
};
function positionForLabel(label) {
  const aliased = LABEL_ALIASES[label] ?? label;
  return LABEL_POSITIONS[aliased] ?? { azimuth: 0, elevation: 0, distance: 1 };
}
function aliasLabel(label) {
  return LABEL_ALIASES[label] ?? label;
}
function physicalChannelOrder(layout) {
  const PRIORITY = [
    "FrontLeft",
    "FrontRight",
    "Center",
    "LFE",
    "RearLeft",
    "RearRight",
    // WASAPI BL/BR 位
    "SurroundLeft",
    "SurroundRight",
    "WideLeft",
    "WideRight",
    "TopFrontLeft",
    "TopFrontRight",
    "TopSideLeft",
    "TopSideRight",
    "TopRearLeft",
    "TopRearRight"
  ];
  const order = PRIORITY.map((name) => layout.findIndex((s) => s.name === name)).filter(
    (i) => i >= 0
  );
  layout.forEach((_, i) => {
    if (!order.includes(i)) order.push(i);
  });
  return order;
}
function isLfeLabel(label) {
  const l = LABEL_ALIASES[label] ?? label;
  return l === "LFE" || label === "LFE2";
}
function detectLayoutId(labels, hasDynamics) {
  const names = new Set(
    labels.filter((l) => !isLfeLabel(l) && !l.startsWith("Obj_")).map((l) => LABEL_ALIASES[l] ?? l)
  );
  const has = (...ns) => ns.some((n) => names.has(n));
  let base = 5;
  if (has("WideLeft", "WideRight")) base = 9;
  else if (has("RearLeft", "RearRight") || names.has("RearCenter")) base = 7;
  let tops = 0;
  if (has("TopSideLeft", "TopSideRight")) tops = 6;
  else if (has("TopRearLeft", "TopRearRight")) tops = 4;
  else if (has("TopFrontLeft", "TopFrontRight")) tops = 2;
  if (hasDynamics) {
    if (base < 7) base = 7;
    if (tops < 4) tops = 4;
  }
  if (tops === 0) return base === 5 ? "5.1" : base === 7 ? "7.1.2" : "9.1.2";
  const id = `${base}.1.${tops}`;
  if (id in LAYOUTS) return id;
  return base === 9 ? "9.1.4" : `${base}.1.4`;
}

// packages/renderer/src/vbap.ts
function unit(v) {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}
function det3(m) {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}
function inv3(m) {
  const d = det3(m);
  if (Math.abs(d) < 1e-9) return null;
  const [a, b, c] = m[0];
  const [e, f, g] = m[1];
  const [h, i, j] = m[2];
  return [
    [(f * j - g * i) / d, -(b * j - c * i) / d, (b * g - c * f) / d],
    [-(e * j - g * h) / d, (a * j - c * h) / d, -(a * g - c * e) / d],
    [(e * i - f * h) / d, -(a * i - b * h) / d, (a * f - b * e) / d]
  ];
}
var VbapSolver = class {
  speakerCount;
  /** Speaker unit vectors in ADM cartesian. */
  dirs;
  lfeMask;
  triplets = [];
  /** 纯水平布局（无顶箱，全部共面）时使用相邻声像对做 2D VBAP。 */
  pairs = [];
  constructor(layout) {
    this.speakerCount = layout.length;
    this.dirs = layout.map((s) => unit(sphericalToAdm(s)));
    this.lfeMask = layout.map((s) => s.isLfe === true);
    const n = layout.length;
    const coplanar = this.dirs.every((d) => Math.abs(d[2]) < 1e-3);
    if (coplanar) {
      const order = layout.map((s, i) => ({ az: s.azimuth, i })).filter((o) => !this.lfeMask[o.i]).sort((a, b) => a.az - b.az);
      const m = order.length;
      for (let k = 0; k < m; k++) {
        const a = order[k].i;
        const b = order[(k + 1) % m].i;
        const [ax, ay] = [this.dirs[a][0], this.dirs[a][1]];
        const [bx, by] = [this.dirs[b][0], this.dirs[b][1]];
        const det = ax * by - bx * ay;
        if (Math.abs(det) < 1e-9) continue;
        this.pairs.push({
          speakers: [a, b],
          inv2: [by / det, -bx / det, -ay / det, ax / det]
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
          const a = this.dirs[i];
          const b = this.dirs[j];
          const c = this.dirs[k];
          const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
          const normal = [
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0]
          ];
          const plane = normal[0] * a[0] + normal[1] * a[1] + normal[2] * a[2];
          if (Math.abs(plane) < 1e-9) continue;
          let hasPositive = false;
          let hasNegative = false;
          for (let q = 0; q < n; q++) {
            if (q === i || q === j || q === k || this.lfeMask[q]) continue;
            const d = this.dirs[q];
            const side = normal[0] * d[0] + normal[1] * d[1] + normal[2] * d[2] - plane;
            if (side > 1e-7) hasPositive = true;
            if (side < -1e-7) hasNegative = true;
          }
          if (hasPositive && hasNegative) continue;
          const basis = [
            [a[0], b[0], c[0]],
            [a[1], b[1], c[1]],
            [a[2], b[2], c[2]]
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
  pan(pos, spread = 0) {
    const gains = new Float32Array(this.speakerCount);
    const p = unit(sphericalToAdm(pos));
    if (this.pairs.length > 0) {
      const pn = Math.hypot(p[0], p[1]) || 1;
      const px = p[0] / pn;
      const py = p[1] / pn;
      let bestPair = null;
      for (const pair of this.pairs) {
        const [a, b, c, d] = pair.inv2;
        const g = [a * px + b * py, c * px + d * py];
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
          const d = this.dirs[i][0] * px + this.dirs[i][1] * py;
          if (d > bestDot) {
            bestDot = d;
            bestIdx = i;
          }
        }
        gains[bestIdx] = 1;
      }
    } else {
      let best = null;
      for (const t of this.triplets) {
        const m = t.invBasis;
        const g = [
          m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2],
          m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2],
          m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2]
        ];
        const minGain = Math.min(g[0], g[1], g[2]);
        if (minGain >= -1e-4 && (!best || minGain > best.minGain)) {
          best = { g, t, minGain };
        }
      }
      if (best) {
        const { g, t } = best;
        for (let s = 0; s < 3; s++) {
          gains[t.speakers[s]] = Math.max(0, g[s]);
        }
      } else {
        let bestIdx = 0;
        let bestDot = -Infinity;
        for (let i = 0; i < this.speakerCount; i++) {
          if (this.lfeMask[i]) continue;
          const d = this.dirs[i][0] * p[0] + this.dirs[i][1] * p[1] + this.dirs[i][2] * p[2];
          if (d > bestDot) {
            bestDot = d;
            bestIdx = i;
          }
        }
        gains[bestIdx] = 1;
      }
    }
    let power = 0;
    for (const g of gains) power += g * g;
    const norm = power > 0 ? 1 / Math.sqrt(power) : 0;
    for (let i = 0; i < gains.length; i++) gains[i] *= norm;
    if (spread > 0) {
      const s = Math.min(1, spread);
      const nearest = this.dirs.map((d, i) => ({
        i,
        dot: this.lfeMask[i] ? -Infinity : d[0] * p[0] + d[1] * p[1] + d[2] * p[2]
      })).filter(({ dot }) => Number.isFinite(dot)).sort((a, b) => b.dot - a.dot).slice(0, Math.min(4, this.lfeMask.filter((l) => !l).length));
      const local = new Float32Array(this.speakerCount);
      const diffuse = 1 / Math.sqrt(nearest.length || 1);
      for (const { i } of nearest) local[i] = diffuse;
      for (let i = 0; i < gains.length; i++) gains[i] = (1 - s) * gains[i] + s * local[i];
      let spreadPower = 0;
      for (const g of gains) spreadPower += g * g;
      const spreadNorm = spreadPower > 0 ? 1 / Math.sqrt(spreadPower) : 0;
      for (let i = 0; i < gains.length; i++) gains[i] *= spreadNorm;
    }
    return gains;
  }
};

// packages/renderer/src/hrtf.ts
var BINAURAL_MODES = {
  // 默认只引入少量早期 BRIR 线索：帮助后方/顶层外化，又不让房间尾音掩盖对象。
  near: { wet: 0.04 },
  mid: { wet: 0.2 },
  far: { wet: 0.45 }
};
var setCache = /* @__PURE__ */ new Map();
function getBinauralIrSet(baseUrl) {
  let p = setCache.get(baseUrl);
  if (!p) {
    p = loadSet(baseUrl);
    p.catch(() => setCache.delete(baseUrl));
    setCache.set(baseUrl, p);
  }
  return p;
}
async function loadSet(baseUrl) {
  const res = await fetch(`${baseUrl}/hrtf-set.json`);
  if (!res.ok) throw new Error(`hrtf-set.json HTTP ${res.status}`);
  const manifest = await res.json();
  const positions = await Promise.all(
    manifest.positions.map(async (entry) => {
      const [dryBuf, wetBuf] = await Promise.all([
        fetch(`${baseUrl}/${entry.dry}`).then((r) => {
          if (!r.ok) throw new Error(`${entry.dry} HTTP ${r.status}`);
          return r.arrayBuffer();
        }),
        fetch(`${baseUrl}/${entry.wet}`).then((r) => {
          if (!r.ok) throw new Error(`${entry.wet} HTTP ${r.status}`);
          return r.arrayBuffer();
        })
      ]);
      const dry = new Float32Array(dryBuf);
      const wet = new Float32Array(wetBuf);
      return {
        azimuth: entry.azimuth,
        elevation: entry.elevation,
        dry,
        dryLen: dry.length >> 1,
        wet,
        wetLen: wet.length >> 1
      };
    })
  );
  return { sampleRate: manifest.sampleRate, positions };
}
function toUnit(azimuth, elevation) {
  const az = azimuth * Math.PI / 180;
  const el = elevation * Math.PI / 180;
  return [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];
}
function nearestPosition(set, azimuth, elevation) {
  const [tx, ty, tz] = toUnit(azimuth, elevation);
  let best = null;
  let bestDot = -2;
  for (const p of set.positions) {
    const [x, y, z] = toUnit(p.azimuth, p.elevation);
    const dot = tx * x + ty * y + tz * z;
    if (dot > bestDot) {
      bestDot = dot;
      best = p;
    }
  }
  return best;
}
function resampleLinear(ir, fromRate, toRate) {
  if (Math.abs(fromRate - toRate) < 1) return ir;
  const ratio = fromRate / toRate;
  const outLen = Math.round(ir.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = ir[i0] ?? 0;
    const b = ir[Math.min(ir.length - 1, i0 + 1)] ?? 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}
function argmaxAbs(x, limit) {
  let idx = 0;
  let peak = 0;
  const n = Math.min(x.length, limit);
  for (let i = 0; i < n; i++) {
    const v = Math.abs(x[i]);
    if (v > peak) {
      peak = v;
      idx = i;
    }
  }
  return idx;
}
function mixIrForMode(ctx, set, raw, mode) {
  const w = BINAURAL_MODES[mode].wet;
  const rate = ctx.sampleRate;
  let dryL = raw.dry.subarray(0, raw.dryLen);
  let dryR = raw.dry.subarray(raw.dryLen);
  let wetL = raw.wet.subarray(0, raw.wetLen);
  let wetR = raw.wet.subarray(raw.wetLen);
  if (Math.abs(set.sampleRate - rate) >= 1) {
    dryL = resampleLinear(dryL, set.sampleRate, rate);
    dryR = resampleLinear(dryR, set.sampleRate, rate);
    wetL = resampleLinear(wetL, set.sampleRate, rate);
    wetR = resampleLinear(wetR, set.sampleRate, rate);
  }
  const search = Math.min(wetL.length, Math.round(rate * 0.02));
  const shift = argmaxAbs(wetL, search) - argmaxAbs(dryL, dryL.length);
  const outLen = wetL.length;
  const L = new Float32Array(outLen);
  const R = new Float32Array(outLen);
  for (let i = 0; i < dryL.length; i++) {
    const j = i + shift;
    if (j >= 0 && j < outLen) {
      L[j] = (1 - w) * dryL[i];
      R[j] = (1 - w) * dryR[i];
    }
  }
  for (let i = 0; i < outLen; i++) {
    L[i] = L[i] + w * wetL[i];
    R[i] = R[i] + w * wetR[i];
  }
  let energy = 0;
  for (let i = 0; i < outLen; i++) energy += L[i] * L[i] + R[i] * R[i];
  if (energy > 0) {
    const s = 1 / Math.sqrt(energy);
    for (let i = 0; i < outLen; i++) {
      L[i] = L[i] * s;
      R[i] = R[i] * s;
    }
  }
  const buf = ctx.createBuffer(2, outLen, rate);
  buf.copyToChannel(L, 0);
  buf.copyToChannel(R, 1);
  return buf;
}
function buildBusIrs(ctx, set, layout, mode) {
  const result = /* @__PURE__ */ new Map();
  layout.forEach((spk, bus) => {
    if (spk.isLfe) return;
    const raw = nearestPosition(set, spk.azimuth, spk.elevation);
    if (raw) result.set(bus, mixIrForMode(ctx, set, raw, mode));
  });
  return result;
}

// packages/renderer/src/headphone-compensation.ts
var HEADPHONE_COMPENSATION_PROFILES = [
  {
    id: "airpods-pro-2-anc-averaged",
    name: "AirPods Pro 2\uFF08ANC\uFF0C\u5E73\u5747\u6D4B\u91CF\u8FD1\u4F3C\uFF09",
    source: "AutoEq crinacle 711 in-ear Apple AirPods Pro 2 (ANC mode), minimum-phase 48 kHz output",
    target: "AutoEq in-ear target; averaged response, not independent L/R measurement",
    sampleRate: 48e3,
    leftFirUrl: "headphone-compensation/airpods-pro-2-anc-averaged/left.f32",
    rightFirUrl: "headphone-compensation/airpods-pro-2-anc-averaged/right.f32"
  }
];
var rawCache = /* @__PURE__ */ new Map();
function headphoneProfileById(id) {
  if (!id) return null;
  return HEADPHONE_COMPENSATION_PROFILES.find((profile) => profile.id === id) ?? null;
}
function validateHeadphoneProfile(profile) {
  const errors = [];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(profile.id)) errors.push("id \u5FC5\u987B\u662F\u5C0F\u5199 slug");
  if (!profile.name.trim()) errors.push("\u7F3A\u5C11\u8033\u673A\u578B\u53F7\u540D\u79F0");
  if (!profile.source.trim()) errors.push("\u7F3A\u5C11\u6D4B\u91CF\u6765\u6E90");
  if (!profile.target.trim()) errors.push("\u7F3A\u5C11\u76EE\u6807\u66F2\u7EBF\u8BF4\u660E");
  if (!Number.isFinite(profile.sampleRate) || profile.sampleRate <= 0) errors.push("\u91C7\u6837\u7387\u65E0\u6548");
  if (!profile.leftFirUrl || !profile.rightFirUrl) errors.push("\u5FC5\u987B\u63D0\u4F9B\u5DE6\u53F3 FIR \u8D44\u4EA7");
  return errors;
}
function decodeRawFir(buffer, url) {
  if (!buffer.byteLength || buffer.byteLength % Float32Array.BYTES_PER_ELEMENT) {
    throw new Error(`\u8033\u673A FIR \u65E0\u6548\u5B57\u8282\u957F\u5EA6: ${url}`);
  }
  const taps = new Float32Array(buffer);
  if (!taps.every(Number.isFinite)) throw new Error(`\u8033\u673A FIR \u5305\u542B\u65E0\u6548 tap: ${url}`);
  return taps;
}
function resampleLinear2(taps, fromRate, toRate) {
  if (Math.abs(fromRate - toRate) < 1) return taps;
  const ratio = fromRate / toRate;
  const output = new Float32Array(Math.round(taps.length / ratio));
  for (let i = 0; i < output.length; i++) {
    const pos = i * ratio;
    const floor = Math.floor(pos);
    const fraction = pos - floor;
    const a = taps[floor] ?? 0;
    const b = taps[Math.min(taps.length - 1, floor + 1)] ?? 0;
    output[i] = a + (b - a) * fraction;
  }
  return output;
}
async function getRawHeadphoneCompensation(profile) {
  let request = rawCache.get(profile.id);
  if (!request) {
    request = Promise.all([fetch(profile.leftFirUrl), fetch(profile.rightFirUrl)]).then(async ([left, right]) => {
      if (!left.ok) throw new Error(`\u8033\u673A\u5DE6 FIR HTTP ${left.status}: ${profile.leftFirUrl}`);
      if (!right.ok) throw new Error(`\u8033\u673A\u53F3 FIR HTTP ${right.status}: ${profile.rightFirUrl}`);
      const [leftBuffer, rightBuffer] = await Promise.all([left.arrayBuffer(), right.arrayBuffer()]);
      return { profile, left: decodeRawFir(leftBuffer, profile.leftFirUrl), right: decodeRawFir(rightBuffer, profile.rightFirUrl) };
    });
    request.catch(() => rawCache.delete(profile.id));
    rawCache.set(profile.id, request);
  }
  return request;
}
async function getHeadphoneCompensationBuffers(ctx, profile) {
  const raw = await getRawHeadphoneCompensation(profile);
  const makeBuffer = (taps) => {
    const data = resampleLinear2(taps, raw.profile.sampleRate, ctx.sampleRate);
    const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buffer.copyToChannel(data, 0);
    return buffer;
  };
  return { left: makeBuffer(raw.left), right: makeBuffer(raw.right) };
}

// packages/renderer/src/renderer.ts
var LFE_LOWPASS_HZ = 120;
var BINAURAL_LFE_INBAND_GAIN = 1;
var BINAURAL_MAKEUP_GAIN = Math.pow(10, 6 / 20);
var BINAURAL_PEAK_GUARD_CEILING_DB = -0.1;
var BINAURAL_LFE_PEAK_THRESHOLD_DB = -3;
var BINAURAL_LFE_PEAK_KNEE_DB = 0;
var BINAURAL_LFE_PEAK_RATIO = 8;
var BINAURAL_LFE_PEAK_ATTACK_S = 3e-3;
var BINAURAL_LFE_PEAK_RELEASE_S = 0.1;
function sizeToSpread(size) {
  return Math.min(1, (size[0] + size[1] + size[2]) / 3);
}
var SpatialRenderer = class {
  ctx;
  /** 当前用于 VBAP 与床层语义的布局；运行中可切换。 */
  layout;
  /** 固定的最大总线拓扑。AudioWorklet 与卷积图始终按它保持存活。 */
  topology;
  mode;
  /** 三条常驻模式路径的最终增益，实时切换只对它们做交叉淡化。 */
  modeGains = /* @__PURE__ */ new Map();
  vbap;
  node = null;
  /** 常驻最终 sample-peak guard；后级图重建时复用，不触碰播放时间线。 */
  peakGuard = null;
  master = null;
  postNodes = [];
  /** 双耳路径每总线的卷积器（LFE/兜底位置为 null），切模式时只换 buffer。 */
  convs = [];
  sources = /* @__PURE__ */ new Map();
  /** 独立 LFE 床声道的静音状态；与动态对象静音分开存储。 */
  lfeMuted = false;
  irSet = null;
  /** 床扩展表（AVR 上混器语义）：床音箱总线 → 派生馈送。内容床小于所选布局时
   *  把床填满布局 —— 侧环绕馈后环、前馈前宽；目标总线已被真实床声道占用则跳过。 */
  expansion = /* @__PURE__ */ new Map();
  /** 杜比 Binaural Settings 语义：虚拟音箱参考距离。UI 固定"近"（0.7m）；
   *  mid/far 机制保留在引擎内，暂不从界面暴露。 */
  binauralMode = "near";
  /** 最终双耳回放补偿。无 profile 时是 literal bypass。 */
  headphoneProfileId = null;
  /** 当前输出图 revision；迟到的 FIR 请求不得接回已重建的图。 */
  outputGraphRevision = 0;
  /** 已就绪的 context-local FIR buffers；切 profile 或重建 context 时清空。 */
  headphoneBuffers = null;
  onConsumedTick;
  /** Frames actually rendered by the worklet (authoritative playhead). */
  consumedSamples = 0;
  /** Reset generation. Only ticks from the active generation may move the playhead. */
  epoch = 0;
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.mode = options.mode ?? "binaural";
    this.layout = options.layout ?? LAYOUT_7_1_4;
    this.topology = LAYOUTS["9.1.6"];
    this.vbap = new VbapSolver(this.layout);
    if (options.binauralIrSet) this.irSet = options.binauralIrSet;
    this.onConsumedTick = options.onConsumedTick;
    this.buildExpansion();
  }
  /** 上混扩展规则（杜比 DSU / AVR 上混器的静态近似）：
   *  - 侧环绕 → 后环 0.5（5.1 内容在 7.1+ 布局：后环不再沉默，声像略后移
   *    恰好贴近 5.1 环绕的 ±110° 制作位）
   *  - 前左/右 → 前宽 0.35（9.1 布局：拉开前声场宽度，中置对白不动）
   *  顶层不做静态派生（环境声提取超出本渲染器职责）。 */
  buildExpansion() {
    this.expansion.clear();
    const idx = (name) => this.layout.findIndex((s) => s.name === name);
    const feed = (from, to, gain) => {
      const a = idx(from);
      const b = idx(to);
      if (a < 0 || b < 0) return;
      const list = this.expansion.get(a) ?? [];
      list.push({ bus: b, gain });
      this.expansion.set(a, list);
    };
    feed("SurroundLeft", "RearLeft", 0.5);
    feed("SurroundRight", "RearRight", 0.5);
    feed("FrontLeft", "WideLeft", 0.35);
    feed("FrontRight", "WideRight", 0.35);
  }
  /** 改变逻辑布局而不重建 AudioContext/worklet。现有 PCM、播放头和卷积图继续
   * 存活；所有源通过短增益斜坡迁移到固定最大总线中的新位置。 */
  setLayout(layout) {
    if (layout === this.layout) return;
    this.layout = layout;
    this.vbap = new VbapSolver(layout);
    this.buildExpansion();
    for (const state of this.sources.values()) {
      if (state.bedLabel && !state.isLfe) {
        state.snapBus = this.layout.findIndex((speaker) => speaker.name === state.bedLabel);
      }
      this.applyGains(state, 2048);
    }
  }
  async init(workletModuleUrl) {
    await this.ctx.audioWorklet.addModule(workletModuleUrl);
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.node = new AudioWorkletNode(this.ctx, "sda-renderer", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [this.topology.length],
      processorOptions: { busCount: this.topology.length, epoch: this.epoch }
    });
    this.node.port.onmessage = (e) => {
      if (e.data?.type === "tick" && e.data.epoch === this.epoch) {
        this.consumedSamples = e.data.consumed;
        this.onConsumedTick?.();
      }
    };
    this.peakGuard = new AudioWorkletNode(this.ctx, "sda-final-peak-guard", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { ceilingDb: BINAURAL_PEAK_GUARD_CEILING_DB }
    });
    this.buildOutputGraph();
  }
  /** 注入双耳 IR 集；双耳路径常驻，即使当前未选双耳也立即更新，便于实时切回。 */
  setBinauralData(set) {
    this.irSet = set;
    if (this.node) this.buildOutputGraph();
  }
  /** 切换杜比近/中/远：重混每总线 IR（干 HRIR ↔ 湿 BRIR）；对象的空间位置和
   * 制作响度不变，播放不中断。 */
  setBinauralMode(mode) {
    if (mode === this.binauralMode) return;
    this.binauralMode = mode;
    if (this.irSet) {
      const irs = buildBusIrs(this.ctx, this.irSet, this.topology, mode);
      this.convs.forEach((conv, bus) => {
        const ir = irs.get(bus);
        if (conv && ir) conv.buffer = ir;
      });
    }
    for (const state of this.sources.values()) this.applyGains(state, 4096);
  }
  get binauralModeName() {
    return this.binauralMode;
  }
  /** 选择最终双耳耳机补偿。FIR 未就绪时保持 bypass；完成后只重建后级图，
   * 不触碰 worklet、PCM 或播放头。 */
  setHeadphoneCompensation(profileId) {
    if (profileId !== null && !headphoneProfileById(profileId)) {
      throw new Error(`\u672A\u77E5\u6216\u672A\u6CE8\u518C\u7684\u8033\u673A\u8865\u507F profile: ${profileId}`);
    }
    this.headphoneProfileId = profileId;
    this.headphoneBuffers = null;
    this.buildOutputGraph();
  }
  get headphoneCompensationProfile() {
    return headphoneProfileById(this.headphoneProfileId);
  }
  /** 实时切换最终输出模式。三条后级图保持常驻，worklet/PCM/播放头不重建。 */
  setOutputMode(mode) {
    if (mode === this.mode || !this.modeGains.size) {
      this.mode = mode;
      return;
    }
    const now = this.ctx.currentTime;
    const duration = 0.05;
    for (const [id, gain] of this.modeGains) {
      const target = id === mode ? 1 : 0;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(target, now + duration);
    }
    this.mode = mode;
    for (const state of this.sources.values()) this.applyGains(state, 2048);
  }
  get outputMode() {
    return this.mode;
  }
  teardownPostNodes() {
    this.outputGraphRevision++;
    for (const n of this.postNodes) n.disconnect();
    this.postNodes = [];
    this.convs = [];
    this.modeGains.clear();
  }
  /** LR4（Linkwitz-Riley 四阶）滤波对：两个 Q=1/√2 的二阶 biquad 级联，
   *  级联后分频点处 -6dB，高低通同相叠加平坦。返回 [入口, 出口]。 */
  lr4(type, freq) {
    const a = this.ctx.createBiquadFilter();
    const b = this.ctx.createBiquadFilter();
    for (const f of [a, b]) {
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = Math.SQRT1_2;
    }
    a.connect(b);
    return [a, b];
  }
  buildOutputGraph() {
    if (!this.node || !this.master) return;
    this.teardownPostNodes();
    const n = this.topology.length;
    const master = this.master;
    const dest = this.ctx.destination;
    try {
      dest.channelCountMode = "explicit";
      dest.channelCount = Math.max(2, Math.min(n, dest.maxChannelCount || n));
    } catch {
    }
    const createModeOutput = (mode) => {
      const gain = this.ctx.createGain();
      gain.gain.value = mode === this.mode ? 1 : 0;
      gain.connect(master);
      this.modeGains.set(mode, gain);
      this.postNodes.push(gain);
      return gain;
    };
    this.buildMultichannelPath(n, createModeOutput("multichannel"));
    this.buildStereoPath(n, createModeOutput("stereo"));
    this.buildBinauralPath(n, createModeOutput("binaural"));
    this.loadHeadphoneCompensation();
  }
  loadHeadphoneCompensation() {
    const profile = headphoneProfileById(this.headphoneProfileId);
    if (!profile || this.headphoneBuffers) return;
    const revision = this.outputGraphRevision;
    void getHeadphoneCompensationBuffers(this.ctx, profile).then((buffers) => {
      if (this.headphoneProfileId !== profile.id || revision !== this.outputGraphRevision || this.ctx.state === "closed") return;
      this.headphoneBuffers = buffers;
      this.buildOutputGraph();
    }).catch((error) => console.warn(`[SDA] \u8033\u673A\u8865\u507F\u52A0\u8F7D\u5931\u8D25\uFF0C\u4FDD\u6301 bypass: ${profile.id}`, error));
  }
  /** 物理声道直出固定使用最大拓扑和 WASAPI 规范顺序；未激活总线由 worklet 增益归零。 */
  buildMultichannelPath(n, output) {
    const splitter = this.ctx.createChannelSplitter(n);
    const merger = this.ctx.createChannelMerger(n);
    this.node.connect(splitter);
    physicalChannelOrder(this.topology).forEach((bus, i) => splitter.connect(merger, bus, i));
    merger.connect(output);
    this.postNodes.push(splitter, merger);
  }
  /** 常驻立体声 downmix，输出只占固定物理通道 0/1。 */
  buildStereoPath(n, output) {
    const splitter = this.ctx.createChannelSplitter(n);
    const merger = this.ctx.createChannelMerger(n);
    this.node.connect(splitter);
    for (let bus = 0; bus < n; bus++) {
      const spk = this.topology[bus];
      const gainL = this.ctx.createGain();
      const gainR = this.ctx.createGain();
      const az = spk.azimuth * Math.PI / 180;
      gainL.gain.value = (spk.isLfe ? 0.25 : Math.max(0.05, Math.cos((az - Math.PI / 2) / 2))) * 0.7;
      gainR.gain.value = (spk.isLfe ? 0.25 : Math.max(0.05, Math.cos((az + Math.PI / 2) / 2))) * 0.7;
      splitter.connect(gainL, bus);
      splitter.connect(gainR, bus);
      gainL.connect(merger, 0, 0);
      gainR.connect(merger, 0, 1);
      this.postNodes.push(gainL, gainR);
    }
    merger.connect(output);
    this.postNodes.push(splitter, merger);
  }
  /** 常驻双耳图：每条虚拟音箱总线只卷积一次，最终汇总后加输出标定和峰值保护，输出占固定物理通道 0/1。 */
  buildBinauralPath(n, output) {
    const splitter = this.ctx.createChannelSplitter(n);
    const merger = this.ctx.createChannelMerger(n);
    const makeup = this.ctx.createGain();
    makeup.gain.value = BINAURAL_MAKEUP_GAIN;
    const peakGuard = this.peakGuard;
    if (!peakGuard) throw new Error("SpatialRenderer.init() peak guard missing");
    peakGuard.disconnect();
    this.node.connect(splitter);
    const busIrs = this.irSet ? buildBusIrs(this.ctx, this.irSet, this.topology, this.binauralMode) : null;
    let lfeBus = null;
    if (this.topology.some((speaker) => speaker.isLfe)) {
      const sum = this.ctx.createGain();
      const lfePeak = this.ctx.createDynamicsCompressor();
      lfePeak.threshold.value = BINAURAL_LFE_PEAK_THRESHOLD_DB;
      lfePeak.knee.value = BINAURAL_LFE_PEAK_KNEE_DB;
      lfePeak.ratio.value = BINAURAL_LFE_PEAK_RATIO;
      lfePeak.attack.value = BINAURAL_LFE_PEAK_ATTACK_S;
      lfePeak.release.value = BINAURAL_LFE_PEAK_RELEASE_S;
      const lfeOut = this.ctx.createGain();
      lfeOut.gain.value = 0.5;
      sum.connect(lfePeak);
      lfePeak.connect(lfeOut);
      lfeOut.connect(merger, 0, 0);
      lfeOut.connect(merger, 0, 1);
      this.postNodes.push(sum, lfePeak, lfeOut);
      lfeBus = sum;
    }
    for (let bus = 0; bus < n; bus++) {
      const spk = this.topology[bus];
      if (spk.isLfe) {
        const lfeGain = this.ctx.createGain();
        if (lfeBus) {
          const [lpIn, lpOut] = this.lr4("lowpass", LFE_LOWPASS_HZ);
          splitter.connect(lpIn, bus);
          lfeGain.gain.value = BINAURAL_LFE_INBAND_GAIN;
          lpOut.connect(lfeGain);
          lfeGain.connect(lfeBus);
          this.postNodes.push(lpIn, lpOut, lfeGain);
        }
        this.convs.push(null);
        continue;
      }
      const ir = busIrs?.get(bus);
      if (ir) {
        const conv = this.ctx.createConvolver();
        conv.buffer = ir;
        conv.normalize = false;
        const earSplit = this.ctx.createChannelSplitter(2);
        splitter.connect(conv, bus);
        conv.connect(earSplit);
        earSplit.connect(merger, 0, 0);
        earSplit.connect(merger, 1, 1);
        this.postNodes.push(conv, earSplit);
        this.convs.push(conv);
      } else {
        const panner = this.ctx.createPanner();
        panner.panningModel = "HRTF";
        panner.distanceModel = "linear";
        panner.refDistance = 1;
        panner.maxDistance = 1;
        panner.rolloffFactor = 0;
        const [x, y, z] = sphericalToWebAudio(spk);
        panner.positionX.value = x;
        panner.positionY.value = y;
        panner.positionZ.value = z;
        const earSplit = this.ctx.createChannelSplitter(2);
        splitter.connect(panner, bus);
        panner.connect(earSplit);
        earSplit.connect(merger, 0, 0);
        earSplit.connect(merger, 1, 1);
        this.postNodes.push(panner, earSplit);
        this.convs.push(null);
      }
    }
    let finalBinaural = merger;
    const profile = headphoneProfileById(this.headphoneProfileId);
    if (profile && this.headphoneBuffers) {
      const earSplit = this.ctx.createChannelSplitter(2);
      const left = this.ctx.createConvolver();
      const right = this.ctx.createConvolver();
      left.buffer = this.headphoneBuffers.left;
      right.buffer = this.headphoneBuffers.right;
      left.normalize = false;
      right.normalize = false;
      const earMerge = this.ctx.createChannelMerger(2);
      merger.connect(earSplit);
      earSplit.connect(left, 0);
      earSplit.connect(right, 1);
      left.connect(earMerge, 0, 0);
      right.connect(earMerge, 0, 1);
      this.postNodes.push(earSplit, left, right, earMerge);
      finalBinaural = earMerge;
    }
    finalBinaural.connect(makeup);
    makeup.connect(peakGuard);
    peakGuard.connect(output);
    this.postNodes.push(splitter, merger, makeup);
  }
  /** Register a source. Bed channels pass their speaker label; objects an event id.
   *  重复声明同一 id（稀疏声明变化时 player 会重放整组）完全幂等：保留
   *  SourceState/元数据/静音状态，也不向 worklet 重发即时 gains。 */
  addSource(id, opts = {}) {
    if (this.sources.has(id)) return;
    if (!this.node) throw new Error("SpatialRenderer.init() first");
    const state = {
      id,
      spread: 0,
      position: { azimuth: 0, elevation: 0, distance: 1 },
      gainDb: 0,
      isLfe: opts.bedLabel ? isLfeLabel(opts.bedLabel) : false,
      muted: false,
      bedLabel: opts.bedLabel ? aliasLabel(opts.bedLabel) : void 0,
      snapBus: -1
    };
    if (opts.bedLabel) {
      state.position = positionForLabel(opts.bedLabel);
      if (!state.isLfe) {
        state.snapBus = this.layout.findIndex((s) => s.name === state.bedLabel);
      }
    }
    this.sources.set(id, state);
    this.node.port.postMessage({ type: "add", id });
    this.applyGains(state, 0);
    if (state.snapBus >= 0) this.recomputeBedGains(id);
  }
  /** 床声道集合变化（新床声道占用/释放了扩展目标总线）→ 重推其余床声道的增益，
   *  让上混馈送跳过/恢复被真实声道占用的总线。 */
  recomputeBedGains(excludeId) {
    for (const s of this.sources.values()) {
      if (s.id !== excludeId && s.snapBus >= 0) this.applyGains(s, 512);
    }
  }
  /** 其余床声道吸附占用的总线（扩展馈送要避开）。 */
  bedOccupiedBuses(excludeId) {
    const occ = /* @__PURE__ */ new Set();
    for (const s of this.sources.values()) {
      if (s.id !== excludeId && s.snapBus >= 0) occ.add(s.snapBus);
    }
    return occ;
  }
  /** 静音/取消静音一个源（Omniphony 式对象 mute/solo 的底层原语）。
   *  走 2048 采样斜坡（@48k ≈ 43ms），切换无爆音。
   *  返回 false = 源不存在（调用方可据此提示 id 不匹配）。 */
  setSourceMuted(id, muted) {
    const state = this.sources.get(id);
    if (!state) {
      console.warn(`[SDA] setSourceMuted \u65E0\u6E90 "${id}"\uFF0C\u73B0\u6709\u6E90: ${[...this.sources.keys()].join(", ") || "(\u7A7A)"}`);
      return false;
    }
    if (state.muted === muted) return true;
    state.muted = muted;
    this.node?.port.postMessage({ type: "mute", id, muted, ramp: 2048 });
    console.log(`[SDA] ${id} ${muted ? "\u9759\u97F3" : "\u89E3\u9664\u9759\u97F3"} \u2192 scalar ${muted ? 0 : 1}`);
    return true;
  }
  /** 静音/恢复所有独立 LFE 床声道；状态会应用到迟到注册的 LFE 源。 */
  setLfeMuted(muted) {
    this.lfeMuted = muted;
    for (const state of this.sources.values()) {
      if (state.isLfe) this.applyGains(state, 2048);
    }
  }
  removeSource(id) {
    const state = this.sources.get(id);
    this.sources.delete(id);
    this.node?.port.postMessage({ type: "remove", id });
    if (state && state.snapBus >= 0) this.recomputeBedGains(id);
  }
  /** Feed PCM for a source (legacy single-source path). */
  feed(id, samples) {
    this.node?.port.postMessage({ type: "feed", id, samples }, [samples.buffer]);
  }
  /** Atomically enqueue every channel of one decoded frame at its absolute
   * codec sample position. Partial frame writes are rejected by the worklet. */
  feedBatch(samplePos, entries) {
    if (!this.node || entries.length === 0) return;
    const transferable = entries.map(({ samples }) => samples.buffer);
    this.node.port.postMessage(
      { type: "feedBatch", start: Math.trunc(samplePos), entries },
      transferable
    );
  }
  /** Queue an object event on the same absolute sample clock as its PCM. */
  applyEvent(ev, rampSamples) {
    const state = this.sources.get(`obj:${ev.id}`);
    if (!state) return;
    if (ev.hasPos) {
      state.position = admToSpherical(ev.pos);
      state.spread = sizeToSpread(ev.size);
    }
    state.gainDb = ev.gainDb;
    this.applyGains(
      state,
      rampSamples || ev.rampDuration || 128,
      Math.trunc(ev.samplePos)
    );
  }
  /** Recompute and send a source's gain vector over the buses. */
  applyGains(state, rampSamples, atSample) {
    const gains = this.vbap.pan(state.position, state.spread);
    const normalizedDistance = Math.max(1e-3, state.position.distance);
    let distGain = 1;
    let lp = 1;
    if (normalizedDistance > 1) {
      distGain = 1 / normalizedDistance;
    }
    const metadataGain = state.gainDb <= -128 ? 0 : Math.pow(10, state.gainDb / 20);
    let scalar = metadataGain * distGain;
    if (state.isLfe) {
      gains.fill(0);
      const lfeBus = this.layout.findIndex((s) => s.isLfe);
      if (lfeBus >= 0) gains[lfeBus] = 1;
      scalar = metadataGain;
      if (this.lfeMuted) scalar = 0;
      lp = 1;
    } else if (state.snapBus >= 0) {
      gains.fill(0);
      gains[state.snapBus] = 1;
      if (this.mode === "multichannel") {
        const occupied = this.bedOccupiedBuses(state.id);
        for (const e of this.expansion.get(state.snapBus) ?? []) {
          if (!occupied.has(e.bus)) gains[e.bus] = e.gain;
        }
      }
    }
    const topologyGains = new Float32Array(this.topology.length);
    for (let bus = 0; bus < gains.length; bus++) {
      const target = this.topology.findIndex((speaker) => speaker.name === this.layout[bus].name);
      if (target >= 0) topologyGains[target] = gains[bus];
    }
    this.node?.port.postMessage({
      type: atSample === void 0 ? "gains" : "scheduleGains",
      id: state.id,
      at: atSample,
      gains: topologyGains,
      gain: scalar,
      lp,
      ramp: Math.max(1, rampSamples)
    });
  }
  /** Reset the codec timeline. MessagePort FIFO guarantees a following feed is
   * handled after reset; the epoch only rejects already-queued stale ticks. */
  resetBuffers() {
    this.epoch++;
    this.consumedSamples = 0;
    this.node?.port.postMessage({ type: "reset", epoch: this.epoch });
  }
  /** Playhead in seconds: frames the worklet actually rendered. */
  consumedSeconds() {
    return this.consumedSamples / this.ctx.sampleRate;
  }
  /** Worklet-level pause: outputs silence without consuming the ring buffers,
   *  so resume continues from the exact sample. */
  setPaused(paused) {
    this.node?.port.postMessage({ type: "pause", paused });
  }
  /** Master output volume, 0..1 (applied perceptually: gain = v²). */
  setVolume(v) {
    if (this.master) this.master.gain.value = Math.max(0, Math.min(1, v)) ** 2;
  }
  async close() {
    this.teardownPostNodes();
    this.peakGuard?.disconnect();
    this.peakGuard = null;
    this.node?.disconnect();
    this.master?.disconnect();
    if (this.ctx.state !== "closed") await this.ctx.close();
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BINAURAL_MODES,
  HEADPHONE_COMPENSATION_PROFILES,
  LAYOUTS,
  LAYOUT_7_1_4,
  SpatialRenderer,
  VbapSolver,
  admToSpherical,
  aliasLabel,
  buildBusIrs,
  detectLayoutId,
  getBinauralIrSet,
  getHeadphoneCompensationBuffers,
  headphoneProfileById,
  isLfeLabel,
  mixIrForMode,
  physicalChannelOrder,
  positionForLabel,
  sphericalToAdm,
  sphericalToWebAudio,
  validateHeadphoneProfile
});
