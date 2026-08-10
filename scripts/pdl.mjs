// Parallel ranged download: splits the file into N chunks, downloads each
// with its own connection (Zenodo throttles per-connection to ~20KB/s from
// some networks), retries each chunk until done, then concatenates.
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [url, out, partsArg] = process.argv.slice(2);
const PARTS = Number(partsArg || 12);
if (!url || !out) {
  console.error("用法: node scripts/pdl.mjs <url> <out> [parts=12]");
  process.exit(1);
}

const head = await fetch(url, { method: "HEAD", redirect: "follow" });
const total = Number(head.headers.get("content-length"));
if (!total) throw new Error("拿不到 content-length");
console.log(`总大小 ${(total / 1048576).toFixed(1)} MB，分 ${PARTS} 段并行下载`);

const dir = `${out}.parts`;
mkdirSync(dir, { recursive: true });
const bounds = [];
const chunk = Math.ceil(total / PARTS);
for (let i = 0; i < PARTS; i++) {
  const start = i * chunk;
  const end = Math.min(total - 1, start + chunk - 1);
  if (start <= end) bounds.push([start, end]);
}

async function dlPart(i) {
  const [start, end] = bounds[i];
  const fp = join(dir, String(i));
  const want = end - start + 1;
  for (let attempt = 0; attempt < 30; attempt++) {
    const have = existsSync(fp) ? statSync(fp).size : 0;
    if (have === want) return;
    if (have > want) unlinkSync(fp);
    const from = start + (have > want ? 0 : have);
    try {
      const res = await fetch(url, { headers: { range: `bytes=${from}-${end}` } });
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      const ws = createWriteStream(fp, { flags: have > 0 && have <= want ? "a" : "w" });
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!ws.write(value)) await new Promise((r) => ws.once("drain", r));
      }
      await new Promise((r) => ws.end(r));
    } catch {
      await new Promise((r) => setTimeout(r, 1000 + attempt * 500));
    }
  }
  if (!existsSync(fp) || statSync(fp).size !== want) throw new Error(`分段 ${i} 下载失败`);
}

let done = 0;
const progress = setInterval(() => {
  let got = 0;
  for (let i = 0; i < bounds.length; i++) {
    const fp = join(dir, String(i));
    if (existsSync(fp)) got += statSync(fp).size;
  }
  console.log(`${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB (${((got / total) * 100).toFixed(0)}%)`);
}, 5000);

await Promise.all(bounds.map((_, i) => dlPart(i).then(() => done++)));
clearInterval(progress);

const ws = createWriteStream(out);
for (let i = 0; i < bounds.length; i++) {
  ws.write(readFileSync(join(dir, String(i))));
  unlinkSync(join(dir, String(i)));
}
await new Promise((r) => ws.end(r));
if (statSync(out).size !== total) throw new Error("拼接后大小不对");
console.log(`完成 → ${out} (${(total / 1048576).toFixed(1)} MB)`);
