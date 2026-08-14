// 播放中打开任务管理器，收集回调间隙/供给不足日志
import { execSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = list.find((entry) => entry.type === "page" && entry.url.includes("4173"));
if (!page) throw new Error("no page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let id = 0;
const pending = new Map();
const consoleLines = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === "Runtime.consoleAPICalled") {
    const text = msg.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
    consoleLines.push(`[${msg.params.type}] ${text}`);
  } else if (msg.method === "Log.entryAdded") {
    consoleLines.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text}`);
  }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const callId = ++id;
  pending.set(callId, resolve);
  ws.send(JSON.stringify({ id: callId, method, params }));
});
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return result.result?.result?.value;
};

await send("Runtime.enable");
await send("Log.enable");

// 等播放器加载完成
for (let i = 0; i < 30; i++) {
  const state = await evaluate(`document.querySelector("audio") ? "audio" : (document.body.innerText.includes("00:") ? "loaded" : "waiting")`);
  if (state !== "waiting") break;
  await new Promise((r) => setTimeout(r, 1000));
}
// 点击播放（若未自动播放）
const playState = await evaluate(`(() => {
  const buttons = [...document.querySelectorAll("button")];
  const play = buttons.find((b) => /播放|▶|Play/i.test(b.textContent + b.title + b.getAttribute("aria-label")));
  if (play) { play.click(); return "clicked"; }
  return "no-play-button";
})()`);
console.log("play:", playState);
await new Promise((r) => setTimeout(r, 5000));

// 基线 5s 后打开任务管理器
console.log("--- baseline done, starting taskmgr ---");
const taskmgr = spawn("cmd", ["/c", "start", "taskmgr"], { detached: true, stdio: "ignore" });
taskmgr.unref();
// 任务管理器保持打开 20s，期间多次读取健康状态
const healthSnapshots = [];
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const snap = await evaluate(`(() => {
    const el = document.querySelector("[class*=health], [class*=status]");
    return el ? el.textContent : null;
  })()`);
  healthSnapshots.push(snap);
}
try { execSync("powershell -NoProfile -Command \"Stop-Process -Name Taskmgr -Force -ErrorAction SilentlyContinue\""); } catch {}
console.log("--- taskmgr closed, trailing 5s ---");
await new Promise((r) => setTimeout(r, 5000));

writeFileSync("tmp/taskmgr-repro-console.log", consoleLines.join("\n") + "\n");
const interesting = consoleLines.filter((line) => /回调间隙|供给不足|健康|glitch|underrun|health|gap/i.test(line));
console.log(`console lines: ${consoleLines.length}, interesting: ${interesting.length}`);
for (const line of interesting.slice(0, 40)) console.log(line);
if (interesting.length === 0) console.log("(无回调间隙/供给不足记录)");
ws.close();
process.exit(0);
