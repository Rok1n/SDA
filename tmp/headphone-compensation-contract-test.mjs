// Headless contract test: only traceable measured headphone profiles are valid.
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

check(HEADPHONE_COMPENSATION_PROFILES.length === 0, "默认不内置未经授权的耳机曲线");
check(headphoneProfileById("unknown") === null, "未知 profile 不可选");
check(
  validateHeadphoneProfile({
    id: "demo-headphone",
    name: "Demo Headphone",
    source: "https://example.invalid/measurement",
    target: "Documented diffuse-field target",
    sampleRate: 48000,
    leftFirUrl: "/headphone/demo-left.f32",
    rightFirUrl: "/headphone/demo-right.f32",
    preampDb: -6,
  }).length === 0,
  "完整来源、目标、左右 FIR 与 headroom 的 profile 可通过契约校验",
);
check(
  validateHeadphoneProfile({
    id: "BAD ID",
    name: "",
    source: "",
    target: "",
    sampleRate: 0,
    leftFirUrl: "",
    rightFirUrl: "",
    preampDb: 1,
  }).length >= 6,
  "缺来源或左右 FIR 的 profile 被拒绝",
);

console.log(failed ? `\n${failed} 项失败` : "\n耳机补偿 profile 契约通过");
process.exit(failed ? 1 : 0);
