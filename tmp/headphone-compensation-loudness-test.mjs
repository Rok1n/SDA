// AirPods profile loudness diagnostic: AutoEq headroom is recovered after FIR.
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

function responseMagnitude(hz) {
  let real = 0, imag = 0;
  for (let i = 0; i < taps.length; i++) {
    const phase = (2 * Math.PI * hz * i) / profile.sampleRate;
    real += taps[i] * Math.cos(phase);
    imag -= taps[i] * Math.sin(phase);
  }
  return Math.hypot(real, imag);
}

let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}

let peak = 0;
for (let hz = 20; hz <= 20000; hz += 1) peak = Math.max(peak, responseMagnitude(hz));
const preamp = Math.pow(10, profile.preampDb / 20);
const recovery = Math.pow(10, -profile.preampDb / 20);
const loudnessTrim = Math.pow(10, profile.postFirLoudnessTrimDb / 20);
check(Math.abs(preamp * recovery - 1) < 1e-12, `profile preamp/recovery 精确抵消（${db(preamp * recovery).toFixed(6)}dB）`);
check(Math.abs(db(loudnessTrim) - 2) < 1e-12, `AirPods profile loudness trim 精确为 +2.00dB`);
check(db(peak) > -0.5 && db(peak) <= 0.1, `FIR 峰值接近 unity（${db(peak).toFixed(2)}dB）`);
console.log(`INFO  FIR 峰值 ${db(peak).toFixed(2)}dB；preamp/recovery 抵消后加 profile trim ${profile.postFirLoudnessTrimDb.toFixed(2)}dB，trim 后峰值 ${(db(peak * loudnessTrim)).toFixed(2)}dB，由最终 safety compressor 保护。`);

console.log(failed ? `\n${failed} 项失败` : "\nAirPods profile 响度标定通过");
process.exit(failed ? 1 : 0);
