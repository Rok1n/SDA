#!/usr/bin/env node
/** Build the MDR-7506 average-measurement FIR from AutoEq's published PEQ. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const sampleRate = 48000;
const taps = 8192;
const outputPath = resolve("apps/web/public/headphone-compensation/sony-mdr-7506-average-autoeq/average.f32");
// AutoEq Super Review result, revision 36b1afc. The source preamp is intentionally
// excluded: this FIR is normalized at 1 kHz and has no runtime output trim.
const filters = [
  ["lowshelf", 105, 0.7, 6.4],
  ["peaking", 52, 0.67, -7.5],
  ["peaking", 85, 5.66, 3.4],
  ["peaking", 466, 0.92, 2.2],
  ["peaking", 7446, 3.29, -4.3],
  ["peaking", 1600, 2.63, -1.1],
  ["peaking", 2925, 6, -1.8],
  ["peaking", 3825, 5.01, 3.4],
  ["peaking", 9152, 2.75, -1.5],
  ["highshelf", 10000, 0.7, 2.6],
];

function biquad(type, frequency, q, gainDb) {
  const a = 10 ** (gainDb / 40);
  const w = (2 * Math.PI * frequency) / sampleRate;
  const cos = Math.cos(w);
  const sin = Math.sin(w);
  const alpha = sin / (2 * q);
  const beta = 2 * Math.sqrt(a) * alpha;
  let b0; let b1; let b2; let a0; let a1; let a2;
  if (type === "peaking") {
    b0 = 1 + alpha * a; b1 = -2 * cos; b2 = 1 - alpha * a;
    a0 = 1 + alpha / a; a1 = -2 * cos; a2 = 1 - alpha / a;
  } else if (type === "lowshelf") {
    b0 = a * ((a + 1) - (a - 1) * cos + beta);
    b1 = 2 * a * ((a - 1) - (a + 1) * cos);
    b2 = a * ((a + 1) - (a - 1) * cos - beta);
    a0 = (a + 1) + (a - 1) * cos + beta;
    a1 = -2 * ((a - 1) + (a + 1) * cos);
    a2 = (a + 1) + (a - 1) * cos - beta;
  } else {
    b0 = a * ((a + 1) + (a - 1) * cos + beta);
    b1 = -2 * a * ((a - 1) + (a + 1) * cos);
    b2 = a * ((a + 1) + (a - 1) * cos - beta);
    a0 = (a + 1) - (a - 1) * cos + beta;
    a1 = 2 * ((a - 1) - (a + 1) * cos);
    a2 = (a + 1) - (a - 1) * cos - beta;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

const stages = filters.map(([type, frequency, q, gainDb]) => biquad(type, frequency, q, gainDb));
const responseAt = (frequency) => stages.reduce((product, s) => {
  const w = (2 * Math.PI * frequency) / sampleRate;
  const z1 = { re: Math.cos(w), im: -Math.sin(w) };
  const z2 = { re: Math.cos(2 * w), im: -Math.sin(2 * w) };
  const numerator = { re: s.b0 + s.b1 * z1.re + s.b2 * z2.re, im: s.b1 * z1.im + s.b2 * z2.im };
  const denominator = { re: 1 + s.a1 * z1.re + s.a2 * z2.re, im: s.a1 * z1.im + s.a2 * z2.im };
  const magnitude = Math.hypot(numerator.re, numerator.im) / Math.hypot(denominator.re, denominator.im);
  return product * magnitude;
}, 1);
const referenceScale = 1 / responseAt(1000);
const fir = new Float32Array(taps);
for (let i = 0; i < taps; i++) {
  let value = i === 0 ? 1 : 0;
  for (const stage of stages) {
    const input = value;
    value = stage.b0 * input + stage.b1 * stage.x1 + stage.b2 * stage.x2 - stage.a1 * stage.y1 - stage.a2 * stage.y2;
    stage.x2 = stage.x1; stage.x1 = input; stage.y2 = stage.y1; stage.y1 = value;
  }
  fir[i] = value * referenceScale;
}
if (![...fir].every(Number.isFinite)) throw new Error("FIR synthesis produced non-finite taps");
mkdirSync(dirname(outputPath), { recursive: true });
const bytes = Buffer.from(fir.buffer);
writeFileSync(outputPath, bytes);
console.log(JSON.stringify({ outputPath, sampleRate, taps, sha256: createHash("sha256").update(bytes).digest("hex"), referenceGainDb: 20 * Math.log10(responseAt(1000) * referenceScale) }, null, 2));
