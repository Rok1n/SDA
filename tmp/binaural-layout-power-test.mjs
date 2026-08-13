// Cross-layout KU100 calibration acceptance. The same decorrelated object field
// is VBAP-panned through the manual 5/7/9 Groups and rendered through one room.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "tmp/renderer.bundle.cjs");
const manifestPath = path.resolve(process.argv[2] ?? path.join(root, "apps/web/public/hrtf/hrtf-set.json"));
const hrtfDir = path.dirname(manifestPath);
const { BINAURAL_MODES, LAYOUTS, VbapSolver } = await import(pathToFileURL(bundle).href);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const calibrated = manifest.calibrationVersion >= 1 && manifest.processing?.calibrated === true;

const readF32 = (file) => {
  const bytes = readFileSync(path.join(hrtfDir, file));
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
};
const positions = new Map(manifest.positions.map((entry) => [
  `${entry.azimuth}/${entry.elevation}`,
  { ...entry, dry: readF32(entry.dry), wet: readF32(entry.wet) },
]));

function peak(values, limit = values.length) {
  let index = 0;
  let value = 0;
  for (let sample = 0; sample < Math.min(limit, values.length); sample++) {
    if (Math.abs(values[sample]) > value) {
      value = Math.abs(values[sample]);
      index = sample;
    }
  }
  return index;
}

function mixedIr(raw, mode, mirror = false) {
  const wetMix = BINAURAL_MODES[mode].wet;
  const dryLength = raw.dry.length >> 1;
  const wetLength = raw.wet.length >> 1;
  const dryLeft = raw.dry.subarray(0, dryLength);
  const dryRight = raw.dry.subarray(dryLength);
  const wetLeft = raw.wet.subarray(0, wetLength);
  const wetRight = raw.wet.subarray(wetLength);
  const shift = calibrated ? 0 : peak(wetLeft, 960) - peak(dryLeft);
  const left = new Float64Array(wetLength);
  const right = new Float64Array(wetLength);
  for (let sample = 0; sample < dryLength; sample++) {
    const output = sample + shift;
    if (output >= 0 && output < wetLength) {
      left[output] = (1 - wetMix) * dryLeft[sample];
      right[output] = (1 - wetMix) * dryRight[sample];
    }
  }
  for (let sample = 0; sample < wetLength; sample++) {
    left[sample] += wetMix * wetLeft[sample];
    right[sample] += wetMix * wetRight[sample];
  }

  if (!calibrated && Math.abs(raw.azimuth) < 1e-6) {
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let sample = 0; sample < wetLength; sample++) {
      leftEnergy += left[sample] ** 2;
      rightEnergy += right[sample] ** 2;
    }
    const target = (leftEnergy + rightEnergy) / 2;
    const leftScale = Math.sqrt(target / leftEnergy);
    const rightScale = Math.sqrt(target / rightEnergy);
    for (let sample = 0; sample < wetLength; sample++) {
      left[sample] *= leftScale;
      right[sample] *= rightScale;
    }
  }
  if (!calibrated) {
    let energy = 0;
    for (let sample = 0; sample < wetLength; sample++) energy += left[sample] ** 2 + right[sample] ** 2;
    const scale = 1 / Math.sqrt(energy || 1);
    for (let sample = 0; sample < wetLength; sample++) {
      left[sample] *= scale;
      right[sample] *= scale;
    }
  }
  return mirror ? { left: right, right: left } : { left, right };
}

function speakerIr(speaker, mode) {
  const mirror = !calibrated && speaker.name === "WideRight";
  const azimuth = mirror ? -speaker.azimuth : speaker.azimuth;
  const raw = positions.get(`${azimuth}/${speaker.elevation}`);
  if (!raw) throw new Error(`缺IR: ${speaker.name} ${azimuth}/${speaker.elevation}`);
  return mixedIr(raw, mode, mirror);
}

function fftPower(values) {
  const size = values.length;
  const real = Float64Array.from(values);
  const imaginary = new Float64Array(size);
  for (let index = 1, reversed = 0; index < size; index++) {
    let bit = size >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = -2 * Math.PI / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let offset = 0; offset < length / 2; offset++) {
        const even = start + offset;
        const odd = even + length / 2;
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
  return Float64Array.from(real, (value, index) => value ** 2 + imaginary[index] ** 2);
}

const objectDirections = Array.from({ length: 15 }, (_, index) => ({
  azimuth: -168 + index * 24,
  elevation: index % 3 === 0 ? 45 : 0,
  distance: 1,
}));
const layoutIds = ["5.1.4", "7.1.4", "9.1.4"];
const modes = ["near", "mid", "far"];
let failed = 0;
function check(condition, message) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${message}`);
}

check(calibrated, "manifest启用calibration v1");
for (const mode of modes) {
  const results = [];
  for (const layoutId of layoutIds) {
    const layout = LAYOUTS[layoutId];
    const solver = new VbapSolver(layout);
    const irs = layout.map((speaker) => speaker.isLfe ? null : speakerIr(speaker, mode));
    let broadband = 0;
    const bands = { low: 0, mid: 0, high: 0 };
    for (const position of objectDirections) {
      const gains = solver.pan(position, 0);
      const left = new Float64Array(8192);
      const right = new Float64Array(8192);
      for (let bus = 0; bus < gains.length; bus++) {
        const ir = irs[bus];
        if (!ir || gains[bus] === 0) continue;
        for (let sample = 0; sample < left.length; sample++) {
          left[sample] += gains[bus] * ir.left[sample];
          right[sample] += gains[bus] * ir.right[sample];
        }
      }
      for (let sample = 0; sample < left.length; sample++) broadband += left[sample] ** 2 + right[sample] ** 2;
      const leftPower = fftPower(left);
      const rightPower = fftPower(right);
      for (let bin = 1; bin <= 4096; bin++) {
        const frequency = bin * 48000 / 8192;
        const power = leftPower[bin] + rightPower[bin];
        if (frequency < 250) bands.low += power;
        else if (frequency < 4000) bands.mid += power;
        else bands.high += power;
      }
    }
    results.push({ layoutId, broadband, bands });
  }

  const reference = results[0];
  const deltas = results.map((result) => ({
    layoutId: result.layoutId,
    broadband: 10 * Math.log10(result.broadband / reference.broadband),
    low: 10 * Math.log10(result.bands.low / reference.bands.low),
    mid: 10 * Math.log10(result.bands.mid / reference.bands.mid),
    high: 10 * Math.log10(result.bands.high / reference.bands.high),
  }));
  for (const delta of deltas) {
    console.log(`INFO  ${mode}/${delta.layoutId}: broadband ${delta.broadband.toFixed(2)} dB, L ${delta.low.toFixed(2)} M ${delta.mid.toFixed(2)} H ${delta.high.toFixed(2)} dB`);
  }
  const spread = (key) => Math.max(...deltas.map((delta) => delta[key])) - Math.min(...deltas.map((delta) => delta[key]));
  check(spread("broadband") <= 0.5, `${mode}: 5/7/9 Group宽带离散≤0.5dB（${spread("broadband").toFixed(2)}dB）`);
  for (const band of ["low", "mid", "high"]) {
    check(spread(band) <= 1, `${mode}: 5/7/9 Group ${band}离散≤1dB（${spread(band).toFixed(2)}dB）`);
  }
}

console.log(failed ? `\n${failed}项Group验收失败` : "\nKU100单房间5/7/9 Group验收通过");
process.exit(failed ? 1 : 0);
