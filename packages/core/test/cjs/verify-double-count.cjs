// 验证 JOC 双份渲染：核心床层是否已包含完整混音（对象内容烘焙在内）。
// 若是：播放床层+对象 = 对象叠两遍，静音对象后床层仍在放完整混音 → "M/S 没用"。
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const core = require("./sda_core.js");
const data = readFileSync(join(__dirname, "../../../../apps/web/public/demo-joc.ec3"));

const dec = new core.SdaDecoder("eac3");

const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

let frameIdx = 0;
let labels = null;
let decls = null;
let accBed = null;
let accObj = null;
let used = 0;

const drain = () => {
  while (true) {
    const frame = dec.nextFrame();
    if (!frame) break;
    frameIdx++;
    labels ??= frame.labels;
    decls ??= JSON.parse(frame.objectChannelsJson);
    const chans = [];
    for (let i = 0; i < frame.channelCount; i++) chans.push(frame.channel(i));
    frame.free();
    if (frameIdx < 20 || frameIdx > 120) continue; // 取中段 100 帧
    const nBed = chans.length - decls.length;
    accBed ??= new Array(nBed).fill(0);
    accObj ??= new Array(decls.length).fill(0);
    for (let c = 0; c < nBed; c++) accBed[c] += rms(chans[c]) ** 2;
    for (let c = nBed; c < chans.length; c++) accObj[c - nBed] += rms(chans[c]) ** 2;
    used++;
  }
  const errs = dec.drainErrors();
  if (errs.length) console.log("解码错误:", errs.slice(0, 5));
};

// 模拟播放器：整文件一次推入（与 dump-objects 相同），随后排空
dec.push(data);
drain();
drain();

const nBed = labels.length - decls.length;
console.log(`帧数=${frameIdx} 采样帧=${used}`);
console.log(`labels=[${labels.join(",")}]`);
console.log(`对象声明=${decls.length} 个: ids=${decls.map((d) => d.id).join(",")} channel=${decls[0]?.channel}..${decls.at(-1)?.channel}`);
console.log(`床层 ${nBed} 声道 平均总功率=${(accBed.reduce((a, b) => a + b, 0) / used).toFixed(4)}`);
console.log(`对象 ${decls.length} 声道 平均总功率=${(accObj.reduce((a, b) => a + b, 0) / used).toFixed(4)}`);
accBed.forEach((p, i) => console.log(`  bed[${i}] ${labels[i]} 功率=${(p / used).toFixed(4)}`));
console.log(
  accBed.reduce((a, b) => a + b, 0) / used > 0.005
    ? "→ 床层有完整混音电平：双份渲染成立 —— 静音对象只是去掉叠加层，床层照放全部内容"
    : "→ 床层接近无声，双份渲染理论不成立",
);
