// Verify the shipped HD 820 FIR remains spectral EQ, not a loudness scalar.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sampleRate = 48000;
const firPath = resolve("apps/web/public/headphone-compensation/sennheiser-hd-820-average-autoeq/average.f32");
const bytes = readFileSync(firPath);
const fir = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
let failed = 0;

function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}

function gainDbAt(frequency) {
  let re = 0;
  let im = 0;
  for (let index = 0; index < fir.length; index++) {
    const phase = (-2 * Math.PI * frequency * index) / sampleRate;
    re += fir[index] * Math.cos(phase);
    im += fir[index] * Math.sin(phase);
  }
  return 20 * Math.log10(Math.hypot(re, im));
}

const at1000 = gainDbAt(1000);
const at100 = gainDbAt(100);
const at300 = gainDbAt(300);
const at2800 = gainDbAt(2800);
check(fir.length === 8192, "HD 820 FIR 保持 8192 taps");
check(Math.abs(at1000) < 0.02, `1 kHz 保持 0 dB 参考 (${at1000.toFixed(2)} dB)`);
check(at100 > 3 && at100 < 8, `低频保持预期提升 (${at100.toFixed(2)} dB)`);
check(at300 > 5 && at300 < 11, `300 Hz 保持预期提升 (${at300.toFixed(2)} dB)`);
check(at2800 < -1 && at2800 > -3, `2.8 kHz 保持预期削减 (${at2800.toFixed(2)} dB)`);
check(Math.abs(at1000 - at300) > 3, "FIR 不是隐藏的全局响度增益 scalar");

console.log(failed ? `\n${failed} 项失败` : "\nHD 820 FIR 频响参考契约通过");
process.exit(failed ? 1 : 0);
