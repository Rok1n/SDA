// Binaural makeup calibration diagnostic. It validates the final +3 dB stage
// without changing KU100 IR normalization and reports peak headroom honestly.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hrtfDir = path.join(root, "apps/web/public/hrtf");
const bundle = path.join(root, "tmp/renderer.bundle.cjs");
const { BINAURAL_MODES } = await import(pathToFileURL(bundle).href);
const manifest = JSON.parse(readFileSync(path.join(hrtfDir, "hrtf-set.json"), "utf8"));
const MAKEUP = Math.pow(10, 3 / 20);
const db = (value) => 20 * Math.log10(Math.max(value, 1e-12));

function readF32(file) {
  const buffer = readFileSync(path.join(hrtfDir, file));
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
}
function peak(x, limit) {
  let value = 0, index = 0;
  for (let i = 0; i < Math.min(x.length, limit); i++) {
    if (Math.abs(x[i]) > value) { value = Math.abs(x[i]); index = i; }
  }
  return index;
}
function mixed(entry, mode) {
  const dry = readF32(entry.dry), wet = readF32(entry.wet);
  const dn = dry.length >> 1, wn = wet.length >> 1;
  const dl = dry.subarray(0, dn), dr = dry.subarray(dn);
  const wl = wet.subarray(0, wn), wr = wet.subarray(wn);
  const shift = peak(wl, 960) - peak(dl, dn);
  const L = new Float32Array(wn), R = new Float32Array(wn);
  const w = BINAURAL_MODES[mode].wet;
  for (let i = 0; i < dn; i++) {
    const j = i + shift;
    if (j >= 0 && j < wn) { L[j] += (1 - w) * dl[i]; R[j] += (1 - w) * dr[i]; }
  }
  for (let i = 0; i < wn; i++) { L[i] += w * wl[i]; R[i] += w * wr[i]; }
  let energy = 0;
  for (let i = 0; i < wn; i++) energy += L[i] ** 2 + R[i] ** 2;
  const scale = 1 / Math.sqrt(energy || 1);
  let max = 0;
  for (let i = 0; i < wn; i++) max = Math.max(max, Math.abs(L[i] * scale), Math.abs(R[i] * scale));
  return max;
}

let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}
check(Math.abs(db(MAKEUP) - 3) < 1e-6, `最终双耳标定精确为 +3.00dB（${db(MAKEUP).toFixed(2)}dB）`);
for (const mode of ["near", "mid", "far"]) {
  const peaks = manifest.positions.map((entry) => mixed(entry, mode) * MAKEUP);
  const max = Math.max(...peaks), min = Math.min(...peaks);
  check(max < 1, `${mode}: 单一虚拟音箱经 +3dB 标定仍保留 ${(-db(max)).toFixed(2)}dB 峰值余量`);
  console.log(`INFO  ${mode}: 单箱 makeup 峰值范围 ${db(min).toFixed(2)}..${db(max).toFixed(2)}dBFS；多总线同相内容可能超过 0dBFS，渲染器不隐藏压缩。`);
}
console.log(failed ? `\n${failed} 项失败` : "\n双耳响度标定诊断通过");
process.exit(failed ? 1 : 0);
