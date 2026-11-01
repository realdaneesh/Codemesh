const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

async function main() {
  const executable = process.env.CODEMESH_VSCODE_PATH;
  assert.ok(executable, "Set CODEMESH_VSCODE_PATH to the installed VS Code executable");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codemesh-editor-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const result = path.join(root, "result.json");
  const suite = process.env.CODEMESH_EDITOR_SUITE ? path.resolve(process.env.CODEMESH_EDITOR_SUITE) : path.join(__dirname, "editor-host.cjs");
  // Extension-test mode suppresses modal prompts. A temporary development extension
  // runs the same suite in a normal workbench so real import dialogs can be tested.
  const harness = path.join(root, "native-harness");
  await fs.mkdir(harness);
  await fs.writeFile(path.join(harness, "package.json"), JSON.stringify({
    name: "codemesh-native-harness", publisher: "codemesh-tests", version: "0.0.1",
    engines: { vscode: "^1.96.0" }, main: "main.cjs", activationEvents: ["onStartupFinished"]
  }));
  await fs.writeFile(path.join(harness, "main.cjs"),
    "const vscode = require('vscode');\n" +
    "exports.activate = async () => {\n" +
    "try { await require(" + JSON.stringify(suite) + ").run(); }\n" +
    "catch(error) { console.error(error); }\n" +
    "finally { for(const document of vscode.workspace.textDocuments.filter(d => d.isDirty)) {\n" +
    "await vscode.window.showTextDocument(document); await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');\n" +
    "} await vscode.commands.executeCommand('workbench.action.closeWindow'); }\n" +
    "};\n");
  const profile = path.join(root, "profile");
  await fs.mkdir(path.join(profile, "User"), { recursive: true });
  await fs.writeFile(path.join(profile, "User", "settings.json"), JSON.stringify({ "window.dialogStyle": "custom", "update.mode": "none" }));
  const env = { ...process.env, CODEMESH_EDITOR_RESULT: result, CODEMESH_EDITOR_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [
    workspace, "--new-window", "--disable-extensions", "--disable-workspace-trust",
    "--skip-welcome", "--skip-release-notes", "--disable-gpu",
    "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profile}`,
    `--extensions-dir=${path.join(root, "extensions")}`,
    `--extensionDevelopmentPath=${path.resolve(__dirname, "..")}`,
    `--extensionDevelopmentPath=${harness}`
  ], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = "";
  const capture = (data) => { diagnostics = (diagnostics + data.toString()).slice(-8000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const timeout = setTimeout(() => child.kill(), 90000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    let report;
    try { report = JSON.parse(await fs.readFile(result, "utf8")); }
    catch (error) { throw new Error("VS Code produced no test report (exit " + code + "): " + diagnostics, { cause: error }); }
    for (const line of report.passed) console.log(`PASS: ${line}`);
    assert.equal(report.error, undefined, report.error);
    assert.equal(code, 0, "VS Code editor test exit code");
  } finally {
    clearTimeout(timeout);
    console.log(`Editor test artifacts: ${root}`);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
