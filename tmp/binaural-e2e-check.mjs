// 端到端数值仿真：真实 worklet（gains 消息）+ 真实 IR 卷积 → 双耳输出。
// 验证 snap+扩展 的增益向量经过 BRIR 后仍是立体声（左环绕应在左耳显著占优）。
import { readFileSync } from "node:fs";
import path from "node:path";

const hrtfDir = "apps/web/public/hrtf";
const readF32 = (f) => {
  const b = readFileSync(path.join(hrtfDir, f));
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
};

// ---- 真实 worklet ----
const workletSrc = readFileSync("packages/renderer/worklet/sda-renderer.worklet.js", "utf8");
let ProcessorClass = null;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, postMessage() {} }; } };
globalThis.registerProcessor = (name, cls) => { if (name === "sda-renderer") ProcessorClass = cls; };
globalThis.sampleRate = 48000;
eval(workletSrc);

const BUS = 12; // 7.1.4
const p = new ProcessorClass({ processorOptions: { busCount: BUS } });
const post = (m, transfer) => p.port.onmessage({ data: m });

// bed:4 = SurroundLeft：snap 后 gains[4]=1 + 扩展馈后环 gains[6]=0.5（renderer 实测值）
post({ type: "add", id: "bed:4" });
post({ type: "start", origin: 0 });
const gains = new Float32Array(BUS);
gains[4] = 1; gains[6] = 0.5;
post({ type: "gains", id: "bed:4", gains, gain: 1, lp: 1, ramp: 1 });

// 白噪声（环绕内容通常是扩散的）；8192 样本足以统计分离度
const N = 8192;
const noise = new Float32Array(N);
let seed = 42;
for (let i = 0; i < N; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; noise[i] = (seed / 0x40000000 - 1) * 0.5; }

const buses = Array.from({ length: BUS }, () => new Float32Array(128));
const busOut = Array.from({ length: BUS }, () => new Float32Array(N));
for (let off = 0; off < N; off += 128) {
  post({ type: "feed", id: "bed:4", samples: noise.subarray(off, off + 128) });
  for (const b of buses) b.fill(0);
  p.process([], [buses]);
  for (let b = 0; b < BUS; b++) busOut[b].set(buses[b], off);
}

// bus4 应≈noise，bus6 应≈0.5·noise
const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
console.log(`bus4(SL) rms=${rms(busOut[4]).toFixed(4)} bus6(RL) rms=${rms(busOut[6]).toFixed(4)}（期望 ≈0.5 / 0.25）`);

// ---- 真实 IR 卷积（near：90% dry + 10% wet，简化用 dry 即可判断分离度）----
function loadIr(az) {
  const a = readF32(`az${az < 0 ? "m" + (-az) : az}_el0_dry.f32`);
  const half = a.length >> 1;
  return [a.subarray(0, half), a.subarray(half)];
}
function convolve(x, ir) {
  const out = new Float32Array(x.length + ir.length - 1);
  for (let i = 0; i < ir.length; i++) {
    const h = ir[i];
    if (h === 0) continue;
    for (let j = 0; j < x.length; j++) out[i + j] += h * x[j];
  }
  return out.subarray(0, x.length);
}

const [ir100L, ir100R] = loadIr(100); // SL 总线（7.1.4 侧环 100°）
const [ir140L, ir140R] = loadIr(140); // RL 总线（后环 140°）
const c4L = convolve(busOut[4], ir100L);
const c6L = convolve(busOut[6], ir140L);
const c4R = convolve(busOut[4], ir100R);
const c6R = convolve(busOut[6], ir140R);
const earL = c4L.map((v, i) => v + c6L[i]);
const earR = c4R.map((v, i) => v + c6R[i]);

const eL = rms(earL), eR = rms(earR);
let sLR = 0, sLL = 0, sRR = 0;
for (let i = 0; i < earL.length; i++) { sLR += earL[i] * earR[i]; sLL += earL[i] * earL[i]; sRR += earR[i] * earR[i]; }
const corr = sLR / Math.sqrt(sLL * sRR);
console.log(`\n左环绕源 → 双耳：L=${eL.toFixed(4)} R=${eR.toFixed(4)} ILD=${(20 * Math.log10(eL / eR)).toFixed(1)}dB corr=${corr.toFixed(3)}`);
console.log(Math.abs(corr) < 0.5 && eL / eR > 2 ? "PASS — 双耳分离良好，不是单声道" : "FAIL — 双耳塌了");
