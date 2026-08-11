// Headless runtime test: averaged FIR applies only to final binaural L/R output.
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
  constructor() {
    worklets++;
    this._tag = "worklet";
    this.port = { postMessage() {}, onmessage: null };
  }
  connect(to, out, input) { wiring.push({ from: "worklet", to: to?._tag, out, input }); }
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

const fir = new Float32Array([1, 0, 0, 0]);
globalThis.fetch = async (url) => ({ ok: true, status: 200, arrayBuffer: async () => fir.buffer.slice(0) });
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
check(ctx.convolverCount === 0, "无 profile 时 fallback 双耳图没有校正 FIR convolver");
renderer.setHeadphoneCompensation("airpods-pro-2-anc-averaged");
await new Promise((resolve) => setTimeout(resolve, 0));
check(worklets === initialWorklets, "加载 profile 不重建 worklet");
check(ctx.convolverCount === 2, "平均 profile 建立两个独立最终耳道 FIR convolver");
const leftInput = wiring.find((edge) => edge.to === "profile-conv-0" && edge.out === 0);
const rightInput = wiring.find((edge) => edge.to === "profile-conv-1" && edge.out === 1);
const leftOutput = wiring.find((edge) => edge.from === "profile-conv-0" && edge.to?.startsWith("merge2-") && edge.input === 0);
const rightOutput = wiring.find((edge) => edge.from === "profile-conv-1" && edge.to === leftOutput?.to && edge.input === 1);
const recovery = leftOutput && wiring.find((edge) => edge.from === leftOutput.to && edge.to?.startsWith("gain-"));
const makeupAfterRecovery = recovery && wiring.find((edge) => edge.from === recovery.to && edge.to?.startsWith("gain-"));
check(!!leftInput && !!rightInput && !!leftOutput && !!rightOutput, "左右 FIR 保持通道身份，不交叉馈送");
check(!!recovery && !!makeupAfterRecovery, "FIR merger 后先经 profile recovery，再进入全局 makeup");
renderer.setHeadphoneCompensation(null);
await new Promise((resolve) => setTimeout(resolve, 0));
check(worklets === initialWorklets, "切回 bypass 不重建 worklet");
check(renderer.headphoneCompensationProfile === null, "切回 bypass 清除已选 profile");

console.log(failed ? `\n${failed} 项失败` : "\n耳机补偿运行时接线通过");
process.exit(failed ? 1 : 0);
