// 全方位镜像扫描：对象在 +θ vs -θ 时，同侧/对侧耳能量是否镜像
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const renderer = require("./renderer.bundle.cjs");
const directory = process.argv[2] ?? "apps/web/public/hrtf";
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
const set = { ...manifest, calibrated: manifest.calibrationVersion >= 1 };
const rawSet = {
  ...set,
  positions: manifest.positions.map((entry) => {
    const dry = readF32(entry.dry);
    const wet = readF32(entry.wet);
    return { azimuth: entry.azimuth, elevation: entry.elevation, dry, wet, dryLen: dry.length >> 1, wetLen: wet.length >> 1 };
  }),
};

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
  let worst = { az: 0, value: 0 };
  const rows = [];
  for (let az = 5; az <= 180; az += 5) {
    const [plusL, plusR] = renderObjectEars(busIrs, solver, layout, az, 0);
    const [minusL, minusR] = renderObjectEars(busIrs, solver, layout, -az, 0);
    // 完美镜像：E_L(+θ) == E_R(-θ) 且 E_R(+θ) == E_L(-θ)
    const ipsiMismatch = db(Math.sqrt(plusL / minusR)); // 同侧耳
    const contraMismatch = db(Math.sqrt(plusR / minusL)); // 对侧耳
    const worstMismatch = Math.max(Math.abs(ipsiMismatch), Math.abs(contraMismatch));
    if (worstMismatch > Math.abs(worst.value)) worst = { az, value: worstMismatch === Math.abs(ipsiMismatch) ? ipsiMismatch : contraMismatch };
    rows.push({ az, ipsi: +ipsiMismatch.toFixed(2), contra: +contraMismatch.toFixed(2) });
  }
  console.log(`\n=== ${layoutId} 镜像扫描（el=0，+θ左耳 vs -θ右耳）===`);
  console.table(rows.filter((r) => Math.abs(r.ipsi) > 0.3 || Math.abs(r.contra) > 0.3));
  console.log(`最大失配: az=${worst.az} ${worst.value.toFixed(2)}dB`);
}
