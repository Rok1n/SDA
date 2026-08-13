#!/usr/bin/env node
/** Build level-, arrival-, and room-response-calibrated KU100 assets into staging. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { analyzeStereoImpulse, median } from "./lib/impulse-metrics.mjs";
import { collectIrs, nearestImpulse } from "./lib/hrtf-source.mjs";

const DRY_TAPS = 512;
const WET_TAPS = 8192;
const COMMON_ARRIVAL_SAMPLE = 128;
const DIRECT_WINDOW_MS = 4;
const REFERENCE_MINIMUM_HZ = 500;
const REFERENCE_MAXIMUM_HZ = 2000;
const ROOM_FRACTION = 3;
const ROOM_MINIMUM_HZ = 125;
const ROOM_MAXIMUM_HZ = 16000;
const ROOM_MAX_GAIN_DB = 3;
const ROOM_FIR_TAPS = 257;
const ROOM_GATE_START_MS = 2;
const ROOM_GATE_END_MS = 4;
const ROOM_DECORRELATION_VERSION = "sda-ku100-tail-ap-v1";
const ROOM_DECORRELATION_MINIMUM_HZ = 80;
const ROOM_DECORRELATION_MAXIMUM_HZ = 16000;
const ROOM_DECORRELATION_SECTIONS = 8;
const ROOM_DECORRELATION_MAX_ENERGY_TRIM_DB = 0.25;
const MAX_SPEAKER_LEVEL_GAIN_DB = 3;

const args = process.argv.slice(2);
function option(name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}

const manifestPath = resolve(option("manifest", "apps/web/public/hrtf/hrtf-set.json"));
const archivePath = resolve(option("archive", "tmp/sadie-source/D1.zip"));
const outputDirectory = resolve(option("out", "tmp/hrtf-calibrated"));
const sourceManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (sourceManifest.schemaVersion !== 2) throw new Error("校准构建要求schema v2 provenance manifest");
if (sourceManifest.positions?.length !== 17) throw new Error("校准构建要求17个虚拟音箱方向");

const archiveBytes = readFileSync(archivePath);
const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
if (archiveSha256 !== sourceManifest.source.archiveSha256) throw new Error("原始档案SHA-256与manifest不匹配");

const [dryCollection, wetCollection] = await Promise.all([
  collectIrs(archivePath, sourceManifest.source.hrPath),
  collectIrs(archivePath, sourceManifest.source.brPath),
]);
const dryByPath = new Map(dryCollection.impulses.map((impulse) => [impulse.sourcePath, impulse]));
const wetByPath = new Map(wetCollection.impulses.map((impulse) => [impulse.sourcePath, impulse]));
const sampleRate = sourceManifest.sampleRate;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gainFromDb = (db) => 10 ** (db / 20);
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function analyze(impulse, kind) {
  return analyzeStereoImpulse(impulse.left, impulse.right, impulse.sampleRate ?? sampleRate, {
    onsetThresholdDb: kind === "dry" ? -30 : -24,
    onsetHoldSamples: 1,
    onsetSearchSamples: Math.round(sampleRate * 0.03),
    directWindowMs: DIRECT_WINDOW_MS,
    earlyWindowMs: 50,
    lateStartMs: 50,
    directFftSize: 4096,
    fullFftSize: kind === "dry" ? 4096 : 16384,
    fraction: ROOM_FRACTION,
    referenceMinimumHz: REFERENCE_MINIMUM_HZ,
    referenceMaximumHz: REFERENCE_MAXIMUM_HZ,
  });
}

function alignStereo(left, right, commonOnset, length) {
  const shift = Math.round(COMMON_ARRIVAL_SAMPLE - commonOnset);
  const outputLeft = new Float64Array(length);
  const outputRight = new Float64Array(length);
  for (let index = 0; index < length; index++) {
    const sourceIndex = index - shift;
    outputLeft[index] = left[sourceIndex] ?? 0;
    outputRight[index] = right[sourceIndex] ?? 0;
  }
  return { left: outputLeft, right: outputRight, shift };
}

function scaleStereo(stereo, gain) {
  for (let index = 0; index < stereo.left.length; index++) {
    stereo.left[index] *= gain;
    stereo.right[index] *= gain;
  }
  return stereo;
}

function convolve(signal, filter) {
  const output = new Float64Array(signal.length + filter.length - 1);
  for (let sample = 0; sample < signal.length; sample++) {
    const value = signal[sample];
    if (value === 0) continue;
    for (let tap = 0; tap < filter.length; tap++) output[sample + tap] += value * filter[tap];
  }
  return output;
}

function interpolateCorrectionDb(bands, frequency) {
  if (frequency <= ROOM_MINIMUM_HZ || frequency >= ROOM_MAXIMUM_HZ) return 0;
  const active = bands.filter((band) => band.centerHz >= ROOM_MINIMUM_HZ && band.centerHz <= ROOM_MAXIMUM_HZ);
  if (frequency <= active[0].centerHz) {
    const blend = Math.log(frequency / ROOM_MINIMUM_HZ) / Math.log(active[0].centerHz / ROOM_MINIMUM_HZ);
    return active[0].correctionDb * clamp(blend, 0, 1);
  }
  if (frequency >= active.at(-1).centerHz) {
    const blend = Math.log(ROOM_MAXIMUM_HZ / frequency) / Math.log(ROOM_MAXIMUM_HZ / active.at(-1).centerHz);
    return active.at(-1).correctionDb * clamp(blend, 0, 1);
  }
  for (let index = 1; index < active.length; index++) {
    if (frequency > active[index].centerHz) continue;
    const lower = active[index - 1];
    const upper = active[index];
    const blend = Math.log(frequency / lower.centerHz) / Math.log(upper.centerHz / lower.centerHz);
    return lower.correctionDb + (upper.correctionDb - lower.correctionDb) * blend;
  }
  return 0;
}

function designLinearPhaseCorrection(bands) {
  const fftSize = 2048;
  const magnitudes = new Float64Array(fftSize / 2 + 1);
  for (let bin = 0; bin < magnitudes.length; bin++) {
    const frequency = bin * sampleRate / fftSize;
    magnitudes[bin] = gainFromDb(interpolateCorrectionDb(bands, frequency));
  }

  const center = (ROOM_FIR_TAPS - 1) / 2;
  const filter = new Float64Array(ROOM_FIR_TAPS);
  for (let tap = 0; tap < filter.length; tap++) {
    const time = tap - center;
    let value = magnitudes[0] + magnitudes.at(-1) * Math.cos(Math.PI * time);
    for (let bin = 1; bin < magnitudes.length - 1; bin++) {
      value += 2 * magnitudes[bin] * Math.cos(2 * Math.PI * bin * time / fftSize);
    }
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * tap / (filter.length - 1));
    filter[tap] = value * window / fftSize;
  }
  const dc = filter.reduce((sum, value) => sum + value, 0);
  if (dc !== 0) for (let index = 0; index < filter.length; index++) filter[index] /= dc;
  return filter;
}

function roomTail(stereo) {
  const start = COMMON_ARRIVAL_SAMPLE + Math.round(ROOM_GATE_START_MS * sampleRate / 1000);
  const end = COMMON_ARRIVAL_SAMPLE + Math.round(ROOM_GATE_END_MS * sampleRate / 1000);
  for (let index = 0; index < stereo.left.length; index++) {
    let gain = 1;
    if (index <= start) gain = 0;
    else if (index < end) gain = 0.5 - 0.5 * Math.cos(Math.PI * (index - start) / (end - start));
    stereo.left[index] *= gain;
    stereo.right[index] *= gain;
  }
  return stereo;
}

function stereoEnergy(stereo) {
  let total = 0;
  for (let index = 0; index < stereo.left.length; index++) {
    total += stereo.left[index] ** 2 + stereo.right[index] ** 2;
  }
  return total;
}

function stereoRangeEnergy(stereo, start, end) {
  let total = 0;
  const first = Math.max(0, Math.trunc(start));
  const last = Math.min(stereo.left.length, Math.trunc(end));
  for (let index = first; index < last; index++) {
    total += stereo.left[index] ** 2 + stereo.right[index] ** 2;
  }
  return total;
}

function energyDb(energy) {
  return energy > 0 ? 10 * Math.log10(energy) : Number.NEGATIVE_INFINITY;
}

function directEnergyCentroid(stereo) {
  const start = COMMON_ARRIVAL_SAMPLE;
  const end = Math.min(stereo.left.length, start + Math.round(DIRECT_WINDOW_MS * sampleRate / 1000));
  let weighted = 0;
  let total = 0;
  for (const channel of [stereo.left, stereo.right]) {
    for (let index = start; index < end; index++) {
      const power = channel[index] ** 2;
      weighted += index * power;
      total += power;
    }
  }
  return weighted / total;
}

function shiftStereo(stereo, amount) {
  const output = {
    left: new Float64Array(stereo.left.length),
    right: new Float64Array(stereo.right.length),
  };
  for (const [source, target] of [[stereo.left, output.left], [stereo.right, output.right]]) {
    for (let index = 0; index < source.length; index++) target[index] = source[index - amount] ?? 0;
  }
  return output;
}

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function allPassBiquad(signal, centerHz, radius) {
  const cosine = Math.cos(2 * Math.PI * centerHz / sampleRate);
  const a1 = -2 * radius * cosine;
  const a2 = radius * radius;
  const b0 = a2;
  const b1 = a1;
  const b2 = 1;
  const output = new Float64Array(signal.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let index = 0; index < signal.length; index++) {
    const x0 = signal[index];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    output[index] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return output;
}

function decorrelationParameters(position) {
  const key = `${position.azimuth}/${position.elevation}`;
  const digest = createHash("sha256")
    .update(`${ROOM_DECORRELATION_VERSION}\0${archiveSha256}\0${key}`)
    .digest();
  const random = xorshift32(digest.readUInt32LE(0));
  const logarithmicRange = Math.log(ROOM_DECORRELATION_MAXIMUM_HZ / ROOM_DECORRELATION_MINIMUM_HZ);
  const sections = Array.from({ length: ROOM_DECORRELATION_SECTIONS }, (_, index) => {
    const frequencyPosition = (index + 0.15 + 0.7 * random()) / ROOM_DECORRELATION_SECTIONS;
    return {
      centerHz: ROOM_DECORRELATION_MINIMUM_HZ * Math.exp(logarithmicRange * frequencyPosition),
      radius: 0.4 + 0.3 * random(),
    };
  });
  return { key, digestSha256: digest.toString("hex"), sections };
}

function decorrelateRoomTail(stereo, position) {
  const parameters = decorrelationParameters(position);
  let filteredLeft = stereo.left;
  let filteredRight = stereo.right;
  for (const section of parameters.sections) {
    filteredLeft = allPassBiquad(filteredLeft, section.centerHz, section.radius);
    filteredRight = allPassBiquad(filteredRight, section.centerHz, section.radius);
  }

  const output = { left: filteredLeft, right: filteredRight };
  const targetEnergy = stereoEnergy(stereo);
  const outputEnergy = stereoEnergy(output);
  const energyTrimDb = 10 * Math.log10(targetEnergy / outputEnergy);
  if (Math.abs(energyTrimDb) > ROOM_DECORRELATION_MAX_ENERGY_TRIM_DB) {
    throw new Error(
      `room tail去相关能量恢复越界 ${position.azimuth}/${position.elevation}: ${energyTrimDb.toFixed(3)}dB`,
    );
  }
  scaleStereo(output, gainFromDb(energyTrimDb));
  return {
    stereo: output,
    provenance: {
      algorithm: ROOM_DECORRELATION_VERSION,
      ...parameters,
      commonLeftRightFilter: true,
      energyTrimDb,
    },
  };
}

function combineWet(dry, tail) {
  const output = { left: Float64Array.from(tail.left), right: Float64Array.from(tail.right) };
  for (let index = 0; index < dry.left.length; index++) {
    output.left[index] += dry.left[index];
    output.right[index] += dry.right[index];
  }
  return output;
}

function stereoBytes(stereo) {
  const output = new Float32Array(stereo.left.length * 2);
  output.set(stereo.left, 0);
  output.set(stereo.right, stereo.left.length);
  return Buffer.from(output.buffer, output.byteOffset, output.byteLength);
}

const rows = sourceManifest.positions.map((position) => {
  const targetDry = dryByPath.get(position.measurement.dry.sourcePath);
  const wet = wetByPath.get(position.measurement.wet.sourcePath);
  if (!targetDry || !wet) throw new Error(`manifest源路径未命中: ${position.azimuth}/${position.elevation}`);
  const pairedDryMatch = nearestImpulse(dryCollection.impulses, wet.azimuth, wet.elevation);
  if (!pairedDryMatch || pairedDryMatch.distanceDegrees > 1e-3) {
    throw new Error(`BRIR方向缺同坐标HRIR: ${wet.azimuth}/${wet.elevation}`);
  }
  return {
    position,
    targetDry,
    wet,
    pairedDry: pairedDryMatch.impulse,
    targetDryAnalysis: analyze(targetDry, "dry"),
    wetAnalysis: analyze(wet, "wet"),
    pairedDryAnalysis: analyze(pairedDryMatch.impulse, "dry"),
  };
});

const directEnergyValuesDb = rows.map((row) => energyDb(stereoEnergy({
  left: row.targetDry.left,
  right: row.targetDry.right,
})));
const targetDirectEnergyDbUnbounded = median(directEnergyValuesDb);
const directEnergyMinimumDb = Math.min(...directEnergyValuesDb);
const directEnergyMaximumDb = Math.max(...directEnergyValuesDb);
const targetDirectEnergyDb = clamp(
  targetDirectEnergyDbUnbounded,
  directEnergyMaximumDb - MAX_SPEAKER_LEVEL_GAIN_DB,
  directEnergyMinimumDb + MAX_SPEAKER_LEVEL_GAIN_DB,
);
const roomBandTargets = rows[0].wetAnalysis.fullBands.map((band, bandIndex) => {
  const ratioDb = median(rows.map((row) => (
    row.wetAnalysis.fullBands[bandIndex].powerDb - row.pairedDryAnalysis.fullBands[bandIndex].powerDb
  )));
  return { centerHz: band.centerHz, ratioDb: Number.isFinite(ratioDb) ? ratioDb : null };
});

for (const row of rows) {
  row.roomCorrectionBands = row.wetAnalysis.fullBands.map((band, bandIndex) => {
    const measuredRatioDb = band.powerDb - row.pairedDryAnalysis.fullBands[bandIndex].powerDb;
    const targetRatioDb = roomBandTargets[bandIndex].ratioDb;
    const inCorrectionRange = band.centerHz >= ROOM_MINIMUM_HZ && band.centerHz <= ROOM_MAXIMUM_HZ;
    const correctionDb = inCorrectionRange && Number.isFinite(measuredRatioDb) && Number.isFinite(targetRatioDb)
      ? clamp(targetRatioDb - measuredRatioDb, -ROOM_MAX_GAIN_DB, ROOM_MAX_GAIN_DB)
      : 0;
    return {
      centerHz: band.centerHz,
      measuredRatioDb: Number.isFinite(measuredRatioDb) ? measuredRatioDb : null,
      targetRatioDb: Number.isFinite(targetRatioDb) ? targetRatioDb : null,
      correctionDb,
    };
  });
}

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
const positions = [];
const wetTotalGains = [];
const dryTotalGains = [];
const roomSourceCanonical = new Map();
for (const row of rows) {
  const sourcePath = row.position.measurement.wet.sourcePath;
  if (!roomSourceCanonical.has(sourcePath)) {
    roomSourceCanonical.set(sourcePath, {
      azimuth: row.position.azimuth,
      elevation: row.position.elevation,
    });
  }
}

const earlyRoomStartSample = COMMON_ARRIVAL_SAMPLE + Math.round(ROOM_GATE_END_MS * sampleRate / 1000);
const earlyRoomEndSample = COMMON_ARRIVAL_SAMPLE + Math.round(50 * sampleRate / 1000);
const prepared = rows.map((row) => {
  let dryAligned = alignStereo(
    row.targetDry.left,
    row.targetDry.right,
    row.targetDryAnalysis.onset.commonSample,
    DRY_TAPS,
  );
  const dryBeforeGain = analyze({ ...dryAligned, sampleRate }, "dry");
  const dryEnergyDbBeforeGain = energyDb(stereoEnergy(dryAligned));
  const dryGainDb = targetDirectEnergyDb - dryEnergyDbBeforeGain;
  if (Math.abs(dryGainDb) > MAX_SPEAKER_LEVEL_GAIN_DB + 1e-9) {
    throw new Error(`宽带直达校准超过±3dB ${row.position.azimuth}/${row.position.elevation}: ${dryGainDb.toFixed(2)}dB`);
  }
  scaleStereo(dryAligned, gainFromDb(dryGainDb));

  const correctionFir = designLinearPhaseCorrection(row.roomCorrectionBands);
  const filteredWet = {
    left: convolve(row.wet.left, correctionFir),
    right: convolve(row.wet.right, correctionFir),
    sampleRate,
  };
  const filteredWetAnalysis = analyze(filteredWet, "wet");
  const wetAligned = alignStereo(
    filteredWet.left,
    filteredWet.right,
    filteredWetAnalysis.onset.commonSample,
    WET_TAPS,
  );
  let tail = roomTail(wetAligned);
  return {
    row,
    dryAligned,
    dryCoarseShiftSamples: dryAligned.shift,
    dryBeforeGain,
    dryEnergyDbBeforeGain,
    dryGainDb,
    filteredWetAnalysis,
    wetAligned,
    wetCoarseShiftSamples: wetAligned.shift,
    tail,
    directEnergyCentroidSample: directEnergyCentroid(dryAligned),
  };
});
const targetDirectEnergyCentroidSample = median(prepared.map((entry) => entry.directEnergyCentroidSample));
for (const entry of prepared) {
  entry.energyCentroidShiftSamples = Math.round(
    targetDirectEnergyCentroidSample - entry.directEnergyCentroidSample,
  );
  entry.dryAligned = shiftStereo(entry.dryAligned, entry.energyCentroidShiftSamples);
  entry.tail = shiftStereo(entry.tail, entry.energyCentroidShiftSamples);
  entry.directEnergyCentroidOutputSample = directEnergyCentroid(entry.dryAligned);
  entry.roomEarlyEnergyDb = energyDb(stereoRangeEnergy(
    entry.tail,
    earlyRoomStartSample,
    earlyRoomEndSample,
  ));
}
const targetRoomEarlyEnergyDb = median(prepared.map((entry) => entry.roomEarlyEnergyDb));

for (const entry of prepared) {
  const { dryAligned, tail } = entry;
  const { row, dryBeforeGain, dryEnergyDbBeforeGain, dryGainDb, filteredWetAnalysis } = entry;
  const roomGainDb = targetRoomEarlyEnergyDb - entry.roomEarlyEnergyDb;
  if (Math.abs(roomGainDb) > MAX_SPEAKER_LEVEL_GAIN_DB + 1e-9) {
    throw new Error(`房间residual校准超过±3dB ${row.position.azimuth}/${row.position.elevation}: ${roomGainDb.toFixed(2)}dB`);
  }
  scaleStereo(tail, gainFromDb(roomGainDb));
  const sourcePath = row.position.measurement.wet.sourcePath;
  const canonical = roomSourceCanonical.get(sourcePath);
  let roomTailOutput = tail;
  let roomTailDecorrelation = {
    role: "canonical",
    canonicalTarget: canonical,
    algorithm: null,
  };
  if (canonical.azimuth !== row.position.azimuth || canonical.elevation !== row.position.elevation) {
    const decorrelated = decorrelateRoomTail(tail, row.position);
    roomTailOutput = decorrelated.stereo;
    roomTailDecorrelation = {
      role: "variant",
      canonicalTarget: canonical,
      ...decorrelated.provenance,
    };
  }
  const baselineWetAnalysis = analyze({ ...combineWet(dryAligned, tail), sampleRate }, "wet");
  const wetOutput = combineWet(dryAligned, roomTailOutput);

  const dryBytes = stereoBytes(dryAligned);
  const wetBytes = stereoBytes(wetOutput);
  writeFileSync(resolve(outputDirectory, row.position.dry), dryBytes);
  writeFileSync(resolve(outputDirectory, row.position.wet), wetBytes);
  dryTotalGains.push(dryGainDb);
  wetTotalGains.push(roomGainDb);

  const dryOutputAnalysis = analyze({ ...dryAligned, sampleRate }, "dry");
  const wetOutputAnalysis = analyze({ ...wetOutput, sampleRate }, "wet");
  positions.push({
    ...row.position,
    measurement: {
      ...row.position.measurement,
      roomReferenceDry: {
        sourcePath: row.pairedDry.sourcePath,
        azimuth: row.pairedDry.azimuth,
        elevation: row.pairedDry.elevation,
        sourceDistanceMeters: sourceManifest.source.hrirMeasurement.radiusMeters,
        monitor: sourceManifest.source.hrirMeasurement.monitor,
      },
    },
    processing: {
      dry: {
        sourceOnset: row.targetDryAnalysis.onset,
        coarseAlignmentShiftSamples: entry.dryCoarseShiftSamples,
        energyCentroidTof: {
          beforeSample: entry.directEnergyCentroidSample,
          targetSample: targetDirectEnergyCentroidSample,
          commonShiftSamples: entry.energyCentroidShiftSamples,
          afterSample: entry.directEnergyCentroidOutputSample,
        },
        commonDelaySamples: entry.dryCoarseShiftSamples + entry.energyCentroidShiftSamples,
        calibrationGainDb: dryGainDb,
        fullHrirEnergyDbBeforeGain: dryEnergyDbBeforeGain,
        fullHrirEnergyTargetDb: targetDirectEnergyDb,
        fullHrirEnergyDbOutput: energyDb(stereoEnergy(dryAligned)),
        outputOnset: dryOutputAnalysis.onset,
      },
      wet: {
        sourceOnset: row.wetAnalysis.onset,
        filteredOnset: filteredWetAnalysis.onset,
        coarseAlignmentShiftSamples: entry.wetCoarseShiftSamples,
        energyCentroidTof: {
          targetSample: targetDirectEnergyCentroidSample,
          commonShiftSamples: entry.energyCentroidShiftSamples,
        },
        commonDelaySamples: entry.wetCoarseShiftSamples + entry.energyCentroidShiftSamples,
        calibrationGainDb: roomGainDb,
        roomEarlyEnergyDbBeforeGain: entry.roomEarlyEnergyDb,
        roomEarlyEnergyTargetDb: targetRoomEarlyEnergyDb,
        roomCorrectionBands: row.roomCorrectionBands,
        directPathSource: row.position.measurement.dry.sourcePath,
        roomTailSource: row.position.measurement.wet.sourcePath,
        roomTailDecorrelation: {
          ...roomTailDecorrelation,
          baselineMetrics: {
            c50Db: baselineWetAnalysis.windows.c50Db,
            c80Db: baselineWetAnalysis.windows.c80Db,
            directToLateDb: baselineWetAnalysis.windows.directToLateDb,
            totalEnergyDb: baselineWetAnalysis.windows.totalEnergyDb,
          },
          outputMetrics: {
            c50Db: wetOutputAnalysis.windows.c50Db,
            c80Db: wetOutputAnalysis.windows.c80Db,
            directToLateDb: wetOutputAnalysis.windows.directToLateDb,
            totalEnergyDb: wetOutputAnalysis.windows.totalEnergyDb,
          },
        },
        outputOnset: wetOutputAnalysis.onset,
      },
    },
    assets: {
      dry: { tapCountPerEar: DRY_TAPS, sha256: sha256(dryBytes) },
      wet: { tapCountPerEar: WET_TAPS, sha256: sha256(wetBytes) },
    },
  });
}

const dryGlobalGainDb = median(dryTotalGains);
const wetGlobalGainDb = median(wetTotalGains);
for (let index = 0; index < positions.length; index++) {
  positions[index].processing.dry.globalGainDb = dryGlobalGainDb;
  positions[index].processing.dry.speakerLevelTrimDb = dryTotalGains[index] - dryGlobalGainDb;
  positions[index].processing.wet.globalGainDb = wetGlobalGainDb;
  positions[index].processing.wet.speakerLevelTrimDb = wetTotalGains[index] - wetGlobalGainDb;
}

const manifest = {
  ...sourceManifest,
  calibrationVersion: 2,
  processing: {
    dryTapLimit: DRY_TAPS,
    wetTapLimit: WET_TAPS,
    peakNormalized: false,
    calibrated: true,
    runtimeEnergyNormalization: false,
    directPathModel: "target HRIR plus calibrated BRIR room tail",
    note: "One KU100 room/listening position. Per-speaker common arrival, direct reference level, low-resolution room-response correction, and deterministic decorrelation only for reused BRIR room tails; no layout- or programme-specific EQ.",
  },
  calibration: {
    algorithm: "sda-ku100-room-v2",
    sampleRate,
    commonArrivalSample: COMMON_ARRIVAL_SAMPLE,
    energyCentroidTof: {
      metric: "stereo direct-energy time centroid",
      targetSample: targetDirectEnergyCentroidSample,
      windowStartSample: COMMON_ARRIVAL_SAMPLE,
      windowMs: DIRECT_WINDOW_MS,
      maximumOutputSpreadSamples: 1,
      commonLeftRightShift: true,
      commonDryRoomResidualShift: true,
    },
    directReference: {
      metric: "stereo full-anechoic-HRIR energy",
      targetEnergyDb: targetDirectEnergyDb,
      minimumHz: 20,
      maximumHz: sampleRate / 2,
      windowMs: null,
    },
    roomResidualReference: {
      metric: "stereo 4-50ms gated room-residual energy",
      targetEnergyDb: targetRoomEarlyEnergyDb,
      startMs: ROOM_GATE_END_MS,
      endMs: 50,
      maximumGainDb: 3,
    },
    roomCorrection: {
      fraction: ROOM_FRACTION,
      minimumHz: ROOM_MINIMUM_HZ,
      maximumHz: ROOM_MAXIMUM_HZ,
      maximumGainDb: ROOM_MAX_GAIN_DB,
      firTaps: ROOM_FIR_TAPS,
      phase: "linear",
      commonLeftRightFilter: true,
      target: "robust median BRIR/paired-HRIR room transfer across all virtual speakers",
      bands: roomBandTargets,
    },
    roomTailGate: { startMs: ROOM_GATE_START_MS, endMs: ROOM_GATE_END_MS },
    roomTailDecorrelation: {
      algorithm: ROOM_DECORRELATION_VERSION,
      scope: "only non-canonical virtual speakers that reuse the same measured BRIR source",
      sections: ROOM_DECORRELATION_SECTIONS,
      minimumHz: ROOM_DECORRELATION_MINIMUM_HZ,
      maximumHz: ROOM_DECORRELATION_MAXIMUM_HZ,
      maximumEnergyTrimDb: ROOM_DECORRELATION_MAX_ENERGY_TRIM_DB,
      commonLeftRightFilter: true,
    },
    level: { dryGlobalGainDb, wetGlobalGainDb },
  },
  positions,
};
writeFileSync(resolve(outputDirectory, "hrtf-set.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`校准staging完成: ${positions.length}方向 -> ${outputDirectory}`);
console.log(`共同到达=${COMMON_ARRIVAL_SAMPLE} samples, 宽带直达=${targetDirectEnergyDb.toFixed(2)} dB`);
console.log(`直达能量质心TOF=${targetDirectEnergyCentroidSample.toFixed(3)} samples`);
console.log(`房间residual 4-50ms=${targetRoomEarlyEnergyDb.toFixed(2)} dB`);
console.log(`dry全局=${dryGlobalGainDb.toFixed(2)} dB, wet全局=${wetGlobalGainDb.toFixed(2)} dB`);
