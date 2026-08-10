#!/usr/bin/env node
/**
 * build-hrtf.mjs — 把 SADIE II（University of York，Apache-2.0）KU100 假头的
 * HRIR/BRIR WAV 集转换为本项目运行时格式：
 *
 *   apps/web/public/hrtf/hrtf-set.json   清单（方向 → 干/湿文件对）
 *   apps/web/public/hrtf/*.f32           [leftIR][rightIR] f32le 拼接
 *
 * 用法：
 *   node scripts/build-hrtf.mjs --hr <HRIR源> --br <BRIR源> [--out apps/web/public/hrtf]
 *
 * <源> 可以是：http(s) zip 地址 / 本地 zip / 本地目录（递归找 .wav）。
 * 文件名里必须能解析出方位角/仰角（支持 az30_el0、AZ030_EL000 等写法，
 * 见 AZ_EL_PATTERNS，数据集命名不同时在这里加一条即可）。
 *
 * 约定：本渲染器方位角 + = 左（ADM/ITU）；多数 HRTF 数据集 + = 右，
 * 默认 --flip-az 取反匹配（左右声道不互换，只是选另一边的测量点）。
 * 若数据集也是 + = 左，传 --no-flip-az。
 */

import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

// ---- 目标方向：全部扬声器布局的并集（见 packages/renderer/src/layouts.ts） ----
const TARGETS = [
  [0, 0], [30, 0], [-30, 0], [60, 0], [-60, 0],
  [100, 0], [-100, 0], [110, 0], [-110, 0], [140, 0], [-140, 0],
  [45, 45], [-45, 45], [90, 45], [-90, 45], [135, 45], [-135, 45],
];

const DRY_TAPS = 512;   // HRIR 截断（≈10.7ms @48k，直达声）
const WET_TAPS = 8192;  // BRIR 截断（≈170ms @48k，含房间早期反射 + 尾音）

const AZ_EL_PATTERNS = [
  /az(-?\d+(?:\.\d+)?)[^\d-]+el(-?\d+(?:\.\d+)?)/i,   // az30_el0 / AZ030_EL000
  /(-?\d+)_(-?\d+)/,                                   // 30_0.wav
];

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
}
const HR_SRC = opt("hr", null);
const BR_SRC = opt("br", null);
const OUT_DIR = resolve(opt("out", "apps/web/public/hrtf"));
const FLIP_AZ = !args.includes("--no-flip-az");

if (!HR_SRC || !BR_SRC) {
  console.error("用法: node scripts/build-hrtf.mjs --hr <HRIR zip/目录/URL> --br <BRIR zip/目录/URL>");
  console.error("数据集：SADIE II D1 (KU100)，https://www.york.ac.uk/sadie-project/ （Apache-2.0）");
  process.exit(1);
}

// ---- 极简 zip 读取（central directory + raw deflate，无第三方依赖） ----
function readZipEntries(buf) {
  // End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是 zip 文件（找不到 EOCD）");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    // local header 里 extra 长度可能不同，重新读
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataOff, dataOff + compSize);
    entries.push({ name, method, raw });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipEntryData({ method, raw }) {
  if (method === 0) return raw;
  if (method === 8) return inflateRawSync(raw);
  throw new Error(`不支持的 zip 压缩方式 ${method}`);
}

// ---- WAV 解析（PCM16/24/32、float32，取前两个声道） ----
function parseWav(buf) {
  if (buf.readUInt32BE(0) !== 0x52494646) throw new Error("不是 RIFF/WAV");
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.readUInt32BE(off);
    const size = buf.readUInt32LE(off + 4);
    if (id === 0x666d7420) fmt = buf.subarray(off + 8, off + 8 + size); // "fmt "
    if (id === 0x64617461) data = buf.subarray(off + 8, off + 8 + size); // "data"
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("WAV 缺 fmt/data 块");
  const format = fmt.readUInt16LE(0); // 1=PCM 3=float
  const channels = fmt.readUInt16LE(2);
  const rate = fmt.readUInt32LE(4);
  const bits = fmt.readUInt16LE(14);
  if (channels < 2) throw new Error(`单声道 WAV（${channels}ch）`);
  const frames = Math.floor(data.length / (channels * (bits / 8)));
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    for (const [ch, arr] of [[0, L], [1, R]]) {
      const o = (i * channels + ch) * (bits / 8);
      let v;
      if (format === 3 && bits === 32) v = data.readFloatLE(o);
      else if (bits === 16) v = data.readInt16LE(o) / 32768;
      else if (bits === 24) v = ((data[o] | (data[o + 1] << 8) | (data[o + 2] << 16)) << 8 >> 8) / 8388608;
      else if (bits === 32) v = data.readInt32LE(o) / 2147483648;
      else throw new Error(`不支持的 WAV 格式 fmt=${format} bits=${bits}`);
      arr[i] = v;
    }
  }
  return { L, R, rate };
}

