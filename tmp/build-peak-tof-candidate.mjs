import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const sourceDirectory = "tmp/hrtf-calibrated-v2";
const factor = Number(process.argv[2] ?? 1);
const outputDirectory = process.argv[3] ?? "tmp/hrtf-peak-tof-candidate";
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
const commonPeak = (stereo) => {
  const indices = stereo.map((channel) => {
    let index = 0;
    let peak = 0;
    for (let sample = 0; sample < channel.length; sample++) {
      const value = Math.abs(channel[sample]);
      if (value > peak) {
        peak = value;
        index = sample;
      }
    }
    return index;
  });
  return { left: indices[0], right: indices[1], common: (indices[0] + indices[1]) / 2, itd: indices[0] - indices[1] };
};
const shift = (stereo, amount) => stereo.map((channel) => {
  const output = new Float64Array(channel.length);
  for (let index = 0; index < channel.length; index++) output[index] = channel[index - amount] ?? 0;
  return output;
});
const prepared = manifest.positions.map((position) => ({ position, dry: readStereo(position.dry), wet: readStereo(position.wet) }));
const peaks = prepared.map((entry) => commonPeak(entry.dry).common).sort((a, b) => a - b);
const target = peaks[peaks.length >> 1];
rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
for (const entry of prepared) {
  const before = commonPeak(entry.dry);
  const amount = Math.round(factor * (target - before.common));
  const dry = shift(entry.dry, amount);
  const wet = shift(entry.wet, amount);
  const after = commonPeak(dry);
  const dryBytes = bytesFor(dry);
  const wetBytes = bytesFor(wet);
  writeFileSync(path.join(outputDirectory, entry.position.dry), dryBytes);
  writeFileSync(path.join(outputDirectory, entry.position.wet), wetBytes);
  entry.position.assets.dry.sha256 = sha256(dryBytes);
  entry.position.assets.wet.sha256 = sha256(wetBytes);
  entry.position.processing.dry.peakTof = { before, targetCommonSample: target, commonShiftSamples: amount, after };
  entry.position.processing.wet.peakTof = { targetCommonSample: target, commonShiftSamples: amount };
}
manifest.calibration.algorithm = "sda-ku100-room-v2-peak-tof-candidate";
manifest.calibration.peakTof = { targetCommonSample: target, alignmentFactor: factor, commonLeftRightShift: true, candidateOnly: true };
writeFileSync(path.join(outputDirectory, "hrtf-set.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`peak TOF candidate target=${target} -> ${outputDirectory}`);
