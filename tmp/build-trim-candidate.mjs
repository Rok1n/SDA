import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const sourceDirectory = "tmp/hrtf-calibrated-v2";
const outputDirectory = "tmp/hrtf-trim-candidate";
const manifest = JSON.parse(readFileSync(path.join(sourceDirectory, "hrtf-set.json"), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const energy = (stereo) => stereo.reduce((sum, channel) => sum + channel.reduce((part, value) => part + value ** 2, 0), 0);
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

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
const targetEnergy = 10 ** (manifest.calibration.directReference.targetEnergyDb / 10);
for (const position of manifest.positions) {
  const dry = readStereo(position.dry);
  const wet = readStereo(position.wet);
  const tail = wet.map((channel, ear) => Float64Array.from(channel, (value, index) => value - (dry[ear][index] ?? 0)));
  let peakIndex = 0;
  let peak = 0;
  for (let index = 0; index < dry[0].length; index++) {
    const value = Math.max(Math.abs(dry[0][index]), Math.abs(dry[1][index]));
    if (value > peak) {
      peak = value;
      peakIndex = index;
    }
  }
  const trimBefore = Math.max(0, peakIndex - 16);
  for (const channel of dry) channel.fill(0, 0, trimBefore);
  const gain = Math.sqrt(targetEnergy / energy(dry));
  for (const channel of dry) for (let index = 0; index < channel.length; index++) channel[index] *= gain;
  const nextWet = wet.map((channel, ear) => Float64Array.from(channel, (_value, index) => (dry[ear][index] ?? 0) + tail[ear][index]));
  const dryBytes = bytesFor(dry);
  const wetBytes = bytesFor(nextWet);
  writeFileSync(path.join(outputDirectory, position.dry), dryBytes);
  writeFileSync(path.join(outputDirectory, position.wet), wetBytes);
  position.assets.dry.sha256 = sha256(dryBytes);
  position.assets.wet.sha256 = sha256(wetBytes);
  position.processing.dry.trimBeforeSample = trimBefore;
  position.processing.dry.postTrimGainDb = 20 * Math.log10(gain);
  position.processing.dry.outputOnset.leftSample = dry[0].findIndex((value) => value !== 0);
  position.processing.dry.outputOnset.rightSample = dry[1].findIndex((value) => value !== 0);
  position.processing.dry.outputOnset.commonSample = (position.processing.dry.outputOnset.leftSample + position.processing.dry.outputOnset.rightSample) / 2;
  position.processing.dry.outputOnset.itdSamples = position.processing.dry.outputOnset.leftSample - position.processing.dry.outputOnset.rightSample;
}
manifest.calibration.algorithm = "sda-ku100-room-v2-trim-candidate";
manifest.calibration.directReference.trim = "zero before shared binaural peak minus 16 samples; candidate only";
writeFileSync(path.join(outputDirectory, "hrtf-set.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`trim candidate -> ${outputDirectory}`);
