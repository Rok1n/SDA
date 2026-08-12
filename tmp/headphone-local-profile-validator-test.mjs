import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const directory = mkdtempSync(join(tmpdir(), "sda-profile-"));
const bytes = (values) => Buffer.from(new Float32Array(values).buffer);
const left = bytes([1, 0, 0.25, 0]);
const right = bytes([0.9, 0, 0.1, 0]);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const profile = {
  schemaVersion: 1, id: "airpods-pro-2-local-test", name: "AirPods Pro 2 local test",
  source: "fixture session", target: "documented target", leftMeasurement: "left raw", rightMeasurement: "right raw",
  balanceEvidence: "verified L/R map", measurementMode: "independent-lr", channelClaim: "independent L/R calibration",
  sampleRate: 48000, preampDb: -6, leftFirUrl: "local://left.f32", rightFirUrl: "local://right.f32",
  createdAt: "2026-08-12T00:00:00.000Z", deviceRevision: "test", playbackState: "ANC on", earTips: "M",
  firmware: "test", measurementRig: "fixture", referenceBand: "500 Hz to 2 kHz",
  leftFir: { fileName: "left.f32", tapCount: 4, sha256: hash(left) },
  rightFir: { fileName: "right.f32", tapCount: 4, sha256: hash(right) },
};
writeFileSync(join(directory, "left.f32"), left);
writeFileSync(join(directory, "right.f32"), right);
writeFileSync(join(directory, "profile.json"), JSON.stringify(profile, null, 2));
const validator = join(process.cwd(), "scripts", "validate-headphone-profile.mjs");
let result = spawnSync(process.execPath, [validator, join(directory, "profile.json")], { encoding: "utf8" });
console.log(result.stdout.trim());
if (result.status !== 0) process.exit(result.status ?? 1);
writeFileSync(join(directory, "right.f32"), Buffer.from([0, 1, 2, 3]));
result = spawnSync(process.execPath, [validator, join(directory, "profile.json")], { encoding: "utf8" });
console.log(result.stderr.trim());
rmSync(directory, { recursive: true, force: true });
if (result.status === 0 || !result.stderr.includes("SHA-256 不匹配")) process.exit(1);
console.log("本地 profile 篡改拒绝通过");
