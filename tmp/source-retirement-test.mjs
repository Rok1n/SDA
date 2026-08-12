// Sample-scheduled source retirement must preserve prebuffered PCM and release cleanly.
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(path.join("packages", "renderer", "worklet", "sda-renderer.worklet.js"), "utf8");
let Renderer = null;
globalThis.sampleRate = 48000;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, postMessage() {} }; } };
globalThis.registerProcessor = (name, processor) => { if (name === "sda-renderer") Renderer = processor; };
eval(source);

const renderer = new Renderer({ processorOptions: { busCount: 1 } });
const post = (data) => renderer.port.onmessage({ data });
post({ type: "add", id: "obj:10" });
post({ type: "gains", id: "obj:10", gains: new Float32Array([1]), gain: 1, lp: 1, ramp: 1 });
post({ type: "feedBatch", sequence: 1, start: 0, entries: [{ id: "obj:10", samples: new Float32Array(384).fill(0.75) }] });
post({ type: "removeAt", id: "obj:10", at: 192 });
post({ type: "start", origin: 0 });
const output = new Float32Array(384);
for (let offset = 0; offset < output.length; offset += 128) {
  const block = new Float32Array(128);
  renderer.process([], [[block]]);
  output.set(block, offset);
}

let failed = 0;
function check(condition, text) { if (!condition) failed++; console.log(`${condition ? "PASS" : "FAIL"}  ${text}`); }
let maximumStep = 0;
for (let i = 192; i < 225; i++) maximumStep = Math.max(maximumStep, Math.abs(output[i] - output[i - 1]));
check(output[191] > 0.7, "retireAt 前的预缓冲 PCM 完整播放");
check(maximumStep < 0.03 && output[223] === 0, "retireAt 后 32 samples 连续淡出");
check(!renderer.sources.has("obj:10"), "release 完成后从实时 source Map 删除");
check(renderer.underrunSamples === 0, "计划退休不计入 underrun");

const resumed = new Renderer({ processorOptions: { busCount: 1 } });
const postResumed = (data) => resumed.port.onmessage({ data });
postResumed({ type: "add", id: "obj:10" });
postResumed({ type: "gains", id: "obj:10", gains: new Float32Array([1]), gain: 1, lp: 1, ramp: 1 });
postResumed({ type: "feedBatch", sequence: 2, start: 0, entries: [{ id: "obj:10", samples: new Float32Array(512).fill(0.75) }] });
postResumed({ type: "removeAt", id: "obj:10", at: 192 });
postResumed({ type: "resumeAt", id: "obj:10", at: 256 });
postResumed({ type: "start", origin: 0 });
const resumedOutput = new Float32Array(512);
for (let offset = 0; offset < resumedOutput.length; offset += 128) {
  const block = new Float32Array(128);
  resumed.process([], [[block]]);
  resumedOutput.set(block, offset);
}
check(resumedOutput[223] === 0 && resumedOutput[255] === 0, "同 ID 恢复前保持退休静音区间");
check(resumedOutput[256] < 0.03 && resumedOutput[287] > 0.7, "同 ID 在 resumeAt 后 32 samples 平滑淡入");
check(resumed.sources.has("obj:10"), "计划恢复的同 ID source 不会被提前删除");

const repeated = new Renderer({ processorOptions: { busCount: 1 } });
const postRepeated = (data) => repeated.port.onmessage({ data });
postRepeated({ type: "add", id: "obj:10" });
postRepeated({ type: "gains", id: "obj:10", gains: new Float32Array([1]), gain: 1, lp: 1, ramp: 1 });
postRepeated({ type: "feedBatch", sequence: 3, start: 0, entries: [{ id: "obj:10", samples: new Float32Array(384).fill(0.75) }] });
postRepeated({ type: "removeAt", id: "obj:10", at: 128 });
postRepeated({ type: "resumeAt", id: "obj:10", at: 192 });
postRepeated({ type: "removeAt", id: "obj:10", at: 256 });
postRepeated({ type: "start", origin: 0 });
const repeatedOutput = new Float32Array(384);
for (let offset = 0; offset < repeatedOutput.length; offset += 128) {
  const block = new Float32Array(128);
  repeated.process([], [[block]]);
  repeatedOutput.set(block, offset);
}
check(repeatedOutput[159] === 0 && repeatedOutput[191] === 0, "多个预缓冲边界保留第一个退休区间");
check(repeatedOutput[192] < 0.03 && repeatedOutput[223] > 0.7, "多个预缓冲边界按时恢复同 ID");
check(repeatedOutput[287] === 0 && !repeated.sources.has("obj:10"), "多个预缓冲边界执行最终退休并释放 source");

console.log(failed ? `\n${failed} 项失败` : "\n对象 source sample-scheduled 退休与恢复通过");
process.exit(failed ? 1 : 0);
