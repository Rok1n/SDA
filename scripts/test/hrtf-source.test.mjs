import assert from "node:assert/strict";
import {
  angularDistanceDegrees,
  nearestImpulse,
  parseAzEl,
  parseWav,
} from "../lib/hrtf-source.mjs";

function pcm24(value) {
  const integer = Math.max(-8388608, Math.min(8388607, Math.round(value * 8388608)));
  return Buffer.from([integer & 0xff, (integer >> 8) & 0xff, (integer >> 16) & 0xff]);
}

function stereoWav24(left, right, sampleRate = 48000) {
  assert.equal(left.length, right.length);
  const data = Buffer.concat(left.flatMap((value, index) => [pcm24(value), pcm24(right[index])]));
  const output = Buffer.alloc(44 + data.length);
  output.write("RIFF", 0);
  output.writeUInt32LE(output.length - 8, 4);
  output.write("WAVE", 8);
  output.write("fmt ", 12);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(2, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 6, 28);
  output.writeUInt16LE(6, 32);
  output.writeUInt16LE(24, 34);
  output.write("data", 36);
  output.writeUInt32LE(data.length, 40);
  data.copy(output, 44);
  return output;
}

assert.deepEqual(parseAzEl("azi_315,0_ele_-35,3.wav"), [315, -35.3]);
assert.deepEqual(parseAzEl("az-60_el45_wet.wav"), [-60, 45]);
assert.deepEqual(parseAzEl("140_0.wav"), [140, 0]);
assert.equal(parseAzEl("README.txt"), null);

{
  const sourceLeft = [0, 0.5, -0.5, 0.25];
  const sourceRight = [0, -0.25, 0.75, -0.5];
  const wav = parseWav(stereoWav24(sourceLeft, sourceRight));
  assert.equal(wav.sampleRate, 48000);
  assert.equal(wav.channels, 2);
  assert.equal(wav.bitsPerSample, 24);
  for (let index = 0; index < sourceLeft.length; index++) {
    assert.ok(Math.abs(wav.left[index] - sourceLeft[index]) < 2 / 8388608);
    assert.ok(Math.abs(wav.right[index] - sourceRight[index]) < 2 / 8388608);
  }
}

assert.ok(Math.abs(angularDistanceDegrees(30, 0, 45, 0) - 15) < 1e-10);
assert.ok(Math.abs(angularDistanceDegrees(-45, 0, 315, 0)) < 1e-10);
assert.ok(Math.abs(angularDistanceDegrees(0, 45, 0, 0) - 45) < 1e-10);

{
  const impulses = [
    { azimuth: 0, elevation: 0, sourcePath: "front.wav" },
    { azimuth: 45, elevation: 0, sourcePath: "left.wav" },
    { azimuth: 315, elevation: 0, sourcePath: "right.wav" },
  ];
  const left = nearestImpulse(impulses, 30, 0);
  const right = nearestImpulse(impulses, -60, 0);
  assert.equal(left.impulse.sourcePath, "left.wav");
  assert.ok(Math.abs(left.distanceDegrees - 15) < 1e-10);
  assert.equal(right.impulse.sourcePath, "right.wav");
  assert.ok(Math.abs(right.distanceDegrees - 15) < 1e-10);
}

console.log("HRTF source parsing tests passed");
