// Headless test: 床声道吸附 + 上混扩展 + 多声道物理重排。
// 5.1 内容选 7.1 布局 → 多声道物理输出每路总线都有信号（像 AVR 上混器）；
// 双耳/立体声只吸附不馈送（相干拷贝会在鼓膜处梳状滤波，声场挤成一团）。
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "renderer.bundle.cjs");

// ---- Web Audio mocks（connect 调用带记录，验证物理重排接线）----
const postedToWorklet = [];
const wiring = [];
function fakeParam() {
  return { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} };
}
let tagSeq = 0;
function fakeNode(tag) {
  return {
    _tag: tag ?? `n${tagSeq++}`,
    connect(to, out, inn) { wiring.push({ from: this._tag, to: to?._tag, out, in: inn }); },
    disconnect() {}, start() {}, stop() {},
    gain: fakeParam(), frequency: fakeParam(), Q: fakeParam(),
    pan: fakeParam(), positionX: fakeParam(), positionY: fakeParam(), positionZ: fakeParam(),
    orientationX: fakeParam(), orientationY: fakeParam(), orientationZ: fakeParam(),
    buffer: null, type: "", channelCount: 0, channelCountMode: "", channelInterpretation: "",
    maxChannelCount: 12,
  };
}
class FakeAudioWorkletNode {
  constructor(ctx, name, opts) {
    this._tag = "worklet";
    this.port = { postMessage: (msg) => postedToWorklet.push(msg), onmessage: null };
  }
  connect(to, out, inn) { wiring.push({ from: "worklet", to: to?._tag, out, in: inn }); }
  disconnect() {}
}
globalThis.AudioWorkletNode = FakeAudioWorkletNode;
class FakeAudioContext {
  constructor() {
    this.sampleRate = 48000;
    this.state = "running";
    this.audioWorklet = { addModule: async () => {} };
    this.destination = fakeNode("destination");
    this.listener = {};
  }
  createGain() { return fakeNode("gain"); }
  createBiquadFilter() { return fakeNode("biquad"); }
  createConvolver() { return fakeNode("conv"); }
  createPanner() { return fakeNode("panner"); }
  createChannelSplitter(n) { return fakeNode(`split${n}`); }
  createChannelMerger(n) { return fakeNode(`merge${n}`); }
  createBuffer(ch, len, sr) { return { numberOfChannels: ch, length: len, sampleRate: sr, getChannelData: () => new Float32Array(len), copyToChannel() {} }; }
  async close() { this.state = "closed"; }
  async resume() {}
}
globalThis.AudioContext = FakeAudioContext;

const { SpatialRenderer, LAYOUTS } = await import(pathToFileURL(out).href);

