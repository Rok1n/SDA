// Headless contract test: built-ins require auditable independent L/R balance.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const bundle = path.join(path.dirname(fileURLToPath(import.meta.url)), "renderer.bundle.cjs");
const {
  HEADPHONE_COMPENSATION_PROFILES,
  headphoneProfileById,
  validateHeadphoneProfile,
} = await import(pathToFileURL(bundle).href);

let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}

const validProfile = {
  id: "measured-headphone-rev-a",
  name: "Measured Headphone Rev A",
  source: "https://example.invalid/method",
  target: "Documented target v1",
  leftMeasurement: "https://example.invalid/left.csv",
  rightMeasurement: "https://example.invalid/right.csv",
  balanceEvidence: "GRAS rig, ANC state, tips, firmware, and verified L/R mapping",
  sampleRate: 48000,
  leftFirUrl: "/headphone/measured-left.f32",
  rightFirUrl: "/headphone/measured-right.f32",
};

check(HEADPHONE_COMPENSATION_PROFILES.length === 0, "不内置未经独立左右平衡验证的耳机 profile");
check(headphoneProfileById("airpods-pro-2-anc-averaged") === null, "已撤回 AirPods 平均测量 profile");
check(headphoneProfileById("unknown") === null, "未知 profile 不可选");
check(validateHeadphoneProfile(validProfile).length === 0,
  "独立左右测量、状态/映射证明与左右 FIR 齐全的 profile 可通过契约");
check(validateHeadphoneProfile({ ...validProfile, leftMeasurement: "", balanceEvidence: "" }).length >= 2,
  "缺独立左右测量或平衡证明的 profile 被拒绝");

console.log(failed ? `\n${failed} 项失败` : "\n耳机补偿 profile 平衡契约通过");
process.exit(failed ? 1 : 0);
