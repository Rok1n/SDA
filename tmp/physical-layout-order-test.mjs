// Physical channel ordering regression for compact 7.1.x/9.1.x output.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const bundle = path.join(path.dirname(fileURLToPath(import.meta.url)), "renderer.bundle.cjs");
const { LAYOUTS, physicalChannelOrder } = await import(pathToFileURL(bundle).href);

let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}
const names = (id) => physicalChannelOrder(LAYOUTS[id]).map((index) => LAYOUTS[id][index].name);

check(names("7.1.2").join() === [
  "FrontLeft", "FrontRight", "Center", "LFE", "RearLeft", "RearRight",
  "SurroundLeft", "SurroundRight", "TopMiddleLeft", "TopMiddleRight",
].join(), "7.1.2 物理输出紧凑且中顶声道在前 10 槽");
check(names("7.1.4").join() === [
  "FrontLeft", "FrontRight", "Center", "LFE", "RearLeft", "RearRight",
  "SurroundLeft", "SurroundRight", "TopFrontLeft", "TopFrontRight", "TopRearLeft", "TopRearRight",
].join(), "7.1.4 物理输出紧凑且顶后声道在前 12 槽");
check(names("9.1.6").join() === [
  "FrontLeft", "FrontRight", "Center", "LFE", "RearLeft", "RearRight",
  "WideLeft", "WideRight", "SurroundLeft", "SurroundRight",
  "TopFrontLeft", "TopFrontRight", "TopMiddleLeft", "TopMiddleRight", "TopRearLeft", "TopRearRight",
].join(), "9.1.6 WASAPI 顺序为 BL/BR、FLC/FRC、SL/SR 后接六顶声道");
for (const [id, layout] of Object.entries(LAYOUTS)) {
  const order = physicalChannelOrder(layout);
  check(order.length === layout.length && new Set(order).size === layout.length,
    `${id}: 每个选择布局声道恰好投影一次且无固定拓扑空洞`);
}

console.log(failed ? `\n${failed} 项失败` : "\n物理布局紧凑输出顺序通过");
process.exit(failed ? 1 : 0);
