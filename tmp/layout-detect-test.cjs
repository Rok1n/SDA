/**
 * 布局自动检测矩阵测试 —— 重点是 eac3 BedChannel Debug 全名标签
 * （Rust 侧 `format!("{b:?}")` 产物），确保 eac3 各声道配置落到正确布局。
 * 运行：node tmp/layout-detect-test.mjs（先重建 tmp/renderer.bundle.cjs）
 */
const { detectLayoutId, positionForLabel, isLfeLabel, LAYOUTS } = require("./renderer.bundle.cjs");

let failed = 0;
function eq(actual, expected, what) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}: ${actual}${ok ? "" : `（期望 ${expected}）`}`);
}

// ---- eac3 纯床层（channel_mode → fullband_channel_order + LFE 单列）----
// 2.0 立体声（channel_mode 2）
eq(detectLayoutId(["FrontLeft", "FrontRight"], false), "5.1", "eac3 2.0 → 5.1");
// 5.1（channel_mode 7 + lfe）
eq(
  detectLayoutId(
    ["FrontLeft", "Center", "FrontRight", "SurroundLeft", "SurroundRight", "LFE"],
    false,
  ),
  "5.1",
  "eac3 5.1 → 5.1",
);
// 7.1（5.1 核心 + dependent 子流 Ls/Rs/Lrs/Rrs，chanmap 0x1A00）
eq(
  detectLayoutId(
    [
      "FrontLeft", "Center", "FrontRight",
      "SurroundLeft", "SurroundRight", "RearLeft", "RearRight", "LFE",
    ],
    false,
  ),
  "7.1.2",
  "eac3 7.1 → 7.1.2",
);
// 6.1（channel_mode 5：L C R Cs + lfe）—— 后中置 → 7.1 床（后环对合成 180°）
eq(
  detectLayoutId(["FrontLeft", "Center", "FrontRight", "RearCenter", "LFE"], false),
  "7.1.2",
  "eac3 6.1(后中置) → 7.1.2",
);
// 9.1（7.1 + dependent chanmap Lw/Rw 前宽）
eq(
  detectLayoutId(
    [
      "FrontLeft", "Center", "FrontRight", "Lw", "Rw",
      "SurroundLeft", "SurroundRight", "RearLeft", "RearRight", "LFE",
    ],
    false,
  ),
  "9.1.2",
  "eac3 9.1（原生 Lw/Rw）→ 9.1.2",
);

// ---- eac3 JOC ----
// 全动态 JOC（demo 矢量）：床层被丢弃，只剩 LFE + 对象 → 杜比标准 7.1.4
const jocLabels = ["LFE", ...Array.from({ length: 15 }, (_, k) => `Obj_${10 + k}`)];
eq(detectLayoutId(jocLabels, true), "7.1.4", "eac3 JOC 全动态 → 7.1.4");
// 混合呈现 JOC（5.1 床 + 对象）
eq(
  detectLayoutId(
    ["FrontLeft", "Center", "FrontRight", "SurroundLeft", "SurroundRight", "LFE", "Obj_10"],
    true,
  ),
  "7.1.4",
  "eac3 JOC 混合呈现 → 7.1.4",
);

// ---- 标签位置 / LFE 判定（renderer addSource 的 bedLabel 路径）----
eq(String(positionForLabel("RearCenter").azimuth), "180", "RearCenter 方位 180°");
eq(String(isLfeLabel("LowFrequencyEffects")), "true", "LowFrequencyEffects 判定为 LFE");
eq(String(isLfeLabel("LowFrequencyEffects2")), "true", "LowFrequencyEffects2 判定为 LFE");
eq(String(isLfeLabel("LFE")), "true", "LFE 判定为 LFE");
eq(String(isLfeLabel("FrontLeft")), "false", "FrontLeft 不是 LFE");
eq(
  String(positionForLabel("TopSurroundLeft").azimuth),
  String(positionForLabel("TopSideLeft").azimuth),
  "TopSurroundLeft 归一到 TopSideLeft 位置",
);
eq(
  String(positionForLabel("TopSurroundLeft").elevation),
  "45",
  "TopSurroundLeft 仰角 45°",
);

// ---- truehd 0.6.3 实际 ChannelLabel Debug 输出 ----
eq(
  detectLayoutId(["L", "C", "R", "Ls", "Rs", "LFE"], false),
  "5.1",
  "truehd 5.1 → 5.1",
);
eq(
  detectLayoutId(
    ["L", "C", "R", "Ls", "Rs", "Lb", "Rb", "Tfl", "Tfr", "Tbl", "Tbr", "LFE"],
    false,
  ),
  "7.1.4",
  "truehd 7.1.4 → 7.1.4",
);
eq(
  detectLayoutId(
    [
      "L", "C", "R", "Lw", "Rw", "Ls", "Rs", "Lb", "Rb",
      "Tfl", "Tfr", "Tsl", "Tsr", "Tbl", "Tbr", "LFE",
    ],
    false,
  ),
  "9.1.6",
  "truehd 9.1.6 → 9.1.6",
);

eq(
  detectLayoutId(["L", "R", "Tc"], false),
  "5.1.2",
  "truehd 顶中 Tc 触发顶层布局",
);
eq(
  detectLayoutId(["L", "R", "Tfc"], false),
  "5.1.2",
  "truehd 顶前中 Tfc 触发顶层布局",
);
eq(String(positionForLabel("Tc").azimuth), "0", "truehd Tc 保持正中方位");
eq(String(positionForLabel("Tfc").azimuth), "0", "truehd Tfc 保持正中方位");

// 布局引用完整性：检测返回的 id 必须存在
for (const id of ["5.1", "7.1.2", "9.1.2", "7.1.4"]) {
  eq(String(id in LAYOUTS), "true", `LAYOUTS 含 ${id}`);
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
