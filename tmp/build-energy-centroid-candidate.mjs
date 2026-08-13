import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const sourceDirectory = "tmp/hrtf-calibrated-v2";
const outputDirectory = "tmp/hrtf-energy-centroid-candidate";
const manifest = JSON.parse(readFileSync(path.join(sourceDirectory, "hrtf-set.json"), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readStereo = (fileName) => {
  const bytes = readFileSync(path.join(sourceDirectory, fileName));
  const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const length = samples.length >> 1;
  return [Float64Array.from(samples.subarray(0, length)), Float64Array.from(samples.subarray(length))];
};
const bytesFor = (stereo) => {
  const samples = new Float32Array(stereo[0].length * 2);
  samples.set(stereo[0]);
  samples.set(stereo[1], stereo[0].length);
  return Buffer.from(samples.buffer);
};
const centroid = (stereo) => {
  const start = manifest.calibration.commonArrivalSample;
  const end = Math.min(stereo[0].length, start + Math.round(0.004 * manifest.sampleRate));
  let weighted = 0;
  let energy = 0;
  for (const channel of stereo) for (let index = start; index < end; index++) {
    const power = channel[index] ** 2;
    weighted += index * power;
    energy += power;
  }
  return weighted / energy;
};
const shift = (stereo, amount) => stereo.map((channel) => {
  const output = new Float64Array(channel.length);
  for (let index = 0; index < channel.length; index++) output[index] = channel[index - amount] ?? 0;
  return output;
});
const prepared = manifest.positions.map((position) => ({ position, dry: readStereo(position.dry), wet: readStereo(position.wet) }));
const values = prepared.map((entry) => centroid(entry.dry)).sort((a, b) => a - b);
const target = values[values.length >> 1];
rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
for (const entry of prepared) {
  const before = centroid(entry.dry);
  const amount = Math.round(target - before);
  const dry = shift(entry.dry, amount);
  const wet = shift(entry.wet, amount);
  const dryBytes = bytesFor(dry);
  const wetBytes = bytesFor(wet);
  writeFileSync(path.join(outputDirectory, entry.position.dry), dryBytes);
  writeFileSync(path.join(outputDirectory, entry.position.wet), wetBytes);
  entry.position.assets.dry.sha256 = sha256(dryBytes);
  entry.position.assets.wet.sha256 = sha256(wetBytes);
  entry.position.processing.dry.energyCentroidTof = { beforeSample: before, targetSample: target, commonShiftSamples: amount, afterSample: centroid(dry) };
  entry.position.processing.wet.energyCentroidTof = { targetSample: target, commonShiftSamples: amount };
}
manifest.calibration.algorithm = "sda-ku100-room-v2-energy-centroid-candidate";
manifest.calibration.energyCentroidTof = { targetSample: target, windowMs: 4, commonLeftRightShift: true, candidateOnly: true };
writeFileSync(path.join(outputDirectory, "hrtf-set.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`energy centroid target=${target.toFixed(3)} -> ${outputDirectory}`);
