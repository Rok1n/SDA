// 验证 JOC 双份渲染：核心床层是否已包含完整混音（对象内容烘焙在内）。
// 若是：播放床层+对象 = 对象叠两遍，静音对象后床层仍在放完整混音 → "M/S 没用"。
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const core = await import(pathToFileURL(join(here, "../pkg-node/sda_core.js")).href);
const data = readFileSync(join(here, "../../../apps/web/public/demo-joc.ec3"));

const dec = new core.SdaDecoder("eac3");
dec.push(data);

const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

let frameIdx = 0;
let labels = null;
let decls = null;
let accBed = null;
let accObj = null;
let used = 0;

while (true) {
  const frame = dec.nextFrame();
  if (!frame) break;
  frameIdx++;
  labels ??= frame.labels;
  decls ??= JSON.parse(frame.objectChannelsJson);
  if (frameIdx < 20 || frameIdx > 120) continue; // 取中段 100 帧
  const chans = frame.channels; // Float32Array[]
  const nBed = chans.length - decls.length;
  accBed ??= new Array(nBed).fill(0);
  accObj ??= new Array(decls.length).fill(0);
  for (let c = 0; c < nBed; c++) accBed[c] += rms(chans[c]) ** 2;
  for (let c = nBed; c < chans.length; c++) accObj[c - nBed] += rms(chans[c]) ** 2;
  used++;
}

const nBed = labels.length - decls.length;
console.log(`帧数=${frameIdx} 采样帧=${used}`);
console.log(`labels=[${labels.join(",")}]`);
console.log(`对象声明=${decls.length} 个: ids=${decls.map((d) => d.id).join(",")} 首末 channel=${decls[0]?.channel}..${decls.at(-1)?.channel}`);
console.log(`床层 ${nBed} 声道 平均功率=${(accBed.reduce((a, b) => a + b, 0) / used).toFixed(4)}`);
console.log(`对象 ${decls.length} 声道 平均功率=${(accObj.reduce((a, b) => a + b, 0) / used).toFixed(4)}`);
accBed.forEach((p, i) => console.log(`  bed[${i}] ${labels[i]} 功率=${(p / used).toFixed(4)}`));
console.log(
  accBed.reduce((a, b) => a + b, 0) > 0.01
    ? "→ 床层有完整混音电平：双份渲染成立 —— 静音对象只是去掉叠加层，床层照放全部内容"
    : "→ 床层接近无声，双份渲染理论不成立",
);
