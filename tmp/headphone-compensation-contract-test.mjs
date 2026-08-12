// Headless contract test for the built-in AirPods Pro 2 ANC averaged profile.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "tmp/renderer.bundle.cjs");
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

const profile = headphoneProfileById("airpods-pro-2-anc-averaged");
check(HEADPHONE_COMPENSATION_PROFILES.length === 1, "内置一个明确标注的平均近似 profile");
check(!!profile && profile.name.includes("平均测量近似"), "AirPods Pro 2 profile 明确标注平均近似");
check(profile?.sampleRate === 48000 && profile?.preampDb === -3.4 && profile?.postFirLoudnessTrimDb === 2,
  "AirPods profile 固定为 48kHz / -3.4dB preamp / +2dB loudness trim");
check(profile !== null && validateHeadphoneProfile(profile).length === 0, "内置 profile 通过元数据契约校验");
check(headphoneProfileById("unknown") === null, "未知 profile 不可选");
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
    postFirLoudnessTrimDb: 4,
  }).length >= 6,
  "缺来源、左右 FIR 或越界响度 trim 的 profile 被拒绝",
);

if (profile) {
  const asset = (url) => path.join(root, "apps/web/public", url.replace(/^\//, ""));
  const left = readFileSync(asset(profile.leftFirUrl));
  const right = readFileSync(asset(profile.rightFirUrl));
  check(left.length === 4800 * Float32Array.BYTES_PER_ELEMENT, "左耳 FIR 为 4,800 taps f32le");
  check(left.equals(right), "平均测量近似的左右 FIR 逐字节相同");
  const taps = new Float32Array(left.buffer, left.byteOffset, left.length / Float32Array.BYTES_PER_ELEMENT);
  check(taps.every(Number.isFinite), "FIR taps 均为有限值");
}

console.log(failed ? `\n${failed} 项失败` : "\n耳机补偿 profile 契约通过");
process.exit(failed ? 1 : 0);
