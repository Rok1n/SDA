// 验证播放状态：播放头是否前进、对象数、布局
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
  if (result.result?.exceptionDetails) return `ERR: ${JSON.stringify(result.result.exceptionDetails).slice(0, 200)}`;
  return result.result?.result?.value;
};

const probe = `(() => {
  const text = document.body.innerText.replace(/\\s+/g, " ");
  const timeMatch = text.match(/(\\d{2}:\\d{2})[^\\d]*(\\d{2}:\\d{2})/);
  const buttons = [...document.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 20);
  return { time: timeMatch ? [timeMatch[1], timeMatch[2]] : null, buttons, snippet: text.slice(0, 300) };
})()`;
for (let i = 0; i < 4; i++) {
  console.log(JSON.stringify(await evaluate(probe)));
  await new Promise((r) => setTimeout(r, 2000));
}
ws.close();
process.exit(0);
