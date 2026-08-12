// Worklet PCM gap regression: explicit holes and recovery must be continuous.
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(path.join("packages", "renderer", "worklet", "sda-renderer.worklet.js"), "utf8");
let Renderer = null;
globalThis.sampleRate = 48000;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { onmessage: null, postMessage() {} }; }
};
globalThis.registerProcessor = (name, processor) => {
  if (name === "sda-renderer") Renderer = processor;
};
eval(source);

const renderer = new Renderer({ processorOptions: { busCount: 1 } });
const post = (data) => renderer.port.onmessage({ data });
post({ type: "add", id: "source" });
post({ type: "gains", id: "source", gains: new Float32Array([1]), gain: 1, lp: 1, ramp: 1 });
post({ type: "feedBatch", sequence: 1, start: 0, entries: [{ id: "source", samples: new Float32Array(128).fill(0.75) }] });
post({ type: "feedBatch", sequence: 2, start: 192, entries: [{ id: "source", samples: new Float32Array(128).fill(-0.75) }] });
post({ type: "start", origin: 0 });

const rendered = new Float32Array(384);
for (let offset = 0; offset < rendered.length; offset += 128) {
  const block = new Float32Array(128);
  renderer.process([], [[block]]);
  rendered.set(block, offset);
}

let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}
const maxStep = (values, start, end) => {
  let maximum = 0;
  for (let i = Math.max(1, start); i < end; i++) maximum = Math.max(maximum, Math.abs(values[i] - values[i - 1]));
  return maximum;
};

check(rendered[127] > 0.7 && rendered[159] === 0,
"显式 gap 被标记为缺样而不是普通零 PCM");
check(maxStep(rendered, 120, 165) < 0.03,
"进入 gap 在 32 samples 内平滑衰减，无非零到零阶跃");
check(rendered[192] > -0.03 && rendered[223] < -0.7,
"恢复到反相 PCM 时由当前零电平平滑插值");
check(maxStep(rendered, 185, 230) < 0.03,
"gap 恢复无零到非零单样本阶跃");

console.log(failed ? `\n${failed} 项失败` : "\nPCM gap 进入与恢复连续性通过");
process.exit(failed ? 1 : 0);
