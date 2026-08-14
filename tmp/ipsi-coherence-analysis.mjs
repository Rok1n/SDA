// 同侧耳到达时间与直达相干叠加分析：±60/±100 对
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
const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));
const set = { ...manifest, calibrated: manifest.calibrationVersion >= 1 };
const rawByKey = new Map();
for (const entry of manifest.positions) {
  const dry = readF32(entry.dry);
  const wet = readF32(entry.wet);
  rawByKey.set(`${entry.azimuth}/${entry.elevation}`, { azimuth: entry.azimuth, elevation: entry.elevation, dry, wet, dryLen: dry.length >> 1, wetLen: wet.length >> 1 });
}
const mix = (az, el) => renderer.mixIrForMode(context, set, rawByKey.get(`${az}/${el}`), "near");

function firstPeak(values, from, to) {
  let best = 0, idx = from;
  for (let i = from; i < Math.min(to, values.length); i++) {
    if (Math.abs(values[i]) > best) { best = Math.abs(values[i]); idx = i; }
  }
  return idx;
}
// 最大互相关系数（±50 taps 窗）
function xcorr(a, b, center, span = 48) {
  let best = -2, bestLag = 0;
  for (let lag = -span; lag <= span; lag++) {
    let dot = 0, ea = 0, eb = 0;
    for (let i = center - 96; i < center + 96; i++) {
      const va = a[i] ?? 0;
      const vb = b[i + lag] ?? 0;
      dot += va * vb; ea += va * va; eb += vb * vb;
    }
    const c = dot / Math.sqrt(ea * eb + 1e-18);
    if (c > best) { best = c; bestLag = lag; }
  }
  return { corr: best, lag: bestLag };
}

for (const [a, b, ear] of [[60, 100, 0], [-60, -100, 1], [30, 110, 0], [-30, -110, 1], [30, 60, 0], [-30, -60, 1]]) {
  const irA = mix(a, 0).getChannelData(ear);
  const irB = mix(b, 0).getChannelData(ear);
  const pA = firstPeak(irA, 0, 480);
  const pB = firstPeak(irB, 0, 480);
  const center = Math.max(pA, pB) + 8;
  const { corr, lag } = xcorr(irA, irB, center);
  // 0.707/0.707 相干和能量（前 20ms 直达+早期窗）
  const sum = new Float64Array(960);
  for (let i = 0; i < 960; i++) sum[i] = 0.707 * (irA[i] ?? 0) + 0.707 * (irB[i] ?? 0);
  const eSum = energy(sum);
  const eIncoherent = 0.5 * energy(irA.subarray(0, 960)) + 0.5 * energy(irB.subarray(0, 960));
  console.log(`az ${String(a).padStart(4)} / ${String(b).padStart(4)} @ear${ear}: 直达峰 ${pA}/${pB} (Δ${pB - pA}) xcorr=${corr.toFixed(3)}@lag${lag}  相干和非相干比=${db(Math.sqrt(eSum / eIncoherent)).toFixed(2)}dB`);
}
