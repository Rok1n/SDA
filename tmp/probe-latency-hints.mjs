// 直接测量不同 latencyHint 下 Chromium 给的输出缓冲
const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = list.find((entry) => entry.type === "page" && entry.url.includes("4173"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const callId = ++id;
  pending.set(callId, resolve);
  ws.send(JSON.stringify({ id: callId, method, params }));
});
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.result?.exceptionDetails) return `ERR: ${result.result.exceptionDetails.exception?.description?.slice(0, 300) ?? result.result.exceptionDetails.text}`;
  return result.result?.result?.value;
};
const info = await evaluate(`(async () => {
  const results = [];
  for (const hint of ["interactive", "balanced", "playback", 0.02, 0.05, 0.1]) {
    try {
      const ctx = new AudioContext({ latencyHint: hint });
      await ctx.resume();
      results.push({ hint, sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency, state: ctx.state });
      await ctx.close();
    } catch (error) {
      results.push({ hint, error: String(error).slice(0, 120) });
    }
  }
  return results;
})()`);
console.log(JSON.stringify(info, null, 2));
ws.close();
process.exit(0);
