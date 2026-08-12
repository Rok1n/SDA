// Regression: an EC-3/JOC stream keeps Obj_* labels after sparse declarations end.
const fs = require("fs");
const path = require("path");
const core = require("../packages/core/test/cjs/sda_core.js");

const fixture = path.join(__dirname, "../harletty-bridge/harletty/tests/fixtures/joc_atmos_1s.eac3");
const decoder = new core.SdaDecoder("eac3");
decoder.push(fs.readFileSync(fixture));
let frameCount = 0;
let declaredObjects = 0;
let laterObjectLabels = 0;
let failed = 0;

while (true) {
  const frame = decoder.nextFrame();
  if (!frame) break;
  frameCount++;
  const labels = frame.labels;
  const labelsObjectCount = labels.filter((label) => label.startsWith("Obj_")).length;
  const declarations = JSON.parse(frame.objectChannelsJson);
  if (frameCount === 1) declaredObjects = declarations.length;
  if (frameCount > 1) laterObjectLabels = Math.max(laterObjectLabels, labelsObjectCount);
  frame.free();
}

function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}

check(frameCount > 1, `JOC fixture 解码多帧 (${frameCount})`);
check(declaredObjects > 0, `首帧有稀疏对象声明 (${declaredObjects})`);
check(laterObjectLabels === declaredObjects, `后续帧保持 Obj_* 标签 (${laterObjectLabels})`);
console.log(failed ? `\n${failed} 项失败` : "\nJOC 稀疏对象元数据契约通过");
process.exit(failed ? 1 : 0);
