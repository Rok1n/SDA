// Headless integration test: renderer main thread -> worklet message protocol.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "tmp/renderer.bundle.cjs");
const posted = [];
function param() { return { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} }; }
function node() {
  return {
    connect() {}, disconnect() {}, start() {}, stop() {}, gain: param(), frequency: param(), Q: param(),
    threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
    positionX: param(), positionY: param(), positionZ: param(), channelCount: 0, channelCountMode: "", maxChannelCount: 32,
  };
}
class FakeAudioWorkletNode {
  constructor() { this.port = { postMessage: (message) => posted.push(message), onmessage: null }; }
  connect() {}
  disconnect() {}
}
globalThis.AudioWorkletNode = FakeAudioWorkletNode;
class FakeAudioContext {
  constructor() { this.sampleRate = 48000; this.currentTime = 0; this.state = "running"; this.destination = node(); this.audioWorklet = { addModule: async () => {} }; }
  createDelay() { const delay = node(); delay.delayTime = param(); return delay; }
  createGain() { return node(); }
  createBiquadFilter() { return node(); }
  createConvolver() { return node(); }
  createPanner() { return node(); }
  createDynamicsCompressor() { return node(); }
  createChannelSplitter() { return node(); }
  createChannelMerger() { return node(); }
  createBuffer(_, length) { return { copyToChannel() {}, getChannelData: () => new Float32Array(length), length }; }
  async close() { this.state = "closed"; }
}

const { LAYOUTS, RENDER_TOPOLOGY, SpatialRenderer } = await import(pathToFileURL(bundle).href);
const renderer = new SpatialRenderer(new FakeAudioContext(), { mode: "stereo", layout: LAYOUTS["5.1"] });
await renderer.init("mock://worklet");
renderer.addSource("obj:10");
const event = (samplePos, x) => ({
  id: 10, samplePos, pos: [x, 1, 0], hasPos: true, size: [0, 0, 0], gainDb: 0,
  anchor: "room", distanceM: null, distanceInfinite: false, screenFactor: null, depthFactor: null, rampDuration: 128,
});
renderer.applyEvent(event(0, 0), 128);
renderer.setSourceMuted("obj:10", true);
for (let i = 1; i <= 5; i++) renderer.applyEvent(event(i * 128, i * 0.1), 128);
renderer.addSource("obj:10");
renderer.setSourceMuted("obj:10", false);

let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}
const gainMessages = posted.flatMap((message) => message.type === "scheduleGainsBatch" ? message.entries : [message])
  .filter((message) => (message.type === "gains" || message.type === "scheduleGains") && message.id === "obj:10");
const muteMessages = posted.filter((message) => message.type === "mute");
check(gainMessages.every((message) => message.gain > 0), "对象移动不把 mute 状态混入 metadata gain");
check(muteMessages.some((message) => message.muted) && muteMessages.some((message) => !message.muted),
  "静音和解除静音通过独立 worklet envelope 消息");
check(gainMessages.filter((message) => message.type === "scheduleGains").length === 6,
  "首个目标和五次真实移动全部保留 sample-scheduled gains");

let RendererProcessor;
const context = {
  sampleRate: 48000,
  currentFrame: 0,
  AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {}, onmessage: null }; } },
  registerProcessor(name, processor) { if (name === "sda-renderer") RendererProcessor = processor; },
  console,
};
const vm = await import("node:vm");
vm.runInNewContext(readFileSync(path.join(root, "packages/renderer/worklet/sda-renderer.worklet.js"), "utf8"), context);
const processor = new RendererProcessor({ processorOptions: { busCount: RENDER_TOPOLOGY.length } });
processor.onMessage({ type: "add", id: "obj:10" });
processor.onMessage({ type: "gains", id: "obj:10", gains: Float32Array.from({ length: RENDER_TOPOLOGY.length }, (_, i) => i === 0 ? 1 : 0), gain: 1, lp: 1, ramp: 1 });
processor.onMessage({ type: "start", origin: 0 });
const samples = new Float32Array(128).fill(1);
processor.onMessage({ type: "feedBatch", sequence: 1, start: 0, entries: [{ id: "obj:10", samples }] });
const outputs = Array.from({ length: 4 }, () => Array.from({ length: RENDER_TOPOLOGY.length }, () => new Float32Array(128)));
processor.process([], outputs);
const audible = outputs.reduce((sum, bank) => sum + bank.reduce((bankSum, bus) => bankSum + Math.abs(bus[64]), 0), 0);
check(audible > 0, "真实 worklet 在对象 gain 生效后输出音频");
processor.onMessage({ type: "mute", id: "obj:10", muted: true, ramp: 32 });
for (let i = 0; i < 2; i++) {
  processor.onMessage({ type: "feedBatch", sequence: i + 2, start: (i + 1) * 128, entries: [{ id: "obj:10", samples: new Float32Array(128).fill(1) }] });
  processor.process([], outputs);
}
const silent = outputs.reduce((sum, bank) => sum + bank.reduce((bankSum, bus) => bankSum + Math.abs(bus[64]), 0), 0);
check(silent === 0, "真实 worklet 完成 mute ramp 后保持静音");

console.log(failed ? `\n${failed} 项失败` : "\n对象移动与静音集成通过");
process.exit(failed ? 1 : 0);
