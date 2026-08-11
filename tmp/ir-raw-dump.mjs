// 直接检查 f32 文件结构：长度、两半的非零样本数、峰值位置
import { readFileSync } from "node:fs";
import path from "node:path";

const dir = "apps/web/public/hrtf";
for (const f of ["az100_el0_dry.f32", "az100_el0_wet.f32", "az30_el0_dry.f32", "az0_el0_dry.f32"]) {
  const buf = readFileSync(path.join(dir, f));
  const a = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const half = a.length >> 1;
  const info = (x) => {
    let nz = 0, peak = 0, pkIdx = -1, first = -1;
    for (let i = 0; i < x.length; i++) {
      const v = Math.abs(x[i]);
      if (v > 1e-7) { nz++; if (first < 0) first = i; }
      if (v > peak) { peak = v; pkIdx = i; }
    }
    return { len: x.length, nz, first, peak: peak.toExponential(2), pkIdx };
  };
  const L = info(a.subarray(0, half));
  const R = info(a.subarray(half));
  console.log(`${f} 总长${a.length}`);
  console.log(`  前半(L): ${JSON.stringify(L)}`);
  console.log(`  后半(R): ${JSON.stringify(R)}`);
  // 也看看是不是交错存储：前 8 个样本
  console.log(`  前8样本: [${[...a.subarray(0, 8)].map((v) => v.toExponential(1)).join(", ")}]`);
}
