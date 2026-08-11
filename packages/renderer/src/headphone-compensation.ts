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
}

/**
 * Only profiles backed by redistributable, documented measurements belong here.
 * SADIE D1 ships KU100 HRIR/BRIR assets but no usable headphone correction FIR,
 * so the built-in registry intentionally starts empty.
 */
export const HEADPHONE_COMPENSATION_PROFILES: readonly HeadphoneCompensationProfile[] = [];

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
  return errors;
}
