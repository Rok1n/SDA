import assert from "node:assert/strict";
import {
  alignedStereoWindow,
  analyzeStereoImpulse,
  median,
  stereoWindowEnergy,
  sumBandPower,
} from "../lib/impulse-metrics.mjs";

const sampleRate = 48000;
const left = new Float64Array(9600);
const right = new Float64Array(9600);
left[100] = 1;
right[105] = 0.5;
left[100 + Math.round(0.04 * sampleRate)] = 0.25;
right[105 + Math.round(0.04 * sampleRate)] = 0.125;
left[100 + Math.round(0.06 * sampleRate)] = 0.125;
right[105 + Math.round(0.06 * sampleRate)] = 0.0625;
left[100 + Math.round(0.09 * sampleRate)] = 0.0625;
right[105 + Math.round(0.09 * sampleRate)] = 0.03125;

const analysis = analyzeStereoImpulse(left, right, sampleRate, {
  onsetThresholdDb: -20,
  directWindowMs: 4,
  directFftSize: 4096,
  fullFftSize: 16384,
});
assert.deepEqual(analysis.onset, {
  leftSample: 100,
  rightSample: 105,
  commonSample: 102.5,
  itdSamples: -5,
});
assert.equal(analysis.windows.directEnergy, 1.25);
assert.equal(stereoWindowEnergy(left, right, 100, 105, 192), 1.25);
const aligned = alignedStereoWindow(left, right, 100, 105, 8);
assert.equal(aligned.left[0], 1);
assert.equal(aligned.right[0], 0.5);
assert.ok(Number.isFinite(analysis.windows.referencePowerDb));
assert.ok(analysis.windows.c50Db > 10);
assert.ok(analysis.windows.c80Db > analysis.windows.c50Db);
assert.ok(sumBandPower(analysis.directBands, 500, 2000) > 0);

assert.equal(median([5, 1, 9]), 5);
assert.equal(median([4, 2, 10, 8]), 6);
assert.ok(Number.isNaN(median([Number.NaN])));

console.log("Impulse metric tests passed");
