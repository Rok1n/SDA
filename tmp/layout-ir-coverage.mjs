// 布局×IR 方向覆盖审计：每个布局的每只音箱，匹配到的最近测量 IR 的角误差。
// 双耳渲染的精度 = 虚拟音箱位置 vs HRTF 测量点位置的吻合度。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "apps/web/public/hrtf/hrtf-set.json"), "utf8"));
const { LAYOUTS } = await import(pathToFileURL(path.join(root, "tmp/renderer.bundle.cjs")).href);

const toUnit = (az, el) => {
  const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
  return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
};

console.log(`IR 集：${manifest.positions.length} 个方向 @${manifest.sampleRate}Hz`);
for (const p of manifest.positions) {
  const hasDry = !!p.dry, hasWet = !!p.wet;
  if (!hasDry || !hasWet) console.log(`  ⚠ 缺文件: az${p.azimuth} el${p.elevation}`);
}

let worst = 0;
for (const [id, layout] of Object.entries(LAYOUTS)) {
  const rows = [];
  for (const spk of layout) {
    if (spk.isLfe) { rows.push(`    ${spk.name.padEnd(15)} LFE 直通（不卷积）`); continue; }
    const [tx, ty, tz] = toUnit(spk.azimuth, spk.elevation);
    let best = null, bestDot = -2;
    for (const p of manifest.positions) {
      const [x, y, z] = toUnit(p.azimuth, p.elevation);
      const dot = tx * x + ty * y + tz * z;
      if (dot > bestDot) { bestDot = dot; best = p; }
    }
    const err = (Math.acos(Math.min(1, bestDot)) * 180) / Math.PI;
    worst = Math.max(worst, err);
    rows.push(
      `    ${spk.name.padEnd(15)} (${String(spk.azimuth).padStart(4)}°, el${spk.elevation}°) → az${best.azimuth}_el${best.elevation}  角误差 ${err.toFixed(1)}°${err > 1 ? "  ⚠" : ""}`,
    );
  }
  console.log(`\n${id}:`);
  console.log(rows.join("\n"));
}
console.log(`\n最大角误差 ${worst.toFixed(1)}° — ${worst <= 1 ? "全部音箱精确命中测量点" : "有音箱只能近似"}`);
