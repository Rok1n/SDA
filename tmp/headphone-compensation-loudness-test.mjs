// AirPods profile FIR diagnostic: compensation is raw final-L/R EQ only.
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
let weightedPower = 0;
let weights = 0;
for (let hz = 20; hz <= 20000; hz += 1) peakPower = Math.max(peakPower, responsePower(hz));
for (let hz = 250; hz <= 2000; hz += 1) {
  const weight = 1 / hz;
  weightedPower += responsePower(hz) * weight;
  weights += weight;
}
const midrangeDb = 10 * Math.log10(weightedPower / weights);
const peakDb = db(Math.sqrt(peakPower));
check(Math.abs(midrangeDb - -4.5764) <= 0.01, `250Hz-2kHz pink-weighted raw FIR 响应稳定（${midrangeDb.toFixed(4)}dB）`);
check(peakDb > -0.5 && peakDb <= 0.1, `raw FIR 峰值接近 unity（${peakDb.toFixed(2)}dB）`);
console.log(`INFO  profile 只应用 raw L/R FIR EQ：250Hz-2kHz=${midrangeDb.toFixed(4)}dB，峰值=${peakDb.toFixed(2)}dB；SDA 不添加 profile gain、loudness trim 或 profile dynamics。`);

console.log(failed ? `\n${failed} 项失败` : "\nAirPods profile 原始 EQ 诊断通过");
process.exit(failed ? 1 : 0);
