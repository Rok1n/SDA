// 注入 AudioContext 构造器补丁 → 刷新 → 播放 → 探测 baseLatency
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

await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    window.__sdaContexts = [];
    const Native = window.AudioContext;
    window.AudioContext = function(options) {
      const ctx = new Native(options);
      window.__sdaContexts.push({ ctx, options });
      return ctx;
    };
    window.AudioContext.prototype = Native.prototype;
  })()`,
});
await send("Page.reload", { ignoreCache: true });
await new Promise((r) => setTimeout(r, 6000));
// 播放
await evaluate(`(() => {
  const buttons = [...document.querySelectorAll("button")];
  const play = buttons.find((b) => /▶|播放/.test(b.textContent));
  if (play) { play.click(); return "clicked"; }
  return "already-playing";
})()`);
await new Promise((r) => setTimeout(r, 4000));
const info = await evaluate(`(() => window.__sdaContexts.map(({ ctx, options }) => ({
  state: ctx.state,
  sampleRate: ctx.sampleRate,
  baseLatency: ctx.baseLatency,
  outputLatency: ctx.outputLatency,
  latencyHint: options?.latencyHint,
  currentTime: +ctx.currentTime.toFixed(2),
})))()`);
console.log(JSON.stringify(info, null, 2));
ws.close();
process.exit(0);
