// Headless realtime output-mode test: persistent paths must crossfade without
// recreating the worklet, source state, or destination channel configuration.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const bundle = path.join(path.dirname(fileURLToPath(import.meta.url)), "renderer.bundle.cjs");
const posted = [];
const wiring = [];
const delays = [];
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
  createDelay() { const delay = node("delay"); delay.delayTime = param(); delays.push(delay); return delay; }
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
const lfePeak = wiring.find((edge) => edge.from === "gain" && edge.to === "compressor-0");
const lfeEarSplit = wiring.find((edge) => edge.from === "compressor-0" && edge.to === "gain");
const guardInputs = wiring.filter((edge) => edge.to === "sda-final-peak-guard");
const guardOutputs = wiring.filter((edge) => edge.from === "sda-final-peak-guard");
check(!!lfePeak && !!lfeEarSplit, "LFE 后仍有独立 peak compressor，再等量分送双耳");
check(guardInputs.length === 2 && guardOutputs.length === 1,
  "立体声与双耳 mode gain 共用一个 linked limiter，并只输出一次到 master");
check(delays.length === 1 && delays[0].delayTime.value === 0.005
  && wiring.some((edge) => edge.to === "delay") && wiring.some((edge) => edge.from === "delay" && edge.to === "gain"),
"多声道路径补偿 limiter 的 5ms lookahead，模式 crossfade 保持 sample-aligned");
renderer.setBinauralData({ sampleRate: 48000, positions: [] });
const rebuiltGuardOutputs = wiring.filter((edge) => edge.from === "sda-final-peak-guard");
check(rebuiltGuardOutputs.length === 2, "HRTF 图重建只新增当前 limiter→master 连接，不保留旧连接");
check(wiring.filter((edge) => edge.to?.startsWith("compressor-")).length === 2,
  "初始图与一次 HRTF 重建各创建一个仅 LFE 使用的 compressor");
check(ctx.destination.channelCount === LAYOUTS["7.1.4"].length, `设备通道数紧凑匹配当前布局（${ctx.destination.channelCount}）`);

console.log(failed ? `\n${failed} 项失败` : "\n播放中输出模式切换通过");
process.exit(failed ? 1 : 0);
