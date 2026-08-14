// 镜像对 symmetrization 原型：
// 每对 ±θ：B=mirror(IR(-θ))；搜 s∈{±1}, δ∈[-8,8]（双耳公共）使直达窗相关最大；
// avg = 0.5·(A + s·shift(B,δ))；+θ←avg，-θ←mirror(avg)。正中方向不动。
// 然后重跑镜像扫描验证三布局失配收敛。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const renderer = require("./renderer.bundle.cjs");
const directory = "apps/web/public/hrtf";
const manifest = JSON.parse(readFileSync(path.join(directory, "hrtf-set.json"), "utf8"));
const readF32 = (file) => {
  const data = readFileSync(path.join(directory, file));
  return new Float32Array(data.buffer, data.byteOffset, data.length / 4);
};
const context = {
  sampleRate: manifest.sampleRate,
  createBuffer(channels, length) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { copyToChannel(values, channel) { data[channel].set(values); }, getChannelData(channel) { return data[channel]; } };
  },
};
const energy = (values) => values.reduce((sum, v) => sum + v * v, 0);
const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));

const DIRECT_FROM = 128;
const DIRECT_TO = 320;

function alignScore(a, b, sign, shift, perEarLen) {
  let dot = 0, ea = 0, eb = 0;
  for (const offset of [0, perEarLen]) {
    for (let i = DIRECT_FROM; i < DIRECT_TO; i++) {
      const va = a[offset + i] ?? 0;
      const vb = sign * (b[offset + i - shift] ?? 0);
      dot += va * vb;
      ea += va * va;
      eb += vb * vb;
    }
  }
  return dot / Math.sqrt(ea * eb + 1e-18);
}

function symmetrizePair(plus, minus) {
  // plus/minus: {data: Float32Array(2N), perEarLen}
  // B = mirror(minus)
  const B = new Float32Array(minus.data.length);
  B.set(minus.data.subarray(minus.perEarLen), 0);
  B.set(minus.data.subarray(0, minus.perEarLen), minus.perEarLen);
  let best = { score: -2, sign: 1, shift: 0 };
  for (const sign of [1, -1]) {
    for (let shift = -8; shift <= 8; shift++) {
      const score = alignScore(plus.data, B, sign, shift, plus.perEarLen);
      if (score > best.score) best = { score, sign, shift };
    }
  }
  const avg = new Float32Array(plus.data.length);
  for (let i = 0; i < plus.data.length; i++) {
    avg[i] = 0.5 * ((plus.data[i] ?? 0) + best.sign * (B[i - best.shift] ?? 0));
  }
  const mirrored = new Float32Array(avg.length);
  mirrored.set(avg.subarray(plus.perEarLen), 0);
  mirrored.set(avg.subarray(0, plus.perEarLen), plus.perEarLen);
  return { avg, mirrored, ...best };
}

const PAIRS = [30, 60, 100, 110, 140].map((az) => [az, 0]).concat([[45, 45], [90, 45], [135, 45]]);
const rawMap = new Map();
for (const entry of manifest.positions) {
  rawMap.set(`${entry.azimuth}/${entry.elevation}`, {
    azimuth: entry.azimuth,
    elevation: entry.elevation,
    dry: readF32(entry.dry),
    wet: readF32(entry.wet),
    dryLen: readF32(entry.dry).length >> 1,
    wetLen: readF32(entry.wet).length >> 1,
  });
}
console.log("=== 对齐参数 ===");
for (const [az, el] of PAIRS) {
  const plus = rawMap.get(`${az}/${el}`);
  const minus = rawMap.get(`-${az}/${el}`);
  const dryResult = symmetrizePair({ data: plus.dry, perEarLen: plus.dryLen }, { data: minus.dry, perEarLen: minus.dryLen });
  const wetResult = symmetrizePair({ data: plus.wet, perEarLen: plus.wetLen }, { data: minus.wet, perEarLen: minus.wetLen });
  console.log(`±${az}/${el}: dry sign=${dryResult.sign} shift=${dryResult.shift} corr=${dryResult.score.toFixed(3)} | wet sign=${wetResult.sign} shift=${wetResult.shift} corr=${wetResult.score.toFixed(3)}`);
  plus.dry = dryResult.avg;
  minus.dry = dryResult.mirrored;
  plus.wet = wetResult.avg;
  minus.wet = wetResult.mirrored;
}

