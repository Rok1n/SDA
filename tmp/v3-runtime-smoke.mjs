// v3 资产运行时冒烟：播放 → 切布局 → 收集异常
const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = list.find((entry) => entry.type === "page" && entry.url.includes("4173"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else if (msg.method === "Runtime.consoleAPICalled") {
    const text = msg.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
    if (/error|Error|失败|异常|warn/i.test(text) && !/deprecated|Security Warning/.test(text)) errors.push(text);
  }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const callId = ++id;
  pending.set(callId, resolve);
  ws.send(JSON.stringify({ id: callId, method, params }));
});
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return result.result?.exceptionDetails ? `ERR ${result.result.exceptionDetails.text}` : result.result?.result?.value;
};
await send("Runtime.enable");
// 播放
await evaluate(`(() => {
  const play = [...document.querySelectorAll("button")].find((b) => /▶|播放/.test(b.textContent));
  if (play) { play.click(); return "clicked"; }
  return "already";
})()`);
await new Promise((r) => setTimeout(r, 3000));
// 依次切换布局
for (const layout of ["Dolby 5.1.4", "Dolby 7.1.4", "Dolby 9.1.4", "Dolby 9.1.6", "自动"]) {
  const result = await evaluate(`(() => {
    const select = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.textContent.includes("Dolby 5.1.4")));
    if (!select) return "no-select";
    const option = [...select.options].find((o) => o.textContent.includes(${JSON.stringify(layout)}));
    if (!option) return "no-option";
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return "switched-" + option.textContent;
  })()`);
  console.log(result);
  await new Promise((r) => setTimeout(r, 2500));
}
// 播放头前进确认
const playing = await evaluate(`document.body.innerText.includes("❚❚")`);
console.log("播放中:", playing);
console.log("异常数:", errors.length);
for (const line of errors.slice(0, 10)) console.log("ERR:", line);
ws.close();
process.exit(0);
