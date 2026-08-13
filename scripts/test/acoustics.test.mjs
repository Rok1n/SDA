import assert from "node:assert/strict";
import {
  clarityDb,
  detectOnset,
  energy,
  estimateDelay,
  fftReal,
  fractionalOctaveBands,
  groupDelay,
  peakIndex,
  powerSpectrum,
  stereoArrival,
  unwrapPhase,
} from "../lib/acoustics.mjs";

const sampleRate = 48000;
const almostEqual = (actual, expected, tolerance, message) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
};

{
  const impulse = new Float64Array(64);
  impulse[11] = -0.75;
  assert.deepEqual(peakIndex(impulse), { index: 11, value: 0.75 });
  assert.equal(detectOnset(impulse), 11);
  assert.equal(energy(impulse), 0.75 ** 2);
}

{
  const reference = new Float64Array(128);
  const delayed = new Float64Array(128);
  for (let index = 0; index < 32; index++) {
    const value = Math.sin(index * 0.71) * Math.exp(-index / 9);
    reference[24 + index] = value;
    delayed[31 + index] = value;
  }
  const estimate = estimateDelay(reference, delayed, 20);
  almostEqual(estimate.lag, 7, 0.01, "cross-correlation delay");
  assert.ok(estimate.correlation > 0.999999);
}

{
  const left = new Float64Array(128);
  const right = new Float64Array(128);
  left[30] = 1;
  right[34] = 1;
  assert.deepEqual(stereoArrival(left, right), { left: 30, right: 34, common: 32, itd: -4 });
}

{
  const response = new Float64Array(sampleRate / 5);
  response[0] = 1;
  response[Math.round(0.04 * sampleRate)] = 0.5;
  response[Math.round(0.06 * sampleRate)] = 0.25;
  response[Math.round(0.09 * sampleRate)] = 0.125;
  const expectedC50 = 10 * Math.log10((1 + 0.5 ** 2) / (0.25 ** 2 + 0.125 ** 2));
  const expectedC80 = 10 * Math.log10((1 + 0.5 ** 2 + 0.25 ** 2) / 0.125 ** 2);
  almostEqual(clarityDb(response, sampleRate, 50), expectedC50, 1e-12, "C50");
  almostEqual(clarityDb(response, sampleRate, 80), expectedC80, 1e-12, "C80");
}

{
  const impulse = new Float64Array(256);
  impulse[23] = 1;
  const delay = groupDelay(impulse, sampleRate, 4096);
  const measuredSamples = delay.slice(10, 1000).reduce((sum, value) => sum + value * sampleRate, 0) / 990;
  almostEqual(measuredSamples, 23, 1e-9, "pure-delay group delay");
}

{
  const phase = unwrapPhase(Float64Array.of(0, Math.PI * 0.75, -Math.PI * 0.75, -Math.PI * 0.25));
  almostEqual(phase[2], Math.PI * 1.25, 1e-12, "phase unwrap");
  almostEqual(phase[3], Math.PI * 1.75, 1e-12, "phase unwrap continuation");
}

{
  const size = 4096;
  const tone = new Float64Array(size);
  for (let index = 0; index < size; index++) tone[index] = Math.sin(2 * Math.PI * 1000 * index / sampleRate);
  const { real, imag } = fftReal(tone, size);
  const bin = Math.round(1000 * size / sampleRate);
  assert.ok(Math.hypot(real[bin], imag[bin]) > size * 0.4);
  const power = powerSpectrum(tone, size);
  assert.equal(power.length, size / 2 + 1);
  const bands = fractionalOctaveBands(tone, sampleRate, 3, { fftSize: size });
  const strongest = bands.reduce((best, band) => band.power > best.power ? band : best);
  almostEqual(strongest.center, 1000, 1e-9, "third-octave center");
}

console.log("Acoustic analysis tests passed");