const set = { ...manifest, calibrated: manifest.calibrationVersion >= 1 };
const rawSet = { ...set, positions: [...rawMap.values()] };

// 正中方向对称化：双耳都给平均 IR（头朝正前时左右耳物理上应收到相同响应；
// 实测 1.11dB/3 sample 偏差是头模/摆放不对称，是人声结像倾斜的直接来源）
{
  const center = rawMap.get("0/0");
  for (const part of ["dry", "wet"]) {
    const data = center[part];
    const perEarLen = part === "dry" ? center.dryLen : center.wetLen;
    const B = new Float32Array(data.length);
    B.set(data.subarray(perEarLen), 0);
    B.set(data.subarray(0, perEarLen), perEarLen);
    let best = { score: -2, sign: 1, shift: 0 };
    for (const sign of [1, -1]) {
      for (let shift = -4; shift <= 4; shift++) {
        const score = alignScore(data, B, sign, shift, perEarLen);
        if (score > best.score) best = { score, sign, shift };
      }
    }
    const avg = new Float32Array(perEarLen);
    for (let i = 0; i < perEarLen; i++) {
      avg[i] = 0.5 * ((data[i] ?? 0) + best.sign * (B[i - best.shift] ?? 0));
    }
    const out = new Float32Array(data.length);
    out.set(avg, 0);
    out.set(avg, perEarLen);
    center[part] = out;
    console.log(`center ${part}: sign=${best.sign} shift=${best.shift} corr=${best.score.toFixed(3)}`);
  }
}

function renderObjectEars(busIrs, solver, layout, azimuth, elevation) {
  const gains = solver.pan({ azimuth, elevation, distance: 1 }, 0);
  const accum = [new Float64Array(8192), new Float64Array(8192)];
  for (let bus = 0; bus < layout.length; bus++) {
    const gain = gains[bus];
    if (!gain) continue;
    const ir = busIrs.get(bus);
    if (!ir) continue;
    for (let ear = 0; ear < 2; ear++) {
      const data = ir.getChannelData(ear);
      for (let i = 0; i < data.length; i++) accum[ear][i] += gain * data[i];
    }
  }
  return [energy(accum[0]), energy(accum[1])];
}

for (const layoutId of ["5.1.4", "7.1.4", "9.1.4"]) {
  const layout = renderer.LAYOUTS[layoutId];
  const busIrs = renderer.buildBusIrs(context, rawSet, layout, "near");
  const solver = new renderer.VbapSolver(layout);
  let worst = 0;
  let sumSq = 0, count = 0;
  const badRows = [];
  for (let az = 5; az <= 180; az += 5) {
    const [plusL, plusR] = renderObjectEars(busIrs, solver, layout, az, 0);
    const [minusL, minusR] = renderObjectEars(busIrs, solver, layout, -az, 0);
    const ipsi = db(Math.sqrt(plusL / minusR));
    const contra = db(Math.sqrt(plusR / minusL));
    const worstMismatch = Math.max(Math.abs(ipsi), Math.abs(contra));
    if (worstMismatch > Math.abs(worst)) worst = worstMismatch === Math.abs(ipsi) ? ipsi : contra;
    sumSq += ipsi ** 2 + contra ** 2;
    count += 2;
    if (worstMismatch > 0.3) badRows.push({ az, ipsi: +ipsi.toFixed(2), contra: +contra.toFixed(2) });
  }
  console.log(`\n${layoutId}: 最大失配 ${worst.toFixed(2)}dB, RMS 失配 ${Math.sqrt(sumSq / count).toFixed(2)}dB`);
  if (badRows.length) console.table(badRows);
}
