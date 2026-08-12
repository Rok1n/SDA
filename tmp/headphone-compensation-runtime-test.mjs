// Headless runtime test: without a qualified profile, binaural output is literal
// FIR bypass while the shared emergency guard remains persistent.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const bundle = path.join(path.dirname(fileURLToPath(import.meta.url)), "renderer.bundle.cjs");
const wiring = [];
let worklets = 0;
function param() {
  return { value: 0, setValueAtTime(value) { this.value = value; }, linearRampToValueAtTime(value) { this.value = value; }, cancelScheduledValues() {} };
}
function node(tag) {
  return {
    _tag: tag,
    connect(to, out, input) { wiring.push({ from: tag, to: to?._tag, out, input }); },
    disconnect() {}, start() {}, stop() {},
    gain: param(), frequency: param(), Q: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
    positionX: param(), positionY: param(), positionZ: param(),
    channelCount: 0, channelCountMode: "", channelInterpretation: "", maxChannelCount: 16,
  };
}
class FakeAudioWorkletNode {
  constructor(_, name) {
    worklets++;
    this._tag = name;
    this.port = { postMessage() {}, onmessage: null };
  }
  connect(to, out, input) { wiring.push({ from: this._tag, to: to?._tag, out, input }); }
  disconnect() {}
}
globalThis.AudioWorkletNode = FakeAudioWorkletNode;
class FakeAudioContext {
  constructor() {
    this.sampleRate = 48000;
    this.currentTime = 1;
    this.state = "running";
    this.destination = node("destination");
    this.audioWorklet = { addModule: async () => {} };
    this.compressorCount = 0;
    this.convolverCount = 0;
    this.mergerCount = 0;
    this.gainCount = 0;
  }
  createGain() { return node(`gain-${this.gainCount++}`); }
  createBiquadFilter() { return node("biquad"); }
  createConvolver() { return node(`profile-conv-${this.convolverCount++}`); }
  createPanner() { return node("panner"); }
  createDynamicsCompressor() { return node(`compressor-${this.compressorCount++}`); }
  createChannelSplitter(n) { return node(`split${n}`); }
  createChannelMerger(n) { return node(`merge${n}-${this.mergerCount++}`); }
  createBuffer(_, length) { return { length, copyToChannel() {} }; }
  async close() { this.state = "closed"; }
}

const { LAYOUTS, SpatialRenderer } = await import(pathToFileURL(bundle).href);
let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}

const ctx = new FakeAudioContext();
const renderer = new SpatialRenderer(ctx, { mode: "binaural", layout: LAYOUTS["7.1.4"] });
await renderer.init("mock://worklet");
const initialWorklets = worklets;
const guardInput = wiring.find((edge) => edge.to === "sda-final-peak-guard" && edge.from?.startsWith("gain-"));
const makeupInput = guardInput && wiring.find((edge) => edge.to === guardInput.from && edge.from?.startsWith("merge"));
check(initialWorklets === 2, "初始化只有 source renderer + shared emergency guard 两个常驻 worklet");
check(ctx.convolverCount === 0, "无合格 profile 时不创建最终耳机 FIR convolver");
check(!!guardInput && !!makeupInput, "最终 L/R merger 直接进入共享 makeup 与 emergency guard");
check(ctx.compressorCount === 1, "无 profile 时只有 LFE 使用 DynamicsCompressor");
let rejected = false;
try {
  renderer.setHeadphoneCompensation("airpods-pro-2-anc-averaged");
} catch {
  rejected = true;
}
check(rejected && worklets === initialWorklets && ctx.convolverCount === 0,
  "撤回或未知 profile 被拒绝，保持 literal bypass 且不重建 worklet");

console.log(failed ? `\n${failed} 项失败` : "\n耳机补偿 bypass 运行时接线通过");
process.exit(failed ? 1 : 0);
