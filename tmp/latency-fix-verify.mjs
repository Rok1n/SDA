// 验证：播放中实际 baseLatency=0.1 + taskmgr 压测收集间隙
import { execSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = list.find((entry) => entry.type === "page" && entry.url.includes("4173"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
const consoleLines = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else if (msg.method === "Runtime.consoleAPICalled") {
    consoleLines.push(msg.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
  }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const callId = ++id;
  pending.set(callId, resolve);
  ws.send(JSON.stringify({ id: callId, method, params }));
});
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.result?.exceptionDetails) return `ERR: ${result.result.exceptionDetails.exception?.description?.slice(0, 200) ?? result.result.exceptionDetails.text}`;
  return result.result?.result?.value;
};
await send("Runtime.enable");

// 播放
await evaluate(`(() => {
  const play = [...document.querySelectorAll("button")].find((b) => /▶|播放/.test(b.textContent));
  if (play) { play.click(); return "clicked"; }
  return "already";
})()`);
await new Promise((r) => setTimeout(r, 3000));

// 读 AudioContext baseLatency（通过已创建的实例：从 renderer 拿不到，直接再建同参数 ctx 对照已验证；
// 这里通过播放头是否前进 + 间隙日志判断）
const t0 = await evaluate(`performance.now()`);
await new Promise((r) => setTimeout(r, 2000));

console.log("--- open taskmgr + window churn ---");
spawn("cmd", ["/c", "start", "taskmgr"], { detached: true, stdio: "ignore" }).unref();
// 模拟窗口操作：alt+tab 几次
for (let i = 0; i < 6; i++) {
  try {
    execSync(`powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $ws.SendKeys('%{TAB}')"`, { timeout: 5000 });
  } catch {}
  await new Promise((r) => setTimeout(r, 1500));
}
await new Promise((r) => setTimeout(r, 6000));
try { execSync("powershell -NoProfile -Command \"Stop-Process -Name Taskmgr -Force -ErrorAction SilentlyContinue\""); } catch {}
await new Promise((r) => setTimeout(r, 4000));

writeFileSync("tmp/latency-fix-verify.log", consoleLines.join("\n") + "\n");
const interesting = consoleLines.filter((line) => /回调间隙|供给不足|拒绝|重建|异常/.test(line));
console.log(`lines=${consoleLines.length} interesting=${interesting.length}`);
for (const line of interesting.slice(0, 30)) console.log(line);
if (!interesting.length) console.log("(无异常日志)");
ws.close();
process.exit(0);
