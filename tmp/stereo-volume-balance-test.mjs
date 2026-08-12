// Stereo mirror routing and layout-volume balance regression.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const bundle = path.join(path.dirname(fileURLToPath(import.meta.url)), "renderer.bundle.cjs");
const { LAYOUTS, layoutLevelCompensationGain, stereoDownmixGains } = await import(pathToFileURL(bundle).href);

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
      `${layoutId}: ${speaker.name} 保持等功率`);
  }
}

const referencePower = LAYOUTS["5.1"].filter((speaker) => !speaker.isLfe).length;
for (const [layoutId, layout] of Object.entries(LAYOUTS)) {
  const channels = layout.filter((speaker) => !speaker.isLfe).length;
  const gain = layoutLevelCompensationGain(layout);
  check(Math.abs(channels * gain ** 2 - referencePower) < 1e-12,
    `${layoutId}: 布局电平补偿将 ${channels} 条非 LFE 总线归一到 5.1 参考功率`);
}
check(layoutLevelCompensationGain(LAYOUTS["5.1"]) === 1, "5.1 参考布局保持 unity");
check(layoutLevelCompensationGain(LAYOUTS["9.1.6"]) < layoutLevelCompensationGain(LAYOUTS["7.1.2"]),
  "总线更多的 9.1.6 获得更大并发功率余量");

console.log(failed ? `\n${failed} 项失败` : "\n立体声镜像路由与布局布局电平补偿通过");
process.exit(failed ? 1 : 0);
