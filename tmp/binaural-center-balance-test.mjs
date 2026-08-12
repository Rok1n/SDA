// Centre-direction binaural calibration regression using shipped KU100 assets.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "tmp", "renderer.bundle.cjs");
const { mixIrForMode } = await import(pathToFileURL(bundle).href);
const directory = path.join(root, "apps", "web", "public", "hrtf");
const manifest = JSON.parse(readFileSync(path.join(directory, "hrtf-set.json"), "utf8"));
const entry = manifest.positions.find((position) => position.azimuth === 0 && position.elevation === 0);
const readF32 = (file) => {
  const data = readFileSync(path.join(directory, file));
  return new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
};
const raw = {
  azimuth: 0,
  elevation: 0,
  dry: readF32(entry.dry),
  wet: readF32(entry.wet),
};
raw.dryLen = raw.dry.length >> 1;
raw.wetLen = raw.wet.length >> 1;
const context = {
  sampleRate: manifest.sampleRate,
  createBuffer(channels, length) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { copyToChannel(values, channel) { data[channel].set(values); }, getChannelData(channel) { return data[channel]; } };
  },
};
const rms = (values) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);

let failed = 0;
function check(condition, text) { if (!condition) failed++; console.log(`${condition ? "PASS" : "FAIL"}  ${text}`); }
for (const mode of ["near", "mid", "far"]) {
  const buffer = mixIrForMode(context, { sampleRate: manifest.sampleRate, positions: [raw] }, raw, mode);
  const ild = 20 * Math.log10(rms(buffer.getChannelData(0)) / rms(buffer.getChannelData(1)));
  check(Math.abs(ild) <= 0.05, `${mode}: 正中虚拟音箱 ILD ${ild.toFixed(3)}dB`);
}

console.log(failed ? `\n${failed} 项失败` : "\n正中 KU100 IR 双耳电平校准通过");
process.exit(failed ? 1 : 0);
