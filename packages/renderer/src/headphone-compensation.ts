/**
 * Headphone playback compensation profiles.
 *
 * Profiles belong after the final binaural stereo merge. They must never alter
 * the KU100 HRIR/BRIR assets or individual virtual-speaker buses.
 */

export interface HeadphoneCompensationProfile {
  /** Stable profile identifier. */
  id: string;
  /** Headphone model and revision as stated by the measurement source. */
  name: string;
  /** Public measurement source or a local, auditable measurement reference. */
  source: string;
  /** The response target used when deriving the correction FIRs. */
  target: string;
  sampleRate: number;
  /** Final stereo-output FIR asset URLs. Left/right may intentionally differ. */
  leftFirUrl: string;
  rightFirUrl: string;
  /** Fixed headroom before correction; must be zero or negative. */
  preampDb: number;
  /** Post-FIR 250Hz–2kHz pink-weighted RMS level match before global output calibration. */
  postFirLoudnessTrimDb: number;
}

export interface HeadphoneCompensationBuffers {
  left: AudioBuffer;
  right: AudioBuffer;
}

/**
 * AirPods Pro 2 ANC compensation uses AutoEq's crinacle 711 averaged response.
 * Both FIR files deliberately match: this is an averaged approximation, not an
 * independently measured left/right correction. See the colocated asset README.
 */
export const HEADPHONE_COMPENSATION_PROFILES: readonly HeadphoneCompensationProfile[] = [
  {
    id: "airpods-pro-2-anc-averaged",
    name: "AirPods Pro 2（ANC，平均测量近似）",
    source: "AutoEq crinacle 711 in-ear Apple AirPods Pro 2 (ANC mode), minimum-phase 48 kHz output",
    target: "AutoEq in-ear target; averaged response, not independent L/R measurement",
    sampleRate: 48000,
    leftFirUrl: "headphone-compensation/airpods-pro-2-anc-averaged/left.f32",
    rightFirUrl: "headphone-compensation/airpods-pro-2-anc-averaged/right.f32",
    preampDb: -3.4,
    postFirLoudnessTrimDb: 4.58,
  },
];

interface RawHeadphoneCompensation {
  profile: HeadphoneCompensationProfile;
  left: Float32Array;
  right: Float32Array;
}

const rawCache = new Map<string, Promise<RawHeadphoneCompensation>>();

export function headphoneProfileById(id: string | null): HeadphoneCompensationProfile | null {
  if (!id) return null;
  return HEADPHONE_COMPENSATION_PROFILES.find((profile) => profile.id === id) ?? null;
}

export function validateHeadphoneProfile(profile: HeadphoneCompensationProfile): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(profile.id)) errors.push("id 必须是小写 slug");
  if (!profile.name.trim()) errors.push("缺少耳机型号名称");
  if (!profile.source.trim()) errors.push("缺少测量来源");
  if (!profile.target.trim()) errors.push("缺少目标曲线说明");
  if (!Number.isFinite(profile.sampleRate) || profile.sampleRate <= 0) errors.push("采样率无效");
  if (!profile.leftFirUrl || !profile.rightFirUrl) errors.push("必须提供左右 FIR 资产");
  if (!Number.isFinite(profile.preampDb) || profile.preampDb > 0) errors.push("preampDb 必须为 0 或负值");
  if (!Number.isFinite(profile.postFirLoudnessTrimDb) || profile.postFirLoudnessTrimDb < 0 || profile.postFirLoudnessTrimDb > 6) {
    errors.push("postFirLoudnessTrimDb 必须在 0..6dB");
  }
  return errors;
}

function decodeRawFir(buffer: ArrayBuffer, url: string): Float32Array {
  if (!buffer.byteLength || buffer.byteLength % Float32Array.BYTES_PER_ELEMENT) {
    throw new Error(`耳机 FIR 无效字节长度: ${url}`);
  }
  const taps = new Float32Array(buffer);
  if (!taps.every(Number.isFinite)) throw new Error(`耳机 FIR 包含无效 tap: ${url}`);
  return taps;
}

function resampleLinear(taps: Float32Array, fromRate: number, toRate: number): Float32Array {
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

async function getRawHeadphoneCompensation(profile: HeadphoneCompensationProfile): Promise<RawHeadphoneCompensation> {
  let request = rawCache.get(profile.id);
  if (!request) {
    request = Promise.all([fetch(profile.leftFirUrl), fetch(profile.rightFirUrl)])
      .then(async ([left, right]) => {
        if (!left.ok) throw new Error(`耳机左 FIR HTTP ${left.status}: ${profile.leftFirUrl}`);
        if (!right.ok) throw new Error(`耳机右 FIR HTTP ${right.status}: ${profile.rightFirUrl}`);
        const [leftBuffer, rightBuffer] = await Promise.all([left.arrayBuffer(), right.arrayBuffer()]);
        return { profile, left: decodeRawFir(leftBuffer, profile.leftFirUrl), right: decodeRawFir(rightBuffer, profile.rightFirUrl) };
      });
    request.catch(() => rawCache.delete(profile.id));
    rawCache.set(profile.id, request);
  }
  return request;
}

/** Load immutable raw taps once, then create context-local mono AudioBuffers. */
export async function getHeadphoneCompensationBuffers(
  ctx: AudioContext,
  profile: HeadphoneCompensationProfile,
): Promise<HeadphoneCompensationBuffers> {
  const raw = await getRawHeadphoneCompensation(profile);
  const makeBuffer = (taps: Float32Array) => {
    const data = resampleLinear(taps, raw.profile.sampleRate, ctx.sampleRate);
    const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buffer.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
    return buffer;
  };
  return { left: makeBuffer(raw.left), right: makeBuffer(raw.right) };
}
