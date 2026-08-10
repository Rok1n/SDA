/**
 * Coordinate conversions.
 *
 * Events from @sda/core are ADM cartesian: x+ = left, y+ = front, z+ = up,
 * each nominally in [-1, 1] (unit cube mapped onto the room).
 *
 * Internally the renderer works in spherical: azimuth degrees
 * (0 = front, + = left, matching ITU/ADM polar), elevation degrees
 * (+ = up), distance (1 = reference speaker distance).
 */

export interface Spherical {
  /** Degrees: 0 = front, +90 = left, -90 = right, ±180 = behind. */
  azimuth: number;
  /** Degrees: +90 = zenith, -90 = nadir. */
  elevation: number;
  /** Reference distance 1.0 ≈ speaker ring radius. */
  distance: number;
}

/** ADM cartesian [x, y, z] → spherical. */
export function admToSpherical(pos: [number, number, number]): Spherical {
  const [x, y, z] = pos;
  // 不钳制到 1：房间角落的 ADM 距离可达 √3，距离增益/空气吸收 cue 靠它驱动
  // （VBAP 只用方向，不受距离影响）。上限 4 防异常值。
  const distance = Math.min(4, Math.hypot(x, y, z));
  if (distance < 1e-6) return { azimuth: 0, elevation: 0, distance: 0 };
  return {
    azimuth: (Math.atan2(x, y) * 180) / Math.PI,
    elevation: (Math.asin(Math.min(1, Math.max(-1, z / distance))) * 180) / Math.PI,
    distance,
  };
}

/** Spherical → ADM cartesian [x, y, z]. */
export function sphericalToAdm(s: Spherical): [number, number, number] {
  const az = (s.azimuth * Math.PI) / 180;
  const el = (s.elevation * Math.PI) / 180;
  const r = s.distance;
  return [r * Math.cos(el) * Math.sin(az), r * Math.cos(el) * Math.cos(az), r * Math.sin(el)];
}

/**
 * Spherical → Web Audio / three.js right-handed coordinates:
 * x+ = right, y+ = up, z+ = toward listener (behind the viewer is +z... in
 * Web Audio, the listener faces -z, so "front" is -z).
 */
export function sphericalToWebAudio(s: Spherical): [number, number, number] {
  const [x, y, z] = sphericalToAdm(s);
  // ADM x+ = left → WebAudio x-; ADM y+ = front → WebAudio z-; z+ = up stays y+.
  return [-x, z, -y];
}
