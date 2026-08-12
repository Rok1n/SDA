#!/usr/bin/env node
/** Validate an auditable local headphone-compensation package. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error("用法: node scripts/validate-headphone-profile.mjs <profile.json>");
  process.exit(1);
}

const absoluteManifestPath = resolve(manifestPath);
const profile = JSON.parse(readFileSync(absoluteManifestPath, "utf8"));
const errors = [];
if (profile.schemaVersion !== 1) errors.push("schemaVersion 必须为 1");
if (!/^[a-z0-9][a-z0-9-]*$/.test(profile.id ?? "")) errors.push("id 必须是小写 slug");
if (!["independent-lr", "average-dual-mono"].includes(profile.measurementMode)) errors.push("measurementMode 无效");
for (const key of [
  "name", "source", "target", "channelClaim", "createdAt", "deviceRevision", "playbackState", "earTips", "firmware", "measurementRig", "referenceBand",
]) {
  if (typeof profile[key] !== "string" || !profile[key].trim()) errors.push(`缺少 ${key}`);
}
if (profile.measurementMode === "independent-lr") {
  for (const key of ["leftMeasurement", "rightMeasurement", "balanceEvidence"]) {
    if (typeof profile[key] !== "string" || !profile[key].trim()) errors.push(`独立 L/R profile 缺少 ${key}`);
  }
} else if (profile.measurementMode === "average-dual-mono") {
  for (const key of ["averageMeasurement", "derivation"]) {
    if (typeof profile[key] !== "string" || !profile[key].trim()) errors.push(`平均双单声道 profile 缺少 ${key}`);
  }
  if (!/not independent|非独立|同一.*(?:eq|曲线)/i.test(profile.channelClaim ?? "")) errors.push("平均双单声道 profile 必须声明非独立 L/R");
}
if (!Number.isFinite(Date.parse(profile.createdAt))) errors.push("createdAt 无效");
if (!Number.isFinite(profile.sampleRate) || profile.sampleRate <= 0) errors.push("sampleRate 无效");
if (!Number.isFinite(profile.preampDb) || profile.preampDb > 0) errors.push("preampDb 必须是有限非正值");

for (const key of ["leftFir", "rightFir"]) {
  const asset = profile[key];
  if (!asset || typeof asset !== "object") {
    errors.push(`缺少 ${key}`);
    continue;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.f32$/.test(asset.fileName ?? "")) errors.push(`${key}.fileName 无效`);
  if (!Number.isInteger(asset.tapCount) || asset.tapCount < 2) errors.push(`${key}.tapCount 无效`);
  if (!/^[a-f0-9]{64}$/i.test(asset.sha256 ?? "")) errors.push(`${key}.sha256 无效`);
  const filePath = resolve(dirname(absoluteManifestPath), asset.fileName ?? "");
  if (!existsSync(filePath)) {
    errors.push(`${key} 文件不存在`);
    continue;
  }
  const bytes = readFileSync(filePath);
  if (bytes.byteLength !== asset.tapCount * Float32Array.BYTES_PER_ELEMENT) errors.push(`${key} 字节长度与 tapCount 不符`);
  if (statSync(filePath).size !== bytes.byteLength || bytes.byteLength % Float32Array.BYTES_PER_ELEMENT) errors.push(`${key} 不是合法 f32 数据`);
  const taps = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
  if (![...taps].every(Number.isFinite)) errors.push(`${key} 包含非有限 tap`);
  if (createHash("sha256").update(bytes).digest("hex") !== String(asset.sha256).toLowerCase()) errors.push(`${key} SHA-256 不匹配`);
}
const sharedAsset = profile.leftFir?.fileName === profile.rightFir?.fileName || profile.leftFir?.sha256 === profile.rightFir?.sha256;
if (profile.measurementMode === "independent-lr" && sharedAsset) errors.push("独立 L/R profile 的左右 FIR 必须是独立资产");
if (profile.measurementMode === "average-dual-mono" && !sharedAsset) errors.push("平均双单声道 profile 的左右 FIR 必须是同一资产");

if (errors.length) {
  console.error(`Profile 无效: ${errors.join("；")}`);
  process.exit(1);
}
console.log(`Profile 有效: ${profile.id} @ ${profile.sampleRate}Hz，${profile.measurementMode} FIR 与 SHA-256 已验证`);
