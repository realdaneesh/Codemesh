const path = require("node:path");
const { spawn } = require("node:child_process");
const runner = path.resolve(__dirname, "../../../extension/test/run-editor-tests.cjs");
const child = spawn(process.execPath, [runner], {
  env: { ...process.env, CODEMESH_EDITOR_SUITE: path.join(__dirname, "editor-host.cjs") },
  windowsHide: true, stdio: "inherit"
});
child.once("error", (error) => { console.error(error); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
