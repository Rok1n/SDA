// Headless integration test: renderer.ts main thread → worklet message protocol.
// Mocks Web Audio just enough to run SpatialRenderer in Node, then drives the
// real worklet source with the posted messages and checks audible output.
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// renderer.bundle.cjs 已用 esbuild CLI 预先构建（见注释）：
// node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild \
//   packages/renderer/src/renderer.ts --bundle --format=cjs --platform=node \
//   --outfile=tmp/renderer.bundle.cjs
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "renderer.bundle.cjs");

// ---- Web Audio mocks ----
const postedToWorklet = [];
function fakeParam() {
  return { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} };
}
function fakeNode() {
  return {
    connect() {}, disconnect() {}, start() {}, stop() {},
    gain: fakeParam(), frequency: fakeParam(), Q: fakeParam(),
    pan: fakeParam(), positionX: fakeParam(), positionY: fakeParam(), positionZ: fakeParam(),
    orientationX: fakeParam(), orientationY: fakeParam(), orientationZ: fakeParam(),
    buffer: null, type: "", channelCount: 0, channelCountMode: "", channelInterpretation: "",
  };
}
class FakeAudioWorkletNode {
  constructor(ctx, name, opts) {
    this.name = name;
    this.port = {
      postMessage: (msg) => postedToWorklet.push(msg),
      onmessage: null,
    };
    this._opts = opts;
  }
  connect() {} disconnect() {}
}
globalThis.AudioWorkletNode = FakeAudioWorkletNode;
class FakeAudioContext {
  constructor() {
    this.sampleRate = 48000;
    this.state = "running";
    this.audioWorklet = { addModule: async () => {} };
    this.destination = fakeNode();
    this.listener = {};
  }
  createGain() { return fakeNode(); }
  createBiquadFilter() { return fakeNode(); }
  createConvolver() { return fakeNode(); }
  createPanner() { return fakeNode(); }
  createChannelSplitter() { return fakeNode(); }
  createChannelMerger() { return fakeNode(); }
  createBuffer(ch, len, sr) { return { numberOfChannels: ch, length: len, sampleRate: sr, getChannelData: () => new Float32Array(len), copyToChannel() {} }; }
  createBufferSource() { return fakeNode(); }
  createDynamicsCompressor() { return fakeNode(); }
  createOscillator() { return fakeNode(); }
  async close() { this.state = "closed"; }
  async resume() {} async suspend() {}
}
globalThis.AudioContext = FakeAudioContext;

// ---- load renderer ----
const { SpatialRenderer, LAYOUTS } = await import(pathToFileURL(out).href);

const ctx = new FakeAudioContext();
const r = new SpatialRenderer(ctx, { mode: "stereo", layout: LAYOUTS["5.1"] });
await r.init("mock://worklet");

// declare an object source like pumpPcm does
r.addSource("obj:10");
// an event arrives (position front-left, normal gain)
r.applyEvent({ id: 10, pos: [-0.5, 0.8, 0], hasPos: true, size: 0, gainDb: 0, rampDuration: 128 }, 128);

const lastGains = () => [...postedToWorklet].reverse().find((m) => m.type === "gains" && m.id === "obj:10");
console.log("事件后 scalar:", lastGains().gain);

// ---- MUTE ----
r.setSourceMuted("obj:10", true);
console.log("静音后 scalar:", lastGains().gain, "(期望 0)");

// events keep flowing (this is what pumpPcm does every frame)
for (let i = 0; i < 5; i++) {
  r.applyEvent({ id: 10, pos: [-0.5 + i * 0.1, 0.8, 0], hasPos: true, size: 0, gainDb: 0, rampDuration: 128 }, 128);
}
console.log("事件刷新×5 后 scalar:", lastGains().gain, "(期望仍 0)");

// re-declaration (sparse declare change mid-stream)
r.addSource("obj:10");
console.log("重复 addSource 后 scalar:", lastGains().gain, "(player 应立即恢复静音)");
r.setSourceMuted("obj:10", true); // player.ts line 371 restore
console.log("player 恢复静音后 scalar:", lastGains().gain, "(期望 0)");

// unmute
r.setSourceMuted("obj:10", false);
console.log("解除静音后 scalar:", lastGains().gain, "(期望 1)");

// ---- now feed these messages into the REAL worklet and measure output ----
const workletSrc = readFileSync(path.join(root, "packages/renderer/worklet/sda-renderer.worklet.js"), "utf8");
let ProcessorClass = null;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, postMessage() {} }; } };
globalThis.registerProcessor = (name, cls) => { ProcessorClass = cls; };
globalThis.sampleRate = 48000;
eval(workletSrc);

const p = new ProcessorClass({ processorOptions: { busCount: LAYOUTS["5.1"].length } });
// replay the full message stream in order (add / gains / feed…)
postedToWorklet.length = 0;
r.addSource("obj:10");
r.applyEvent({ id: 10, pos: [0, 1, 0], hasPos: true, size: 0, gainDb: 0, rampDuration: 128 }, 128);
for (const m of postedToWorklet) p.port.onmessage({ data: m });

const feed = new Float32Array(128).fill(1);
const buses = Array.from({ length: LAYOUTS["5.1"].length }, () => new Float32Array(128));
const runBlock = () => { p.port.onmessage({ data: { type: "feed", id: "obj:10", samples: feed } }); p.process([], [buses]); return buses.reduce((a, b) => a + Math.abs(b[64]), 0); };

// NOTE: worklet got its own fresh "add" + gains from the replay above.
console.log("worklet 出声:", runBlock().toFixed(3), "(期望 > 0)");
postedToWorklet.length = 0;
r.setSourceMuted("obj:10", true);
for (const m of postedToWorklet) p.port.onmessage({ data: m });
for (let i = 0; i < 40; i++) runBlock(); // let the 2048-sample ramp finish
console.log("worklet 静音后:", runBlock().toFixed(3), "(期望 0.000)");
console.log("PASS — 主线程 + worklet 链路在 Node 下全部正确");
