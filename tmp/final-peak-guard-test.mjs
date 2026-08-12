// Final emergency peak guard worklet diagnostic: no release envelope or crossfeed.
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(path.join("packages", "renderer", "worklet", "sda-renderer.worklet.js"), "utf8");
let PeakGuard = null;
globalThis.AudioWorkletProcessor = class {};
globalThis.registerProcessor = (name, processor) => {
  if (name === "sda-final-peak-guard") PeakGuard = processor;
};
eval(source);

const ceiling = Math.pow(10, -0.1 / 20);
const guard = new PeakGuard({ processorOptions: { ceilingDb: -0.1 } });
const left = new Float32Array([0.25, ceiling * 1.5, 0.25, -ceiling * 1.5]);
const right = new Float32Array([-0.5, 0.4, -0.3, 0.2]);
const outLeft = new Float32Array(left.length);
const outRight = new Float32Array(right.length);
guard.process([[left, right]], [[outLeft, outRight]]);

let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}

check(outLeft[0] === left[0] && outLeft[2] === left[2] && outRight.every((value, i) => value === right[i]),
  "ceiling 内样本逐样本不变，左右不交叉");
check(Math.abs(outLeft[1] - ceiling) < 1e-7 && Math.abs(outLeft[3] + ceiling) < 1e-7,
  "超过 ceiling 的正负样本被独立限制到 -0.1dBFS");
check(outLeft[2] === left[2], "峰值后的普通样本立即恢复，不存在 release ducking");

console.log(failed ? `\n${failed} 项失败` : "\n最终 emergency peak guard 诊断通过");
process.exit(failed ? 1 : 0);
