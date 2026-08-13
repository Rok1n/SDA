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
  RENDER_TOPOLOGY: () => RENDER_TOPOLOGY,
  SpatialRenderer: () => SpatialRenderer,
  VbapSolver: () => VbapSolver,
  admToSpherical: () => admToSpherical,
  aliasLabel: () => aliasLabel,
  availableHeadphoneCompensationProfiles: () => availableHeadphoneCompensationProfiles,
  binauralEqHeadroomDb: () => binauralEqHeadroomDb,
  buildBusIrs: () => buildBusIrs,
  detectLayoutId: () => detectLayoutId,
  getBinauralIrSet: () => getBinauralIrSet,
  getHeadphoneCompensationBuffers: () => getHeadphoneCompensationBuffers,
  headphoneProfileById: () => headphoneProfileById,
  isLfeLabel: () => isLfeLabel,
  mixIrForMode: () => mixIrForMode,
  mixIrForWet: () => mixIrForWet,
  physicalChannelOrder: () => physicalChannelOrder,
  positionForLabel: () => positionForLabel,
  registerLocalHeadphoneCompensation: () => registerLocalHeadphoneCompensation,
  setBinauralAssetLoader: () => setBinauralAssetLoader,
  setHeadphoneCompensationAssetLoader: () => setHeadphoneCompensationAssetLoader,
  speakerBusKey: () => speakerBusKey,
  sphericalToAdm: () => sphericalToAdm,
  sphericalToWebAudio: () => sphericalToWebAudio,
  stereoDownmixGains: () => stereoDownmixGains,
  unregisterLocalHeadphoneCompensation: () => unregisterLocalHeadphoneCompensation,
  validateHeadphoneProfile: () => validateHeadphoneProfile,
  validateLocalHeadphoneProfile: () => validateLocalHeadphoneProfile,
  virtualLayoutForOutput: () => virtualLayoutForOutput
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
  { name: "SurroundLeft", bus: "Surround5Left", azimuth: 110, elevation: 0, distance: 1 },
  { name: "SurroundRight", bus: "Surround5Right", azimuth: -110, elevation: 0, distance: 1 }
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
var TOP_MIDDLE = [
  { name: "TopMiddleLeft", azimuth: 90, elevation: 45, distance: 1 },
  { name: "TopMiddleRight", azimuth: -90, elevation: 45, distance: 1 }
];
var BED_5_1 = [...FRONT, ...SURROUND_5];
var BED_7_1 = [...FRONT, ...SURROUND_7];
var BED_9_1 = [...FRONT, ...WIDE, ...SURROUND_7];
var LAYOUT_7_1_4 = [...BED_7_1, ...TOP_FRONT, ...TOP_REAR];
var LAYOUTS = {
  "5.1": BED_5_1,
  "5.1.2": [...BED_5_1, ...TOP_MIDDLE],
  "5.1.4": [...BED_5_1, ...TOP_FRONT, ...TOP_REAR],
  "7.1.2": [...BED_7_1, ...TOP_MIDDLE],
  "7.1.4": LAYOUT_7_1_4,
  "9.1.2": [...BED_9_1, ...TOP_MIDDLE],
  "9.1.4": [...BED_9_1, ...TOP_FRONT, ...TOP_REAR],
  "9.1.6": [...BED_9_1, ...TOP_FRONT, ...TOP_MIDDLE, ...TOP_REAR]
};
var RENDER_TOPOLOGY = [
  ...LAYOUTS["9.1.6"],
  ...SURROUND_5
];
function speakerBusKey(speaker) {
  return speaker.bus ?? speaker.name;
}
var LABEL_POSITIONS = {
  ...Object.fromEntries([...LAYOUTS["9.1.6"]].map((s) => [s.name, s])),
  // 6.1 后中置（eac3 channel_mode 4/5、dependent chanmap Cs 位）：正后方 180°，
  // 不属于任何布局的音箱，渲染时由 VBAP 平移到后环/环绕对之间。
  RearCenter: { azimuth: 180, elevation: 0, distance: 1 },
  TopCenter: { azimuth: 0, elevation: 90, distance: 1 },
  TopFrontCenter: { azimuth: 0, elevation: 45, distance: 1 }
};
var LABEL_ALIASES = {
  // truehd 0.6.3 ChannelLabel Debug variants
  L: "FrontLeft",
  R: "FrontRight",
  C: "Center",
  LFE: "LFE",
  Ls: "SurroundLeft",
  Rs: "SurroundRight",
  Tfl: "TopFrontLeft",
  Tfr: "TopFrontRight",
  Tsl: "TopMiddleLeft",
  Tsr: "TopMiddleRight",
  Tbl: "TopRearLeft",
  Tbr: "TopRearRight",
  Lsc: "SurroundLeft",
  Rsc: "SurroundRight",
  Lb: "RearLeft",
  Rb: "RearRight",
  Cb: "RearCenter",
  Tc: "TopCenter",
  Lsd: "SurroundLeft",
  Rsd: "SurroundRight",
  Lw: "WideLeft",
  Rw: "WideRight",
  Tfc: "TopFrontCenter",
  LFE2: "LFE",
  // Legacy names retained for old bridge output and fixtures.
  Left: "FrontLeft",
  Right: "FrontRight",
  Lrs: "RearLeft",
  Rrs: "RearRight",
  Ltf: "TopFrontLeft",
  Rtf: "TopFrontRight",
  Ltr: "TopRearLeft",
  Rtr: "TopRearRight",
  // Older bridge/ADM spellings.
  TopSideLeft: "TopMiddleLeft",
  TopSideRight: "TopMiddleRight",
  Lts: "TopMiddleLeft",
  Rts: "TopMiddleRight",
  Ltm: "TopMiddleLeft",
  Rtm: "TopMiddleRight",
  Trl: "TopRearLeft",
  Trr: "TopRearRight",
  Lfe: "LFE",
  // eac3 BedChannel Debug 全名（lfe_channel 通常单列 "LFE"，此处防御性覆盖）
  LowFrequencyEffects: "LFE",
  LowFrequencyEffects2: "LFE",
  // eac3/dca BedChannel variants
  SurroundLeftRear: "RearLeft",
  SurroundRightRear: "RearRight",
  RearLeftSurround: "RearLeft",
  RearRightSurround: "RearRight",
  TopSurroundLeft: "TopMiddleLeft",
  // eac3 BedChannel::TopSurround* = 顶中
  TopSurroundRight: "TopMiddleRight",
  TopLeft: "TopFrontLeft",
  TopRight: "TopFrontRight",
  WideLeft: "WideLeft",
  // 9.1 前宽 ±60°
  WideRight: "WideRight",
  TopCenter: "TopCenter",
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
    // WASAPI BL/BR bits
    "WideLeft",
    "WideRight",
    // WASAPI FLC/FRC bits precede side surrounds
    "SurroundLeft",
    "SurroundRight",
    "TopFrontLeft",
    "TopFrontRight",
    "TopMiddleLeft",
    "TopMiddleRight",
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
  const hasTopMiddle = has("TopMiddleLeft", "TopMiddleRight");
  const hasTopRear = has("TopRearLeft", "TopRearRight");
  const hasTopFront = has("TopFrontLeft", "TopFrontRight") || names.has("TopFrontCenter");
  let tops = 0;
  if (hasTopMiddle && (hasTopFront || hasTopRear)) tops = 6;
  else if (hasTopRear || hasTopFront) tops = 4;
  else if (hasTopMiddle || names.has("TopCenter")) tops = 2;
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
      const nearestIndices = [-1, -1, -1, -1];
      const nearestDots = [-Infinity, -Infinity, -Infinity, -Infinity];
      for (let i = 0; i < this.speakerCount; i++) {
        if (this.lfeMask[i]) continue;
        const d = this.dirs[i];
        const dot = d[0] * p[0] + d[1] * p[1] + d[2] * p[2];
        for (let rank = 0; rank < nearestDots.length; rank++) {
          if (dot <= nearestDots[rank]) continue;
          for (let move = nearestDots.length - 1; move > rank; move--) {
            nearestDots[move] = nearestDots[move - 1];
            nearestIndices[move] = nearestIndices[move - 1];
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
var assetLoader = null;
function setBinauralAssetLoader(loader) {
  assetLoader = loader;
  setCache.clear();
}
async function loadAsset(baseUrl, fileName) {
  if (assetLoader) return assetLoader(`hrtf/${fileName}`);
  const response = await fetch(`${baseUrl}/${fileName}`);
  if (!response.ok) throw new Error(`${fileName} HTTP ${response.status}`);
  return response.arrayBuffer();
}
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
  const manifestBuffer = await loadAsset(baseUrl, "hrtf-set.json");
  const manifest = JSON.parse(new TextDecoder().decode(manifestBuffer));
  const positions = await Promise.all(
    manifest.positions.map(async (entry) => {
      const [dryBuf, wetBuf] = await Promise.all([
        loadAsset(baseUrl, entry.dry),
        loadAsset(baseUrl, entry.wet)
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
  return {
    sampleRate: manifest.sampleRate,
    calibrated: manifest.calibrationVersion !== void 0 && manifest.calibrationVersion >= 1 && manifest.processing?.calibrated === true,
    positions
  };
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
function mirrorAudioBuffer(ctx, source) {
  const mirrored = ctx.createBuffer(2, source.length, ctx.sampleRate);
  mirrored.copyToChannel(source.getChannelData(1), 0);
  mirrored.copyToChannel(source.getChannelData(0), 1);
  return mirrored;
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
function mixIrForWet(ctx, set, raw, wet) {
  const w = Math.max(0, Math.min(1, wet));
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
  const shift = set.calibrated ? 0 : argmaxAbs(wetL, search) - argmaxAbs(dryL, dryL.length);
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
  if (!set.calibrated && Math.abs(raw.azimuth) < 1e-6) {
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let i = 0; i < outLen; i++) {
      leftEnergy += L[i] * L[i];
      rightEnergy += R[i] * R[i];
    }
    if (leftEnergy > 0 && rightEnergy > 0) {
      const targetEnergy = (leftEnergy + rightEnergy) / 2;
      const leftScale = Math.sqrt(targetEnergy / leftEnergy);
      const rightScale = Math.sqrt(targetEnergy / rightEnergy);
      for (let i = 0; i < outLen; i++) {
        L[i] = L[i] * leftScale;
        R[i] = R[i] * rightScale;
      }
    }
  }
  if (!set.calibrated) {
    let energy = 0;
    for (let i = 0; i < outLen; i++) energy += L[i] * L[i] + R[i] * R[i];
    if (energy > 0) {
      const s = 1 / Math.sqrt(energy);
      for (let i = 0; i < outLen; i++) {
        L[i] = L[i] * s;
        R[i] = R[i] * s;
      }
    }
  }
  const buf = ctx.createBuffer(2, outLen, rate);
  buf.copyToChannel(L, 0);
  buf.copyToChannel(R, 1);
  return buf;
}
function mixIrForMode(ctx, set, raw, mode) {
  return mixIrForWet(ctx, set, raw, BINAURAL_MODES[mode].wet);
}
function buildBusIrs(ctx, set, layout, mode) {
  const result = /* @__PURE__ */ new Map();
  layout.forEach((spk, bus) => {
    if (spk.isLfe) return;
    const canonicalWide = !set.calibrated && spk.name === "WideRight" ? nearestPosition(set, -spk.azimuth, spk.elevation) : null;
    const raw = canonicalWide ?? nearestPosition(set, spk.azimuth, spk.elevation);
    if (!raw) return;
    const ir = mixIrForMode(ctx, set, raw, mode);
    result.set(bus, canonicalWide ? mirrorAudioBuffer(ctx, ir) : ir);
  });
  return result;
}

// packages/renderer/src/headphone-compensation.ts
var HEADPHONE_COMPENSATION_PROFILES = [
  {
    id: "sennheiser-hd-820-average-autoeq",
    name: "\u68EE\u6D77\u585E\u5C14 HD 820\uFF08AutoEq \u5E73\u5747\u6D4B\u91CF EQ\uFF0CL/R \u540C\u4E00\u66F2\u7EBF\uFF09",
    source: "AutoEq HypetheSonics over-ear result, revision 7ae0f56d53074872b028649617a22bbb4232feb7",
    target: "AutoEq over-ear target; FIR normalized to 0 dB at 1 kHz",
    leftMeasurement: "\u4E0D\u9002\u7528\uFF1A\u516C\u5F00\u6765\u6E90\u4E3A\u5355\u4E00/\u5E73\u5747\u6D4B\u91CF\u54CD\u5E94",
    rightMeasurement: "\u4E0D\u9002\u7528\uFF1A\u516C\u5F00\u6765\u6E90\u4E3A\u5355\u4E00/\u5E73\u5747\u6D4B\u91CF\u54CD\u5E94",
    balanceEvidence: "\u4E0D\u9002\u7528\uFF1A\u6B64 profile \u4E0D\u58F0\u79F0\u72EC\u7ACB\u5DE6\u53F3\u58F0\u9053\u6D4B\u91CF\u6216 balance \u6821\u51C6",
    measurementMode: "average-dual-mono",
    channelClaim: "\u540C\u4E00\u5E73\u5747\u6D4B\u91CF EQ \u5E94\u7528\u4E8E L/R\uFF1B\u975E\u72EC\u7ACB L/R \u6821\u51C6\uFF0C\u4E0D\u4FEE\u6B63\u8033\u673A\u4E2A\u4F53\u58F0\u9053\u5DEE\u5F02",
    averageMeasurement: "https://github.com/jaakkopasanen/AutoEq/tree/7ae0f56d53074872b028649617a22bbb4232feb7/results/HypetheSonics/over-ear/Sennheiser%20HD%20820",
    derivation: "scripts/build-sennheiser-hd-820-average-profile.mjs; published 10-band PEQ synthesized at 48 kHz, 8192 taps, 1 kHz normalized; source -6.4 dB preamp excluded",
    sampleRate: 48e3,
    preampDb: -8.3,
    leftFirUrl: "headphone-compensation/sennheiser-hd-820-average-autoeq/average.f32",
    rightFirUrl: "headphone-compensation/sennheiser-hd-820-average-autoeq/average.f32"
  },
  {
    id: "beyerdynamic-xelento-2nd-gen-average-autoeq",
    name: "Beyerdynamic Xelento 2nd Gen \u6709\u7EBF\u7248\uFF08AutoEq \u5E73\u5747\u6D4B\u91CF EQ\uFF0CL/R \u540C\u4E00\u66F2\u7EBF\uFF09",
    source: "AutoEq HypetheSonics GRAS RA0045 in-ear result, revision 6c9a097626213b8cbb0973e5a4dd645f5f9e3fd4",
    target: "AutoEq in-ear target; FIR normalized to 0 dB at 1 kHz",
    leftMeasurement: "\u4E0D\u9002\u7528\uFF1A\u516C\u5F00\u6765\u6E90\u4E3A\u5355\u4E00/\u5E73\u5747\u6D4B\u91CF\u54CD\u5E94",
    rightMeasurement: "\u4E0D\u9002\u7528\uFF1A\u516C\u5F00\u6765\u6E90\u4E3A\u5355\u4E00/\u5E73\u5747\u6D4B\u91CF\u54CD\u5E94",
    balanceEvidence: "\u4E0D\u9002\u7528\uFF1A\u6B64 profile \u4E0D\u58F0\u79F0\u72EC\u7ACB\u5DE6\u53F3\u58F0\u9053\u6D4B\u91CF\u6216 balance \u6821\u51C6",
    measurementMode: "average-dual-mono",
    channelClaim: "\u540C\u4E00\u5E73\u5747\u6D4B\u91CF EQ \u5E94\u7528\u4E8E L/R\uFF1B\u975E\u72EC\u7ACB L/R \u6821\u51C6\uFF0C\u4E0D\u4FEE\u6B63\u8033\u673A\u4E2A\u4F53\u58F0\u9053\u5DEE\u5F02",
    averageMeasurement: "https://github.com/jaakkopasanen/AutoEq/tree/master/results/HypetheSonics/GRAS%20RA0045%20in-ear/Beyerdynamic%20Xelento%20%282nd%20Gen%29",
    derivation: "scripts/build-beyerdynamic-xelento-2nd-gen-average-profile.mjs; published 10-band PEQ synthesized at 48 kHz, 8192 taps, 1 kHz normalized; source -6.3 dB preamp excluded",
    sampleRate: 48e3,
    preampDb: -6.3,
    leftFirUrl: "headphone-compensation/beyerdynamic-xelento-2nd-gen-average-autoeq/average.f32",
    rightFirUrl: "headphone-compensation/beyerdynamic-xelento-2nd-gen-average-autoeq/average.f32"
  },
  {
    id: "beyerdynamic-xelento-wired-average-autoeq",
    name: "Beyerdynamic Xelento \u6709\u7EBF\u7248\uFF08AutoEq \u5E73\u5747\u6D4B\u91CF EQ\uFF0CL/R \u540C\u4E00\u66F2\u7EBF\uFF09",
    source: "AutoEq HypetheSonics B&K 5128 in-ear result, revision 6c9a097626213b8cbb0973e5a4dd645f5f9e3fd4",
    target: "AutoEq in-ear target; FIR normalized to 0 dB at 1 kHz",
    leftMeasurement: "\u4E0D\u9002\u7528\uFF1A\u516C\u5F00\u6765\u6E90\u4E3A\u5355\u4E00/\u5E73\u5747\u6D4B\u91CF\u54CD\u5E94",
    rightMeasurement: "\u4E0D\u9002\u7528\uFF1A\u516C\u5F00\u6765\u6E90\u4E3A\u5355\u4E00/\u5E73\u5747\u6D4B\u91CF\u54CD\u5E94",
    balanceEvidence: "\u4E0D\u9002\u7528\uFF1A\u6B64 profile \u4E0D\u58F0\u79F0\u72EC\u7ACB\u5DE6\u53F3\u58F0\u9053\u6D4B\u91CF\u6216 balance \u6821\u51C6",
    measurementMode: "average-dual-mono",
    channelClaim: "\u540C\u4E00\u5E73\u5747\u6D4B\u91CF EQ \u5E94\u7528\u4E8E L/R\uFF1B\u975E\u72EC\u7ACB L/R \u6821\u51C6\uFF0C\u4E0D\u4FEE\u6B63\u8033\u673A\u4E2A\u4F53\u58F0\u9053\u5DEE\u5F02",
    averageMeasurement: "https://github.com/jaakkopasanen/AutoEq/tree/master/results/HypetheSonics/Bruel%20%26%20Kjaer%205128%20in-ear/Beyerdynamic%20Xelento",
    derivation: "scripts/build-beyerdynamic-xelento-wired-average-profile.mjs; published 10-band PEQ synthesized at 48 kHz, 8192 taps, 1 kHz normalized; source -6.6 dB preamp excluded",
    sampleRate: 48e3,
    preampDb: -5.2,
    leftFirUrl: "headphone-compensation/beyerdynamic-xelento-wired-average-autoeq/average.f32",
    rightFirUrl: "headphone-compensation/beyerdynamic-xelento-wired-average-autoeq/average.f32"
  },
  {
    id: "sony-mdr-7506-average-autoeq",
    name: "Sony MDR-7506\uFF08AutoEq \u5E73\u5747\u6D4B\u91CF EQ\uFF0CL/R \u540C\u4E00\u66F2\u7EBF\uFF09",
    source: "AutoEq Super Review result, revision 36b1afcdf161c8a52b5093daefbbd335272508f3",
    target: "AutoEq Harman over-ear target; FIR normalized to 0 dB at 1 kHz",
    leftMeasurement: "\u4E0D\u9002\u7528\uFF1A\u516C\u5F00\u6765\u6E90\u4E3A\u5355\u4E00/\u5E73\u5747\u6D4B\u91CF\u54CD\u5E94",
    rightMeasurement: "\u4E0D\u9002\u7528\uFF1A\u516C\u5F00\u6765\u6E90\u4E3A\u5355\u4E00/\u5E73\u5747\u6D4B\u91CF\u54CD\u5E94",
    balanceEvidence: "\u4E0D\u9002\u7528\uFF1A\u6B64 profile \u4E0D\u58F0\u79F0\u72EC\u7ACB\u5DE6\u53F3\u58F0\u9053\u6D4B\u91CF\u6216 balance \u6821\u51C6",
    measurementMode: "average-dual-mono",
    channelClaim: "\u540C\u4E00\u5E73\u5747\u6D4B\u91CF EQ \u5E94\u7528\u4E8E L/R\uFF1B\u975E\u72EC\u7ACB L/R \u6821\u51C6\uFF0C\u4E0D\u4FEE\u6B63\u8033\u673A\u4E2A\u4F53\u58F0\u9053\u5DEE\u5F02",
    averageMeasurement: "https://github.com/jaakkopasanen/AutoEq/tree/master/results/Super%20Review/over-ear/Sony%20MDR-7506",
    derivation: "scripts/build-sony-mdr-7506-average-profile.mjs; published 10-band PEQ synthesized at 48 kHz, 8192 taps, 1 kHz normalized; source -4.1 dB preamp excluded",
    sampleRate: 48e3,
    preampDb: -6.1,
    leftFirUrl: "headphone-compensation/sony-mdr-7506-average-autoeq/average.f32",
    rightFirUrl: "headphone-compensation/sony-mdr-7506-average-autoeq/average.f32"
  }
];
var localProfiles = /* @__PURE__ */ new Map();
var rawCache = /* @__PURE__ */ new Map();
var bundledAssetLoader = null;
function setHeadphoneCompensationAssetLoader(loader) {
  bundledAssetLoader = loader;
  rawCache.clear();
}
function headphoneProfileById(id) {
  if (!id) return null;
  return localProfiles.get(id)?.profile ?? HEADPHONE_COMPENSATION_PROFILES.find((profile) => profile.id === id) ?? null;
}
function availableHeadphoneCompensationProfiles() {
  return [...HEADPHONE_COMPENSATION_PROFILES, ...[...localProfiles.values()].map((entry) => entry.profile)];
}
function validateHeadphoneProfile(profile) {
  const errors = validateCommonProfile(profile);
  const mode = profile.measurementMode ?? "independent-lr";
  if (mode === "independent-lr") {
    if (!profile.leftMeasurement.trim() || !profile.rightMeasurement.trim()) errors.push("\u72EC\u7ACB L/R profile \u5FC5\u987B\u63D0\u4F9B\u5DE6\u53F3\u6D4B\u91CF\u6765\u6E90");
    if (!profile.balanceEvidence.trim()) errors.push("\u72EC\u7ACB L/R profile \u7F3A\u5C11\u5E73\u8861\u8BC1\u660E");
    if (profile.leftFirUrl === profile.rightFirUrl) errors.push("\u72EC\u7ACB L/R profile \u7684\u5DE6\u53F3 FIR \u5FC5\u987B\u662F\u72EC\u7ACB\u8D44\u4EA7");
  } else if (mode === "average-dual-mono") {
    if (!profile.averageMeasurement?.trim()) errors.push("\u5E73\u5747\u53CC\u5355\u58F0\u9053 profile \u7F3A\u5C11 averageMeasurement");
    if (!profile.derivation?.trim()) errors.push("\u5E73\u5747\u53CC\u5355\u58F0\u9053 profile \u7F3A\u5C11 derivation");
    if (!profile.channelClaim?.trim() || !/not independent|非独立|同一.*(?:eq|曲线)/i.test(profile.channelClaim)) {
      errors.push("\u5E73\u5747\u53CC\u5355\u58F0\u9053 profile \u5FC5\u987B\u660E\u786E\u975E\u72EC\u7ACB L/R \u58F0\u660E");
    }
    if (profile.leftFirUrl !== profile.rightFirUrl) errors.push("\u5E73\u5747\u53CC\u5355\u58F0\u9053 profile \u7684\u5DE6\u53F3 FIR \u5FC5\u987B\u6307\u5411\u540C\u4E00\u8D44\u4EA7");
  } else {
    errors.push("measurementMode \u5FC5\u987B\u4E3A independent-lr \u6216 average-dual-mono");
  }
  return errors;
}
function validateCommonProfile(profile) {
  const errors = [];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(profile.id)) errors.push("id \u5FC5\u987B\u662F\u5C0F\u5199 slug");
  if (!profile.name.trim()) errors.push("\u7F3A\u5C11\u8033\u673A\u578B\u53F7\u540D\u79F0");
  if (!profile.source.trim()) errors.push("\u7F3A\u5C11\u6D4B\u91CF\u6765\u6E90");
  if (!profile.target.trim()) errors.push("\u7F3A\u5C11\u76EE\u6807\u66F2\u7EBF\u8BF4\u660E");
  if (!Number.isFinite(profile.sampleRate) || profile.sampleRate <= 0) errors.push("\u91C7\u6837\u7387\u65E0\u6548");
  if (!Number.isFinite(profile.preampDb) || profile.preampDb > 0) errors.push("preampDb \u5FC5\u987B\u662F\u6709\u9650\u975E\u6B63\u503C");
  if (!profile.leftFirUrl || !profile.rightFirUrl) errors.push("\u5FC5\u987B\u63D0\u4F9B\u5DE6\u53F3 FIR \u8D44\u4EA7");
  return errors;
}
function validateLocalHeadphoneProfile(data) {
  const { profile } = data;
  const errors = validateCommonProfile(profile);
  if (profile.schemaVersion !== 1) errors.push("\u4E0D\u652F\u6301\u7684\u672C\u5730 profile schemaVersion");
  if (profile.measurementMode !== "independent-lr" && profile.measurementMode !== "average-dual-mono") {
    errors.push("measurementMode \u5FC5\u987B\u4E3A independent-lr \u6216 average-dual-mono");
  }
  if (!profile.channelClaim.trim()) errors.push("\u7F3A\u5C11 channelClaim");
  if (!Number.isFinite(Date.parse(profile.createdAt))) errors.push("createdAt \u65E0\u6548");
  for (const key of ["deviceRevision", "playbackState", "earTips", "firmware", "measurementRig", "referenceBand"]) {
    if (!profile[key].trim()) errors.push(`\u7F3A\u5C11 ${key}`);
  }
  if (profile.measurementMode === "independent-lr") {
    if (!profile.leftMeasurement.trim() || !profile.rightMeasurement.trim()) errors.push("\u72EC\u7ACB L/R profile \u5FC5\u987B\u63D0\u4F9B\u5DE6\u53F3\u6D4B\u91CF\u6765\u6E90");
    if (!profile.balanceEvidence.trim()) errors.push("\u72EC\u7ACB L/R profile \u7F3A\u5C11\u5E73\u8861\u8BC1\u660E");
  } else if (profile.measurementMode === "average-dual-mono") {
    if (!profile.averageMeasurement?.trim()) errors.push("\u5E73\u5747\u53CC\u5355\u58F0\u9053 profile \u7F3A\u5C11 averageMeasurement");
    if (!profile.derivation?.trim()) errors.push("\u5E73\u5747\u53CC\u5355\u58F0\u9053 profile \u7F3A\u5C11 derivation");
    if (!/not independent|非独立|同一.*(?:eq|曲线)/i.test(profile.channelClaim)) {
      errors.push("\u5E73\u5747\u53CC\u5355\u58F0\u9053 profile \u5FC5\u987B\u660E\u786E\u975E\u72EC\u7ACB L/R \u58F0\u660E");
    }
  }
  for (const [ear, asset, buffer] of [["left", profile.leftFir, data.leftFir], ["right", profile.rightFir, data.rightFir]]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.f32$/.test(asset.fileName)) errors.push(`${ear} FIR \u6587\u4EF6\u540D\u65E0\u6548`);
    if (!/^[a-f0-9]{64}$/i.test(asset.sha256)) errors.push(`${ear} FIR SHA-256 \u65E0\u6548`);
    if (!Number.isInteger(asset.tapCount) || asset.tapCount < 2) errors.push(`${ear} FIR tapCount \u65E0\u6548`);
    if (buffer.byteLength !== asset.tapCount * Float32Array.BYTES_PER_ELEMENT) errors.push(`${ear} FIR \u5B57\u8282\u957F\u5EA6\u4E0E tapCount \u4E0D\u7B26`);
    try {
      decodeRawFir(buffer, asset.fileName);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `${ear} FIR \u65E0\u6548`);
    }
  }
  const sharedAsset = profile.leftFir.fileName === profile.rightFir.fileName || profile.leftFir.sha256 === profile.rightFir.sha256;
  if (profile.measurementMode === "independent-lr" && sharedAsset) errors.push("\u72EC\u7ACB L/R profile \u7684\u5DE6\u53F3 FIR \u5FC5\u987B\u662F\u72EC\u7ACB\u8D44\u4EA7");
  if (profile.measurementMode === "average-dual-mono" && !sharedAsset) errors.push("\u5E73\u5747\u53CC\u5355\u58F0\u9053 profile \u7684\u5DE6\u53F3 FIR \u5FC5\u987B\u6307\u5411\u540C\u4E00\u8D44\u4EA7");
  return errors;
}
function registerLocalHeadphoneCompensation(data) {
  const errors = validateLocalHeadphoneProfile(data);
  if (errors.length) throw new Error(`\u672C\u5730\u8033\u673A\u8865\u507F profile \u65E0\u6548: ${errors.join("\uFF1B")}`);
  localProfiles.set(data.profile.id, data);
  rawCache.delete(data.profile.id);
}
function unregisterLocalHeadphoneCompensation(id) {
  rawCache.delete(id);
  return localProfiles.delete(id);
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
    output[i] = (a + (b - a) * fraction) * ratio;
  }
  return output;
}
async function getRawHeadphoneCompensation(profile) {
  let request = rawCache.get(profile.id);
  if (!request) {
    const local = localProfiles.get(profile.id);
    request = local ? Promise.resolve({
      profile: local.profile,
      left: decodeRawFir(local.leftFir, local.profile.leftFir.fileName),
      right: decodeRawFir(local.rightFir, local.profile.rightFir.fileName)
    }) : bundledAssetLoader ? Promise.all([
      bundledAssetLoader(profile.leftFirUrl),
      bundledAssetLoader(profile.rightFirUrl)
    ]).then(([leftBuffer, rightBuffer]) => ({
      profile,
      left: decodeRawFir(leftBuffer, profile.leftFirUrl),
      right: decodeRawFir(rightBuffer, profile.rightFirUrl)
    })) : Promise.all([fetch(profile.leftFirUrl), fetch(profile.rightFirUrl)]).then(async ([left, right]) => {
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
var BINAURAL_EQ_BANDS = [
  { band: "low", type: "lowshelf", frequency: 120, q: 0.7 },
  { band: "mid", type: "peaking", frequency: 1200, q: 0.8 },
  { band: "high", type: "highshelf", frequency: 6e3, q: 0.7 }
];
var LFE_LOWPASS_HZ = 120;
var BINAURAL_LFE_INBAND_GAIN = 1;
var BINAURAL_MAKEUP_GAIN = Math.pow(10, 6 / 20);
var BINAURAL_PEAK_GUARD_CEILING_DB = -1;
var BINAURAL_PEAK_GUARD_LOOKAHEAD_S = 5e-3;
var BINAURAL_LFE_PEAK_THRESHOLD_DB = -3;
var BINAURAL_LFE_PEAK_KNEE_DB = 0;
var BINAURAL_LFE_PEAK_RATIO = 8;
var BINAURAL_LFE_PEAK_ATTACK_S = 3e-3;
var BINAURAL_LFE_PEAK_RELEASE_S = 0.1;
var BINAURAL_BANKS = ["off", "near", "mid", "far"];
var BINAURAL_NOT_INDICATED_DEFAULT = "mid";
var PCM_RING_SAMPLES = 1 << 18;
function biquadMagnitude(type, frequency, q, gainDb, sampleRate, probeFrequency) {
  const a = 10 ** (gainDb / 40);
  const w0 = 2 * Math.PI * frequency / sampleRate;
  const cos0 = Math.cos(w0);
  const sin0 = Math.sin(w0);
  const alpha = type === "peaking" ? sin0 / (2 * q) : sin0 / Math.SQRT2;
  const beta = 2 * Math.sqrt(a) * alpha;
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;
  if (type === "peaking") {
    b0 = 1 + alpha * a;
    b1 = -2 * cos0;
    b2 = 1 - alpha * a;
    a0 = 1 + alpha / a;
    a1 = -2 * cos0;
    a2 = 1 - alpha / a;
  } else if (type === "lowshelf") {
    b0 = a * (a + 1 - (a - 1) * cos0 + beta);
    b1 = 2 * a * (a - 1 - (a + 1) * cos0);
    b2 = a * (a + 1 - (a - 1) * cos0 - beta);
    a0 = a + 1 + (a - 1) * cos0 + beta;
    a1 = -2 * (a - 1 + (a + 1) * cos0);
    a2 = a + 1 + (a - 1) * cos0 - beta;
  } else {
    b0 = a * (a + 1 + (a - 1) * cos0 + beta);
    b1 = -2 * a * (a - 1 + (a + 1) * cos0);
    b2 = a * (a + 1 + (a - 1) * cos0 - beta);
    a0 = a + 1 - (a - 1) * cos0 + beta;
    a1 = 2 * (a - 1 - (a + 1) * cos0);
    a2 = a + 1 - (a - 1) * cos0 - beta;
  }
  const w = 2 * Math.PI * probeFrequency / sampleRate;
  const numeratorRe = b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w);
  const numeratorIm = -b1 * Math.sin(w) - b2 * Math.sin(2 * w);
  const denominatorRe = a0 + a1 * Math.cos(w) + a2 * Math.cos(2 * w);
  const denominatorIm = -a1 * Math.sin(w) - a2 * Math.sin(2 * w);
  return Math.hypot(numeratorRe, numeratorIm) / Math.hypot(denominatorRe, denominatorIm);
}
function binauralEqHeadroomDb(bands, sampleRate = 48e3) {
  const nyquist = sampleRate / 2;
  let maxMagnitude = 1;
  for (let i = 0; i <= 2048; i++) {
    const probeFrequency = 10 * (nyquist / 10) ** (i / 2048);
    let magnitude = 1;
    for (const filter of BINAURAL_EQ_BANDS) {
      magnitude *= biquadMagnitude(filter.type, filter.frequency, filter.q, bands[filter.band], sampleRate, probeFrequency);
    }
    maxMagnitude = Math.max(maxMagnitude, magnitude);
  }
  const maxBoostDb = 20 * Math.log10(maxMagnitude);
  return maxBoostDb > 1e-6 ? -maxBoostDb - 0.2 : 0;
}
function stereoDownmixGains(speaker) {
  if (speaker.isLfe) return [0.25 * 0.7, 0.25 * 0.7];
  const pan = Math.sin(speaker.azimuth * Math.PI / 180);
  return [Math.sqrt((1 + pan) / 2) * 0.7, Math.sqrt((1 - pan) / 2) * 0.7];
}
function virtualLayoutForOutput(layout, _mode) {
  return layout;
}
function binauralBank(mode, fallback) {
  if (mode === "off" || mode === "near" || mode === "mid" || mode === "far") return mode;
  return mode === "not-indicated" ? BINAURAL_NOT_INDICATED_DEFAULT : fallback;
}
function sizeToSpread(size) {
  return Math.min(1, (size[0] + size[1] + size[2]) / 3);
}
var SpatialRenderer = class {
  ctx;
  /** 当前用于 VBAP 与床层语义的布局；运行中可切换。 */
  layout;
  /** Active gain-vector layout. Geometry is identical in every output mode. */
  renderLayout;
  /** Current logical-layout bus -> fixed worklet topology bus. Rebuilt only when
   * the layout changes, never while processing object motion. */
  renderToTopology;
  /** 固定的最大总线拓扑。AudioWorklet 与卷积图始终按它保持存活。 */
  topology;
  mode;
  /** 三条常驻模式路径的最终增益，实时切换只对它们做交叉淡化。 */
  modeGains = /* @__PURE__ */ new Map();
  modeVolumeGains = /* @__PURE__ */ new Map();
  modeProgramGains = /* @__PURE__ */ new Map();
  multichannelOutput = null;
  multichannelProjector = null;
  volume = 1;
  volumeBalanceEnabled = false;
  programLoudnessGainDb = null;
  vbap;
  node = null;
  /** 常驻最终 sample-peak guard；后级图重建时复用，不触碰播放时间线。 */
  peakGuard = null;
  master = null;
  postNodes = [];
  /** Per-bank binaural convolution nodes; branches are created only when used. */
  convs = /* @__PURE__ */ new Map();
  binauralMerger = null;
  binauralLfeInput = null;
  sources = /* @__PURE__ */ new Map();
  retiringSources = /* @__PURE__ */ new Map();
  nextRetirementToken = 1;
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
  /** User-controlled final 3-band EQ. Never affects stereo or physical multichannel output. */
  binauralEqBands = { low: 0, mid: 0, high: 0 };
  /** 常驻最终双耳 EQ；实时滑动只改这些 AudioParam，不重建输出图。 */
  binauralEqNodes = /* @__PURE__ */ new Map();
  binauralEqHeadroom = null;
  /** 当前输出图 revision；迟到的 FIR 请求不得接回已重建的图。 */
  outputGraphRevision = 0;
  /** 已就绪的 context-local FIR buffers；切 profile 或重建 context 时清空。 */
  headphoneBuffers = null;
  /** Persistent final-output dry/wet insert. Profile changes never rebuild spatial BRIR paths. */
  headphoneDry = null;
  headphoneWet = null;
  headphoneInput = null;
  headphoneOutput = null;
  headphonePreamp = null;
  headphoneConvolvers = null;
  onConsumedTick;
  onBatchResult;
  /** Frames actually rendered by the worklet (authoritative playhead). */
  consumedSamples = 0;
  /** Reset generation. Only ticks from the active generation may move the playhead. */
  epoch = 0;
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.mode = options.mode ?? "binaural";
    this.layout = options.layout ?? LAYOUT_7_1_4;
    this.topology = RENDER_TOPOLOGY;
    this.renderLayout = virtualLayoutForOutput(this.layout, this.mode);
    this.renderToTopology = this.buildRenderProjection();
    this.vbap = new VbapSolver(this.renderLayout);
    if (options.binauralIrSet) this.irSet = options.binauralIrSet;
    this.onConsumedTick = options.onConsumedTick;
    this.onBatchResult = options.onBatchResult;
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
  updateDestinationChannelCount() {
    const destination = this.ctx.destination;
    try {
      destination.channelCountMode = "explicit";
      destination.channelCount = Math.max(2, Math.min(this.layout.length, destination.maxChannelCount || this.layout.length));
    } catch {
    }
  }
  layoutId(layout) {
    return layout.map(speakerBusKey).join(",");
  }
  retirePostNodes(nodes, delayMs) {
    globalThis.setTimeout(() => {
      nodes.forEach((node) => node.disconnect());
      const retired = new Set(nodes);
      this.postNodes = this.postNodes.filter((node) => !retired.has(node));
    }, delayMs);
  }
  createMultichannelProjector(layout, initialGain) {
    const output = this.multichannelOutput;
    if (!this.node || !output) return null;
    const nodes = [];
    const merger = this.ctx.createChannelMerger(layout.length);
    BINAURAL_BANKS.forEach((_bank, outputIndex) => {
      const splitter = this.ctx.createChannelSplitter(this.topology.length);
      this.node.connect(splitter, outputIndex);
      physicalChannelOrder(layout).forEach((layoutBus, channel) => {
        const topologyBus = this.topology.findIndex(
          (speaker) => speakerBusKey(speaker) === speakerBusKey(layout[layoutBus])
        );
        if (topologyBus >= 0) splitter.connect(merger, topologyBus, channel);
      });
      nodes.push(splitter);
    });
    const gain = this.ctx.createGain();
    gain.gain.value = initialGain;
    merger.connect(gain);
    gain.connect(output);
    nodes.push(merger, gain);
    this.postNodes.push(...nodes);
    return { id: this.layoutId(layout), gain, nodes };
  }
  updateMultichannelLayout() {
    const id = this.layoutId(this.layout);
    if (!this.multichannelOutput || this.multichannelProjector?.id === id) return;
    const next = this.createMultichannelProjector(this.layout, 0);
    if (!next) return;
    const previous = this.multichannelProjector;
    this.multichannelProjector = next;
    const now = this.ctx.currentTime;
    next.gain.gain.setValueAtTime(0, now);
    next.gain.gain.linearRampToValueAtTime(1, now + 0.05);
    if (previous) {
      previous.gain.gain.cancelScheduledValues(now);
      previous.gain.gain.setValueAtTime(previous.gain.gain.value, now);
      previous.gain.gain.linearRampToValueAtTime(0, now + 0.05);
      this.retirePostNodes(previous.nodes, 100);
    }
  }
  buildRenderProjection() {
    const topologyByKey = new Map(
      this.topology.map((speaker, index) => [speakerBusKey(speaker), index])
    );
    return Int16Array.from(
      this.renderLayout.map((speaker) => topologyByKey.get(speakerBusKey(speaker)) ?? -1)
    );
  }
  updateRenderLayout() {
    this.renderLayout = virtualLayoutForOutput(this.layout, this.mode);
    this.renderToTopology = this.buildRenderProjection();
    this.vbap = new VbapSolver(this.renderLayout);
    for (const state of this.sources.values()) {
      if (state.bedLabel && !state.isLfe) {
        state.snapBus = this.renderLayout.findIndex((speaker) => speaker.name === state.bedLabel);
      }
    }
  }
  /** 改变逻辑布局而不重建 AudioContext/worklet。现有 PCM、播放头和卷积图继续
   * 存活；所有源通过短增益斜坡迁移到固定最大总线中的新位置。 */
  setLayout(layout) {
    if (layout === this.layout) return;
    this.layout = layout;
    this.updateRenderLayout();
    this.buildExpansion();
    this.updateMultichannelLayout();
    this.updateDestinationChannelCount();
    for (const state of this.sources.values()) {
      this.applyGains(state, 2048);
    }
  }
  async init(workletModuleUrl) {
    await this.ctx.audioWorklet.addModule(workletModuleUrl);
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.node = new AudioWorkletNode(this.ctx, "sda-renderer", {
      numberOfInputs: 0,
      numberOfOutputs: BINAURAL_BANKS.length,
      outputChannelCount: BINAURAL_BANKS.map(() => this.topology.length),
      processorOptions: { busCount: this.topology.length, epoch: this.epoch }
    });
    this.node.port.onmessage = (e) => {
      if (e.data?.type === "ready") {
        console.log(`[SDA] audio worklet ${String(e.data.build ?? "unknown")} ring=${e.data.ringSize}`);
      } else if (e.data?.type === "tick" && e.data.epoch === this.epoch) {
        this.consumedSamples = e.data.consumed;
        this.onConsumedTick?.({
          underrunSamples: Number(e.data.underrunSamples) || 0,
          rejectedBatches: Number(e.data.rejectedBatches) || 0,
          rejectedSources: Number(e.data.rejectedSources) || 0
        });
      } else if (e.data?.type === "sourceRetired") {
        const id = String(e.data.id ?? "");
        const token = Number(e.data.token);
        if (this.retiringSources.get(id) === token) {
          this.retiringSources.delete(id);
          this.sources.delete(id);
        }
      } else if (e.data?.type === "batchAck") {
        this.onBatchResult?.({ sequence: e.data.sequence, accepted: true, samples: e.data.samples });
      } else if (e.data?.type === "batchRejected") {
        this.onBatchResult?.({ sequence: e.data.sequence, accepted: false, samples: 0, reason: String(e.data.reason ?? "unknown") });
      }
    };
    this.peakGuard = new AudioWorkletNode(this.ctx, "sda-final-peak-guard", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { ceilingDb: BINAURAL_PEAK_GUARD_CEILING_DB }
    });
    this.peakGuard.port.postMessage({ type: "programEnabled", enabled: this.volumeBalanceEnabled });
    this.peakGuard.port.postMessage({
      type: "programGain",
      gain: this.programLoudnessGainDb === null ? 1 : Math.pow(10, this.programLoudnessGainDb / 20)
    });
    this.buildOutputGraph();
  }
  /** 注入双耳 IR 集；双耳路径常驻，即使当前未选双耳也立即更新，便于实时切回。 */
  setBinauralData(set) {
    this.irSet = set;
    if (this.node) this.buildOutputGraph();
  }
  /** True only after the measured binaural IR set has replaced browser Panner fallback. */
  get hasBinauralData() {
    return this.irSet !== null;
  }
  /** 切换杜比近/中/远：重混每总线 IR（干 HRIR ↔ 湿 BRIR）；对象的空间位置和
   * 制作响度不变，播放不中断。 */
  setBinauralMode(mode) {
    if (mode === this.binauralMode) return;
    this.binauralMode = mode;
    this.buildBinauralBank(mode, this.topology.length);
    const bank = BINAURAL_BANKS.indexOf(mode);
    for (const state of this.sources.values()) {
      if (!state.binauralMode) this.node?.port.postMessage({ type: "binauralMode", id: state.id, bank });
    }
  }
  get binauralModeName() {
    return this.binauralMode;
  }
  /** Apply static program-level DBMD metadata. It is deliberately not tied to
   * sample events: Dolby Binaural Render Mode is not automatable. */
  setSourceBinauralMode(id, mode) {
    const state = this.sources.get(id);
    if (!state) return false;
    state.binauralMode = mode;
    const bankName = binauralBank(mode, this.binauralMode);
    const bank = BINAURAL_BANKS.indexOf(bankName);
    this.buildBinauralBank(bankName, this.topology.length);
    this.node?.port.postMessage({ type: "binauralMode", id, bank });
    return true;
  }
  /** Select final binaural compensation without rebuilding spatial BRIR paths. */
  setHeadphoneCompensation(profileId) {
    if (profileId !== null && !headphoneProfileById(profileId)) {
      throw new Error(`\u672A\u77E5\u6216\u672A\u6CE8\u518C\u7684\u8033\u673A\u8865\u507F profile: ${profileId}`);
    }
    this.headphoneProfileId = profileId;
    if (!profileId) {
      this.headphoneBuffers = null;
      const retired = [
        ...this.headphoneWet ?? [],
        ...this.headphonePreamp ?? [],
        ...this.headphoneConvolvers ?? []
      ];
      this.crossfadeHeadphoneCompensation(false);
      this.headphoneWet = null;
      this.headphonePreamp = null;
      this.headphoneConvolvers = null;
      this.retirePostNodes(retired, 250);
      return;
    }
    this.headphoneBuffers = null;
    this.loadHeadphoneCompensation();
  }
  get headphoneCompensationProfile() {
    return headphoneProfileById(this.headphoneProfileId);
  }
  setEqHeadroom(bands) {
    if (!this.binauralEqHeadroom) return;
    const attenuationDb = binauralEqHeadroomDb(bands, this.ctx.sampleRate);
    const target = Math.pow(10, attenuationDb / 20);
    const now = this.ctx.currentTime;
    const gain = this.binauralEqHeadroom.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(target, now + (target < gain.value ? 0.01 : 0.1));
  }
  /** 设置最终双耳输出的低、中、高三段连续 EQ（-12 至 +12 dB）。 */
  setBinauralEqBands(bands) {
    const next = {
      low: Math.max(-12, Math.min(12, bands.low)),
      mid: Math.max(-12, Math.min(12, bands.mid)),
      high: Math.max(-12, Math.min(12, bands.high))
    };
    if (next.low === this.binauralEqBands.low && next.mid === this.binauralEqBands.mid && next.high === this.binauralEqBands.high) return;
    this.binauralEqBands = next;
    this.setEqHeadroom(next);
    const now = this.ctx.currentTime;
    for (const [band, nodes] of this.binauralEqNodes) {
      for (const node of nodes) {
        node.gain.cancelScheduledValues(now);
        node.gain.setValueAtTime(node.gain.value, now);
        node.gain.linearRampToValueAtTime(next[band], now + 0.04);
      }
    }
  }
  get binauralEq() {
    return this.binauralEqBands;
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
    this.updateRenderLayout();
    for (const state of this.sources.values()) this.applyGains(state, 2048);
  }
  get outputMode() {
    return this.mode;
  }
  teardownPostNodes() {
    this.outputGraphRevision++;
    for (const n of this.postNodes) n.disconnect();
    this.postNodes = [];
    this.convs.clear();
    this.binauralMerger = null;
    this.binauralLfeInput = null;
    this.headphoneDry = null;
    this.headphoneWet = null;
    this.headphoneInput = null;
    this.headphoneOutput = null;
    this.headphonePreamp = null;
    this.headphoneConvolvers = null;
    this.binauralEqNodes.clear();
    this.binauralEqHeadroom = null;
    this.modeGains.clear();
    this.modeVolumeGains.clear();
    this.modeProgramGains.clear();
    this.multichannelOutput = null;
    this.multichannelProjector = null;
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
    this.peakGuard?.disconnect();
    this.teardownPostNodes();
    const n = this.topology.length;
    const master = this.master;
    this.updateDestinationChannelCount();
    const createModeOutput = (mode) => {
      const volume = this.ctx.createGain();
      const program = this.ctx.createGain();
      const gain = this.ctx.createGain();
      volume.gain.value = this.volume ** 2;
      program.gain.value = 1;
      gain.gain.value = mode === this.mode ? 1 : 0;
      volume.connect(program);
      program.connect(gain);
      if (mode === "multichannel") {
        const delay = this.ctx.createDelay(BINAURAL_PEAK_GUARD_LOOKAHEAD_S);
        delay.delayTime.value = BINAURAL_PEAK_GUARD_LOOKAHEAD_S;
        gain.connect(delay);
        delay.connect(master);
        this.postNodes.push(delay);
      } else {
        const peakGuard = this.peakGuard;
        if (!peakGuard) throw new Error("SpatialRenderer.init() peak guard missing");
        gain.connect(peakGuard);
      }
      this.modeVolumeGains.set(mode, volume);
      this.modeProgramGains.set(mode, program);
      this.modeGains.set(mode, gain);
      this.postNodes.push(volume, program, gain);
      return volume;
    };
    this.buildMultichannelPath(n, createModeOutput("multichannel"));
    this.buildStereoPath(n, createModeOutput("stereo"));
    this.buildBinauralPath(n, createModeOutput("binaural"));
    this.peakGuard?.connect(master);
    this.loadHeadphoneCompensation();
  }
  crossfadeHeadphoneCompensation(wet) {
    if (!this.headphoneDry || !this.headphoneWet) return;
    const now = this.ctx.currentTime;
    const duration = 0.05;
    const dryTarget = wet ? 0 : 1;
    const wetTarget = wet ? 1 : 0;
    for (const node of [...this.headphoneDry, ...this.headphoneWet]) {
      const target = this.headphoneDry.includes(node) ? dryTarget : wetTarget;
      node.gain.cancelScheduledValues(now);
      node.gain.setValueAtTime(node.gain.value, now);
      node.gain.linearRampToValueAtTime(target, now + duration);
    }
  }
  installHeadphoneCompensation(buffers) {
    const profile = headphoneProfileById(this.headphoneProfileId);
    if (!profile || !this.headphoneInput || !this.headphoneOutput || !this.headphoneDry) return;
    const left = this.ctx.createConvolver();
    const right = this.ctx.createConvolver();
    const preampLeft = this.ctx.createGain();
    const preampRight = this.ctx.createGain();
    const wetLeft = this.ctx.createGain();
    const wetRight = this.ctx.createGain();
    left.normalize = false;
    right.normalize = false;
    left.buffer = buffers.left;
    right.buffer = buffers.right;
    const preamp = Math.pow(10, profile.preampDb / 20);
    preampLeft.gain.value = preamp;
    preampRight.gain.value = preamp;
    wetLeft.gain.value = 0;
    wetRight.gain.value = 0;
    this.headphoneInput.connect(left, 0);
    this.headphoneInput.connect(right, 1);
    left.connect(preampLeft);
    right.connect(preampRight);
    preampLeft.connect(wetLeft);
    preampRight.connect(wetRight);
    wetLeft.connect(this.headphoneOutput, 0, 0);
    wetRight.connect(this.headphoneOutput, 0, 1);
    const retired = [
      ...this.headphoneWet ?? [],
      ...this.headphonePreamp ?? [],
      ...this.headphoneConvolvers ?? []
    ];
    const oldWet = this.headphoneWet;
    this.headphoneWet = [wetLeft, wetRight];
    this.headphonePreamp = [preampLeft, preampRight];
    this.headphoneConvolvers = [left, right];
    this.postNodes.push(left, right, preampLeft, preampRight, wetLeft, wetRight);
    const now = this.ctx.currentTime;
    for (const node of this.headphoneDry) {
      node.gain.cancelScheduledValues(now);
      node.gain.setValueAtTime(node.gain.value, now);
      node.gain.linearRampToValueAtTime(0, now + 0.05);
    }
    for (const node of oldWet ?? []) {
      node.gain.cancelScheduledValues(now);
      node.gain.setValueAtTime(node.gain.value, now);
      node.gain.linearRampToValueAtTime(0, now + 0.05);
    }
    for (const node of [wetLeft, wetRight]) node.gain.linearRampToValueAtTime(1, now + 0.05);
    this.retirePostNodes(retired, 250);
  }
  loadHeadphoneCompensation() {
    const profile = headphoneProfileById(this.headphoneProfileId);
    if (!profile) return;
    if (this.headphoneBuffers) {
      this.installHeadphoneCompensation(this.headphoneBuffers);
      return;
    }
    const revision = this.outputGraphRevision;
    void getHeadphoneCompensationBuffers(this.ctx, profile).then((buffers) => {
      if (this.headphoneProfileId !== profile.id || revision !== this.outputGraphRevision || this.ctx.state === "closed") return;
      this.headphoneBuffers = buffers;
      this.installHeadphoneCompensation(buffers);
      console.log(`[SDA] \u8033\u673A\u8865\u507F\u5DF2\u542F\u7528: ${profile.id} (${buffers.left.length}/${buffers.right.length} taps)`);
    }).catch((error) => console.warn(`[SDA] \u8033\u673A\u8865\u507F\u52A0\u8F7D\u5931\u8D25\uFF0C\u4FDD\u6301 bypass: ${profile.id}`, error));
  }
  /** Physical output keeps the 18-bus worklet topology internal, then compacts
   * the selected layout into contiguous WASAPI-mask order. */
  buildMultichannelPath(_n, output) {
    this.multichannelOutput = output;
    this.multichannelProjector = this.createMultichannelProjector(this.layout, 1);
  }
  /** 常驻立体声 downmix，输出只占固定物理通道 0/1。 */
  buildStereoPath(n, output) {
    const merger = this.ctx.createChannelMerger(2);
    BINAURAL_BANKS.forEach((_bank, outputIndex) => {
      const splitter = this.ctx.createChannelSplitter(n);
      this.node.connect(splitter, outputIndex);
      for (let bus = 0; bus < n; bus++) {
        const spk = this.topology[bus];
        const gainL = this.ctx.createGain();
        const gainR = this.ctx.createGain();
        const [left, right] = stereoDownmixGains(spk);
        gainL.gain.value = left;
        gainR.gain.value = right;
        splitter.connect(gainL, bus);
        splitter.connect(gainR, bus);
        gainL.connect(merger, 0, 0);
        gainR.connect(merger, 0, 1);
        this.postNodes.push(gainL, gainR);
      }
      this.postNodes.push(splitter);
    });
    merger.connect(output);
    this.postNodes.push(merger);
  }
  buildBinauralBank(bank, n) {
    if (!this.node || !this.binauralMerger || this.convs.has(bank)) return;
    const outputIndex = BINAURAL_BANKS.indexOf(bank);
    const splitter = this.ctx.createChannelSplitter(n);
    this.node.connect(splitter, outputIndex);
    const convs = [];
    const mode = bank === "far" ? "far" : bank === "mid" ? "mid" : "near";
    const busIrs = this.irSet && bank !== "off" ? buildBusIrs(this.ctx, this.irSet, this.topology, mode) : null;
    for (let bus = 0; bus < n; bus++) {
      const spk = this.topology[bus];
      if (spk.isLfe) {
        const lfeGain = this.ctx.createGain();
        const [lpIn, lpOut] = this.lr4("lowpass", LFE_LOWPASS_HZ);
        splitter.connect(lpIn, bus);
        lfeGain.gain.value = BINAURAL_LFE_INBAND_GAIN;
        lpOut.connect(lfeGain);
        if (this.binauralLfeInput) lfeGain.connect(this.binauralLfeInput);
        this.postNodes.push(lpIn, lpOut, lfeGain);
        convs.push(null);
        continue;
      }
      if (bank === "off") {
        const direct = this.ctx.createGain();
        direct.gain.value = 0.5;
        splitter.connect(direct, bus);
        direct.connect(this.binauralMerger, 0, 0);
        direct.connect(this.binauralMerger, 0, 1);
        this.postNodes.push(direct);
        convs.push(null);
        continue;
      }
      const ir = busIrs?.get(bus);
      if (ir) {
        const conv = this.ctx.createConvolver();
        conv.normalize = false;
        conv.buffer = ir;
        const earSplit = this.ctx.createChannelSplitter(2);
        splitter.connect(conv, bus);
        conv.connect(earSplit);
        earSplit.connect(this.binauralMerger, 0, 0);
        earSplit.connect(this.binauralMerger, 1, 1);
        this.postNodes.push(conv, earSplit);
        convs.push(conv);
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
        earSplit.connect(this.binauralMerger, 0, 0);
        earSplit.connect(this.binauralMerger, 1, 1);
        this.postNodes.push(panner, earSplit);
        convs.push(null);
      }
    }
    this.convs.set(bank, convs);
    this.postNodes.push(splitter);
  }
  /** Per-mode double-ear rendering. The worklet exposes four 18-channel
   * outputs, avoiding the browser's single-node channel limit. */
  buildBinauralPath(n, output) {
    const merger = this.ctx.createChannelMerger(2);
    const makeup = this.ctx.createGain();
    makeup.gain.value = BINAURAL_MAKEUP_GAIN;
    const peakGuard = this.peakGuard;
    if (!peakGuard) throw new Error("SpatialRenderer.init() peak guard missing");
    this.binauralMerger = merger;
    const lfeSum = this.ctx.createGain();
    const lfePeak = this.ctx.createDynamicsCompressor();
    const lfeOut = this.ctx.createGain();
    lfePeak.threshold.value = BINAURAL_LFE_PEAK_THRESHOLD_DB;
    lfePeak.knee.value = BINAURAL_LFE_PEAK_KNEE_DB;
    lfePeak.ratio.value = BINAURAL_LFE_PEAK_RATIO;
    lfePeak.attack.value = BINAURAL_LFE_PEAK_ATTACK_S;
    lfePeak.release.value = BINAURAL_LFE_PEAK_RELEASE_S;
    lfeOut.gain.value = 0.5;
    lfeSum.connect(lfePeak);
    lfePeak.connect(lfeOut);
    lfeOut.connect(merger, 0, 0);
    lfeOut.connect(merger, 0, 1);
    this.binauralLfeInput = lfeSum;
    this.postNodes.push(lfeSum, lfePeak, lfeOut);
    const activeBanks = /* @__PURE__ */ new Set([this.binauralMode]);
    for (const source of this.sources.values()) activeBanks.add(binauralBank(source.binauralMode, this.binauralMode));
    for (const bank of activeBanks) this.buildBinauralBank(bank, n);
    let finalBinaural = merger;
    const compensationSplit = this.ctx.createChannelSplitter(2);
    const compensationMerge = this.ctx.createChannelMerger(2);
    const dryLeft = this.ctx.createGain();
    const dryRight = this.ctx.createGain();
    dryLeft.gain.value = 1;
    dryRight.gain.value = 1;
    merger.connect(compensationSplit);
    compensationSplit.connect(dryLeft, 0);
    compensationSplit.connect(dryRight, 1);
    dryLeft.connect(compensationMerge, 0, 0);
    dryRight.connect(compensationMerge, 0, 1);
    this.headphoneInput = compensationSplit;
    this.headphoneOutput = compensationMerge;
    this.headphoneDry = [dryLeft, dryRight];
    this.headphoneWet = null;
    this.headphonePreamp = null;
    this.headphoneConvolvers = null;
    this.postNodes.push(compensationSplit, compensationMerge, dryLeft, dryRight);
    finalBinaural = compensationMerge;
    const eqSplit = this.ctx.createChannelSplitter(2);
    const eqMerge = this.ctx.createChannelMerger(2);
    const eqHeadroom = this.ctx.createGain();
    this.binauralEqHeadroom = eqHeadroom;
    this.setEqHeadroom(this.binauralEqBands);
    finalBinaural.connect(eqHeadroom);
    eqHeadroom.connect(eqSplit);
    for (const filter of BINAURAL_EQ_BANDS) {
      const left = this.ctx.createBiquadFilter();
      const right = this.ctx.createBiquadFilter();
      for (const node of [left, right]) {
        node.type = filter.type;
        node.frequency.value = filter.frequency;
        node.Q.value = filter.q;
        node.gain.value = this.binauralEqBands[filter.band];
      }
      this.binauralEqNodes.set(filter.band, [left, right]);
      this.postNodes.push(left, right);
    }
    const low = this.binauralEqNodes.get("low");
    const mid = this.binauralEqNodes.get("mid");
    const high = this.binauralEqNodes.get("high");
    eqSplit.connect(low[0], 0);
    low[0].connect(mid[0]);
    mid[0].connect(high[0]);
    high[0].connect(eqMerge, 0, 0);
    eqSplit.connect(low[1], 1);
    low[1].connect(mid[1]);
    mid[1].connect(high[1]);
    high[1].connect(eqMerge, 0, 1);
    this.postNodes.push(eqHeadroom, eqSplit, eqMerge);
    eqMerge.connect(makeup);
    makeup.connect(output);
    this.postNodes.push(merger, makeup);
  }
  rebindBedSource(id, bedLabel, atSample) {
    const state = this.sources.get(id);
    if (!state) {
      this.addSource(id, { bedLabel, atSample });
      return;
    }
    const normalized = aliasLabel(bedLabel);
    if (state.bedLabel === normalized) return;
    state.bedLabel = normalized;
    state.isLfe = isLfeLabel(bedLabel);
    state.position = positionForLabel(bedLabel);
    state.snapBus = state.isLfe ? -1 : this.renderLayout.findIndex((speaker) => speaker.name === normalized);
    this.recomputeBedGainsAt(Math.trunc(atSample), 32);
  }
  /** Register a source. Bed channels pass their speaker label; objects an event id.
   *  重复声明同一 id（稀疏声明变化时 player 会重放整组）完全幂等：保留
   *  SourceState/元数据/静音状态，也不向 worklet 重发即时 gains。 */
  addSource(id, opts = {}) {
    if (this.sources.has(id)) {
      if (this.retiringSources.delete(id)) {
        const at = Number.isSafeInteger(opts.atSample) ? Math.trunc(opts.atSample) : this.consumedSamples;
        const state2 = this.sources.get(id);
        this.scheduleSourceLifecycle(state2, at, true);
        this.node?.port.postMessage({ type: "add", id });
        this.node?.port.postMessage({
          type: "binauralMode",
          id,
          bank: BINAURAL_BANKS.indexOf(binauralBank(state2.binauralMode, this.binauralMode))
        });
        if (state2.muted) this.node?.port.postMessage({ type: "mute", id, muted: true, ramp: 32 });
        this.node?.port.postMessage({ type: "resumeAt", id, at });
        if (state2.bedLabel) this.recomputeBedGainsAt(at, 32);
        else this.applyGains(state2, 32, at);
      }
      return;
    }
    if (!this.node) throw new Error("SpatialRenderer.init() first");
    const state = {
      id,
      spread: 0,
      position: { azimuth: 0, elevation: 0, distance: 1 },
      gainDb: 0,
      hasObjectMetadata: false,
      objectRampEndSample: Number.NEGATIVE_INFINITY,
      isLfe: opts.bedLabel ? isLfeLabel(opts.bedLabel) : false,
      muted: false,
      bedLabel: opts.bedLabel ? aliasLabel(opts.bedLabel) : void 0,
      snapBus: -1,
      binauralMode: void 0,
      lifecycleEvents: [],
      lifecycleEventOrder: 0
    };
    if (opts.bedLabel) {
      state.position = positionForLabel(opts.bedLabel);
      if (!state.isLfe) {
        state.snapBus = this.renderLayout.findIndex((s) => s.name === state.bedLabel);
      }
    }
    this.sources.set(id, state);
    this.node.port.postMessage({ type: "add", id });
    this.node.port.postMessage({ type: "binauralMode", id, bank: BINAURAL_BANKS.indexOf(binauralBank(state.binauralMode, this.binauralMode)) });
    const atSample = Number.isSafeInteger(opts.atSample) ? Math.trunc(opts.atSample) : void 0;
    if (state.bedLabel && atSample !== void 0) {
      this.recomputeBedGainsAt(atSample, 32);
    } else {
      this.applyGains(state, 0);
      if (state.snapBus >= 0) this.recomputeBedGains(id);
    }
  }
  scheduleSourceLifecycle(state, at, active) {
    state.lifecycleEvents.push({ at, active, order: state.lifecycleEventOrder++ });
    state.lifecycleEvents.sort((left, right) => left.at - right.at || left.order - right.order);
  }
  sourceActiveAt(state, samplePos) {
    let active = true;
    for (const event of state.lifecycleEvents) {
      if (event.at > samplePos) break;
      active = event.active;
    }
    return active;
  }
  /** 床声道集合变化（新床声道占用/释放了扩展目标总线）→ 重推其余床声道的增益，
   *  让上混馈送跳过/恢复被真实声道占用的总线。 */
  recomputeBedGains(excludeId) {
    for (const s of this.sources.values()) {
      if (s.id !== excludeId && s.snapBus >= 0) this.applyGains(s, 512);
    }
  }
  recomputeBedGainsAt(atSample, rampSamples) {
    for (const state of this.sources.values()) {
      if (state.bedLabel && this.sourceActiveAt(state, atSample)) {
        this.applyGains(state, rampSamples, atSample);
      }
    }
  }
  /** 其余床声道在指定 sample 占用的总线（扩展馈送要避开）。 */
  bedOccupiedBuses(excludeId, atSample) {
    const occ = /* @__PURE__ */ new Set();
    for (const state of this.sources.values()) {
      const active = atSample === void 0 || this.sourceActiveAt(state, atSample);
      if (state.id !== excludeId && state.snapBus >= 0 && active) occ.add(state.snapBus);
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
  retireSourceAt(id, samplePos) {
    const state = this.sources.get(id);
    if (!state) return;
    const at = Math.trunc(samplePos);
    const token = this.nextRetirementToken++;
    this.scheduleSourceLifecycle(state, at, false);
    this.retiringSources.set(id, token);
    this.node?.port.postMessage({ type: "removeAt", id, at, token });
    if (state.bedLabel) this.recomputeBedGainsAt(at, 32);
  }
  removeSource(id) {
    const state = this.sources.get(id);
    this.sources.delete(id);
    this.retiringSources.delete(id);
    this.node?.port.postMessage({ type: "remove", id });
    if (state && state.snapBus >= 0) this.recomputeBedGains(id);
  }
  /** Largest safe prebuffer time, leaving one codec frame of ring headroom. */
  maxBufferedSeconds() {
    return Math.max(0.25, (PCM_RING_SAMPLES - 8192) / this.ctx.sampleRate);
  }
  startAt(samplePos) {
    const origin = Math.trunc(samplePos);
    this.node?.port.postMessage({ type: "start", origin });
    this.peakGuard?.port.postMessage({ type: "start", origin });
  }
  /** Feed PCM for a source (legacy single-source path). */
  feed(id, samples) {
    this.node?.port.postMessage({ type: "feed", id, samples }, [samples.buffer]);
  }
  /** Atomically enqueue every channel of one decoded frame at its absolute
   * codec sample position. Partial frame writes are rejected by the worklet. */
  feedBatch(sequence, samplePos, entries) {
    if (!this.node || entries.length === 0) {
      this.onBatchResult?.({ sequence, accepted: false, samples: 0, reason: "invalid" });
      return;
    }
    this.node.port.postMessage({ type: "feedBatch", sequence, start: Math.trunc(samplePos), entries });
  }
  /** Queue object events on the same absolute sample clock as their PCM. Exact
   * repeated targets are discarded before VBAP and MessagePort allocation. */
  applyEvents(events) {
    if (!this.node || events.length === 0) return 0;
    const messages = [];
    for (const ev of events) {
      const state = this.sources.get(`obj:${ev.id}`);
      if (!state) continue;
      const nextPosition = ev.hasPos ? admToSpherical(ev.pos) : state.position;
      const nextSpread = ev.hasPos ? sizeToSpread(ev.size) : state.spread;
      const ramp = ev.rampDuration || 128;
      const at = Math.trunc(ev.samplePos);
      const unchanged = state.hasObjectMetadata && state.objectRampEndSample <= at && state.position.azimuth === nextPosition.azimuth && state.position.elevation === nextPosition.elevation && state.position.distance === nextPosition.distance && state.spread === nextSpread && state.gainDb === ev.gainDb;
      if (unchanged) continue;
      state.position = nextPosition;
      state.spread = nextSpread;
      state.gainDb = ev.gainDb;
      state.hasObjectMetadata = true;
      state.objectRampEndSample = at + Math.max(1, ramp);
      messages.push(this.gainMessage(state, ramp, at));
    }
    if (messages.length === 1) this.node.port.postMessage(messages[0]);
    else if (messages.length > 1) this.node.port.postMessage({ type: "scheduleGainsBatch", entries: messages });
    return messages.length;
  }
  /** Queue one object event. Kept for control surfaces and focused tests. */
  applyEvent(ev, rampSamples) {
    const event = rampSamples === ev.rampDuration ? ev : { ...ev, rampDuration: rampSamples };
    return this.applyEvents([event]) > 0;
  }
  gainMessage(state, rampSamples, atSample) {
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
      const lfeBus = this.renderLayout.findIndex((s) => s.isLfe);
      if (lfeBus >= 0) gains[lfeBus] = 1;
      scalar = metadataGain;
      if (this.lfeMuted) scalar = 0;
      lp = 1;
    } else if (state.snapBus >= 0) {
      gains.fill(0);
      gains[state.snapBus] = 1;
      if (this.mode === "multichannel") {
        const occupied = this.bedOccupiedBuses(state.id, atSample);
        for (const e of this.expansion.get(state.snapBus) ?? []) {
          if (!occupied.has(e.bus)) gains[e.bus] = e.gain;
        }
      }
    }
    const topologyGains = new Float32Array(this.topology.length);
    for (let bus = 0; bus < gains.length; bus++) {
      const target = this.renderToTopology[bus] ?? -1;
      if (target >= 0) topologyGains[target] = gains[bus];
    }
    return {
      type: atSample === void 0 ? "gains" : "scheduleGains",
      id: state.id,
      at: atSample,
      gains: topologyGains,
      gain: scalar,
      lp,
      ramp: Math.max(1, rampSamples)
    };
  }
  /** Recompute and send a source's gain vector over the buses. */
  applyGains(state, rampSamples, atSample) {
    this.node?.port.postMessage(this.gainMessage(state, rampSamples, atSample));
  }
  /** Reset the codec timeline. MessagePort FIFO guarantees a following feed is
   * handled after reset; the epoch only rejects already-queued stale ticks. */
  resetBuffers() {
    this.epoch++;
    this.consumedSamples = 0;
    for (const id of this.retiringSources.keys()) {
      this.sources.delete(id);
      this.node?.port.postMessage({ type: "remove", id });
    }
    this.retiringSources.clear();
    for (const state of this.sources.values()) {
      state.lifecycleEvents.length = 0;
      state.lifecycleEventOrder = 0;
      if (!state.bedLabel) {
        state.hasObjectMetadata = false;
        state.objectRampEndSample = Number.NEGATIVE_INFINITY;
      }
    }
    this.node?.port.postMessage({ type: "reset", epoch: this.epoch });
    this.peakGuard?.port.postMessage({ type: "reset" });
  }
  /** Playhead in seconds: frames the worklet actually rendered. */
  consumedSeconds() {
    return this.consumedSamples / this.ctx.sampleRate;
  }
  /** Worklet-level pause: outputs silence without consuming the ring buffers,
   *  so resume continues from the exact sample. */
  setPaused(paused) {
    this.node?.port.postMessage({ type: "pause", paused });
    this.peakGuard?.port.postMessage({ type: "pause", paused });
  }
  setVolumeBalance(enabled) {
    this.volumeBalanceEnabled = enabled;
    this.peakGuard?.port.postMessage({ type: "programEnabled", enabled });
  }
  setProgramLoudnessGainDb(gainDb, atSample) {
    this.programLoudnessGainDb = gainDb === null || !Number.isFinite(gainDb) ? null : Math.min(0, gainDb);
    const gain = this.programLoudnessGainDb === null ? 1 : Math.pow(10, this.programLoudnessGainDb / 20);
    this.peakGuard?.port.postMessage({
      type: atSample === void 0 ? "programGain" : "scheduleProgramGain",
      gain,
      at: atSample === void 0 ? void 0 : Math.trunc(atSample)
    });
  }
  /** Master output volume, 0..1 (applied perceptually: gain = v²). */
  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    const now = this.ctx.currentTime;
    for (const node of this.modeVolumeGains.values()) {
      node.gain.cancelScheduledValues(now);
      node.gain.setValueAtTime(node.gain.value, now);
      node.gain.linearRampToValueAtTime(this.volume ** 2, now + 0.02);
    }
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
  RENDER_TOPOLOGY,
  SpatialRenderer,
  VbapSolver,
  admToSpherical,
  aliasLabel,
  availableHeadphoneCompensationProfiles,
  binauralEqHeadroomDb,
  buildBusIrs,
  detectLayoutId,
  getBinauralIrSet,
  getHeadphoneCompensationBuffers,
  headphoneProfileById,
  isLfeLabel,
  mixIrForMode,
  mixIrForWet,
  physicalChannelOrder,
  positionForLabel,
  registerLocalHeadphoneCompensation,
  setBinauralAssetLoader,
  setHeadphoneCompensationAssetLoader,
  speakerBusKey,
  sphericalToAdm,
  sphericalToWebAudio,
  stereoDownmixGains,
  unregisterLocalHeadphoneCompensation,
  validateHeadphoneProfile,
  validateLocalHeadphoneProfile,
  virtualLayoutForOutput
});
