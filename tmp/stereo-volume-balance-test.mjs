// Stereo mirror routing and per-source power-normalization regression.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const bundle = path.join(path.dirname(fileURLToPath(import.meta.url)), "renderer.bundle.cjs");
const { LAYOUTS, VbapSolver, stereoDownmixGains } = await import(pathToFileURL(bundle).href);

let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}

for (const [layoutId, layout] of Object.entries(LAYOUTS)) {
  for (const speaker of layout.filter((item) => !item.isLfe && item.azimuth > 0)) {
    const mirror = layout.find((item) => !item.isLfe
      && item.azimuth === -speaker.azimuth
      && item.elevation === speaker.elevation);
    if (!mirror) continue;
    const [left, right] = stereoDownmixGains(speaker);
    const [mirrorLeft, mirrorRight] = stereoDownmixGains(mirror);
    check(Math.abs(left - mirrorRight) < 1e-12 && Math.abs(right - mirrorLeft) < 1e-12,
      `${layoutId}: ${speaker.name}/${mirror.name} 严格镜像 L/R downmix`);
    check(Math.abs(left ** 2 + right ** 2 - 0.49) < 1e-12,
      `${layoutId}: ${speaker.name} 立体声 downmix 保持等功率`);
  }

  const solver = new VbapSolver(layout);
  let maxPowerError = 0;
  for (const elevation of [0, 30, 60]) {
    for (let azimuth = -180; azimuth < 180; azimuth += 15) {
      for (const spread of [0, 0.5, 1]) {
        const gains = solver.pan({ azimuth, elevation, distance: 1 }, spread);
        const power = gains.reduce((sum, gain) => sum + gain ** 2, 0);
        maxPowerError = Math.max(maxPowerError, Math.abs(power - 1));
      }
    }
  }
  check(maxPowerError < 1e-6,
    `${layoutId}: 水平/高度/spread VBAP 单对象单位功率（最大误差 ${maxPowerError.toExponential(2)}）`);

  const objectDirections = Array.from({ length: 15 }, (_, index) => ({
    azimuth: -168 + index * 24,
    elevation: index % 3 === 0 ? 45 : 0,
    distance: 1,
  }));
  const totalPower = objectDirections.reduce((sum, position) => {
    const gains = solver.pan(position, 0);
    return sum + gains.reduce((sourcePower, gain) => sourcePower + gain ** 2, 0);
  }, 0);
  check(Math.abs(totalPower - objectDirections.length) < 1e-5,
    `${layoutId}: 15 个去相关对象总线功率保持 15，不按潜在音箱总数衰减`);
}

console.log(failed ? `\n${failed} 项失败` : "\n立体声镜像与跨布局对象功率归一通过");
process.exit(failed ? 1 : 0);
