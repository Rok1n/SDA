/**
 * Binaural IR pipeline — Apple AVAudioEnvironment / Dolby Atmos binaural style.
 *
 * 数据集：SADIE II（University of York，Apache-2.0）KU100 假头，
 * 由 scripts/build-hrtf.mjs 离线转成紧凑 JSON 清单 + f32le 原始文件：
 *
 *   hrtf-set.json:
 *     { "sampleRate": 48000,
 *       "positions": [ { "azimuth": 30, "elevation": 0,
 *                        "dry": "az30_el0_dry.f32",   // HRIR（消声室直达）
 *                        "wet": "az30_el0_wet.f32" }, // BRIR（含房间早期反射+尾音）
 *                      ... ] }
 *
 * 每个 .f32 文件：[leftIR Float32Array][rightIR Float32Array] 拼接，等长，
 * 离线已截断（HRIR 512 taps，BRIR 8192 taps ≈170ms 房间尾音）。
 *
 * 杜比 Near/Mid/Far 语义（Binaural Settings：虚拟音箱距离 0.7/1.2/2.5m）用
 * 「干 HRIR ↔ 湿 BRIR 按权重混合」实现 —— BRIR 自带房间响应，正是杜比
 * 房间 cue 的来源；距离越远湿声占比越高。
 */

export type BinauralMode = "near" | "mid" | "far";

export interface BinauralModeSpec {
  /** 湿（BRIR）混合权重，0 = 全干 HRIR，1 = 全房间。 */
  wet: number;
  /** 虚拟音箱参考距离（米，杜比近/中/远 ≈ 0.7/1.2/2.5）。 */
  refDistance: number;
}

export const BINAURAL_MODES: Record<BinauralMode, BinauralModeSpec> = {
  near: { wet: 0.15, refDistance: 0.7 },
  mid: { wet: 0.45, refDistance: 1.2 },
  far: { wet: 0.8, refDistance: 2.5 },
};

export interface HrtfManifestEntry {
  azimuth: number;
  elevation: number;
  dry: string;
  wet: string;
}

export interface HrtfManifest {
  sampleRate: number;
  positions: HrtfManifestEntry[];
}

/** 一个测量方向的原始干/湿 IR（ctx 无关，可跨 AudioContext 重建复用）。 */
export interface RawBinauralIr {
  azimuth: number;
  elevation: number;
  /** [leftIR][rightIR] 拼接；长度 = 2 × dryLen。 */
  dry: Float32Array;
  dryLen: number;
  wet: Float32Array;
  wetLen: number;
}

export interface BinauralIrSet {
  sampleRate: number;
  positions: RawBinauralIr[];
}

// ---- 加载（按 baseUrl 记忆化：重建 AudioContext 时不重复下载） ----

const setCache = new Map<string, Promise<BinauralIrSet>>();

/** 加载并缓存原始 IR 集。失败抛错，调用方决定回退策略。 */
export function getBinauralIrSet(baseUrl: string): Promise<BinauralIrSet> {
  let p = setCache.get(baseUrl);
  if (!p) {
    p = loadSet(baseUrl);
    p.catch(() => setCache.delete(baseUrl)); // 失败不缓存，下次可重试
    setCache.set(baseUrl, p);
  }
  return p;
}

async function loadSet(baseUrl: string): Promise<BinauralIrSet> {
  const res = await fetch(`${baseUrl}/hrtf-set.json`);
  if (!res.ok) throw new Error(`hrtf-set.json HTTP ${res.status}`);
  const manifest = (await res.json()) as HrtfManifest;

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
        }),
      ]);
      const dry = new Float32Array(dryBuf);
      const wet = new Float32Array(wetBuf);
      return {
        azimuth: entry.azimuth,
        elevation: entry.elevation,
        dry,
        dryLen: dry.length >> 1,
        wet,
        wetLen: wet.length >> 1,
      } satisfies RawBinauralIr;
    }),
  );
  return { sampleRate: manifest.sampleRate, positions };
}

// ---- 方向匹配：给虚拟音箱找最近的测量方向（球面角距） ----

function toUnit(azimuth: number, elevation: number): [number, number, number] {
  const az = (azimuth * Math.PI) / 180;
  const el = (elevation * Math.PI) / 180;
  return [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];
}

