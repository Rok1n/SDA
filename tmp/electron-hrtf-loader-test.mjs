// Electron bundled-HRTF loader regression. Manual and automatic layouts must
// resolve the same 17-direction asset set without file:// fetch fallback.
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "apps/web/public");
const bundle = path.join(root, "tmp/renderer.bundle.cjs");
const { getBinauralIrSet, setBinauralAssetLoader } = await import(pathToFileURL(bundle).href);

const loaded = [];
let fetches = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  fetches++;
  throw new Error("Electron bundled loader must not call fetch");
};
setBinauralAssetLoader(async (assetPath) => {
  loaded.push(assetPath);
  const bytes = await readFile(path.join(directory, ...assetPath.split("/")));
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
});

let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}
try {
  const set = await getBinauralIrSet("file:///ignored/hrtf");
  check(set.sampleRate === 48000 && set.positions.length === 17,
    "Electron loader读取完整17方向48kHz HRTF集合");
  check(loaded[0] === "hrtf/hrtf-set.json", "manifest通过受限hrtf资产路径读取");
  check(loaded.filter((assetPath) => assetPath.endsWith(".f32")).length === 34,
    "全部34个dry/wet IR通过同一IPC loader读取");
  check(fetches === 0, "Electron路径零fetch，不会回退浏览器HRTF");
  check(set.positions.every((position) => position.dry.length === position.dryLen * 2
    && position.wet.length === position.wetLen * 2),
  "所有双耳IR左右数据长度完整");
} finally {
  setBinauralAssetLoader(null);
  globalThis.fetch = originalFetch;
}

console.log(failed ? `\n${failed} 项失败` : "\nElectron内置HRTF加载通过");
process.exit(failed ? 1 : 0);
