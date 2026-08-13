// Exact speaker-geometry regression for 5.1, 7.1 and 9.1 headphone rendering.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "tmp/renderer.bundle.cjs");
const posted = [];
const workletOptions = [];
function param() {
  return { value: 0, setValueAtTime(value) { this.value = value; }, linearRampToValueAtTime(value) { this.value = value; }, cancelScheduledValues() {} };
}
function node(tag) {
  return {
    _tag: tag,
    connect() {}, disconnect() {}, start() {}, stop() {},
    gain: param(), frequency: param(), Q: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
    positionX: param(), positionY: param(), positionZ: param(), channelCount: 0, channelCountMode: "", maxChannelCount: 32,
  };
}
class FakeAudioBuffer {
  constructor(channels, length) {
    this.length = length;
    this.channels = Array.from({ length: channels }, () => new Float32Array(length));
  }
  copyToChannel(data, channel) { this.channels[channel].set(data); }
  getChannelData(channel) { return this.channels[channel]; }
}
class FakeAudioWorkletNode {
  constructor(_, name, options) {
    this._tag = name;
    this.port = { postMessage: (message) => posted.push(message), onmessage: null };
    workletOptions.push({ name, options });
  }
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
  createBuffer(channels, length) { return new FakeAudioBuffer(channels, length); }
  async close() { this.state = "closed"; }
}

const {
  BINAURAL_MODES,
  LAYOUTS,
  RENDER_TOPOLOGY,
  SpatialRenderer,
  buildBusIrs,
  speakerBusKey,
  virtualLayoutForOutput,
} = await import(pathToFileURL(bundle).href);
const topologyBus = (key) => RENDER_TOPOLOGY.findIndex((speaker) => speakerBusKey(speaker) === key);
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

check(RENDER_TOPOLOGY.length === 18, "固定拓扑包含 9.1.6 十六总线和 5.1 独立 +/-110 度环绕");
for (const mode of ["binaural", "stereo", "multichannel"]) {
  check(virtualLayoutForOutput(LAYOUTS["9.1.4"], mode).length === LAYOUTS["9.1.4"].length,
    `9.1.4 ${mode} 保留前宽标准几何`);
}
check(topologyBus("Surround5Left") !== topologyBus("SurroundLeft"),
  "5.1 的 +110 度环绕与 7.1 的 +100 度侧环使用不同总线");

const render = async (layout, azimuth) => {
  posted.length = 0;
  workletOptions.length = 0;
  const renderer = new SpatialRenderer(new FakeAudioContext(), { mode: "binaural", layout });
  await renderer.init("mock://worklet");
  renderer.addSource("obj:test");
  renderer.applyEvent(eventAt("test", azimuth), 128);
  return latest("obj:test");
};
const fiveSurround = await render(LAYOUTS["5.1"], 110);
const sevenSurround = await render(LAYOUTS["7.1.4"], 100);
check(fiveSurround.gains.length === RENDER_TOPOLOGY.length, "worklet gain vector 使用完整 18 总线拓扑");
check(fiveSurround.gains[topologyBus("Surround5Left")] === 1 && fiveSurround.gains[topologyBus("SurroundLeft")] === 0,
  "5.1 +110 度对象只进入独立 5.1 环绕总线");
check(sevenSurround.gains[topologyBus("SurroundLeft")] === 1 && sevenSurround.gains[topologyBus("Surround5Left")] === 0,
  "7.1 +100 度对象只进入 7.1 侧环总线");

const nineLeft = await render(LAYOUTS["9.1.4"], 60);
const nineRight = await render(LAYOUTS["9.1.4"], -60);
check(nineLeft.gains[topologyBus("WideLeft")] === 1 && nineLeft.gains.every((value, index) => index === topologyBus("WideLeft") || value === 0),
  "9.1 +60 度对象独占 WideLeft，不折回 7.1 环");
check(nineRight.gains[topologyBus("WideRight")] === 1 && nineRight.gains.every((value, index) => index === topologyBus("WideRight") || value === 0),
  "9.1 -60 度对象独占 WideRight，不折回 7.1 环");

const manifest = JSON.parse(readFileSync(path.join(root, "apps/web/public/hrtf/hrtf-set.json"), "utf8"));
const positions = manifest.positions.map((entry) => {
  const dryBytes = readFileSync(path.join(root, "apps/web/public/hrtf", entry.dry));
  const wetBytes = readFileSync(path.join(root, "apps/web/public/hrtf", entry.wet));
  const dry = Float32Array.from(new Float32Array(dryBytes.buffer, dryBytes.byteOffset, dryBytes.byteLength / 4));
  const wet = Float32Array.from(new Float32Array(wetBytes.buffer, wetBytes.byteOffset, wetBytes.byteLength / 4));
  return { azimuth: entry.azimuth, elevation: entry.elevation, dry, dryLen: dry.length >> 1, wet, wetLen: wet.length >> 1 };
});
const irSet = { sampleRate: manifest.sampleRate, positions };
for (const mode of Object.keys(BINAURAL_MODES)) {
  const irs = buildBusIrs(new FakeAudioContext(), irSet, RENDER_TOPOLOGY, mode);
  const left = irs.get(topologyBus("WideLeft"));
  const right = irs.get(topologyBus("WideRight"));
  let maxMirrorError = 0;
  for (let i = 0; i < left.length; i++) {
    maxMirrorError = Math.max(
      maxMirrorError,
      Math.abs(left.getChannelData(0)[i] - right.getChannelData(1)[i]),
      Math.abs(left.getChannelData(1)[i] - right.getChannelData(0)[i]),
    );
  }
  check(maxMirrorError === 0, `9.1 ${mode} 前宽 IR 逐样本严格左右镜像`);
}

console.log(failed ? `\n${failed} 项失败` : "\n精确布局总线与 9.1 前宽镜像通过");
process.exit(failed ? 1 : 0);
