// Object metadata pressure regression: repeated targets must not flood VBAP or
// MessagePort, while true motion remains sample-accurate and batched per frame.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const bundle = path.join(path.dirname(fileURLToPath(import.meta.url)), "renderer.bundle.cjs");
const posted = [];
function param() {
  return { value: 0, setValueAtTime(value) { this.value = value; }, linearRampToValueAtTime(value) { this.value = value; }, cancelScheduledValues() {} };
}
function node(tag) {
  return {
    _tag: tag,
    connect() {}, disconnect() {}, start() {}, stop() {},
    gain: param(), frequency: param(), Q: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
    positionX: param(), positionY: param(), positionZ: param(), channelCount: 0, channelCountMode: "", maxChannelCount: 32,
  };
}
class FakeAudioWorkletNode {
  constructor(_, name) { this._tag = name; this.port = { postMessage: (message) => posted.push(message), onmessage: null }; }
  connect() {}
  disconnect() {}
}
globalThis.AudioWorkletNode = FakeAudioWorkletNode;
class FakeAudioContext {
  constructor() { this.sampleRate = 48000; this.currentTime = 0; this.state = "running"; this.destination = node("destination"); this.audioWorklet = { addModule: async () => {} }; }
  createDelay() { const delay = node("delay"); delay.delayTime = param(); return delay; }
  createGain() { return node("gain"); }
  createBiquadFilter() { return node("biquad"); }
  createConvolver() { return node("conv"); }
  createPanner() { return node("panner"); }
  createDynamicsCompressor() { return node("compressor"); }
  createChannelSplitter(n) { return node(`split${n}`); }
  createChannelMerger(n) { return node(`merge${n}`); }
  createBuffer(_, length) { return { copyToChannel() {}, getChannelData: () => new Float32Array(length), length }; }
  async close() { this.state = "closed"; }
}

const { LAYOUTS, SpatialRenderer } = await import(pathToFileURL(bundle).href);
const renderer = new SpatialRenderer(new FakeAudioContext(), { mode: "binaural", layout: LAYOUTS["7.1.4"] });
await renderer.init("mock://worklet");
for (let id = 0; id < 15; id++) renderer.addSource(`obj:${id}`);
posted.length = 0;

const frame = (samplePos, offset = 0) => Array.from({ length: 15 }, (_, id) => ({
  id,
  samplePos,
  hasPos: true,
  pos: [id * 0.01 + offset, 1, 0],
  gainDb: 0,
  size: [0, 0, 0],
  anchor: "room",
  distanceM: null,
  distanceInfinite: false,
  screenFactor: null,
  depthFactor: null,
  rampDuration: 1536,
}));

let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}

let accepted = 0;
for (let index = 0; index < 940; index++) accepted += renderer.applyEvents(frame(index * 1536));
const gainMessages = posted.filter((message) => message.type === "scheduleGains" || message.type === "scheduleGainsBatch");
check(accepted === 15, `940 静态帧只计算首帧 15 个对象目标（实际 ${accepted}）`);
check(gainMessages.length === 1 && gainMessages[0].type === "scheduleGainsBatch" && gainMessages[0].entries.length === 15,
  `静态目标只产生一个批量 MessagePort 消息（实际 ${gainMessages.length}）`);

posted.length = 0;
accepted = renderer.applyEvents(frame(940 * 1536, 0.05));
const motionBatch = posted.find((message) => message.type === "scheduleGainsBatch");
check(accepted === 15, "真实移动保留全部 15 个对象事件");
check(motionBatch?.entries.length === 15, "一帧真实移动合并为一个 15-entry 消息");
check(motionBatch?.entries.every((entry) => entry.at === 940 * 1536 && entry.ramp === 1536),
  "批量对象事件保留原始 samplePos 和 rampDuration");

posted.length = 0;
const overlapping = renderer.applyEvents(frame(940 * 1536 + 768, 0.05));
check(overlapping === 15, "重叠斜坡的同目标事件全部保留");
check(posted.some((message) => message.type === "scheduleGainsBatch" && message.entries.length === 15),
  "同目标重启仍按样本时钟批量调度");

posted.length = 0;
const unchanged = renderer.applyEvents(frame(942 * 1536, 0.05));
check(unchanged === 0 && posted.every((message) => message.type !== "scheduleGains" && message.type !== "scheduleGainsBatch"),
  "斜坡完成后的重复目标在 VBAP 前被丢弃");

console.log(failed ? `\n${failed} 项失败` : "\n对象事件批量与去重通过");
process.exit(failed ? 1 : 0);
