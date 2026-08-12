// Verify the shipped MDR-7506 FIR remains spectral EQ, not a loudness scalar.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sampleRate = 48000;
const firPath = resolve("apps/web/public/headphone-compensation/sony-mdr-7506-average-autoeq/average.f32");
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
const at3000 = gainDbAt(3000);
const at20 = gainDbAt(20);
check(fir.length === 8192, "MDR-7506 FIR 保持 8192 taps");
check(Math.abs(at1000) < 0.02, `1 kHz 保持 0 dB 参考 (${at1000.toFixed(2)} dB)`);
check(at3000 < -1 && at3000 > -2.5, `存在感频段保持预期削减 (${at3000.toFixed(2)} dB)`);
check(at20 > 2 && at20 < 5, `低频保持预期提升 (${at20.toFixed(2)} dB)`);
check(Math.abs(at1000 - at3000) > 1, "FIR 不是隐藏的全局响度增益 scalar");

console.log(failed ? `\n${failed} 项失败` : "\nMDR-7506 FIR 频响参考契约通过");
process.exit(failed ? 1 : 0);
