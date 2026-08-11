// 9.1.x bilateral balance diagnostic using shipped KU100 IR assets.
// This protects routing signs and quantifies real measurement asymmetry without
// applying an undocumented global left/right correction.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hrtfDir = path.join(root, "apps/web/public/hrtf");
const bundle = path.join(root, "tmp/renderer.bundle.cjs");
const { BINAURAL_MODES, LAYOUTS } = await import(pathToFileURL(bundle).href);
const manifest = JSON.parse(readFileSync(path.join(hrtfDir, "hrtf-set.json"), "utf8"));
const assets = new Map(manifest.positions.map((entry) => [
  `${entry.azimuth}/${entry.elevation}`,
  entry,
]));

function readF32(file) {
  const buffer = readFileSync(path.join(hrtfDir, file));
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
}
function peak(x, limit) {
  let best = 0;
  let idx = 0;
  for (let i = 0; i < Math.min(x.length, limit); i++) {
    if (Math.abs(x[i]) > best) { best = Math.abs(x[i]); idx = i; }
  }
  return idx;
}
function mixedIr(entry, mode) {
  const dry = readF32(entry.dry), wet = readF32(entry.wet);
  const dryLen = dry.length >> 1, wetLen = wet.length >> 1;
  const dryL = dry.subarray(0, dryLen), dryR = dry.subarray(dryLen);
  const wetL = wet.subarray(0, wetLen), wetR = wet.subarray(wetLen);
  const shift = peak(wetL, 960) - peak(dryL, dryLen);
  const L = new Float32Array(wetLen), R = new Float32Array(wetLen);
  const w = BINAURAL_MODES[mode].wet;
  for (let i = 0; i < dryLen; i++) {
    const j = i + shift;
    if (j >= 0 && j < wetLen) { L[j] += (1 - w) * dryL[i]; R[j] += (1 - w) * dryR[i]; }
  }
  for (let i = 0; i < wetLen; i++) { L[i] += w * wetL[i]; R[i] += w * wetR[i]; }
  let energy = 0;
  for (let i = 0; i < wetLen; i++) energy += L[i] ** 2 + R[i] ** 2;
  const scale = 1 / Math.sqrt(energy || 1);
  for (let i = 0; i < wetLen; i++) { L[i] *= scale; R[i] *= scale; }
  return { L, R };
}
function rms(x) {
  let sum = 0;
  for (const value of x) sum += value * value;
  return Math.sqrt(sum / x.length);
}
function db(left, right) {
  return 20 * Math.log10((left || 1e-12) / (right || 1e-12));
}

let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}

for (const layoutId of ["9.1.2", "9.1.4", "9.1.6"]) {
  for (const mode of ["near", "mid", "far"]) {
    const pairs = LAYOUTS[layoutId]
      .filter((speaker) => !speaker.isLfe && speaker.azimuth > 0)
      .map((speaker) => [
        speaker,
        LAYOUTS[layoutId].find((other) => !other.isLfe && other.azimuth === -speaker.azimuth && other.elevation === speaker.elevation),
      ])
      .filter(([, mirror]) => mirror);
    let incoherentL = 0, incoherentR = 0;
    let coherentL = 0, coherentR = 0;
    for (const [leftSpeaker, rightSpeaker] of pairs) {
      const left = mixedIr(assets.get(`${leftSpeaker.azimuth}/${leftSpeaker.elevation}`), mode);
      const right = mixedIr(assets.get(`${rightSpeaker.azimuth}/${rightSpeaker.elevation}`), mode);
      // Equal-power decorrelated sources add power, representative of a diffuse bed.
      incoherentL += rms(left.L) ** 2 + rms(right.L) ** 2;
      incoherentR += rms(left.R) ** 2 + rms(right.R) ** 2;
      // Same impulse on each mirror bus is a deliberately conservative correlated stress case.
      for (let i = 0; i < left.L.length; i++) {
        coherentL += (left.L[i] + right.L[i]) ** 2;
        coherentR += (left.R[i] + right.R[i]) ** 2;
      }
    }
    const incoherentDb = db(Math.sqrt(incoherentL), Math.sqrt(incoherentR));
    const coherentDb = db(Math.sqrt(coherentL), Math.sqrt(coherentR));
    check(Math.abs(incoherentDb) <= 0.5,
      `${layoutId}/${mode}: 镜像非相干总能量左右平衡 ${incoherentDb.toFixed(3)}dB`);
    check(Math.abs(coherentDb) <= 2.5,
      `${layoutId}/${mode}: 镜像同相压力总能量在实测非对称容限内 ${coherentDb.toFixed(3)}dB`);
  }
}

console.log(failed ? `\n${failed} 项失败` : "\n9.1.x 左右平衡诊断通过");
process.exit(failed ? 1 : 0);
