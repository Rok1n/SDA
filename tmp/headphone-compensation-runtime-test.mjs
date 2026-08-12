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
    this.convolvers = [];
  }
  createDelay() { const delay = node("delay"); delay.delayTime = param(); return delay; }
  createGain() { return node(`gain-${this.gainCount++}`); }
  createBiquadFilter() { return node("biquad"); }
  createConvolver() {
    const convolver = node(`profile-conv-${this.convolverCount++}`);
    convolver.normalize = true;
    Object.defineProperty(convolver, "buffer", {
      get() { return this._buffer; },
      set(value) {
        this._buffer = value;
        this.normalizeAtBufferAssignment = this.normalize;
      },
    });
    this.convolvers.push(convolver);
    return convolver;
  }
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
const guardInputs = wiring.filter((edge) => edge.to === "sda-final-peak-guard");
check(initialWorklets === 2, "初始化只有 source renderer + shared emergency guard 两个常驻 worklet");
check(ctx.convolverCount === 0, "无合格 profile 时不创建最终耳机 FIR convolver");
check(guardInputs.length === 2, "立体声与双耳共用最终 linked limiter");
check(ctx.compressorCount === 1, "无 profile 时只有 LFE 使用 DynamicsCompressor");
let rejected = false;
try {
  renderer.setHeadphoneCompensation("airpods-pro-2-anc-averaged");
} catch {
  rejected = true;
}
check(rejected && worklets === initialWorklets && ctx.convolverCount === 0,
  "撤回或未知 profile 被拒绝，保持 literal bypass 且不重建 worklet");

const profileFir = new Float32Array([1, 0, 0.25, 0]).buffer;
globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => profileFir.slice(0) });
let profileApplied = false;
try {
  renderer.setHeadphoneCompensation("sony-mdr-7506-average-autoeq");
  await new Promise((resolve) => setTimeout(resolve, 0));
  profileApplied = true;
} catch {
  profileApplied = false;
}
check(profileApplied && ctx.convolverCount === 2, "MDR-7506 使用两个独立最终耳道 convolver");
check(ctx.convolvers.every((convolver) => convolver.normalize === false), "最终耳道 convolver 禁用 normalize");
check(ctx.convolvers.every((convolver) => convolver.normalizeAtBufferAssignment === false),
  "所有 convolver 在绑定 FIR 前已禁用 normalize");
check(wiring.some((edge) => edge.from === "split2" && edge.to === "profile-conv-0" && edge.out === 0)
  && wiring.some((edge) => edge.from === "split2" && edge.to === "profile-conv-1" && edge.out === 1),
"MDR-7506 profile 保持 L/R 身份且不 crossfeed");
check(wiring.some((edge) => edge.from === "profile-conv-0" && edge.to?.startsWith("gain-"))
  && wiring.some((edge) => edge.from === "profile-conv-1" && edge.to?.startsWith("gain-"))
  && wiring.filter((edge) => edge.to === "sda-final-peak-guard").length === 2,
"profile 输出保持在双耳最终增益链内，并继续进入 shared linked limiter");

console.log(failed ? `\n${failed} 项失败` : "\n耳机补偿 bypass 运行时接线通过");
process.exit(failed ? 1 : 0);
