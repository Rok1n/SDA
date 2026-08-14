// 音量平衡开关端到端验证：播放 KiLLKiSS → 开/关开关 → 码流面板响度行 + 无异常
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
    if (/error|失败|异常/i.test(text) && !/Security Warning/.test(text)) errors.push(text);
  }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const callId = ++id;
  pending.set(callId, resolve);
  ws.send(JSON.stringify({ id: callId, method, params }));
});
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return result.result?.exceptionDetails ? `ERR ${JSON.stringify(result.result.exceptionDetails).slice(0, 200)}` : result.result?.result?.value;
};
await send("Runtime.enable");
await evaluate(`(() => {
  const play = [...document.querySelectorAll("button")].find((b) => /▶|播放/.test(b.textContent));
  if (play) { play.click(); return "clicked"; }
  return "already";
})()`);
await new Promise((r) => setTimeout(r, 3000));
// 打开码流面板读响度行
await evaluate(`(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "码流");
  btn?.click();
})()`);
await new Promise((r) => setTimeout(r, 800));
const loudnessOff = await evaluate(`(() => {
  const dts = [...document.querySelectorAll("dt")];
  const dt = dts.find((d) => d.textContent === "响度");
  return dt ? dt.nextElementSibling.textContent : "未找到";
})()`);
console.log("平衡关:", loudnessOff);
// 打开设置 → 开音量平衡
await evaluate(`(() => {
  const gear = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("⚙"));
  gear?.click();
})()`);
await new Promise((r) => setTimeout(r, 500));
await evaluate(`(() => {
  const label = [...document.querySelectorAll("label")].find((l) => l.textContent.includes("音量平衡"));
  const input = label?.querySelector("input");
  if (input && !input.checked) input.click();
})()`);
await new Promise((r) => setTimeout(r, 1500));
await evaluate(`(() => {
  const close = document.querySelector(".settings-close");
  close?.click();
})()`);
await new Promise((r) => setTimeout(r, 800));
const loudnessOn = await evaluate(`(() => {
  const dt = [...document.querySelectorAll("dt")].find((d) => d.textContent === "响度");
  return dt ? dt.nextElementSibling.textContent : "未找到";
})()`);
console.log("平衡开:", loudnessOn);
// 切立体声模式确认同样覆盖
await evaluate(`(() => {
  const stereo = [...document.querySelectorAll("input[type=radio], button")].find((el) => el.textContent === "立体声");
  stereo?.click();
})()`);
await new Promise((r) => setTimeout(r, 2500));
const stereoLoudness = await evaluate(`(() => {
  const dt = [...document.querySelectorAll("dt")].find((d) => d.textContent === "响度");
  return dt ? dt.nextElementSibling.textContent : "未找到";
})()`);
console.log("立体声+平衡开:", stereoLoudness);
console.log("异常数:", errors.length);
for (const line of errors.slice(0, 8)) console.log("ERR:", line);
ws.close();
process.exit(0);
