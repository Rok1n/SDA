#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { analyzeStereoImpulse, median } from "./lib/impulse-metrics.mjs";
import { collectIrs, nearestImpulse } from "./lib/hrtf-source.mjs";

const args = process.argv.slice(2);
function option(name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}
const manifestPath = resolve(option("manifest", "apps/web/public/hrtf/hrtf-set.json"));
const archivePath = resolve(option("archive", "tmp/sadie-source/D1.zip"));
const outputDirectory = resolve(option("out", "tmp/hrtf-calibration-baseline"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.schemaVersion !== 2) throw new Error("基线报告要求schema v2 manifest");
const archiveBytes = readFileSync(archivePath);
const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
if (archiveSha256 !== manifest.source.archiveSha256) throw new Error("原始档案SHA-256与manifest不匹配");

const [dryCollection, wetCollection] = await Promise.all([
  collectIrs(archivePath, manifest.source.hrPath),
  collectIrs(archivePath, manifest.source.brPath),
]);
const dryByPath = new Map(dryCollection.impulses.map((impulse) => [impulse.sourcePath, impulse]));
const wetByPath = new Map(wetCollection.impulses.map((impulse) => [impulse.sourcePath, impulse]));

function analyze(impulse, kind) {
  return analyzeStereoImpulse(impulse.left, impulse.right, impulse.sampleRate, {
    onsetThresholdDb: kind === "dry" ? -30 : -24,
    onsetHoldSamples: 1,
    onsetSearchSamples: Math.round(impulse.sampleRate * 0.03),
    directWindowMs: 4,
    earlyWindowMs: 50,
    lateStartMs: 50,
    directFftSize: 4096,
    fullFftSize: kind === "dry" ? 4096 : 16384,
    fraction: 3,
    referenceMinimumHz: 500,
    referenceMaximumHz: 2000,
  });
}

function readDerived(fileName) {
  const bytes = readFileSync(resolve(manifestPath, "..", fileName));
  const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const length = samples.length >> 1;
  return {
    left: Float64Array.from(samples.subarray(0, length)),
    right: Float64Array.from(samples.subarray(length)),
    sampleRate: manifest.sampleRate,
  };
}

function compact(analysis) {
  return {
    onset: analysis.onset,
    peak: analysis.peak,
    windows: analysis.windows,
    directBands: analysis.directBands,
    fullBands: analysis.fullBands,
  };
}

const rows = [];
for (const position of manifest.positions) {
  const dry = dryByPath.get(position.measurement.dry.sourcePath);
  const wet = wetByPath.get(position.measurement.wet.sourcePath);
  if (!dry || !wet) throw new Error(`manifest源路径未命中: ${position.azimuth}/${position.elevation}`);
  const pairedDryMatch = nearestImpulse(dryCollection.impulses, wet.azimuth, wet.elevation);
  if (!pairedDryMatch || pairedDryMatch.distanceDegrees > 1e-3) {
    throw new Error(`BRIR方向缺精确HRIR配对: ${wet.azimuth}/${wet.elevation}`);
  }
  const targetDryAnalysis = analyze(dry, "dry");
  const pairedDryAnalysis = analyze(pairedDryMatch.impulse, "dry");
  const wetAnalysis = analyze(wet, "wet");
  const derivedDryAnalysis = analyze(readDerived(position.dry), "dry");
  const derivedWetAnalysis = analyze(readDerived(position.wet), "wet");
  rows.push({
    target: { azimuth: position.azimuth, elevation: position.elevation },
    mapping: {
      targetDry: position.measurement.dry,
      wet: position.measurement.wet,
      pairedDry: {
        sourcePath: pairedDryMatch.impulse.sourcePath,
        azimuth: pairedDryMatch.impulse.azimuth,
        elevation: pairedDryMatch.impulse.elevation,
      },
    },
    original: {
      targetDry: compact(targetDryAnalysis),
      pairedDry: compact(pairedDryAnalysis),
      wet: compact(wetAnalysis),
    },
    derived: {
      dry: compact(derivedDryAnalysis),
      wet: compact(derivedWetAnalysis),
    },
  });
}

const commonArrivals = rows.map((row) => row.original.wet.onset.commonSample);
const referencePowers = rows.map((row) => row.original.pairedDry.windows.referencePowerDb);
const targetCommonArrivalSample = median(commonArrivals);
const targetReferencePowerDb = median(referencePowers);
for (const row of rows) {
  row.recommendation = {
    commonDelaySamples: targetCommonArrivalSample - row.original.wet.onset.commonSample,
    directReferenceGainDb: targetReferencePowerDb - row.original.pairedDry.windows.referencePowerDb,
    preservesOriginalItdSamples: row.original.wet.onset.itdSamples,
  };
}

const summary = {
  generatedFrom: {
    archive: basename(archivePath),
    archiveSha256,
    manifest: basename(manifestPath),
    schemaVersion: manifest.schemaVersion,
    calibrationVersion: manifest.calibrationVersion,
  },
  measurementModel: {
    dry: manifest.source.hrirMeasurement,
    wet: manifest.source.brirMeasurement,
    note: "BRIR room transfer is compared against an exact HRIR at the actual BRIR measurement coordinate, not the target virtual-speaker coordinate.",
  },
  targets: {
    commonArrivalSample: targetCommonArrivalSample,
    directReferencePowerDb: targetReferencePowerDb,
  },
  ranges: {
    wetCommonArrivalSamples: [Math.min(...commonArrivals), Math.max(...commonArrivals)],
    wetCommonArrivalSpreadMs: (Math.max(...commonArrivals) - Math.min(...commonArrivals)) * 1000 / manifest.sampleRate,
    pairedDryReferencePowerDb: [Math.min(...referencePowers), Math.max(...referencePowers)],
    pairedDryReferenceSpreadDb: Math.max(...referencePowers) - Math.min(...referencePowers),
    recommendedCommonDelaySamples: [
      Math.min(...rows.map((row) => row.recommendation.commonDelaySamples)),
      Math.max(...rows.map((row) => row.recommendation.commonDelaySamples)),
    ],
    recommendedDirectGainDb: [
      Math.min(...rows.map((row) => row.recommendation.directReferenceGainDb)),
      Math.max(...rows.map((row) => row.recommendation.directReferenceGainDb)),
    ],
  },
  rows,
};

const markdown = [
  "# KU100 Virtual Room Calibration Baseline",
  "",
  `- Source: ${manifest.source.name}`,
  `- Archive SHA-256: \`${archiveSha256}\``,
  `- Dry: ${manifest.source.hrirMeasurement.monitor} at ${manifest.source.hrirMeasurement.radiusMeters} m`,
  `- Wet: ${manifest.source.brirMeasurement.monitor} at ${manifest.source.brirMeasurement.radiusMeters} m (${manifest.source.brirMeasurement.grid})`,
  `- Wet common-arrival spread: ${summary.ranges.wetCommonArrivalSpreadMs.toFixed(3)} ms`,
  `- Paired-HRIR 500–2000 Hz direct reference spread: ${summary.ranges.pairedDryReferenceSpreadDb.toFixed(2)} dB`,
  `- Recommended common delay range: ${summary.ranges.recommendedCommonDelaySamples.map((value) => value.toFixed(2)).join(" to ")} samples`,
  `- Recommended direct gain range: ${summary.ranges.recommendedDirectGainDb.map((value) => value.toFixed(2)).join(" to ")} dB`,
  "",
  "| Target | Wet source | Error | Wet onset common | Wet ITD | Direct/Late | C50 | C80 | Paired HRIR ref | Delay rec | Gain rec |",
  "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...rows.map((row) => {
    const target = `${row.target.azimuth}/${row.target.elevation}`;
    const wet = `${row.mapping.wet.azimuth}/${row.mapping.wet.elevation}`;
    const analysis = row.original.wet;
    return `| ${target} | ${wet} | ${row.mapping.wet.angularErrorDegrees.toFixed(2)}° | ${analysis.onset.commonSample.toFixed(1)} | ${analysis.onset.itdSamples.toFixed(1)} | ${analysis.windows.directToLateDb.toFixed(2)} dB | ${analysis.windows.c50Db.toFixed(2)} dB | ${analysis.windows.c80Db.toFixed(2)} dB | ${row.original.pairedDry.windows.referencePowerDb.toFixed(2)} dB | ${row.recommendation.commonDelaySamples.toFixed(1)} | ${row.recommendation.directReferenceGainDb.toFixed(2)} dB |`;
  }),
  "",
  "This report is diagnostic only. Recommendations are not applied to production assets until provenance and acceptance limits pass.",
  "",
].join("\n");

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(resolve(outputDirectory, "baseline.json"), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(resolve(outputDirectory, "baseline.md"), markdown);
console.log(markdown);
