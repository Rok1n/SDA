// Runtime final-EQ test: slider updates must automate persistent filters only.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const bundle = path.join(path.dirname(fileURLToPath(import.meta.url)), "renderer.bundle.cjs");
let worklets = 0;
let biquads = 0;
const params = [];
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
    gain: param(), frequency: param(), Q: param(),
    threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
    positionX: param(), positionY: param(), positionZ: param(),
    channelCount: 0, channelCountMode: "", channelInterpretation: "", maxChannelCount: 16,
  };
}
class FakeAudioWorkletNode {
  constructor(_, name) { worklets++; this._tag = name; this.port = { postMessage() {}, onmessage: null }; }
  connect() {}
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
  }
  createDelay() { const delay = node("delay"); delay.delayTime = param(); return delay; }
  createGain() { return node("gain"); }
  createBiquadFilter() { biquads++; return node("biquad"); }
  createConvolver() { return node("conv"); }
  createPanner() { return node("panner"); }
  createDynamicsCompressor() { return node("compressor"); }
  createChannelSplitter(n) { return node(`split${n}`); }
  createChannelMerger(n) { return node(`merge${n}`); }
  createBuffer(_, length) { return { copyToChannel() {}, length }; }
  async close() { this.state = "closed"; }
}

const { binauralEqHeadroomDb, LAYOUTS, SpatialRenderer } = await import(pathToFileURL(bundle).href);
let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}

const ctx = new FakeAudioContext();
const renderer = new SpatialRenderer(ctx, { mode: "binaural", layout: LAYOUTS["7.1.4"] });
await renderer.init("mock://worklet");
const initialWorklets = worklets;
const initialBiquads = biquads;
const initialParams = params.length;

renderer.setBinauralEqBands({ low: 4, mid: -2, high: 3 });
check(worklets === initialWorklets, "EQ 更新不重建 worklet");
check(biquads === initialBiquads, "EQ 更新不创建新的 biquad 节点");
check(params.length === initialParams, "EQ 更新不创建新的 AudioParam");
const gains = renderer.binauralEq;
check(gains.low === 4 && gains.mid === -2 && gains.high === 3, "三段 EQ 状态更新");

const ramps = params.flatMap((parameter) => parameter.calls.filter(([kind]) => kind === "ramp"));
const filterRamps = ramps.filter(([, , time]) => time === 1.04);
const headroomRamps = ramps.filter(([, , time]) => time === 1.01);
check(filterRamps.length === 6, "左右耳三段 EQ 均以 ramp 更新");
check(filterRamps.map(([, value]) => value).sort((a, b) => a - b).join(",") === "-2,-2,3,3,4,4", "左右耳使用相同的目标 EQ 值");
check(headroomRamps.length === 1 && headroomRamps[0][1] < 1, "提升 EQ 前以 10ms ramp 增加 headroom");
const maximumHeadroom = binauralEqHeadroomDb({ low: 12, mid: 12, high: 12 });
check(maximumHeadroom <= -12.2 && maximumHeadroom > -15, "全 +12dB 组合按实际合成频响提供至少 12.2dB 余量");

renderer.setBinauralEqBands({ low: 0, mid: 0, high: 0 });
const releaseRamps = params.flatMap((parameter) => parameter.calls.filter(([kind, value, time]) => kind === "ramp" && value === 1 && time === 1.1));
check(releaseRamps.length === 2, "降低 EQ 后以 100ms 释放 headroom（含初始化 unity ramp）");
check(worklets === initialWorklets && biquads === initialBiquads, "归零也不重建输出图");

console.log(failed ? `\n${failed} 项失败` : "\n实时三段 EQ 更新通过");
process.exit(failed ? 1 : 0);
