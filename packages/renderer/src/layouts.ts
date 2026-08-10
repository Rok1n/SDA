/**
 * Virtual speaker layouts. Azimuth: 0 = front, + = left (ADM/ITU polar).
 * Angles follow ITU-R BS.2051 / Dolby Atmos home conventions.
 */

import type { Spherical } from "./coords.js";

export interface VirtualSpeaker extends Spherical {
  name: string;
  /** True for the LFE — excluded from spatial panning (passed straight through). */
  isLfe?: boolean;
}

/** 底层床（按 ITU-R BS.775 / Dolby Atmos 规范角度）。 */
const FRONT: VirtualSpeaker[] = [
  { name: "FrontLeft", azimuth: 30, elevation: 0, distance: 1 },
  { name: "FrontRight", azimuth: -30, elevation: 0, distance: 1 },
  { name: "Center", azimuth: 0, elevation: 0, distance: 1 },
  { name: "LFE", azimuth: 45, elevation: 0, distance: 1, isLfe: true },
];
/** 5.1 环绕在 ±110°（ITU-R BS.775）。 */
const SURROUND_5: VirtualSpeaker[] = [
  { name: "SurroundLeft", azimuth: 110, elevation: 0, distance: 1 },
  { name: "SurroundRight", azimuth: -110, elevation: 0, distance: 1 },
];
/** 7.1 拆成侧环 ±100° + 后环 ±140°（ITU 90–110 / 130–150 区间中值）。 */
const SURROUND_7: VirtualSpeaker[] = [
  { name: "SurroundLeft", azimuth: 100, elevation: 0, distance: 1 },
  { name: "SurroundRight", azimuth: -100, elevation: 0, distance: 1 },
  { name: "RearLeft", azimuth: 140, elevation: 0, distance: 1 },
  { name: "RearRight", azimuth: -140, elevation: 0, distance: 1 },
];
/** 9.1 = 7.1 + 前宽 ±60°（Dolby 9.1）。 */
const WIDE: VirtualSpeaker[] = [
  { name: "WideLeft", azimuth: 60, elevation: 0, distance: 1 },
  { name: "WideRight", azimuth: -60, elevation: 0, distance: 1 },
];
const TOP_FRONT: VirtualSpeaker[] = [
  { name: "TopFrontLeft", azimuth: 45, elevation: 45, distance: 1 },
  { name: "TopFrontRight", azimuth: -45, elevation: 45, distance: 1 },
];
const TOP_REAR: VirtualSpeaker[] = [
  { name: "TopRearLeft", azimuth: 135, elevation: 45, distance: 1 },
  { name: "TopRearRight", azimuth: -135, elevation: 45, distance: 1 },
];
const TOP_SIDE: VirtualSpeaker[] = [
  { name: "TopSideLeft", azimuth: 90, elevation: 45, distance: 1 },
  { name: "TopSideRight", azimuth: -90, elevation: 45, distance: 1 },
];

const BED_5_1 = [...FRONT, ...SURROUND_5];
const BED_7_1 = [...FRONT, ...SURROUND_7];
const BED_9_1 = [...FRONT, ...WIDE, ...SURROUND_7];

/** 7.1.4 — the full Atmos home bed. */
export const LAYOUT_7_1_4: VirtualSpeaker[] = [...BED_7_1, ...TOP_FRONT, ...TOP_REAR];

/** 可选扬声器布局（床 + 顶箱组合）。 */
export const LAYOUTS = {
  "5.1": BED_5_1,
  "5.1.2": [...BED_5_1, ...TOP_FRONT],
  "5.1.4": [...BED_5_1, ...TOP_FRONT, ...TOP_REAR],
  "7.1.2": [...BED_7_1, ...TOP_FRONT],
  "7.1.4": LAYOUT_7_1_4,
  "9.1.2": [...BED_9_1, ...TOP_FRONT],
  "9.1.4": [...BED_9_1, ...TOP_FRONT, ...TOP_REAR],
  "9.1.6": [...BED_9_1, ...TOP_FRONT, ...TOP_SIDE, ...TOP_REAR],
} as const;

export type LayoutId = keyof typeof LAYOUTS;

/** Decoder bed-channel labels (Rust `BedChannel`/`ChannelLabel` Debug names)
 *  → virtual speaker position. Unknown labels fall back to front.
 *  取全部布局的并集，床标签在任何布局下都有位置（不在当前布局的音箱
 *  会由 VBAP 平移到最近的音箱上）。 */
const LABEL_POSITIONS: Record<string, Spherical> = Object.fromEntries(
  [...LAYOUTS["9.1.6"]].map((s) => [s.name, s]),
);

const LABEL_ALIASES: Record<string, string> = {
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
  Lfe: "LFE",
  LFE2: "LFE",
  // eac3/dca BedChannel variants
  SurroundLeftRear: "RearLeft",
  SurroundRightRear: "RearRight",
  RearLeftSurround: "RearLeft",
  RearRightSurround: "RearRight",
  TopLeft: "TopFrontLeft",
  TopRight: "TopFrontRight",
  WideLeft: "WideLeft", // 9.1 前宽 ±60°
  WideRight: "WideRight",
  TopCenter: "TopFrontLeft",
  CenterSurround: "RearLeft",
  RearCenter: "RearLeft",
};

export function positionForLabel(label: string): Spherical {
  const aliased = LABEL_ALIASES[label] ?? label;
  return LABEL_POSITIONS[aliased] ?? { azimuth: 0, elevation: 0, distance: 1 };
}

export function isLfeLabel(label: string): boolean {
  return label === "LFE" || label === "Lfe" || label === "LFE2";
}