let failed = 0;
function check(cond, what) {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${what}`);
}
const lastGains = (id) => [...postedToWorklet].reverse().find((m) => m.type === "gains" && m.id === id);
const near = (a, b) => Math.abs(a - b) < 1e-6;

// 固定运行时总线：[FL0 FR1 C2 LFE3 WL4 WR5 SL6 SR7 RL8 RR9 TFL10 TFR11 TSL12 TSR13 TRL14 TRR15]
const TOPOLOGY = LAYOUTS["9.1.6"];
const bus = (name) => TOPOLOGY.findIndex((speaker) => speaker.name === name);
const BED_5_1 = ["FrontLeft", "FrontRight", "Center", "LFE", "SurroundLeft", "SurroundRight"];
function addBed(r, labels) {
  labels.forEach((label, ch) => { if (!label.startsWith("Obj_")) r.addSource(`bed:${ch}`, { bedLabel: label }); });
}

// ---- 1. 5.1 床 → 7.1.4 布局（多声道物理输出）：吸附 + 上混馈送 ----
{
  postedToWorklet.length = 0;
  const r = new SpatialRenderer(new FakeAudioContext(), { mode: "multichannel", layout: LAYOUTS["7.1.4"] });
  await r.init("mock://worklet");
  addBed(r, BED_5_1);
  const g = lastGains("bed:4").gains; // SurroundLeft
  check(g[bus("SurroundLeft")] === 1 && g[bus("RearLeft")] === 0.5 && g.every((v, i) => i === bus("SurroundLeft") || i === bus("RearLeft") || v === 0),
    `5.1→7.1.4: Ls 吸附侧环(1.0) + 馈后环(0.5)，其余为 0 — [${g.join(",")}]`);
  const fl = lastGains("bed:0").gains; // FrontLeft（9.1.4 才有前宽，7.1.4 无馈送）
  check(fl[0] === 1 && fl.every((v, i) => i === 0 || v === 0), `5.1→7.1.4: FL 直送前左，无馈送`);
  const lfe = lastGains("bed:3").gains;
  check(lfe[3] === 1 && lfe.every((v, i) => i === 3 || v === 0), `LFE 直通低音总线`);

  // ---- 2. 补进真实 7.1 后环声道 → 馈送跳过被占用总线 ----
  r.addSource("bed:6", { bedLabel: "RearLeft" });
  r.addSource("bed:7", { bedLabel: "RearRight" });
  const g2 = lastGains("bed:4").gains;
  check(g2[bus("SurroundLeft")] === 1 && g2[bus("RearLeft")] === 0, `7.1 内容: 后环被真实声道占用 → Ls 馈送撤回 (RL=${g2[bus("RearLeft")]})`);
  const rl = lastGains("bed:6").gains;
  check(rl[bus("RearLeft")] === 1 && rl.every((v, i) => i === bus("RearLeft") || v === 0), `真实 RearLeft 直送后环总线`);

  // ---- 3. 对象不走吸附/扩展 ----
  r.addSource("obj:10");
  r.applyEvent({ id: 10, pos: [-1, 0, 0], hasPos: true, size: 0, gainDb: 0, rampDuration: 128 }, 128); // 正左(ADM x- = 左)
  const og = lastGains("obj:10").gains;
  const maxBus = og.indexOf(Math.max(...og));
  check(maxBus === bus("SurroundLeft") && og[bus("RearLeft")] === 0 && og[bus("RearRight")] === 0,
    `对象在左侧位: VBAP 主能量在侧环(SL=${og[bus("SurroundLeft")].toFixed(3)})，不触发扩展馈送 (RL=${og[bus("RearLeft")]}, RR=${og[bus("RearRight")]})`);
}

// ---- 4. 5.1 床 → 5.1 布局：纯吸附，无扩展目标 ----
{
  postedToWorklet.length = 0;
  const r = new SpatialRenderer(new FakeAudioContext(), { mode: "binaural", layout: LAYOUTS["5.1"] });
  await r.init("mock://worklet");
  addBed(r, BED_5_1);
  const g = lastGains("bed:4").gains;
  check(g[bus("SurroundLeft")] === 1 && g.every((v, i) => i === bus("SurroundLeft") || v === 0), `5.1→5.1: Ls 直送侧环，无馈送（布局无后环）`);
}

// ---- 5. 5.1 床 → 9.1.4 布局（多声道）：前宽馈送 + 后环馈送 ----
{
  postedToWorklet.length = 0;
  // 9.1.4 总线：[FL0 FR1 C2 LFE3 WL4 WR5 SL6 SR7 RL8 RR9 TFL10 TFR11 TRL12 TRR13]
  const r = new SpatialRenderer(new FakeAudioContext(), { mode: "multichannel", layout: LAYOUTS["9.1.4"] });
  await r.init("mock://worklet");
  addBed(r, BED_5_1);
  const fl = lastGains("bed:0").gains;
  check(near(fl[0], 1) && near(fl[4], 0.35), `5.1→9.1.4: FL 吸附 + 馈前宽(0.35) (WL=${fl[4]})`);
  const ls = lastGains("bed:4").gains;
  check(ls[6] === 1 && ls[8] === 0.5, `5.1→9.1.4: Ls 吸附侧环 + 馈后环(0.5) (RL=${ls[8]})`);
  r.addSource("bed:truehd-lw", { bedLabel: "Lw" });
  const lw = lastGains("bed:truehd-lw").gains;
  check(lw[4] === 1 && lw.every((v, i) => i === 4 || v === 0),
    `TrueHD Lw 原生标签直接吸附前宽总线（WL=${lw[4]}）`);
}

// ---- 5b. 双耳模式：只吸附不馈送（相干拷贝会梳状滤波）----
{
  postedToWorklet.length = 0;
  wiring.length = 0;
  const r = new SpatialRenderer(new FakeAudioContext(), { mode: "binaural", layout: LAYOUTS["7.1.4"] });
  await r.init("mock://worklet");
  addBed(r, BED_5_1);
  const g = lastGains("bed:4").gains; // SurroundLeft
  check(g[bus("SurroundLeft")] === 1 && g[bus("RearLeft")] === 0 && g.every((v, i) => i === bus("SurroundLeft") || v === 0),
    `双耳 5.1→7.1.4: Ls 吸附侧环(1.0)，不馈后环（RL=${g[bus("RearLeft")]})`);
  wiring.length = 0;
  const r9 = new SpatialRenderer(new FakeAudioContext(), { mode: "binaural", layout: LAYOUTS["9.1.4"] });
  await r9.init("mock://worklet");
  addBed(r9, BED_5_1);
  const fl9 = lastGains("bed:0").gains;
  check(near(fl9[0], 1) && fl9[4] === 0, `双耳 5.1→9.1.4: FL 直送前左，不馈前宽（WL=${fl9[4]}）`);
  const binauralBiquads = wiring.filter((edge) => edge.from === "biquad" || edge.to === "biquad");
  check(binauralBiquads.length === 3,
    `双耳: 只有 LFE 120Hz LR4 使用滤波器，主声道全频卷积（biquad 接线=${binauralBiquads.length}）`);
}

// ---- 6. 双耳 Near/Mid/Far：只重混 IR，不篡改 ADM 对象高频或相对响度 ----
{
  postedToWorklet.length = 0;
  const r = new SpatialRenderer(new FakeAudioContext(), { mode: "binaural", layout: LAYOUTS["5.1"] });
  await r.init("mock://worklet");
  r.addSource("obj:distance");
  r.applyEvent({ id: "distance", pos: [0, 2, 0], hasPos: true, size: 0, gainDb: 0, rampDuration: 128 }, 128);
  const nearMode = lastGains("obj:distance");
  r.setBinauralMode("far");
  const farMode = lastGains("obj:distance");
  check(near(nearMode.gain, 0.5) && near(farMode.gain, 0.5),
    `双耳档位：ADM 环外 d=2 的 Apple inverse 增益保持 0.5（near=${nearMode.gain}, far=${farMode.gain}）`);
  check(near(nearMode.lp, 1) && near(farMode.lp, 1),
    `双耳档位：ADM 归一化距离不擅自低通内容（near/far lp=${nearMode.lp}/${farMode.lp}）`);
}

// ---- 7. 多声道模式：destination 声道数 + WASAPI 物理顺序重排 ----
{
  wiring.length = 0;
  const ctx = new FakeAudioContext();
  const r = new SpatialRenderer(ctx, { mode: "multichannel", layout: LAYOUTS["7.1.4"] });
  await r.init("mock://worklet");
  check(ctx.destination.channelCount === 12 && ctx.destination.channelCountMode === "explicit",
    `多声道: 固定最大拓扑受设备上限钳制为 12 ch（实际 ${ctx.destination.channelCount}/${ctx.destination.channelCountMode}）`);
  const edges = wiring.filter((w) => w.from === "split16" && w.to === "merge16" && typeof w.out === "number" && typeof w.in === "number");
  const expect = [[0, 0], [1, 1], [2, 2], [3, 3], [8, 4], [9, 5], [6, 6], [7, 7], [4, 8], [5, 9], [10, 10], [11, 11], [12, 12], [13, 13], [14, 14], [15, 15]];
  const ok = expect.every(([bus, inp]) => edges.some((e) => e.out === bus && e.in === inp));
  check(ok && edges.length === 16, `多声道: 固定 9.1.6 总线按 WASAPI 顺序重排${ok ? "" : JSON.stringify(edges)}`);
}

// ---- 8. 5.1 逻辑布局多声道：仍维持最大物理拓扑以支持无中断切换 ----
{
  wiring.length = 0;
  const ctx = new FakeAudioContext();
  const r = new SpatialRenderer(ctx, { mode: "multichannel", layout: LAYOUTS["5.1"] });
  await r.init("mock://worklet");
  check(ctx.destination.channelCount === 12, `多声道 5.1: 固定最大拓扑受 12ch 设备上限钳制`);
  const edges = wiring.filter((w) => w.from === "split16" && w.to === "merge16" && typeof w.out === "number" && typeof w.in === "number");
  check(edges.length === 16, `多声道 5.1: 固定物理总线完整接线，未用声道由零增益静音`);
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
