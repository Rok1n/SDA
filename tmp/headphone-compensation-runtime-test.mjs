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
    this.gains = [];
  }
  createDelay() { const delay = node("delay"); delay.delayTime = param(); return delay; }
  createGain() {
    const gain = node(`gain-${this.gainCount++}`);
    this.gains.push(gain);
    return gain;
  }
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

const { LAYOUTS, SpatialRenderer, setHeadphoneCompensationAssetLoader } = await import(pathToFileURL(bundle).href);
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
globalThis.fetch = async () => { throw new TypeError("Failed to fetch from file://"); };
const loadedAssets = [];
setHeadphoneCompensationAssetLoader(async (assetPath) => {
  loadedAssets.push(assetPath);
  return profileFir.slice(0);
});
let profileApplied = false;
try {
  renderer.setHeadphoneCompensation("sony-mdr-7506-average-autoeq");
  await new Promise((resolve) => setTimeout(resolve, 0));
  profileApplied = true;
} catch {
  profileApplied = false;
}
check(profileApplied && loadedAssets.length === 2 && ctx.convolverCount === 2,
  "file:// fetch 失败时通过桌面受限 loader 读取 MDR-7506 FIR");
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

const firstWet = renderer.headphoneWet;
const dry = renderer.headphoneDry;
check(firstWet?.every((node) => node.gain.value === 1) && dry?.every((node) => node.gain.value === 0),
  "选择 profile A 后 wet=1、dry=0，补偿实际进入最终双耳输出");
renderer.setHeadphoneCompensation("beyerdynamic-xelento-2nd-gen-average-autoeq");
await new Promise((resolve) => setTimeout(resolve, 0));
const secondWet = renderer.headphoneWet;
check(ctx.convolverCount === 4
  && firstWet?.every((node) => node.gain.value === 0)
  && secondWet?.every((node) => node.gain.value === 1)
  && dry?.every((node) => node.gain.value === 0),
"profile A→B 时旧 wet 淡出、新 wet 淡入，选择变化确实生效");
renderer.setHeadphoneCompensation(null);
check(secondWet?.every((node) => node.gain.value === 0) && dry?.every((node) => node.gain.value === 1),
  "切换到耳机补偿：无时 wet=0、dry=1，恢复 literal bypass");

console.log(failed ? `\n${failed} 项失败` : "\n耳机补偿加载与 A/B/off 切换通过");
process.exit(failed ? 1 : 0);
