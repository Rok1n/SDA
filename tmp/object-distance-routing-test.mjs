// OAMD distance must never be interpreted as Dolby DBMD Binaural Render Mode.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const bundle = path.join(path.dirname(fileURLToPath(import.meta.url)), "renderer.bundle.cjs");
const posted = [];
function param() { return { value: 0, setValueAtTime(v) { this.value = v; }, linearRampToValueAtTime(v) { this.value = v; }, cancelScheduledValues() {} }; }
function node(tag) {
  return {
    _tag: tag,
    connect() {}, disconnect() {}, start() {}, stop() {},
    gain: param(), frequency: param(), Q: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
    positionX: param(), positionY: param(), positionZ: param(), channelCount: 0, channelCountMode: "", maxChannelCount: 16,
  };
}
class FakeAudioWorkletNode {
  constructor(_, name) { this._tag = name; this.port = { postMessage: (msg) => posted.push(msg), onmessage: null }; }
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
const { LAYOUTS, RENDER_TOPOLOGY, SpatialRenderer } = await import(pathToFileURL(bundle).href);
let failed = 0;
function check(condition, text) { if (!condition) failed++; console.log(`${condition ? "PASS" : "FAIL"}  ${text}`); }
function latest(id) { return [...posted].reverse().find((message) => (message.type === "gains" || message.type === "scheduleGains") && message.id === id); }
const event = (id, distanceM, distanceInfinite = false) => ({
  id, samplePos: 0, hasPos: true, pos: [0, 1, 0], gainDb: 0, size: [0, 0, 0], anchor: "room", distanceM, distanceInfinite, screenFactor: null, depthFactor: null, rampDuration: 128,
});

const renderer = new SpatialRenderer(new FakeAudioContext(), { mode: "binaural", layout: LAYOUTS["7.1.4"] });
await renderer.init("mock://worklet");
renderer.addSource("bed:0", { bedLabel: "FrontLeft" });
renderer.addSource("obj:10");
renderer.addSource("obj:11");
const bedBefore = latest("bed:0");
renderer.applyEvent(event(10, 0.7), 128);
renderer.applyEvent(event(11, 2.5), 128);
const near = latest("obj:10");
const far = latest("obj:11");
const bedAfter = latest("bed:0");
check(near.gains.length === RENDER_TOPOLOGY.length && far.gains.length === RENDER_TOPOLOGY.length, "原始多声道方位 gain 保持全部标准位置拓扑宽度");
check(near.gains.every((value, index) => value === far.gains[index]), "相同 ADM 坐标的 VBAP gain 不受 OAMD distanceM 影响");
check(near.gain === far.gain && near.gain === 1, "OAMD distanceM 不推导节目增益或 DBMD 模式");
check(near.wet === undefined && far.wet === undefined && bedBefore.wet === undefined && bedAfter.wet === undefined,
"renderer gain 消息不携带由距离臆造的 near/far wet 参数");
const modeMessagesBefore = posted.filter(({ type }) => type === "binauralMode").length;
renderer.applyEvent(event(10, null, true), 128);
const modeMessagesAfter = posted.filter(({ type }) => type === "binauralMode").length;
check(modeMessagesAfter === modeMessagesBefore, "无限距离 OAMD metadata 同样不切换 Binaural Render Mode");
renderer.setSourceBinauralMode("obj:10", "far");
check(posted.some(({ type, id, bank }) => type === "binauralMode" && id === "obj:10" && bank === 3),
"只有显式 DBMD mode 才选择 Far binaural bank");

console.log(failed ? `\n${failed} 项失败` : "\n对象与床层 metadata 路由通过");
process.exit(failed ? 1 : 0);
