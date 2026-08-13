// AudioWorklet scheduled-gain queue regression: batches append in order without
// per-message sorting, and rare out-of-order entries are inserted correctly.
import { readFileSync } from "node:fs";
import vm from "node:vm";

let ProcessorClass;
const context = {
  sampleRate: 48000,
  currentFrame: 0,
  AudioWorkletProcessor: class {
    constructor() { this.port = { postMessage() {}, onmessage: null }; }
  },
  registerProcessor(name, processor) {
    if (name === "sda-renderer") ProcessorClass = processor;
  },
  console,
};
vm.runInNewContext(readFileSync("packages/renderer/worklet/sda-renderer.worklet.js", "utf8"), context);
const processor = new ProcessorClass({ processorOptions: { busCount: 2 } });
processor.onMessage({ type: "add", id: "obj:1" });
const src = processor.sources.get("obj:1");
const gain = (at, value) => ({ type: "scheduleGains", id: "obj:1", at, gains: new Float32Array([value, 0]), gain: 1, lp: 1, ramp: 1 });
processor.onMessage({ type: "scheduleGainsBatch", entries: [gain(100, 0.1), gain(200, 0.2), gain(300, 0.3)] });
processor.onMessage(gain(250, 0.25));

let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}
check(src.scheduledGains.map(({ at }) => at).join() === "100,200,250,300", "乱序单条事件二分插入有序队列");
processor.applyScheduledGainsThrough(src, 225);
check(src.scheduledGainCursor === 2 && Math.abs(src.gains[0] - 0.2) < 1e-6, "游标消费前两条事件且不 shift 数组");
processor.onMessage({ type: "scheduleGainsBatch", entries: [gain(400, 0.4), gain(500, 0.5)] });
check(src.scheduledGains.map(({ at }) => at).join() === "100,200,250,300,400,500", "后续批量事件按时间 O(1) 追加");
processor.applyScheduledGainsThrough(src, 501);
check(Math.abs(src.gains[0] - 0.5) < 1e-6, "全部未来增益按 samplePos 顺序执行并完成一采样 ramp");
processor.onMessage({ type: "reset", epoch: 1 });
check(src.scheduledGains.length === 0 && src.scheduledGainCursor === 0, "reset 同时清空增益队列与游标");

console.log(failed ? `\n${failed} 项失败` : "\n工作节点对象增益队列通过");
process.exit(failed ? 1 : 0);
