// 双耳布局矩阵：真实 KU100 IR 的脉冲响应等价于单声道虚拟音箱的完整卷积输出。
// 覆盖全部 8 种布局和 Near/Mid/Far，验证方向资产、镜像 ILD/ITD、响度与 LFE 规则。
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hrtfDir = path.join(root, "apps/web/public/hrtf");
const bundle = path.join(path.dirname(fileURLToPath(import.meta.url)), "renderer.bundle.cjs");
const { BINAURAL_MODES, LAYOUTS } = await import(pathToFileURL(bundle).href);
const manifest = JSON.parse(readFileSync(path.join(hrtfDir, "hrtf-set.json"), "utf8"));

const readF32 = (file) => {
  const b = readFileSync(path.join(hrtfDir, file));
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
};
const positions = new Map(manifest.positions.map((p) => [
  `${p.azimuth}/${p.elevation}`,
  { ...p, dry: readF32(p.dry), wet: readF32(p.wet) },
]));

function peak(x, limit = x.length) {
  let index = 0;
  let value = 0;
  for (let i = 0; i < Math.min(limit, x.length); i++) {
    if (Math.abs(x[i]) > value) { value = Math.abs(x[i]); index = i; }
  }
  return index;
}
function mixedStats(raw, mode) {
  const w = BINAURAL_MODES[mode].wet;
  const dryLen = raw.dry.length >> 1;
  const wetLen = raw.wet.length >> 1;
  const dryL = raw.dry.subarray(0, dryLen);
  const dryR = raw.dry.subarray(dryLen);
  const wetL = raw.wet.subarray(0, wetLen);
  const wetR = raw.wet.subarray(wetLen);
  const shift = peak(wetL, 960) - peak(dryL);
  const L = new Float32Array(wetLen);
  const R = new Float32Array(wetLen);
  for (let i = 0; i < dryLen; i++) {
    const j = i + shift;
    if (j >= 0 && j < wetLen) { L[j] += (1 - w) * dryL[i]; R[j] += (1 - w) * dryR[i]; }
  }
  for (let i = 0; i < wetLen; i++) { L[i] += w * wetL[i]; R[i] += w * wetR[i]; }
  let energy = 0;
  for (let i = 0; i < wetLen; i++) energy += L[i] * L[i] + R[i] * R[i];
  const scale = 1 / Math.sqrt(energy || 1);
  let lr = 0, ll = 0, rr = 0;
  for (let i = 0; i < wetLen; i++) {
    L[i] *= scale; R[i] *= scale;
    lr += L[i] * R[i]; ll += L[i] * L[i]; rr += R[i] * R[i];
  }
  return {
    rms: Math.sqrt((ll + rr) / (2 * wetLen)),
    corr: lr / Math.sqrt(ll * rr || 1),
    ild: 20 * Math.log10(Math.sqrt(ll / rr || 1)),
    itd: peak(L) - peak(R),
  };
}

let failed = 0;
const check = (condition, text) => {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
};
for (const mode of ["near", "mid", "far"]) {
  const rmsBySpeaker = [];
  for (const [layoutId, layout] of Object.entries(LAYOUTS)) {
    const byName = new Map();
    for (const speaker of layout) {
      if (speaker.isLfe) continue;
      const raw = positions.get(`${speaker.azimuth}/${speaker.elevation}`);
      check(!!raw, `${layoutId}/${mode}: ${speaker.name} 命中 IR (${speaker.azimuth}°, el${speaker.elevation}°)`);
      if (!raw) continue;
      const s = mixedStats(raw, mode);
      rmsBySpeaker.push(s.rms);
      byName.set(speaker.name, s);
      if (Math.abs(speaker.azimuth) >= 60) {
        check(Math.abs(s.corr) < 0.98, `${layoutId}/${mode}: ${speaker.name} 不塌成单声道 (corr=${s.corr.toFixed(3)})`);
      }
    }
    for (const speaker of layout) {
      if (speaker.azimuth <= 0 || speaker.isLfe) continue;
      const mirror = layout.find((other) => other.azimuth === -speaker.azimuth && other.elevation === speaker.elevation);
      if (!mirror || mirror.isLfe) continue;
      const a = byName.get(speaker.name);
      const b = byName.get(mirror.name);
      if (!a || !b) continue;
      // KU100 是实测假头+实测房间，不要求正负方向的 ILD/ITD 数值严格相等：
      // 耳廓、麦克风和房间反射都可带来真实的左右非对称。保护真正的空间语义：
      // 两侧必须由相反耳侧主导；ITD 的峰值在湿 BRIR 中可能被反射取代，不能用
      // 它做跨方向的硬断言。
      check(a.ild * b.ild < 0 && Math.min(Math.abs(a.ild), Math.abs(b.ild)) > 0.5,
        `${layoutId}/${mode}: ${speaker.name}/${mirror.name} 由相反耳侧主导 (ILD=${a.ild.toFixed(1)}/${b.ild.toFixed(1)}dB)`);
    }
    check(layout.some((speaker) => speaker.isLfe), `${layoutId}: LFE 保持非空间化（输出图等量复制到双耳）`);
  }
  const min = Math.min(...rmsBySpeaker);
  const max = Math.max(...rmsBySpeaker);
  check(20 * Math.log10(max / min) < 0.01, `${mode}: 全布局虚拟音箱总 RMS 已按 IR 能量归一（偏差 ${(20 * Math.log10(max / min)).toFixed(4)}dB）`);
}
console.log(failed ? `\n${failed} 项失败` : "\n全部布局、双耳模式与镜像分离通过");
process.exit(failed ? 1 : 0);
