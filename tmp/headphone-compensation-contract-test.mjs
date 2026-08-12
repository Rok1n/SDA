// Headless contract test: built-ins require auditable measurement provenance.
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

const independentProfile = {
  id: "measured-headphone-rev-a",
  name: "Measured Headphone Rev A",
  source: "https://example.invalid/method",
  target: "Documented target v1",
  leftMeasurement: "https://example.invalid/left.csv",
  rightMeasurement: "https://example.invalid/right.csv",
  balanceEvidence: "GRAS rig, ANC state, tips, firmware, and verified L/R mapping",
  measurementMode: "independent-lr",
  channelClaim: "Independent L/R measurement and calibration",
  sampleRate: 48000,
  preampDb: -6,
  leftFirUrl: "/headphone/measured-left.f32",
  rightFirUrl: "/headphone/measured-right.f32",
};
const averageProfile = {
  ...independentProfile,
  id: "average-headphone-rev-a",
  measurementMode: "average-dual-mono",
  leftMeasurement: "Not applicable: published average response",
  rightMeasurement: "Not applicable: published average response",
  balanceEvidence: "Not applicable: this profile makes no L/R balance claim",
  channelClaim: "Same average EQ applied to L/R; not independent L/R calibration",
  averageMeasurement: "https://example.invalid/average.csv",
  derivation: "Published EQ synthesized at 48 kHz and 1 kHz normalized",
  leftFirUrl: "/headphone/average.f32",
  rightFirUrl: "/headphone/average.f32",
};

const mdr7506 = headphoneProfileById("sony-mdr-7506-average-autoeq");
const hd820 = headphoneProfileById("sennheiser-hd-820-average-autoeq");
const xelento = headphoneProfileById("beyerdynamic-xelento-wired-average-autoeq");
const xelento2ndGen = headphoneProfileById("beyerdynamic-xelento-2nd-gen-average-autoeq");
check(HEADPHONE_COMPENSATION_PROFILES.length === 4, "内置四个受限的平均测量 profile");
check(hd820?.measurementMode === "average-dual-mono", "HD 820 明确归类为平均双单声道");
check(hd820?.leftFirUrl === hd820?.rightFirUrl, "HD 820 仅在平均模式下共享 L/R FIR");
check(hd820?.channelClaim?.includes("非独立"), "HD 820 明确不声称独立 L/R 校准");
check(xelento2ndGen?.measurementMode === "average-dual-mono", "Xelento 2nd Gen 明确归类为平均双单声道");
check(xelento2ndGen?.leftFirUrl === xelento2ndGen?.rightFirUrl, "Xelento 2nd Gen 仅在平均模式下共享 L/R FIR");
check(xelento2ndGen?.channelClaim?.includes("非独立"), "Xelento 2nd Gen 明确不声称独立 L/R 校准");
check(xelento?.measurementMode === "average-dual-mono", "Xelento 有线版明确归类为平均双单声道");
check(xelento?.leftFirUrl === xelento?.rightFirUrl, "Xelento 有线版仅在平均模式下共享 L/R FIR");
check(xelento?.channelClaim?.includes("非独立"), "Xelento 有线版明确不声称独立 L/R 校准");
check(mdr7506?.measurementMode === "average-dual-mono", "MDR-7506 明确归类为平均双单声道");
check(mdr7506?.leftFirUrl === mdr7506?.rightFirUrl, "MDR-7506 仅在平均模式下共享 L/R FIR");
check(mdr7506?.channelClaim?.includes("非独立"), "MDR-7506 明确不声称独立 L/R 校准");
check(headphoneProfileById("airpods-pro-2-anc-averaged") === null, "已撤回 AirPods 平均测量 profile");
check(headphoneProfileById("unknown") === null, "未知 profile 不可选");
check(validateHeadphoneProfile(independentProfile).length === 0,
  "独立左右测量、状态/映射证明与不同 FIR 齐全的 profile 可通过契约");
check(validateHeadphoneProfile({ ...independentProfile, leftFirUrl: independentProfile.rightFirUrl }).some((error) => error.includes("独立资产")),
  "共享 FIR 不能伪装成独立 L/R profile");
check(validateHeadphoneProfile(averageProfile).length === 0,
  "具有限制声明、来源和同一 FIR 的平均 profile 可通过契约");
check(validateHeadphoneProfile({ ...averageProfile, channelClaim: "L/R calibrated" }).some((error) => error.includes("非独立")),
  "平均 profile 缺少非独立声明时被拒绝");
check(validateHeadphoneProfile({ ...averageProfile, rightFirUrl: "/headphone/other.f32" }).some((error) => error.includes("同一资产")),
  "平均 profile 使用不同 L/R FIR 时被拒绝");

console.log(failed ? `\n${failed} 项失败` : "\n耳机补偿 profile 测量类别契约通过");
process.exit(failed ? 1 : 0);
