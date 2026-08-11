// 数值验证：真实 hrtf 资产 + mixIrForMode 产出的 IR 是否保持立体声分离。
// 塌成单声道（L≈R）会表现为"所有声音挤在中间"。
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hrtfDir = path.join(root, "apps/web/public/hrtf");
const bundle = path.join(path.dirname(fileURLToPath(import.meta.url)), "renderer.bundle.cjs");
const { BINAURAL_MODES } = await import(pathToFileURL(bundle).href);

// 与 hrtf.ts loadSet 相同的解析
const manifest = JSON.parse(readFileSync(path.join(hrtfDir, "hrtf-set.json"), "utf8"));
const readF32 = (f) => {
  const b = readFileSync(path.join(hrtfDir, f));
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4); // Buffer 池化，必须带 byteOffset
};
const positions = manifest.positions.map((e) => {
  const dry = readF32(e.dry);
  const wet = readF32(e.wet);
  return { azimuth: e.azimuth, elevation: e.elevation, dry, dryLen: dry.length >> 1, wet, wetLen: wet.length >> 1 };
});
const set = { sampleRate: manifest.sampleRate, positions };
console.log(`清单 ${positions.length} 方向 @${set.sampleRate}Hz，dry=${positions[0].dryLen}taps wet=${positions[0].wetLen}taps`);

// mixIrForMode 的等价实现（bundle 未导出，按 hrtf.ts 源码逻辑复制）
function mix(raw, mode, rate = 48000) {
  const w = BINAURAL_MODES[mode].wet;
  const dryL = raw.dry.subarray(0, raw.dryLen);
  const dryR = raw.dry.subarray(raw.dryLen);
  const wetL = raw.wet.subarray(0, raw.wetLen);
  const wetR = raw.wet.subarray(raw.wetLen);
  const argmax = (x, n) => { let p = 0, idx = 0; for (let i = 0; i < Math.min(x.length, n); i++) { const v = Math.abs(x[i]); if (v > p) { p = v; idx = i; } } return idx; };
  const search = Math.min(wetL.length, Math.round(rate * 0.02));
  const shift = argmax(wetL, search) - argmax(dryL, dryL.length);
  const outLen = wetL.length;
  const L = new Float32Array(outLen), R = new Float32Array(outLen);
  for (let i = 0; i < dryL.length; i++) { const j = i + shift; if (j >= 0 && j < outLen) { L[j] = (1 - w) * dryL[i]; R[j] = (1 - w) * dryR[i]; } }
  for (let i = 0; i < outLen; i++) { L[i] += w * wetL[i]; R[i] += w * wetR[i]; }
  let energy = 0; for (let i = 0; i < outLen; i++) energy += L[i] * L[i] + R[i] * R[i];
  if (energy > 0) { const s = 1 / Math.sqrt(energy); for (let i = 0; i < outLen; i++) { L[i] *= s; R[i] *= s; } }
  return { L, R };
}

function stats(L, R) {
  // 相关度（0 = 完全独立，±1 = 同/反相 = 单声道感）
  let sLR = 0, sLL = 0, sRR = 0;
  for (let i = 0; i < L.length; i++) { sLR += L[i] * R[i]; sLL += L[i] * L[i]; sRR += R[i] * R[i]; }
  const corr = sLR / Math.sqrt(sLL * sRR || 1);
  const rmsL = Math.sqrt(sLL / L.length), rmsR = Math.sqrt(sRR / R.length);
  const ildDb = 20 * Math.log10((rmsL || 1e-9) / (rmsR || 1e-9));
  const pk = (x) => { let p = 0, idx = 0; for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > p) { p = v; idx = i; } } return idx; };
  return { corr, ildDb, itdSamples: pk(L) - pk(R) };
}

let bad = 0;
for (const p of positions) {
  for (const mode of ["near", "mid"]) {
    const { L, R } = mix(p, mode);
    const s = stats(L, R);
    const mono = Math.abs(s.corr) > 0.98;
    if (mono) bad++;
    console.log(`${mono ? "FAIL" : " ok "} az${p.azimuth} el${p.elevation} ${mode}: corr=${s.corr.toFixed(3)} ILD=${s.ildDb.toFixed(1)}dB ITD=${s.itdSamples}采样`);
  }
}
// 原始数据本身的双耳差异（不经混合）
const p100 = positions.find((p) => p.azimuth === 100 && p.elevation === 0);
if (p100) {
  const L = p100.dry.subarray(0, p100.dryLen), R = p100.dry.subarray(p100.dryLen);
  const s = stats(L, R);
  console.log(`原始 HRIR az100: corr=${s.corr.toFixed(3)} ILD=${s.ildDb.toFixed(1)}dB ITD=${s.itdSamples}采样`);
}
console.log(bad ? `\n${bad} 条 IR 塌成单声道` : "\nIR 双耳分离正常");
