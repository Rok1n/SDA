// Dump object event positions from demo-joc.ec3 (ground truth from the decoder).
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const core = await import(pathToFileURL(join(here, "../pkg-node/sda_core.js")).href);
const data = readFileSync(join(here, "../../../apps/web/public/demo-joc.ec3"));

const dec = new core.SdaDecoder("eac3");
dec.push(data);

const track = new Map(); // id -> {n, min:[3], max:[3], first, last, gains:Set}
let frames = 0;
let labels = null;
while (true) {
  const frame = dec.nextFrame();
  if (!frame) break;
  frames++;
  labels ??= frame.labels;
  const events = JSON.parse(frame.eventsJson);
  for (const ev of events) {
    let t = track.get(ev.id);
    if (!t) {
      t = { n: 0, min: [9, 9, 9], max: [-9, -9, -9], first: ev.pos, last: ev.pos, gains: new Set() };
      track.set(ev.id, t);
    }
    t.n++;
    t.last = ev.pos;
    t.gains.add(ev.gainDb);
    for (let i = 0; i < 3; i++) {
      t.min[i] = Math.min(t.min[i], ev.pos[i]);
      t.max[i] = Math.max(t.max[i], ev.pos[i]);
    }
  }
}

console.log(`frames=${frames} labels=[${(labels || []).join(",")}]`);
console.log(`objects=${track.size}\n`);
const f = (v) => v.map((x) => x.toFixed(2)).join(",");
for (const [id, t] of [...track.entries()].sort((a, b) => a[0] - b[0])) {
  const moves = t.min.some((v, i) => Math.abs(t.max[i] - v) > 0.01);
  console.log(
    `#${id} events=${t.n} ${moves ? "移动" : "静止"} first=(${f(t.first)}) last=(${f(t.last)}) ` +
      `x∈[${t.min[0].toFixed(2)},${t.max[0].toFixed(2)}] y∈[${t.min[1].toFixed(2)},${t.max[1].toFixed(2)}] z∈[${t.min[2].toFixed(2)},${t.max[2].toFixed(2)}] gains=[${[...t.gains].join(",")}]`,
  );
}