// ---- 收集某个来源的全部「方向 → 立体声 IR」 ----
async function collectIrs(src, tag) {
  let files = []; // {name, buf}
  if (/^https?:\/\//.test(src)) {
    console.log(`[${tag}] 下载 ${src}`);
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${src}`);
    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`[${tag}] ${(buf.length / 1048576).toFixed(1)} MB，解 zip…`);
    for (const e of readZipEntries(buf)) {
      if (/\.wav$/i.test(e.name)) files.push({ name: basename(e.name), buf: zipEntryData(e) });
    }
  } else {
    const p = resolve(src);
    if (!existsSync(p)) throw new Error(`不存在：${p}`);
    if (statSync(p).isDirectory()) {
      const walk = (dir) => {
        for (const f of readdirSync(dir)) {
          const fp = join(dir, f);
          if (statSync(fp).isDirectory()) walk(fp);
          else if (/\.wav$/i.test(f)) files.push({ name: f, buf: readFileSync(fp) });
        }
      };
      walk(p);
    } else {
      const buf = readFileSync(p);
      for (const e of readZipEntries(buf)) {
        if (/\.wav$/i.test(e.name)) files.push({ name: basename(e.name), buf: zipEntryData(e) });
      }
    }
  }

  const irs = []; // {az, el, L, R, rate}
  let skipped = 0;
  for (const f of files) {
    let m = null;
    for (const re of AZ_EL_PATTERNS) {
      m = f.name.match(re);
      if (m) break;
    }
    if (!m) { skipped++; continue; }
    try {
      const { L, R, rate } = parseWav(f.buf);
      irs.push({ az: parseFloat(m[1]), el: parseFloat(m[2]), L, R, rate });
    } catch (e) {
      console.warn(`[${tag}] 跳过 ${f.name}: ${e.message}`);
    }
  }
  if (!irs.length) throw new Error(`[${tag}] 没有可用的方向 WAV（跳过 ${skipped}/${files.length}）— 文件名里解析不出方位角/仰角，需要在 AZ_EL_PATTERNS 加规则`);
  console.log(`[${tag}] ${irs.length} 个方向（跳过 ${skipped} 个无法解析的文件）@${irs[0].rate}Hz`);
  return irs;
}

// ---- 方向匹配 ----
const rad = (d) => (d * Math.PI) / 180;
function unit(az, el) {
  return [Math.cos(rad(el)) * Math.sin(rad(az)), Math.cos(rad(el)) * Math.cos(rad(az)), Math.sin(rad(el))];
}
function nearest(irs, az, el) {
  const [tx, ty, tz] = unit(az, el);
  let best = null;
  let bestDot = -2;
  for (const p of irs) {
    const [x, y, z] = unit(p.az, p.el);
    const dot = tx * x + ty * y + tz * z;
    if (dot > bestDot) { bestDot = dot; best = p; }
  }
  return best;
}

// ---- 截断 + 峰值归一化 + 写 f32le ----
function trimIr(L, R, taps, preSamples) {
  let peak = 0;
  let peakIdx = 0;
  const n = Math.min(L.length, taps + 4096);
  for (let i = 0; i < n; i++) {
    const v = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (v > peak) { peak = v; peakIdx = i; }
  }
  const start = Math.max(0, peakIdx - preSamples);
  const len = Math.min(taps, L.length - start);
  const out = new Float32Array(len * 2);
  out.set(L.subarray(start, start + len), 0);
  out.set(R.subarray(start, start + len), len);
  let max = 0;
  for (const v of out) max = Math.max(max, Math.abs(v));
  if (max > 0) for (let i = 0; i < out.length; i++) out[i] /= max; // 双耳同比例，保 ILD
  return out;
}

function nameFor(az, el, kind) {
  const a = String(az).replace("-", "m");
  const e = String(el).replace("-", "m");
  return `az${a}_el${e}_${kind}.f32`;
}

// ---- 主流程 ----
const [hrIrs, brIrs] = [await collectIrs(HR_SRC, "HRIR"), await collectIrs(BR_SRC, "BRIR")];
const sampleRate = hrIrs[0].rate;
if (brIrs[0].rate !== sampleRate) {
  console.warn(`警告：HRIR ${sampleRate}Hz 与 BRIR ${brIrs[0].rate}Hz 采样率不一致，运行时按 HRIR 速率声明（renderer 会重采样到设备速率）`);
}

mkdirSync(OUT_DIR, { recursive: true });
const positions = [];
for (const [az, el] of TARGETS) {
  const dsAz = FLIP_AZ ? -az : az; // 数据集 + = 右 → 取反匹配我们的 + = 左
  const dry = nearest(hrIrs, dsAz, el);
  const wet = nearest(brIrs, dsAz, el);
  if (!dry || !wet) { console.warn(`跳过 az${az} el${el}：数据集无匹配`); continue; }
  const dryName = nameFor(az, el, "dry");
  const wetName = nameFor(az, el, "wet");
  writeFileSync(join(OUT_DIR, dryName), Buffer.from(trimIr(dry.L, dry.R, DRY_TAPS, 16).buffer));
  writeFileSync(join(OUT_DIR, wetName), Buffer.from(trimIr(wet.L, wet.R, WET_TAPS, 32).buffer));
  positions.push({ azimuth: az, elevation: el, dry: dryName, wet: wetName });
  console.log(`az${az} el${el}  dry←(${dry.az},${dry.el})  wet←(${wet.az},${wet.el})`);
}

writeFileSync(
  join(OUT_DIR, "hrtf-set.json"),
  JSON.stringify({ sampleRate, source: "SADIE II D1 KU100 (University of York, Apache-2.0)", positions }, null, 2),
);
console.log(`\n完成：${positions.length} 个方向 → ${OUT_DIR}`);
