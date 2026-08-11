// Headless test: 床声道吸附 + 上混扩展 + 多声道物理重排。
// 5.1 内容选 7.1 布局 → 每路总线都有输出（像 AVR 上混器）；双耳路径同一机制。
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

// 7.1.4 总线索引：[FL0 FR1 C2 LFE3 SL4 SR5 RL6 RR7 TFL8 TFR9 TRL10 TRR11]
const BED_5_1 = ["FrontLeft", "FrontRight", "Center", "LFE", "SurroundLeft", "SurroundRight"];
function addBed(r, labels) {
  labels.forEach((label, ch) => { if (!label.startsWith("Obj_")) r.addSource(`bed:${ch}`, { bedLabel: label }); });
}

// ---- 1. 5.1 床 → 7.1.4 布局：吸附 + 上混馈送 ----
{
  postedToWorklet.length = 0;
  const r = new SpatialRenderer(new FakeAudioContext(), { mode: "binaural", layout: LAYOUTS["7.1.4"] });
  await r.init("mock://worklet");
  addBed(r, BED_5_1);
  const g = lastGains("bed:4").gains; // SurroundLeft
  check(g[4] === 1 && g[6] === 0.5 && g.every((v, i) => i === 4 || i === 6 || v === 0),
    `5.1→7.1.4: Ls 吸附侧环(1.0) + 馈后环(0.5)，其余为 0 — [${g.join(",")}]`);
  const fl = lastGains("bed:0").gains; // FrontLeft（9.1.4 才有前宽，7.1.4 无馈送）
  check(fl[0] === 1 && fl.every((v, i) => i === 0 || v === 0), `5.1→7.1.4: FL 直送前左，无馈送`);
  const lfe = lastGains("bed:3").gains;
  check(lfe[3] === 1 && lfe.every((v, i) => i === 3 || v === 0), `LFE 直通低音总线`);

  // ---- 2. 补进真实 7.1 后环声道 → 馈送跳过被占用总线 ----
  r.addSource("bed:6", { bedLabel: "RearLeft" });
  r.addSource("bed:7", { bedLabel: "RearRight" });
  const g2 = lastGains("bed:4").gains;
  check(g2[4] === 1 && g2[6] === 0, `7.1 内容: 后环被真实声道占用 → Ls 馈送撤回 (RL=${g2[6]})`);
  const rl = lastGains("bed:6").gains;
  check(rl[6] === 1 && rl.every((v, i) => i === 6 || v === 0), `真实 RearLeft 直送后环总线`);

  // ---- 3. 对象不走吸附/扩展 ----
  r.addSource("obj:10");
  r.applyEvent({ id: 10, pos: [-1, 0, 0], hasPos: true, size: 0, gainDb: 0, rampDuration: 128 }, 128); // 正左(ADM x- = 左)
  const og = lastGains("obj:10").gains;
  const maxBus = og.indexOf(Math.max(...og));
  check(maxBus === 4 && og[6] === 0 && og[7] === 0,
    `对象在左侧位: VBAP 主能量在侧环(SL=${og[4].toFixed(3)})，不触发扩展馈送 (RL=${og[6]}, RR=${og[7]})`);
}

// ---- 4. 5.1 床 → 5.1 布局：纯吸附，无扩展目标 ----
{
  postedToWorklet.length = 0;
  const r = new SpatialRenderer(new FakeAudioContext(), { mode: "binaural", layout: LAYOUTS["5.1"] });
  await r.init("mock://worklet");
  addBed(r, BED_5_1);
  const g = lastGains("bed:4").gains;
  check(g[4] === 1 && g.every((v, i) => i === 4 || v === 0), `5.1→5.1: Ls 直送侧环，无馈送（布局无后环）`);
}

// ---- 5. 5.1 床 → 9.1.4 布局：前宽馈送 + 后环馈送 ----
{
  postedToWorklet.length = 0;
  // 9.1.4 总线：[FL0 FR1 C2 LFE3 WL4 WR5 SL6 SR7 RL8 RR9 TFL10 TFR11 TRL12 TRR13]
  const r = new SpatialRenderer(new FakeAudioContext(), { mode: "binaural", layout: LAYOUTS["9.1.4"] });
  await r.init("mock://worklet");
  addBed(r, BED_5_1);
  const fl = lastGains("bed:0").gains;
  check(near(fl[0], 1) && near(fl[4], 0.35), `5.1→9.1.4: FL 吸附 + 馈前宽(0.35) (WL=${fl[4]})`);
  const ls = lastGains("bed:4").gains;
  check(ls[6] === 1 && ls[8] === 0.5, `5.1→9.1.4: Ls 吸附侧环 + 馈后环(0.5) (RL=${ls[8]})`);
}

// ---- 6. 多声道模式：destination 声道数 + WASAPI 物理顺序重排 ----
{
  wiring.length = 0;
  const ctx = new FakeAudioContext();
  const r = new SpatialRenderer(ctx, { mode: "multichannel", layout: LAYOUTS["7.1.4"] });
  await r.init("mock://worklet");
  check(ctx.destination.channelCount === 12 && ctx.destination.channelCountMode === "explicit",
    `多声道: destination.channelCount=12 explicit（实际 ${ctx.destination.channelCount}/${ctx.destination.channelCountMode}）`);
  // 物理顺序 [FL FR C LFE RL RR SL SR TFL TFR TRL TRR]：
  // merger 输入4←总线6(RL) 5←7(RR) 6←4(SL) 7←5(SR)
  const edges = wiring.filter((w) => typeof w.out === "number" && typeof w.in === "number");
  const expect = [[0, 0], [1, 1], [2, 2], [3, 3], [6, 4], [7, 5], [4, 6], [5, 7], [8, 8], [9, 9], [10, 10], [11, 11]];
  const ok = expect.every(([bus, inp]) => edges.some((e) => e.out === bus && e.in === inp));
  check(ok && edges.length === 12, `多声道: 总线按 WASAPI 顺序重排（后环在侧环前）${ok ? "" : JSON.stringify(edges)}`);
}

// ---- 7. 5.1 布局多声道：顺序不变 ----
{
  wiring.length = 0;
  const ctx = new FakeAudioContext();
  const r = new SpatialRenderer(ctx, { mode: "multichannel", layout: LAYOUTS["5.1"] });
  await r.init("mock://worklet");
  check(ctx.destination.channelCount === 6, `多声道 5.1: channelCount=6`);
  const edges = wiring.filter((w) => typeof w.out === "number" && typeof w.in === "number");
  const ok = [0, 1, 2, 3, 4, 5].every((i) => edges.some((e) => e.out === i && e.in === i));
  check(ok, `多声道 5.1: 总线顺序直通`);
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
