// Headless realtime output-mode test: persistent paths must crossfade without
// recreating the worklet, source state, or destination channel configuration.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const bundle = path.join(path.dirname(fileURLToPath(import.meta.url)), "renderer.bundle.cjs");
const posted = [];
const wiring = [];
let worklets = 0;
function param() {
  return {
    value: 0,
    setValueAtTime(value) { this.value = value; },
    linearRampToValueAtTime(value) { this.value = value; },
    cancelScheduledValues() {},
  };
}
function node(tag) {
  return {
    _tag: tag,
    connect(to, out, input) { wiring.push({ from: tag, to: to?._tag, out, input }); },
    disconnect() {}, start() {}, stop() {},
    gain: param(), frequency: param(), Q: param(),
    threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
    positionX: param(), positionY: param(), positionZ: param(),
    channelCount: 0, channelCountMode: "", channelInterpretation: "", maxChannelCount: 16,
  };
}
class FakeAudioWorkletNode {
  constructor(_, name) {
    worklets++;
    this._tag = name;
    this.port = { postMessage: (msg) => posted.push(msg), onmessage: null };
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
    this.compressorCount = 0;
    this.audioWorklet = { addModule: async () => {} };
  }
  createGain() { return node("gain"); }
  createBiquadFilter() { return node("biquad"); }
  createConvolver() { return node("conv"); }
  createPanner() { return node("panner"); }
  createDynamicsCompressor() { return node(`compressor-${this.compressorCount++}`); }
  createChannelSplitter(n) { return node(`split${n}`); }
  createChannelMerger(n) { return node(`merge${n}`); }
  createBuffer(_, length) { return { copyToChannel() {}, length }; }
  async close() { this.state = "closed"; }
}

const { LAYOUTS, SpatialRenderer } = await import(pathToFileURL(bundle).href);
let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}
function latest(id) {
  return [...posted].reverse().find((message) => message.type === "gains" && message.id === id);
}
function latestMute(id) {
  return [...posted].reverse().find((message) => message.type === "mute" && message.id === id);
}

const ctx = new FakeAudioContext();
const renderer = new SpatialRenderer(ctx, { mode: "binaural", layout: LAYOUTS["7.1.4"] });
await renderer.init("mock://worklet");
renderer.addSource("obj:7");
renderer.applyEvent({ id: 7, pos: [-1, 0, 0], hasPos: true, size: 0, gainDb: 0, rampDuration: 128 }, 128);
renderer.setSourceMuted("obj:7", true);
renderer.addSource("bed:sl", { bedLabel: "SurroundLeft" });
const initialWorklets = worklets;
const initialChannels = ctx.destination.channelCount;

const rearLeft = LAYOUTS["9.1.6"].findIndex((speaker) => speaker.name === "RearLeft");
renderer.setOutputMode("multichannel");
check(latest("bed:sl").gains[rearLeft] === 0.5, "多声道: 5.1 侧环恢复后环派生馈送");
renderer.setOutputMode("binaural");
check(latest("bed:sl").gains[rearLeft] === 0, "双耳: 撤销物理后环派生馈送");

for (const mode of ["stereo", "multichannel", "binaural"]) {
  renderer.setOutputMode(mode);
  check(worklets === initialWorklets, `${mode}: 不重建 worklet`);
  check(ctx.destination.channelCount === initialChannels, `${mode}: 不改变设备 channelCount`);
  check(renderer.outputMode === mode, `${mode}: 输出模式状态已更新`);
  check(latestMute("obj:7")?.muted === true, `${mode}: 对象静音状态保留`);
}
const modePathOutputs = wiring.filter((edge) => edge.to === "gain").length;
check(modePathOutputs >= 3, `三条常驻输出路径已连接到独立 mode gain（${modePathOutputs}）`);
const makeup = wiring.find((edge) => edge.from === "merge16" && edge.to === "gain");
const lfePeak = wiring.find((edge) => edge.from === "gain" && edge.to === "compressor-0");
const lfeEarSplit = wiring.find((edge) => edge.from === "compressor-0" && edge.to === "gain");
const guard = wiring.find((edge) => edge.from === "gain" && edge.to === "sda-final-peak-guard");
const binauralOutput = wiring.find((edge) => edge.from === "sda-final-peak-guard" && edge.to === "gain");
check(!!makeup, "双耳最终 merger 后存在独立 +6dB makeup gain 节点");
check(!!lfePeak && !!lfeEarSplit, "LFE 后仍有独立 peak compressor，再等量分送双耳");
check(!!guard && !!binauralOutput, "双耳 makeup 后接 emergency peak guard，再进入 mode gain");
check(wiring.filter((edge) => edge.to?.startsWith("compressor-")).length === 1, "只有 LFE 支路经过 DynamicsCompressor");
check(ctx.destination.channelCount === 16, `初始化一次固定最大设备通道数（${ctx.destination.channelCount}）`);

console.log(failed ? `\n${failed} 项失败` : "\n播放中输出模式切换通过");
process.exit(failed ? 1 : 0);
