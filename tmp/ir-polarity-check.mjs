// 全方向 dry IR 直达主峰值极性检查（同侧耳/对侧耳）
import { readFileSync } from "node:fs";
import path from "node:path";

const directory = "apps/web/public/hrtf";
const manifest = JSON.parse(readFileSync(path.join(directory, "hrtf-set.json"), "utf8"));
const readF32 = (file) => {
  const data = readFileSync(path.join(directory, file));
  return new Float32Array(data.buffer, data.byteOffset, data.length / 4);
};
for (const entry of manifest.positions) {
  const dry = readF32(entry.dry);
  const dryLen = dry.length >> 1;
  const L = dry.subarray(0, dryLen);
  const R = dry.subarray(dryLen);
  const peak = (x) => {
    let best = 0, idx = 0;
    for (let i = 0; i < Math.min(x.length, 480); i++) if (Math.abs(x[i]) > best) { best = Math.abs(x[i]); idx = i; }
    return { idx, sign: Math.sign(x[idx]), amp: best };
  };
  const pl = peak(L);
  const pr = peak(R);
  console.log(`${String(entry.azimuth).padStart(4)}/${String(entry.elevation).padStart(3)}  L: peak@${pl.idx} ${pl.sign > 0 ? "+" : "-"}${pl.amp.toFixed(3)}   R: peak@${pr.idx} ${pr.sign > 0 ? "+" : "-"}${pr.amp.toFixed(3)}`);
}
