// Regression for the user MP4's EC-3/JOC presentation: raw 5.1 bed plus objects.
const fs = require("fs");
const core = require("./sda_core.cjs");

const accessUnit = fs.readFileSync("tmp/user-first-ec3.au");
const decoder = new core.SdaDecoder("eac3");
decoder.push(accessUnit);
const frame = decoder.nextFrame();
if (!frame) throw new Error("user EC-3 access unit did not decode");
const actual = {
  rawBedLabels: frame.rawBedLabels,
  outputLabels: frame.labels,
  declarations: JSON.parse(frame.objectChannelsJson),
};
frame.free();
let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}

const expectedBed = ["FrontLeft", "Center", "FrontRight", "SurroundLeft", "SurroundRight", "LFE"];
check(actual.rawBedLabels.join(",") === expectedBed.join(","), `原始 E-AC-3 床层为 5.1 (${actual.rawBedLabels.join(", ")})`);
check(actual.outputLabels[0] === "LFE", "JOC 固定输出保留 LFE 床层");
check(actual.outputLabels.filter((label) => label.startsWith("Obj_")).length === 15, "JOC 重建 15 路对象 PCM");
check(actual.declarations.length === 15, "JOC 首帧声明 15 个对象路由");
console.log(failed ? `\n${failed} 项失败` : "\n真实 MP4 E-AC-3/JOC 元数据契约通过");
process.exit(failed ? 1 : 0);
