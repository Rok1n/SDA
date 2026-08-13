// Headless runtime-layout test: logical layout changes must not recreate the
// AudioWorklet or discard source state. The output topology retains every
// distinct standard virtual-speaker position.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "renderer.bundle.cjs");
const posted = [];
let worklets = 0;
function param() {
  return { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} };
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
  constructor() {
    worklets++;
    this.port = { postMessage: (msg) => posted.push(msg), onmessage: null };
  }
  connect() {}
  disconnect() {}
}
globalThis.AudioWorkletNode = FakeAudioWorkletNode;
class FakeAudioContext {
  constructor() {
    this.sampleRate = 48000;
    this.state = "running";
    this.destination = node("destination");
    this.audioWorklet = { addModule: async () => {} };
  }
  createDelay() { const delay = node("delay"); delay.delayTime = param(); return delay; }
  createGain() { return node("gain"); }
  createBiquadFilter() { return node("biquad"); }
  createConvolver() { return node("conv"); }
  createPanner() { return node("panner"); }
  createDynamicsCompressor() { return node("safety-compressor"); }
  createChannelSplitter(n) { return node(`split${n}`); }
  createChannelMerger(n) { return node(`merge${n}`); }
  createBuffer(_, length) { return { copyToChannel() {}, length }; }
  async close() { this.state = "closed"; }
}

const { LAYOUTS, RENDER_TOPOLOGY, SpatialRenderer, speakerBusKey } = await import(pathToFileURL(out).href);
let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}
function latest(id) {
  return [...posted].reverse().find((msg) => msg.type === "gains" && msg.id === id);
}
function latestMute(id) {
  return [...posted].reverse().find((msg) => msg.type === "mute" && msg.id === id);
}

const ctx = new FakeAudioContext();
const renderer = new SpatialRenderer(ctx, { mode: "binaural", layout: LAYOUTS["5.1"] });
await renderer.init("mock://worklet");
renderer.addSource("bed:fl", { bedLabel: "FrontLeft" });
renderer.addSource("obj:9");
renderer.applyEvent({ id: 9, pos: [-1, 0, 0], hasPos: true, size: 0, gainDb: 0, rampDuration: 128 }, 128);
renderer.setSourceMuted("obj:9", true);

check(worklets === 2, `初始创建 source renderer + final peak guard 两个 worklet（${worklets}）`);
check(latest("bed:fl").gains.length === RENDER_TOPOLOGY.length, "输出固定为全部标准位置的 18 总线拓扑");

for (const id of ["7.1.4", "9.1.6", "5.1"]) {
  const before = worklets;
  renderer.setLayout(LAYOUTS[id]);
  const bed = latest("bed:fl");
  const object = latest("obj:9");
  const frontLeft = RENDER_TOPOLOGY.findIndex((speaker) => speakerBusKey(speaker) === "FrontLeft");
  check(worklets === before, `${id}: 不重建 worklet`);
  check(bed.gains[frontLeft] === 1, `${id}: 床 FrontLeft 重新吸附固定总线`);
  check(latestMute("obj:9")?.muted === true, `${id}: 对象静音状态保留`);
  check(object.ramp === 2048, `${id}: 增益按平滑斜坡迁移（${object.ramp} samples）`);
}

console.log(failed ? `\n${failed} 项失败` : "\n播放中布局切换通过");
process.exit(failed ? 1 : 0);
