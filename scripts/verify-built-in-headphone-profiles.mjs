#!/usr/bin/env node
/** Verify every built-in headphone profile survives the production web build. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const dist = resolve("apps/web/dist");
const profileRoot = resolve(dist, "headphone-compensation");
const errors = [];
const ids = [
  "sony-mdr-7506-average-autoeq",
  "beyerdynamic-xelento-wired-average-autoeq",
  "beyerdynamic-xelento-2nd-gen-average-autoeq",
  "sennheiser-hd-820-average-autoeq",
];

for (const id of ids) {
  const directory = resolve(profileRoot, id);
  const manifestPath = resolve(directory, "profile.json");
  const readmePath = resolve(directory, "README.md");
  if (!existsSync(manifestPath)) {
    errors.push(`${id}: dist 缺少 profile.json`);
    continue;
  }
  if (!existsSync(readmePath)) errors.push(`${id}: dist 缺少 README.md`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.id !== id) errors.push(`${id}: manifest id 不匹配`);
  if (manifest.leftFir.fileName !== manifest.rightFir.fileName || manifest.leftFir.sha256 !== manifest.rightFir.sha256) {
    errors.push(`${id}: 内置 average-dual-mono FIR 必须共享同一资产`);
  }
  const firPath = resolve(directory, manifest.leftFir.fileName);
  if (!existsSync(firPath)) {
    errors.push(`${id}: dist 缺少 ${manifest.leftFir.fileName}`);
    continue;
  }
  const bytes = readFileSync(firPath);
  if (statSync(firPath).size !== manifest.leftFir.tapCount * Float32Array.BYTES_PER_ELEMENT) {
    errors.push(`${id}: FIR tapCount/字节长度不符`);
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== manifest.leftFir.sha256) errors.push(`${id}: FIR SHA-256 不匹配`);
  const resolvedFromFilePage = new URL(`headphone-compensation/${id}/${manifest.leftFir.fileName}`, new URL("index.html", `file:///${dist.replaceAll("\\", "/")}/`));
  if (!resolvedFromFilePage.pathname.endsWith(`/headphone-compensation/${id}/${manifest.leftFir.fileName}`)) {
    errors.push(`${id}: file:// 相对 URL 解析错误`);
  }
}

if (errors.length) {
  console.error(`生产耳机补偿资产无效: ${errors.join("；")}`);
  process.exit(1);
}
console.log(`生产耳机补偿资产有效: ${ids.length} 个内置 profile 已随 web dist 发布`);
