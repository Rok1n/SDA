// Stereo-linked lookahead limiter regression.
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(path.join("packages", "renderer", "worklet", "sda-renderer.worklet.js"), "utf8");
let PeakGuard = null;
globalThis.sampleRate = 48000;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, postMessage() {} }; } };
globalThis.registerProcessor = (name, processor) => {
  if (name === "sda-final-peak-guard") PeakGuard = processor;
};
eval(source);

const ceiling = Math.pow(10, -1 / 20);
const lookahead = 240;
const length = 1400;
const left = new Float32Array(length).fill(0.25);
const right = new Float32Array(length).fill(-0.5);
left[400] = 1.5;
right[400] = -0.75;
const outLeft = new Float32Array(length);
const outRight = new Float32Array(length);
const guard = new PeakGuard({ processorOptions: { ceilingDb: -1 } });
for (let offset = 0; offset < length; offset += 128) {
  const end = Math.min(length, offset + 128);
  guard.process(
    [[left.subarray(offset, end), right.subarray(offset, end)]],
    [[outLeft.subarray(offset, end), outRight.subarray(offset, end)]],
  );
}

let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}

check(outLeft.slice(0, lookahead).every((sample) => sample === 0)
  && outRight.slice(0, lookahead).every((sample) => sample === 0),
"启动阶段提供精确 5ms lookahead 延迟");
check(Math.abs(outLeft[lookahead] - left[0]) < 1e-7
  && Math.abs(outRight[lookahead] - right[0]) < 1e-7,
"阈值以下信号在 lookahead 后保持 unity 与声道身份");
const limitedIndex = 400 + lookahead;
check(Math.abs(outLeft[limitedIndex]) <= ceiling + 1e-6
  && Math.abs(outRight[limitedIndex]) <= ceiling + 1e-6,
"超阈值峰值在延迟后不超过 -1dBFS ceiling");
const leftGain = outLeft[limitedIndex] / left[400];
const rightGain = outRight[limitedIndex] / right[400];
check(Math.abs(leftGain - rightGain) < 1e-6,
"左右耳共享同一 limiter gain，声像不偏移");
check(Math.abs(outLeft[limitedIndex]) < Math.abs(left[400])
  && Math.abs(outLeft[limitedIndex]) > Math.abs(outLeft[limitedIndex - 1]),
"峰值按比例缩放而不是 flat-top 硬钳位");
const prePeak = outLeft.slice(400, limitedIndex);
let maximumAttackStep = 0;
for (let i = 1; i < prePeak.length; i++) maximumAttackStep = Math.max(maximumAttackStep, Math.abs(prePeak[i] - prePeak[i - 1]));
check(maximumAttackStep < 0.001,
"未来峰值只触发连续 lookahead attack，不产生预峰值单样本 duck");
const release = outLeft.slice(limitedIndex + lookahead + 1, length);
const releaseSteps = [...release].map((sample, index) => index === 0 ? 0 : Math.abs(sample - release[index - 1]));
check(release.every(Number.isFinite) && Math.max(...releaseSteps) < 0.01,
"hold 后 release 连续且无单样本增益跳变");

const normalizedLength = 6000;
const normalizedInput = new Float32Array(normalizedLength).fill(0.2);
const normalizedOutput = new Float32Array(normalizedLength);
const normalized = new PeakGuard({ processorOptions: { ceilingDb: -1 } });
const post = (data) => normalized.port.onmessage({ data });
post({ type: "programEnabled", enabled: true });
post({ type: "scheduleProgramGain", at: 100, gain: 0.5 });
post({ type: "scheduleProgramGain", at: 3000, gain: 0.25 });
post({ type: "start", origin: 0 });
for (let offset = 0; offset < normalizedLength; offset += 128) {
  const end = Math.min(normalizedLength, offset + 128);
  normalized.process(
    [[normalizedInput.subarray(offset, end), normalizedInput.subarray(offset, end)]],
    [[normalizedOutput.subarray(offset, end), new Float32Array(end - offset)]],
  );
}
check(Math.abs(normalizedOutput[lookahead + 99] - 0.2) < 1e-7
  && normalizedOutput[lookahead + 101] < 0.2,
"首个未来 dialnorm 只在对应 codec sample 后开始平滑");
check(Math.abs(normalizedOutput[lookahead + 2999] - 0.1) < 1e-5
  && normalizedOutput[lookahead + 3001] < normalizedOutput[lookahead + 2999],
"后续 dialnorm 变化不因预缓冲提前到当前节目");

console.log(failed ? `\n${failed} 项失败` : "\n最终 linked lookahead limiter 诊断通过");
process.exit(failed ? 1 : 0);
