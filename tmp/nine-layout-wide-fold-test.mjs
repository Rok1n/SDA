// 9.1 headphone/stereo rendering folds front-wide into the proven 7.1 base ring.
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
    positionX: param(), positionY: param(), positionZ: param(), channelCount: 0, channelCountMode: "", maxChannelCount: 16,
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
  createBuffer(_, length) { return { copyToChannel() {}, length }; }
  async close() { this.state = "closed"; }
}

const { LAYOUTS, SpatialRenderer, virtualLayoutForOutput } = await import(pathToFileURL(bundle).href);
const topology = LAYOUTS["9.1.6"];
const topologyBus = (name) => topology.findIndex((speaker) => speaker.name === name);
const latest = (id) => [...posted].reverse().find((message) => (message.type === "gains" || message.type === "scheduleGains") && message.id === id);
const eventAt = (id, azimuth) => {
  const radians = azimuth * Math.PI / 180;
  return {
    id,
    samplePos: 0,
    hasPos: true,
    pos: [-Math.sin(radians), Math.cos(radians), 0],
    gainDb: 0,
    size: [0, 0, 0],
    anchor: "room",
    distanceM: null,
    distanceInfinite: false,
    screenFactor: null,
    depthFactor: null,
    rampDuration: 128,
  };
};
let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}

for (const suffix of ["2", "4"]) {
  const nine = virtualLayoutForOutput(LAYOUTS[`9.1.${suffix}`], "binaural").map((speaker) => speaker.name);
  const seven = LAYOUTS[`7.1.${suffix}`].map((speaker) => speaker.name);
  check(JSON.stringify(nine) === JSON.stringify(seven), `9.1.${suffix} 双耳基础环与 7.1.${suffix} 完全一致`);
  check(!nine.includes("WideLeft") && !nine.includes("WideRight"), `9.1.${suffix} 双耳不使用不平衡的前宽 HRTF`);
}
check(virtualLayoutForOutput(LAYOUTS["9.1.6"], "multichannel").some((speaker) => speaker.name === "WideLeft"),
  "9.1.6 物理多声道保留原生前宽");

const render = async (layout, azimuth) => {
  posted.length = 0;
  const renderer = new SpatialRenderer(new FakeAudioContext(), { mode: "binaural", layout });
  await renderer.init("mock://worklet");
  renderer.addSource("obj:test");
  renderer.applyEvent(eventAt("test", azimuth), 128);
  return { renderer, message: latest("obj:test") };
};
const sevenLeft = await render(LAYOUTS["7.1.4"], 60);
const nineLeft = await render(LAYOUTS["9.1.4"], 60);
const nineRight = await render(LAYOUTS["9.1.4"], -60);
check(nineLeft.message.gains.every((value, index) => Math.abs(value - sevenLeft.message.gains[index]) < 1e-6),
  "9.1.4 双耳 60° 对象与正常 7.1.4 使用相同 gain vector");
check(nineLeft.message.gains[topologyBus("WideLeft")] === 0 && nineLeft.message.gains[topologyBus("WideRight")] === 0,
  "9.1.4 双耳 WideLeft/Right 总线严格静音");
check(Math.abs(nineLeft.message.gains[topologyBus("FrontLeft")] - nineRight.message.gains[topologyBus("FrontRight")]) < 1e-6
  && Math.abs(nineLeft.message.gains[topologyBus("SurroundLeft")] - nineRight.message.gains[topologyBus("SurroundRight")]) < 1e-6,
"9.1.4 双耳 60° 左右 gain 严格镜像");

posted.length = 0;
nineLeft.renderer.setOutputMode("multichannel");
nineLeft.renderer.applyEvent(eventAt("test", 60), 128);
const physical = latest("obj:test");
check(physical.gains[topologyBus("WideLeft")] === 1
  && physical.gains.every((value, index) => index === topologyBus("WideLeft") || value === 0),
"切到 9.1.4 物理多声道后 60° 对象恢复原生 WideLeft 直送");

console.log(failed ? `\n${failed} 项失败` : "\n9.1.x 前宽折叠与左右平衡通过");
process.exit(failed ? 1 : 0);
