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
const LABEL_POSITIONS: Record<string, Spherical> = {
  ...Object.fromEntries([...LAYOUTS["9.1.6"]].map((s) => [s.name, s])),
  // 6.1 后中置（eac3 channel_mode 4/5、dependent chanmap Cs 位）：正后方 180°，
  // 不属于任何布局的音箱，渲染时由 VBAP 平移到后环/环绕对之间。
  RearCenter: { azimuth: 180, elevation: 0, distance: 1 },
};

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
  // eac3 BedChannel Debug 全名（lfe_channel 通常单列 "LFE"，此处防御性覆盖）
  LowFrequencyEffects: "LFE",
  LowFrequencyEffects2: "LFE",
  // eac3/dca BedChannel variants
  SurroundLeftRear: "RearLeft",
  SurroundRightRear: "RearRight",
  RearLeftSurround: "RearLeft",
  RearRightSurround: "RearRight",
  TopSurroundLeft: "TopSideLeft", // eac3 BedChannel::TopSurround* = 顶侧
  TopSurroundRight: "TopSideRight",
  TopLeft: "TopFrontLeft",
  TopRight: "TopFrontRight",
  WideLeft: "WideLeft", // 9.1 前宽 ±60°
  WideRight: "WideRight",
  TopCenter: "TopFrontLeft",
  CenterSurround: "RearCenter",
  RearCenter: "RearCenter",
};

export function positionForLabel(label: string): Spherical {
  const aliased = LABEL_ALIASES[label] ?? label;
  return LABEL_POSITIONS[aliased] ?? { azimuth: 0, elevation: 0, distance: 1 };
}

/** 归一化解码器床标签（别名表），供"床声道吸附布局音箱"按名字匹配。 */
export function aliasLabel(label: string): string {
  return LABEL_ALIASES[label] ?? label;
}

/** 物理声道顺序（WASAPI/HDMI 通道掩码约定）：
 *  5.1 = FL FR C LFE SL SR；7.1 = FL FR C LFE **BL BR** SL SR（后环在侧环前），
 *  顶层随后。返回布局总线索引按物理顺序排列的数组 —— 多声道直出时按此重排，
 *  否则 7.1 布局的侧环/后环会在 Windows 设备上互换。 */
export function physicalChannelOrder(layout: readonly VirtualSpeaker[]): number[] {
  const PRIORITY = [
    "FrontLeft", "FrontRight", "Center", "LFE",
    "RearLeft", "RearRight", // WASAPI BL/BR 位
    "SurroundLeft", "SurroundRight",
    "WideLeft", "WideRight",
    "TopFrontLeft", "TopFrontRight", "TopSideLeft", "TopSideRight",
    "TopRearLeft", "TopRearRight",
  ];
  const order = PRIORITY.map((name) => layout.findIndex((s) => s.name === name)).filter(
    (i) => i >= 0,
  );
  layout.forEach((_, i) => {
    if (!order.includes(i)) order.push(i); // 表外音箱按原序附加（防御）
  });
  return order;
}

export function isLfeLabel(label: string): boolean {
  const l = LABEL_ALIASES[label] ?? label;
  return l === "LFE" || label === "LFE2";
}

/** 从码流床标签 + 是否有动态对象推断最合适的虚拟扬声器布局。
 *  规则（杜比双耳惯例）：
 *  - 有动态对象 → 至少 7.1.4（杜比双耳渲染的标准中间层；床本身更大则跟上床）
 *  - 纯声道内容 → 能装下全部床音箱的最小布局
 *  无顶箱的 7.1/9.1 内容映射到同床的 .2 变体（顶层音箱闲置，声学上等价）。 */
export function detectLayoutId(labels: readonly string[], hasDynamics: boolean): LayoutId {
  const names = new Set(
    labels
      .filter((l) => !isLfeLabel(l) && !l.startsWith("Obj_"))
      .map((l) => LABEL_ALIASES[l] ?? l),
  );
  const has = (...ns: string[]) => ns.some((n) => names.has(n));

  let base: 5 | 7 | 9 = 5;
  if (has("WideLeft", "WideRight")) base = 9;
  // 6.1 的后中置（RearCenter）也按 7.1 床渲染 —— 由后环对合成正后方声像
  else if (has("RearLeft", "RearRight") || names.has("RearCenter")) base = 7;

  let tops: 0 | 2 | 4 | 6 = 0;
  if (has("TopSideLeft", "TopSideRight")) tops = 6;
  else if (has("TopRearLeft", "TopRearRight")) tops = 4;
  else if (has("TopFrontLeft", "TopFrontRight")) tops = 2;

  if (hasDynamics) {
    if (base < 7) base = 7;
    if (tops < 4) tops = 4;
  }
  if (tops === 0) return base === 5 ? "5.1" : base === 7 ? "7.1.2" : "9.1.2";
  const id = `${base}.1.${tops}` as LayoutId;
  if (id in LAYOUTS) return id;
  // 非法组合（如 5.1.6）：顶层收窄到该床存在的最大档
  return (base === 9 ? "9.1.4" : `${base}.1.4`) as LayoutId;
}
