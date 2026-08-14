// 逐对象（音箱位置）经 VBAP + 卷积后的 L/R，定位不对称来源
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
const db = (ratio) => 20 * Math.log10(Math.max(ratio, 1e-12));
const set = { ...manifest, calibrated: manifest.calibrationVersion >= 1 };
const rawSet = {
  ...set,
  positions: manifest.positions.map((entry) => {
    const dry = readF32(entry.dry);
    const wet = readF32(entry.wet);
    return { azimuth: entry.azimuth, elevation: entry.elevation, dry, wet, dryLen: dry.length >> 1, wetLen: wet.length >> 1 };
  }),
};

for (const layoutId of ["5.1.4", "7.1.4", "9.1.4"]) {
  const layout = renderer.LAYOUTS[layoutId];
  const busIrs = renderer.buildBusIrs(context, rawSet, layout, "near");
  const solver = new renderer.VbapSolver(layout);
  console.log(`\n=== ${layoutId} 逐对象 L/R（对象在音箱精确位置，spread=0）===`);
  for (const spk of layout) {
    if (spk.isLfe) continue;
    const gains = solver.pan({ azimuth: spk.azimuth, elevation: spk.elevation, distance: 1 }, 0);
    const active = [];
    for (let i = 0; i < gains.length; i++) if (gains[i] > 1e-4) active.push([i, gains[i]]);
    const accum = [new Float64Array(8192), new Float64Array(8192)];
    for (const [bus, gain] of active) {
      const ir = busIrs.get(bus);
      if (!ir) continue;
      for (let ear = 0; ear < 2; ear++) {
        const data = ir.getChannelData(ear);
        for (let i = 0; i < data.length; i++) accum[ear][i] += gain * data[i];
      }
    }
    const lr = db(Math.sqrt(energy(accum[0]) / energy(accum[1])));
    const busList = active.map(([i, g]) => `${layout[i].name}:${g.toFixed(2)}`).join(" ");
    console.log(`${spk.name.padEnd(12)} az=${String(spk.azimuth).padStart(4)} el=${String(spk.elevation).padStart(3)}  L/R=${lr.toFixed(2)}dB  buses: ${busList}`);
  }
}
