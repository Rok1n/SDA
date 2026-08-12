// AirPods profile FIR diagnostic: asset-normalized final-L/R EQ only.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "tmp/renderer.bundle.cjs");
const { headphoneProfileById } = await import(pathToFileURL(bundle).href);
const profile = headphoneProfileById("airpods-pro-2-anc-averaged");
const asset = path.join(root, "apps/web/public", profile.leftFirUrl.replace(/^\//, ""));
const file = readFileSync(asset);
const taps = new Float32Array(file.buffer, file.byteOffset, file.length / Float32Array.BYTES_PER_ELEMENT);
const db = (value) => 20 * Math.log10(Math.max(value, 1e-12));

function responsePower(hz) {
  let real = 0, imag = 0;
  for (let i = 0; i < taps.length; i++) {
    const phase = (2 * Math.PI * hz * i) / profile.sampleRate;
    real += taps[i] * Math.cos(phase);
    imag -= taps[i] * Math.sin(phase);
  }
  return real * real + imag * imag;
}

let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}

let peakPower = 0;
let peakHz = 0;
let weightedPower = 0;
let weights = 0;
for (let hz = 20; hz <= 20000; hz += 1) {
  const power = responsePower(hz);
  if (power > peakPower) {
    peakPower = power;
    peakHz = hz;
  }
}
for (let hz = 250; hz <= 2000; hz += 1) {
  const weight = 1 / hz;
  weightedPower += responsePower(hz) * weight;
  weights += weight;
}
const midrangeDb = 10 * Math.log10(weightedPower / weights);
const peakDb = db(Math.sqrt(peakPower));
check(Math.abs(midrangeDb) <= 0.01, `250Hz-2kHz pink-weighted asset reference 为 0dB（${midrangeDb.toFixed(4)}dB）`);
check(Math.abs(peakDb - 4.3787) <= 0.02 && peakHz === 5106,
  `归一化 FIR 峰值稳定（${peakDb.toFixed(4)}dB @ ${peakHz}Hz）`);
console.log(`INFO  asset-level reference normalization 保持相对 EQ/phase；runtime 只应用 raw L/R FIR，不添加 profile gain 或 dynamics。`);

console.log(failed ? `\n${failed} 项失败` : "\nAirPods profile 归一化 EQ 诊断通过");
process.exit(failed ? 1 : 0);
