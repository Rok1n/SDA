// 分解 ±80° 同侧耳能量：dry-only vs wet-only vs mixed
import { readFileSync } from "node:fs";
import path from "node:path";

const directory = "apps/web/public/hrtf";
const manifest = JSON.parse(readFileSync(path.join(directory, "hrtf-set.json"), "utf8"));
const readF32 = (file) => {
  const data = readFileSync(path.join(directory, file));
  return new Float32Array(data.buffer, data.byteOffset, data.length / 4);
};
const energy = (values) => values.reduce((sum, v) => sum + v * v, 0);
const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));

const irs = new Map();
for (const entry of manifest.positions) {
  const dry = readF32(entry.dry);
  const wet = readF32(entry.wet);
  irs.set(`${entry.azimuth}/${entry.elevation}`, { dry, wet, dryLen: dry.length >> 1, wetLen: wet.length >> 1 });
}

function earData(ir, part, ear) {
  const { dry, wet, dryLen, wetLen } = ir;
  if (part === "dry") return dry.subarray(ear * dryLen, (ear + 1) * dryLen);
  return wet.subarray(ear * wetLen, (ear + 1) * wetLen);
}

// VBAP 9.1.4 @±80: 0.707·±60 + 0.707·±100
for (const part of ["dry", "wet"]) {
  const left60 = earData(irs.get("60/0"), part, 0);
  const left100 = earData(irs.get("100/0"), part, 0);
  const right60 = earData(irs.get("-60/0"), part, 1);
  const right100 = earData(irs.get("-100/0"), part, 1);
  const mixL = new Float64Array(8192);
  const mixR = new Float64Array(8192);
  for (let i = 0; i < 8192; i++) {
    mixL[i] = 0.707 * (left60[i] ?? 0) + 0.707 * (left100[i] ?? 0);
    mixR[i] = 0.707 * (right60[i] ?? 0) + 0.707 * (right100[i] ?? 0);
  }
  // 全带 + 分窗
  const win = (x, from, to) => energy(x.subarray(from, to));
  console.log(`${part}: 全长 L=${db(Math.sqrt(energy(mixL))).toFixed(1)} R=${db(Math.sqrt(energy(mixR))).toFixed(1)}  Δ=${db(Math.sqrt(energy(mixL) / energy(mixR))).toFixed(2)}dB`);
  console.log(`  直达窗(120-300): Δ=${db(Math.sqrt(win(mixL, 120, 300) / win(mixR, 120, 300))).toFixed(2)}dB  早期(300-1200): Δ=${db(Math.sqrt(win(mixL, 300, 1200) / win(mixR, 300, 1200))).toFixed(2)}dB  晚期(1200+): Δ=${db(Math.sqrt(win(mixL, 1200, 8192) / win(mixR, 1200, 8192))).toFixed(2)}dB`);
  // 单边对比
  console.log(`  单音箱能量: +60=${db(Math.sqrt(energy(left60))).toFixed(1)} +100=${db(Math.sqrt(energy(left100))).toFixed(1)} -60=${db(Math.sqrt(energy(right60))).toFixed(1)} -100=${db(Math.sqrt(energy(right100))).toFixed(1)}`);
}
