// Program loudness normalization contract and renderer runtime test.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const bundle = path.join(path.dirname(fileURLToPath(import.meta.url)), "renderer.bundle.cjs");
const params = [];
const workletMessages = [];
function param() {
  const calls = [];
  const value = {
    value: 0,
    calls,
    setValueAtTime(next, time) { this.value = next; calls.push(["set", next, time]); },
    linearRampToValueAtTime(next, time) { this.value = next; calls.push(["ramp", next, time]); },
    cancelScheduledValues(time) { calls.push(["cancel", time]); },
  };
  params.push(value);
  return value;
}
function node(tag) {
  return {
    _tag: tag,
    connect() {}, disconnect() {}, start() {}, stop() {},
    gain: param(), frequency: param(), Q: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
    positionX: param(), positionY: param(), positionZ: param(), channelCount: 0, channelCountMode: "", channelInterpretation: "", maxChannelCount: 16,
  };
}
class FakeAudioWorkletNode {
  constructor(_, name) {
    this._tag = name;
    this.port = { postMessage(message) { workletMessages.push({ processor: name, ...message }); }, onmessage: null };
  }
  connect() {}
  disconnect() {}
}
globalThis.AudioWorkletNode = FakeAudioWorkletNode;
class FakeAudioContext {
  constructor() { this.sampleRate = 48000; this.currentTime = 1; this.state = "running"; this.destination = node("destination"); this.audioWorklet = { addModule: async () => {} }; }
  createDelay() { const delay = node("delay"); delay.delayTime = param(); return delay; }
  createGain() { return node("gain"); }
  createBiquadFilter() { return node("biquad"); }
  createConvolver() { return node("conv"); }
  createPanner() { return node("panner"); }
  createDynamicsCompressor() { return node("compressor"); }
  createChannelSplitter(n) { return node(`split${n}`); }
  createChannelMerger(n) { return node(`merge${n}`); }
  createBuffer(_, length) { return { copyToChannel() {}, length }; }
  async close() { this.state = "closed"; }
}

const { LAYOUTS, SpatialRenderer } = await import(pathToFileURL(bundle).href);
const renderer = new SpatialRenderer(new FakeAudioContext(), { mode: "binaural", layout: LAYOUTS["7.1.4"] });
await renderer.init("mock://worklet");
workletMessages.length = 0;
renderer.setProgramLoudnessGainDb(-5, 48000);
renderer.setVolumeBalance(true);
renderer.setProgramLoudnessGainDb(-8, 96000);

let failed = 0;
function check(condition, text) { if (!condition) failed++; console.log(`${condition ? "PASS" : "FAIL"}  ${text}`); }
const scheduled = workletMessages.filter(({ type }) => type === "scheduleProgramGain");
check(scheduled.length === 2
  && scheduled[0].at === 48000 && Math.abs(scheduled[0].gain - 10 ** (-5 / 20)) < 1e-7
  && scheduled[1].at === 96000 && Math.abs(scheduled[1].gain - 10 ** (-8 / 20)) < 1e-7,
"dialnorm 变化按绝对 codec sample 排队，不按预解码 wall clock 提前应用");
check(workletMessages.some(({ type, enabled }) => type === "programEnabled" && enabled),
"开启音量平衡由 shared stereo/binaural final worklet 执行");
check(!params.flatMap((parameter) => parameter.calls).some(([kind, value]) => kind === "ramp" && value < 1),
"multichannel/模式 GainNode 不承载 dialnorm，物理输出保持 literal bypass");
renderer.setProgramLoudnessGainDb(4, 144000);
const positive = workletMessages.find(({ type, at }) => type === "scheduleProgramGain" && at === 144000);
check(positive?.gain === 1, "正 dialnorm gain 被保守限制到 unity");
renderer.setVolumeBalance(false);
check(workletMessages.some(({ type, enabled }) => type === "programEnabled" && !enabled),
"关闭音量平衡时 final worklet 平滑恢复 unity");

console.log(failed ? `\n${failed} 项失败` : "\nDolby 节目音量平衡运行时契约通过");
process.exit(failed ? 1 : 0);
