// VBAP 布局矩阵：对象精确落在每个非 LFE 虚拟音箱位置时，检查主导总线、
// 单位功率与 LFE 隔离；同时检查左右镜像位置的总线增益镜像。
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "renderer.bundle.cjs");
const { LAYOUTS, VbapSolver } = await import(pathToFileURL(out).href);
const sphericalToAdm = ({ azimuth, elevation }) => {
  const az = (azimuth * Math.PI) / 180;
  const el = (elevation * Math.PI) / 180;
  // renderer ADM: x- = 左，y+ = 前，z+ = 上。
  return [-Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];
};
let failed = 0;
const check = (condition, text) => {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
};
const approx = (a, b, eps = 1e-5) => Math.abs(a - b) < eps;
for (const [layoutId, layout] of Object.entries(LAYOUTS)) {
  const solver = new VbapSolver(layout);
  for (let target = 0; target < layout.length; target++) {
    const speaker = layout[target];
    if (speaker.isLfe) continue;
    const gains = solver.pan({ azimuth: speaker.azimuth, elevation: speaker.elevation, distance: 1 }, 0);
    const energy = gains.reduce((sum, gain) => sum + gain * gain, 0);
    const dominant = gains.indexOf(Math.max(...gains));
    check(approx(energy, 1), `${layoutId}: ${speaker.name} 精确对象位置单位功率 (${energy.toFixed(6)})`);
    check(dominant === target, `${layoutId}: ${speaker.name} 精确对象位置主导对应总线 (${dominant})`);
    const lfe = layout.findIndex((entry) => entry.isLfe);
    check(lfe < 0 || gains[lfe] === 0, `${layoutId}: ${speaker.name} 对象不进入 LFE 总线`);
    const mirrored = layout.findIndex((other) => other.azimuth === -speaker.azimuth && other.elevation === speaker.elevation && !other.isLfe);
    if (speaker.azimuth > 0 && mirrored >= 0) {
      const right = solver.pan({ azimuth: -speaker.azimuth, elevation: speaker.elevation, distance: 1 }, 0);
      check(approx(gains[target], right[mirrored]), `${layoutId}: ${speaker.name} 左右镜像主增益`);
    }
  }
}

// 非零 size 只能向对象附近的少数虚拟音箱扩展，不能把一个对象均匀铺到整套布局。
for (const layoutId of ["5.1", "7.1.4", "9.1.6"]) {
  const layout = LAYOUTS[layoutId];
  const solver = new VbapSolver(layout);
  const gains = solver.pan({ azimuth: 45, elevation: 35, distance: 1 }, 1);
  const active = gains.filter((gain) => gain > 1e-5).length;
  const energy = gains.reduce((sum, gain) => sum + gain * gain, 0);
  const lfe = layout.findIndex((speaker) => speaker.isLfe);
  check(active <= 4, `${layoutId}: 大尺寸对象只扩展到局部音箱（${active} 路）`);
  check(approx(energy, 1), `${layoutId}: 大尺寸对象保持单位功率 (${energy.toFixed(6)})`);
  check(lfe < 0 || gains[lfe] === 0, `${layoutId}: 大尺寸对象不进入 LFE 总线`);
}

console.log(failed ? `\n${failed} 项失败` : "\n全部布局 VBAP 定位通过");
process.exit(failed ? 1 : 0);
