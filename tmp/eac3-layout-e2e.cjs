/** 端到端：真实 JOC 码流 → 解码标签 → detectLayoutId（eac3 布局接入验证） */
const fs = require("fs");
const path = require("path");
const core = require("../packages/core/test/cjs/sda_core.js");
const { detectLayoutId } = require("./renderer.bundle.cjs");

const data = fs.readFileSync(
  path.join(__dirname, "../harletty-bridge/harletty/tests/fixtures/joc_atmos_1s.eac3"),
);
const dec = new core.SdaDecoder("eac3");
dec.push(data);

let first = null;
let frames = 0;
for (;;) {
  const f = dec.nextFrame();
  if (!f) break;
  frames++;
  if (!first) {
    const labels = [];
    for (let i = 0; i < f.channelCount; i++) labels.push(f.labels[i]);
    first = {
      labels,
      objects: JSON.parse(f.objectChannelsJson).length,
      events: JSON.parse(f.eventsJson).length,
    };
  }
  f.free();
}
console.log(`解码 ${frames} 帧`);
console.log(`首帧标签: [${first.labels.join(", ")}]`);
console.log(`对象声明 ${first.objects} 个, 事件 ${first.events} 个`);
const layout = detectLayoutId(first.labels, first.objects > 0);
console.log(`detectLayoutId → ${layout}`);
const errs = dec.drainErrors();
if (errs.length) console.log("解码错误:", errs);
console.log(layout === "7.1.4" && frames > 0 ? "E2E PASS" : "E2E FAIL");
process.exit(layout === "7.1.4" && frames > 0 ? 0 : 1);