function nearestPosition(set: BinauralIrSet, azimuth: number, elevation: number): RawBinauralIr | null {
  const [tx, ty, tz] = toUnit(azimuth, elevation);
  let best: RawBinauralIr | null = null;
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

// ---- 混合 + 重采样 ----

/** 线性重采样（IR 长度短，线性足够；避免离线再产一套 44.1k 文件）。 */
function resampleLinear(ir: Float32Array, fromRate: number, toRate: number): Float32Array {
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

function argmaxAbs(x: Float32Array, limit: number): number {
  let idx = 0;
  let peak = 0;
  const n = Math.min(x.length, limit);
  for (let i = 0; i < n; i++) {
    const v = Math.abs(x[i]!);
    if (v > peak) {
      peak = v;
      idx = i;
    }
  }
  return idx;
}

/**
 * 按模式把干 HRIR 与湿 BRIR 混合成一条 IR：
 *   IR = (1-w)·HRIR + w·BRIR
 * 两者起点对齐到各自直达声峰值（HRIR 通常无预延迟，BRIR 含直达+房间），
 * 再重采样到 ctx 速率。
 */
export function mixIrForMode(ctx: AudioContext, set: BinauralIrSet, raw: RawBinauralIr, mode: BinauralMode): AudioBuffer {
  const w = BINAURAL_MODES[mode].wet;
  const rate = ctx.sampleRate;

  let dryL = raw.dry.subarray(0, raw.dryLen) as Float32Array;
  let dryR = raw.dry.subarray(raw.dryLen) as Float32Array;
  let wetL = raw.wet.subarray(0, raw.wetLen) as Float32Array;
  let wetR = raw.wet.subarray(raw.wetLen) as Float32Array;
  if (Math.abs(set.sampleRate - rate) >= 1) {
    dryL = resampleLinear(dryL, set.sampleRate, rate);
    dryR = resampleLinear(dryR, set.sampleRate, rate);
    wetL = resampleLinear(wetL, set.sampleRate, rate);
    wetR = resampleLinear(wetR, set.sampleRate, rate);
  }

  // 对齐：以左耳直达峰值为准（双耳共用同一 shift，保住 ITD）。
  // 只在 BRIR 前 20ms 内找直达峰，避免抓到房间反射峰。
  const search = Math.min(wetL.length, Math.round(rate * 0.02));
  const shift = argmaxAbs(wetL, search) - argmaxAbs(dryL, dryL.length);

  const outLen = wetL.length;
  const L = new Float32Array(outLen);
  const R = new Float32Array(outLen);
  for (let i = 0; i < dryL.length; i++) {
    const j = i + shift;
    if (j >= 0 && j < outLen) {
      L[j] = (1 - w) * dryL[i]!;
      R[j] = (1 - w) * dryR[i]!;
    }
  }
  for (let i = 0; i < outLen; i++) {
    L[i] = L[i]! + w * wetL[i]!;
    R[i] = R[i]! + w * wetR[i]!;
  }

  // 能量归一化（Omnitone 惯例）：近/中/远切换、不同方向之间响度一致，
  // 不会因为房间能量多少而忽大忽小。
  let energy = 0;
  for (let i = 0; i < outLen; i++) energy += L[i]! * L[i]! + R[i]! * R[i]!;
  if (energy > 0) {
    const s = 1 / Math.sqrt(energy);
    for (let i = 0; i < outLen; i++) {
      L[i] = L[i]! * s;
      R[i] = R[i]! * s;
    }
  }

  const buf = ctx.createBuffer(2, outLen, rate);
  buf.copyToChannel(L as Float32Array<ArrayBuffer>, 0);
  buf.copyToChannel(R as Float32Array<ArrayBuffer>, 1);
  return buf;
}

/**
 * 为整个虚拟音箱布局构建每总线一条立体声 IR（按最近测量方向匹配）。
 * LFE 不返回（低频无方向性，由渲染器直接分送双耳）。
 */
export function buildBusIrs(
  ctx: AudioContext,
  set: BinauralIrSet,
  layout: readonly { name: string; azimuth: number; elevation: number; isLfe?: boolean }[],
  mode: BinauralMode,
): Map<number, AudioBuffer> {
  const result = new Map<number, AudioBuffer>();
  layout.forEach((spk, bus) => {
    if (spk.isLfe) return;
    const raw = nearestPosition(set, spk.azimuth, spk.elevation);
    if (raw) result.set(bus, mixIrForMode(ctx, set, raw, mode));
  });
  return result;
}
