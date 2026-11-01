const fs = require("node:fs/promises");
const path = require("node:path");
const WebSocket = require("ws");

exports.connect = async function connect() {
  const port = (await fs.readFile(path.join(process.env.CODEMESH_EDITOR_PROFILE, "DevToolsActivePort"), "utf8")).split("\n")[0];
  const targets = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
  const target = targets.find((target) => target.type === "page" && target.url.includes("workbench"));
  if (!target) throw new Error("Cannot find native workbench renderer for UI checks");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let sequence = 0;
  const pending = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Native UI request timed out: " + method)); }, 5000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async (expression) => {
    const deadline = Date.now() + 5000;
    while (!await evaluate(expression)) {
      if (Date.now() > deadline) throw new Error("Native UI condition timed out: " + expression + "\n" + await evaluate("document.body.innerText"));
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };
  return {
    evaluate, wait,
    async input(value) {
      await wait("[...document.querySelectorAll('.quick-input-widget input')].some(e => e.offsetWidth > 0)");
      await evaluate("(() => {const e=[...document.querySelectorAll('.quick-input-widget input')].find(e=>e.offsetWidth>0); e.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e," + JSON.stringify(value) + ");e.dispatchEvent(new Event('input',{bubbles:true}));})()");
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    },
    async choose(label) {
      const expression = "(() => {const e=[...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find(e=>e.offsetWidth>0 && e.innerText.replace(/&/g,'').trim()===" + JSON.stringify(label) + ");if(!e)return false;e.click();return true;})()";
      await wait(expression);
    },
    async cancelInput() {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    },
    close() { socket.close(); for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Native UI closed")); } pending.clear(); }
  };
};
