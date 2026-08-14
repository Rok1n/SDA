// 对照原始 SADIE D1 wav 的直达极性（HRIR，ele 0 / 45 关键方向）
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import path from "node:path";

// 用 PowerShell 解压指定文件
const zip = "tmp/sadie-source/D1.zip";
const wanted = [
  ["30,0", "0,0"], ["330,0", "0,0"], ["60,0", "0,0"], ["300,0", "0,0"],
  ["100,0", "0,0"], ["260,0", "0,0"], ["110,0", "0,0"], ["250,0", "0,0"],
  ["140,0", "0,0"], ["220,0", "0,0"], ["0,0", "0,0"],
  ["45,0", "45,0"], ["315,0", "45,0"], ["90,0", "45,0"], ["270,0", "45,0"],
  ["135,0", "45,0"], ["225,0", "45,0"],
];
import { mkdirSync, existsSync } from "node:fs";
mkdirSync("tmp/sadie-check", { recursive: true });
for (const [azi, ele] of wanted) {
  const name = `azi_${azi}_ele_${ele}.wav`;
  const inner = `D1/D1_HRIR_WAV/48K_24bit/${name}`;
  const out = `tmp/sadie-check/${name}`;
  if (existsSync(out)) continue;
  try {
    execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[System.IO.Compression.ZipFile]::OpenRead('${path.resolve(zip)}'); $e=$z.Entries | Where-Object FullName -eq '${inner}'; if ($e) { [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, '${path.resolve(out)}', $true) }; $z.Dispose()"`, { stdio: "pipe" });
  } catch (error) {
    console.log(`extract fail ${name}: ${error.message.slice(0, 120)}`);
  }
}

function readWav(file) {
  const buf = readFileSync(file);
  // 简化 RIFF 解析
  let offset = 12;
  let dataOffset = -1, dataLength = 0, bits = 24, channels = 2;
  while (offset < buf.length - 8) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      bits = buf.readUInt16LE(offset + 22);
      channels = buf.readUInt16LE(offset + 10);
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size & 1);
  }
  const frames = Math.floor(dataLength / (channels * (bits / 8)));
  const out = [new Float64Array(frames), new Float64Array(frames)];
  const bytesPerSample = bits / 8;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < 2; ch++) {
      const at = dataOffset + (i * channels + ch) * bytesPerSample;
      let value;
      if (bits === 24) {
        value = buf.readIntLE(at, 3) / 8388608;
      } else if (bits === 16) {
        value = buf.readInt16LE(at) / 32768;
      } else {
        value = buf.readFloatLE(at);
      }
      out[ch][i] = value;
    }
  }
  return out;
}

for (const [azi, ele] of wanted) {
  const name = `azi_${azi}_ele_${ele}.wav`;
  const out = `tmp/sadie-check/${name}`;
  if (!existsSync(out)) { console.log(`${name}: 缺失`); continue; }
  const [L, R] = readWav(out);
  const peak = (x) => {
    let best = 0, idx = 0;
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > best) { best = Math.abs(x[i]); idx = i; }
    return { idx, sign: Math.sign(x[idx]), amp: best };
  };
  const pl = peak(L);
  const pr = peak(R);
  console.log(`azi ${azi.padStart(6)} ele ${ele}: L peak@${pl.idx} ${pl.sign > 0 ? "+" : "-"}${pl.amp.toFixed(3)}  R peak@${pr.idx} ${pr.sign > 0 ? "+" : "-"}${pr.amp.toFixed(3)}`);
}
