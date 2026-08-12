#!/usr/bin/env node
/** Validate a redistributable headphone-compensation profile manifest. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error("用法: node scripts/validate-headphone-profile.mjs <profile.json>");
  process.exit(1);
}

const profile = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
const errors = [];
if (!/^[a-z0-9][a-z0-9-]*$/.test(profile.id ?? "")) errors.push("id 必须是小写 slug");
for (const key of ["name", "source", "target", "leftMeasurement", "rightMeasurement", "balanceEvidence", "leftFirUrl", "rightFirUrl"]) {
  if (typeof profile[key] !== "string" || !profile[key].trim()) errors.push(`缺少 ${key}`);
}
if (!Number.isFinite(profile.sampleRate) || profile.sampleRate <= 0) errors.push("sampleRate 无效");

if (errors.length) {
  console.error(`Profile 无效: ${errors.join("；")}`);
  process.exit(1);
}
console.log(`Profile 有效: ${profile.id} @ ${profile.sampleRate}Hz`);
