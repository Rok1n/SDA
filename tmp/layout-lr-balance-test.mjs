// 布局左右平衡诊断（v2 校准资产 + 运行时混音路径）
// 1) 逐方向：±θ 镜像对的耳能量对称性
// 2) 逐布局：对称对象场（每个音箱位置放等能量对象，经 VBAP）全场 L/R 比
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const renderer = require("./renderer.bundle.cjs");
const directory = "apps/web/public/hrtf";
const manifest = JSON.parse(readFileSync(path.join(directory, "hrtf-set.json"), "utf8"));
const readF32 = (file) => {
  const data = readFileSync(path.join(directory, file));
  return new Float32Array(data.buffer, data.byteOffset, data.length / 4);
};
const context = {
  sampleRate: manifest.sampleRate,
  createBuffer(channels, length) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { copyToChannel(values, channel) { data[channel].set(values); }, getChannelData(channel) { return data[channel]; } };
  },
};
const energy = (values) => values.reduce((sum, v) => sum + v * v, 0);
const db = (ratio) => 20 * Math.log10(Math.max(ratio, 1e-12));

const set = { ...manifest, calibrated: manifest.calibrationVersion >= 1 };
const rawByKey = new Map();
for (const entry of manifest.positions) {
  const dry = readF32(entry.dry);
  const wet = readF32(entry.wet);
  rawByKey.set(`${entry.azimuth}/${entry.elevation}`, {
    azimuth: entry.azimuth,
    elevation: entry.elevation,
    dry,
    wet,
    dryLen: dry.length >> 1,
    wetLen: wet.length >> 1,
  });
}
// buildBusIrs 从 set.positions 里做 nearestPosition 查找 —— 必须给它喂原始数据版。
const rawSet = { ...set, positions: [...rawByKey.values()] };

// 逐方向 IR 耳能量（near 档）
console.log("=== 逐方向 IR 耳能量对称性（near，v2 资产）===");
const dirStats = new Map();
for (const [key, raw] of rawByKey) {
  const buf = renderer.mixIrForMode(context, set, raw, "near");
  const eL = energy(buf.getChannelData(0));
  const eR = energy(buf.getChannelData(1));
  dirStats.set(key, { eL, eR, ild: db(Math.sqrt(eL / eR)) });
  console.log(`${key.padStart(8)}  EL=${eL.toExponential(3)} ER=${eR.toExponential(3)} ILD=${db(Math.sqrt(eL / eR)).toFixed(2)}dB`);
}

// 镜像对总和对称性：E_L(+θ)+E_L(-θ) vs E_R(+θ)+E_R(-θ)
console.log("\n=== 镜像对总和对称 ===");
const pairs = [[30, 0], [60, 0], [100, 0], [110, 0], [140, 0], [45, 45], [90, 45], [135, 45]];
for (const [az, el] of pairs) {
  const plus = dirStats.get(`${az}/${el}`);
  const minus = dirStats.get(`-${az}/${el}`);
  if (!plus || !minus) continue;
  const pairBalance = db(Math.sqrt((plus.eL + minus.eL) / (plus.eR + minus.eR)));
  // 完美镜像应满足 E_L(+θ)=E_R(-θ) 且 E_R(+θ)=E_L(-θ)
  const mirrorMismatch = db(Math.sqrt(plus.eL / minus.eR));
  console.log(`±${az}/${el}: 对总 L/R=${pairBalance.toFixed(2)}dB  +θ左耳 vs -θ右耳=${mirrorMismatch.toFixed(2)}dB`);
}

// 逐布局对称对象场
console.log("\n=== 逐布局对称对象场（对象置于每个音箱位置，VBAP near 卷积求和）===");
const layouts = { "5.1.4": renderer.LAYOUTS["5.1.4"], "7.1.4": renderer.LAYOUTS["7.1.4"], "9.1.4": renderer.LAYOUTS["9.1.4"] };
// buildBusIrs 需要 layout speakers；卷积用脉冲即可——VBAP 增益加权的 IR 线性叠加，直接求能量：
// E_ear = Σ_buses || Σ_obj gain_obj,bus * IR_bus,ear ||² —— 需逐样本叠加后求能量（相干）。
for (const [layoutId, layout] of Object.entries(layouts)) {
  const busIrs = renderer.buildBusIrs(context, rawSet, layout, "near");
  const solver = new renderer.VbapSolver(layout);
  // 每个非 LFE 音箱位置放一个对象（ADM 直角坐标近似：az/el 单位球）
  const accum = [new Float64Array(8192), new Float64Array(8192)];
  let objectCount = 0;
  for (const spk of layout) {
    if (spk.isLfe) continue;
    objectCount++;
    const position = { azimuth: spk.azimuth, elevation: spk.elevation, distance: 1 };
    const gains = solver.pan(position, 0);
    for (let bus = 0; bus < layout.length; bus++) {
      const gain = gains[bus];
      if (!gain) continue;
      const ir = busIrs.get(bus);
      if (!ir) continue;
      for (let ear = 0; ear < 2; ear++) {
        const data = ir.getChannelData(ear);
        for (let i = 0; i < data.length; i++) accum[ear][i] += gain * data[i];
      }
    }
  }
  const eL = energy(accum[0]);
  const eR = energy(accum[1]);
  console.log(`${layoutId}: ${objectCount} 对象  L=${eL.toExponential(3)} R=${eR.toExponential(3)}  L/R=${db(Math.sqrt(eL / eR)).toFixed(3)}dB`);
}
