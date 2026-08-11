// Binaural low-band diagnostic: LFE remains centered while directional KU100
// virtual speakers retain left/right separation in the 80-250 Hz band.
import { readFileSync } from "node:fs";
import path from "node:path";

const hrtfDir = "apps/web/public/hrtf";
const SAMPLE_RATE = 48000;
const LOW_BAND_HZ = [80, 250];
const LFE_LOWPASS_HZ = 120;
const LFE_INBAND_GAIN = Math.pow(10, 10 / 20);
const LFE_EAR_GAIN = 0.5;

function readF32(file) {
  const buffer = readFileSync(path.join(hrtfDir, file));
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
}
function powerAt(signal, hz) {
  const w = (2 * Math.PI * hz) / SAMPLE_RATE;
  let real = 0, imag = 0;
  for (let i = 0; i < signal.length; i++) {
    real += signal[i] * Math.cos(w * i);
    imag -= signal[i] * Math.sin(w * i);
  }
  return real * real + imag * imag;
}
function bandPower(signal) {
  let power = 0;
  for (let hz = LOW_BAND_HZ[0]; hz <= LOW_BAND_HZ[1]; hz += 5) power += powerAt(signal, hz);
  return power;
}
function db(value) {
  return 10 * Math.log10(Math.max(value, 1e-12));
}
function lr4Magnitude(hz) {
  const ratio = hz / LFE_LOWPASS_HZ;
  return 1 / (1 + ratio ** 4);
}

let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}

const irRight = readF32("az100_el0_dry.f32");
const irLeft = readF32("azm100_el0_dry.f32");
const half = irRight.length >> 1;
const rightIld = db(bandPower(irRight.subarray(0, half)) / bandPower(irRight.subarray(half)));
const leftIld = db(bandPower(irLeft.subarray(0, half)) / bandPower(irLeft.subarray(half)));
check(Math.abs(rightIld) > 1 && Math.abs(leftIld) > 1 && rightIld * leftIld < 0,
  `镜像虚拟音箱在 ${LOW_BAND_HZ.join("-")}Hz 保留相反耳间主导（${rightIld.toFixed(2)} / ${leftIld.toFixed(2)}dB）`);

const lfeEarGain = LFE_INBAND_GAIN * LFE_EAR_GAIN;
check(Math.abs(lfeEarGain - (Math.pow(10, 10 / 20) * 0.5)) < 1e-12,
  `LFE 两耳静态增益严格相等（每耳 ${(20 * Math.log10(lfeEarGain)).toFixed(2)}dB）`);
check(Math.abs(lr4Magnitude(LFE_LOWPASS_HZ) - 0.5) < 1e-12,
  `LFE LR4 在 ${LFE_LOWPASS_HZ}Hz 为 -6.02dB`);
check(db(lr4Magnitude(240) ** 2) < -20,
  `LFE LR4 在 240Hz 衰减 ${db(lr4Magnitude(240) ** 2).toFixed(2)}dB，避免高低频泄漏`);

console.log(failed ? `\n${failed} 项失败` : "\n双耳低频分离诊断通过");
process.exit(failed ? 1 : 0);
