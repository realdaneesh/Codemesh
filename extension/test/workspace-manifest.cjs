const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const WebSocket = require("ws");
const { buildWorkspaceManifest } = require("../dist/services/workspaceManifest");
const validation = require("../dist/types/workspaceManifest");
const { parseClientMessage } = require("../../server/dist/websocket/messageValidation");
const { CollaborationServer } = require("../../server/dist/websocket/CollaborationServer");
const { getWorkspaceViewModel } = require("../dist/ui/workspaceViewModel");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for workspace state");
    await pause(5);
  }
}
class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  }
  fire(value) { for (const listener of [...this.listeners]) listener(value); }
  dispose() { this.listeners.clear(); }
}
const commands = new Map();
const documentChanges = new EventEmitter();
const documentCloses = new EventEmitter();
const errors = [];
let folders = [];
let choice;
let choicesOffered;
const vscode = {
  EventEmitter,
  EndOfLine: { LF: 1, CRLF: 2 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  Range: class { constructor(start, end) { this.start = start; this.end = end; } },
  commands: { registerCommand: (name, callback) => { commands.set(name, callback); return { dispose() {} }; } },
  workspace: {
    get workspaceFolders() { return folders; },
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    getWorkspaceFolder: (uri) => folders.find((folder) => uri.fsPath.startsWith(folder.uri.fsPath + path.sep)),
    asRelativePath: (uri) => path.relative(folders.find((folder) => uri.fsPath.startsWith(folder.uri.fsPath + path.sep)).uri.fsPath, uri.fsPath),
    onDidChangeTextDocument: documentChanges.event,
    onDidCloseTextDocument: documentCloses.event
  },
  window: {
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    showInformationMessage() {}, showWarningMessage() {},
    showErrorMessage: (message) => errors.push(message),
    showQuickPick: async (items) => { choicesOffered = items; return items[choice]; }
  }
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  return request === "vscode" ? vscode : originalLoad.call(this, request, parent, isMain);
};
const { CodeMeshClient } = require("../dist/services/CodeMeshClient");
const { registerCommands } = require("../dist/commands/registerCommands");
const { CodeMeshTreeProvider } = require("../dist/providers/CodeMeshTreeProvider");
Module._load = originalLoad;

function folder(fsPath, name) {
  return { name, index: 0, uri: { scheme: "file", fsPath, toString: () => fsPath } };
}
const manifest = (files) => ({ workspaceName: "Project", files });

function boundaries() {
  const validators = [
    validation.validateWorkspaceManifest,
    (value) => parseClientMessage(JSON.stringify({ type: "SHARE_WORKSPACE", roomId: "ABC234", manifest: value })).manifest
  ];
  for (const validate of validators) {
    assert.deepEqual(validate(manifest([{ path: "src\\main.ts", size: 8 }])), manifest([{ path: "src/main.ts", size: 8 }]));
    assert.equal(validate(manifest([{ path: "unix/file.txt", size: 0 }])).files[0].path, "unix/file.txt");
    for (const invalid of ["", "/etc/passwd", "\\root", "C:\\secret", "C:secret", "\\\\host\\share", "../x", "a/../x",
      "a\\..\\x", "./x", "a//x", "a/", "x\0y", "a:b", "file?", "name. ", "NUL.txt"]) {
      assert.throws(() => validate(manifest([{ path: invalid, size: 0 }])), /path/i, invalid);
    }
    for (const paths of [["a/b", "a\\b"], ["A.txt", "a.txt"], ["caf\u00e9.txt", "cafe\u0301.txt"]]) {
      assert.throws(() => validate(manifest(paths.map((path) => ({ path, size: 0 })))), /duplicate/);
    }
    for (const invalid of [".env", "src/.env.local", "cert.pem", "id_ed25519", "node_modules/x", "dist/x", ".git/config", "obj/x", ".yarn/x"]) {
      assert.throws(() => validate(manifest([{ path: invalid, size: 0 }])), /excluded/);
    }
    for (const size of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "2"]) {
      assert.throws(() => validate(manifest([{ path: "ok", size }])), /sizes/);
    }
    assert.throws(() => validate({ ...manifest([]), text: "do not send contents" }), /unsupported/);
    assert.throws(() => validate(manifest([{ path: "ok", size: 1, text: "contents" }])), /only path/);
    assert.equal(validate(manifest(Array.from({ length: validation.MAX_MANIFEST_FILES }, (_, i) => ({ path: "f" + i, size: 0 })))).files.length, 2000);
    assert.throws(() => validate(manifest(Array.from({ length: 2001 }, (_, i) => ({ path: "f" + i, size: 0 })))), /2000-file/);
    assert.throws(() => validate(manifest(Array.from({ length: 1000 }, (_, i) => ({ path: "p".repeat(300) + i, size: 0 })))), /256 KiB/);
  }
  const raw = JSON.stringify({ type: "SHARE_WORKSPACE", roomId: "ABC234", manifest: manifest([]) }) + " ".repeat(validation.MAX_MANIFEST_BYTES);
  assert.throws(() => parseClientMessage(raw), /256 KiB/);
  const refresh = (extra) => JSON.stringify({ type: "SHARE_WORKSPACE", roomId: "ABC234", manifest: manifest([{ path: "src/main.ts", size: 8 }]),
    baseManifestId: "11111111-1111-1111-1111-111111111111", changedPaths: ["src/main.ts"], ...extra });
  assert.deepEqual(parseClientMessage(refresh({ changedPaths: ["src\\main.ts"] })).changedPaths, ["src/main.ts"]);
  for (const changedPaths of [["../escape"], ["C:\\secret"], ["src/main.ts", "src\\main.ts"], "src/main.ts", undefined]) {
    assert.throws(() => parseClientMessage(refresh({ changedPaths })));
  }
  assert.throws(() => parseClientMessage(refresh({ baseManifestId: "invalid" })), /refresh manifest/);
  assert.throws(() => parseClientMessage(refresh({ changedPaths: Array.from({ length: 2001 }, (_, i) => "f" + i) })), /file limit/);
  assert.throws(() => parseClientMessage(refresh({ changedPaths: Array.from({ length: 1000 }, (_, i) => "p".repeat(300) + i) })), /256 KiB/);
  for (const validate of [validation.validateWorkspaceChanges, require("../../server/dist/types/workspaceManifest").validateWorkspaceChanges]) {
    assert.deepEqual(validate({ added: ["src\\new.ts"], changed: [], removed: ["old.ts"] }), { added: ["src/new.ts"], changed: [], removed: ["old.ts"] });
    assert.throws(() => validate({ added: ["../escape"], changed: [], removed: [] }), /path/);
    assert.throws(() => validate({ added: ["same"], changed: ["same"], removed: [] }), /Duplicate/);
    assert.throws(() => validate({ added: [], changed: [], removed: [], text: "contents" }), /Unsupported/);
  }
  console.log("PASS: refresh base identity, changed-path normalization/traversal/duplicates, count/message bounds and change-summary validation");
  console.log("PASS: client/server Windows and Unix paths, traversal, invalid paths, duplicate normalization, sizes, excluded entries, count and message limits");
}

async function scanner(root) {
  const workspace = path.join(root, "filtered");
  await fs.mkdir(workspace);
  const fixtures = {
    ".gitignore": "*.tmp\nignored/\n!ignored/keep.txt\n!node_modules/keep.txt\n!dist/keep.txt\n!.env\n",
    "src/.gitignore": "!keep.tmp\nlocal.txt\n",
    "src/keep.tmp": "kept", "src/drop.tmp": "ignored", "src/local.txt": "ignored",
    "src/main.ts": "hello", "readme.md": "notes", "assets/image.bin": Buffer.from([0, 255]),
    "ignored/keep.txt": "ignored parent", ".git/config": "private", "node_modules/keep.txt": "dependency",
    "vendor/dep": "dependency", "dist/keep.txt": "build", "src/build/out": "build",
    ".env": "SECRET=private", ".env.production": "private", "src/local.env": "private",
    "cert.pem": "private", "id_rsa": "private", "keys/private-key.key": "private"
  };
  for (const [file, text] of Object.entries(fixtures)) {
    await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await fs.writeFile(path.join(workspace, file), text);
  }
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "outside-secret.txt"), "never traverse");
  await fs.symlink(outside, path.join(workspace, "external-link"), process.platform === "win32" ? "junction" : "dir");
  await fs.symlink(path.join(workspace, "src"), path.join(workspace, "internal-link"), process.platform === "win32" ? "junction" : "dir");
  const result = await buildWorkspaceManifest(workspace, "Filtered");
  assert.deepEqual(result.files.map((file) => file.path).sort(), [".gitignore", "assets/image.bin", "readme.md", "src/.gitignore", "src/keep.tmp", "src/main.ts"]);
  for (const file of result.files) {
    assert.equal(file.size, (await fs.stat(path.join(workspace, file.path))).size);
    assert.deepEqual(Object.keys(file).sort(), ["path", "size"]);
  }
  assert.ok(!JSON.stringify(result).includes("SECRET"));
  const limitRoot = path.join(root, "count-limit");
  await fs.mkdir(limitRoot);
  for (let start = 0; start < 2001; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, 2001 - start) }, (_, i) => fs.writeFile(path.join(limitRoot, "f" + (start + i)), "")));
  }
  await assert.rejects(buildWorkspaceManifest(limitRoot, "TooMany"), /2000-file/);
  const bytesRoot = path.join(root, "byte-limit");
  await fs.mkdir(bytesRoot);
  // Use directory depth rather than invalid long filenames to hit the payload limit.
  const longDir = path.join(bytesRoot, "a".repeat(180), "b".repeat(180));
  await fs.mkdir(longDir, { recursive: true });
  for (let start = 0; start < 800; start += 100) {
    await Promise.all(Array.from({ length: 100 }, (_, i) => fs.writeFile(path.join(longDir, "f" + (start + i)), "")));
  }
  await assert.rejects(buildWorkspaceManifest(bytesRoot, "TooLarge"), /256 KiB/);
  const repository = path.join(root, "repository");
  const subdirectory = path.join(repository, "packages", "app");
  await fs.mkdir(path.join(repository, ".git"), { recursive: true });
  await fs.mkdir(subdirectory, { recursive: true });
  await fs.writeFile(path.join(repository, ".gitignore"), "*.private\npackages/blocked/\n");
  await fs.writeFile(path.join(subdirectory, "local.private"), "ignored by repository root");
  await fs.writeFile(path.join(subdirectory, "source.ts"), "included");
  assert.deepEqual((await buildWorkspaceManifest(subdirectory, "App")).files, [{ path: "source.ts", size: 8 }]);
  const blocked = path.join(repository, "packages", "blocked");
  await fs.mkdir(blocked);
  await fs.writeFile(path.join(blocked, ".gitignore"), "!source.ts\n");
  await fs.writeFile(path.join(blocked, "source.ts"), "still ignored parent");
  assert.deepEqual((await buildWorkspaceManifest(blocked, "Blocked")).files, []);
  console.log("PASS: scanner nested gitignore/negation, mandatory exclusions, disk sizes only, external/internal symlinks skipped, scan count and payload limits");
  return workspace;
}

async function clientFlow(root, workspace) {
  const second = path.join(root, "selected");
  await fs.mkdir(second);
  await fs.writeFile(path.join(second, "selected.txt"), "selected only");
  folders = [folder(workspace, "First"), folder(second, "Selected")];
  const server = new CollaborationServer(0);
  server.start();
  await new Promise((resolve) => server.server.once("listening", resolve));
  const received = [];
  server.server.on("connection", (socket) => socket.on("message", (raw) => received.push(JSON.parse(raw.toString()))));
  const client = new CodeMeshClient({ serverUrl: "ws://127.0.0.1:" + server.server.address().port, self: { memberId: "client", displayName: "Client" } });
  const context = { subscriptions: [] };
  const tree = new CodeMeshTreeProvider(client);
  registerCommands(context, client);
  try {
    await client.createRoom();
    await waitFor(() => client.getState().roomId);
    await pause(30);
    assert.equal(server.workspaces.size, 0, "room creation never scans or publishes files");
    assert.equal(received.filter((message) => message.type === "SHARE_WORKSPACE").length, 0);
    choice = undefined;
    await commands.get("codemesh.shareWorkspace")();
    assert.equal(server.workspaces.size, 0, "cancelled selection shares nothing");
    choice = 1;
    await commands.get("codemesh.shareWorkspace")();
    assert.equal(choicesOffered.length, 2);
    await waitFor(() => client.getState().ownsWorkspaceManifest);
    const state = client.getState();
    assert.equal(state.workspaceManifest.workspaceName, "Selected");
    assert.deepEqual(state.workspaceManifest.files, [{ path: "selected.txt", size: 13 }]);
    assert.deepEqual(getWorkspaceViewModel(state), { label: "Selected", summary: "1 files, 13 bytes (yours)" });
    const nodes = tree.getChildren();
    assert.equal(nodes.find((node) => node.label === "Workspace").description, "Selected");
    assert.match(nodes.find((node) => node.label === "Manifest").description, /13 bytes/);
    assert.ok(!JSON.stringify(received.find((message) => message.type === "SHARE_WORKSPACE")).includes(second));
    state.workspaceManifest.files[0].path = "mutated";
    assert.equal(client.getState().workspaceManifest.files[0].path, "selected.txt");
    const inbound = { type: "WORKSPACE_MANIFEST", roomId: client.getState().roomId, ownedByYou: true, manifest: manifest([{ path: "a/b", size: 0 }, { path: "a\\b", size: 0 }]) };
    client.handleServerMessage(JSON.stringify(inbound));
    assert.match(errors.pop(), /duplicate/);
    client.handleServerMessage(JSON.stringify({ ...inbound, manifest: manifest([]) }) + " ".repeat(validation.MAX_MANIFEST_BYTES));
    assert.match(errors.pop(), /256 KiB/);
    assert.equal(client.getState().workspaceManifest.files[0].path, "selected.txt", "invalid incoming manifest cannot replace accepted state");
    const sends = received.length;
    assert.throws(() => client.publishWorkspaceManifest(manifest([{ path: "../escape", size: 0 }])), /path/);
    assert.throws(() => client.publishWorkspaceManifest(manifest([{ path: "a/b", size: 0 }, { path: "a\\b", size: 0 }])), /duplicate/);
    await assert.rejects(client.shareWorkspace(folder(root, "Outside")), /open VS Code/);
    await pause(30);
    assert.equal(received.length, sends, "invalid client manifest never reaches wire");
    const uri = { fsPath: path.join(second, "selected.txt"), toString: () => "file:///selected/selected.txt" };
    const document = { uri, text: "selected only", eol: 1, getText() { return this.text; }, positionAt: (offset) => ({ offset }) };
    await client.collaborateDocument(document);
    await waitFor(() => client.getState().documentStatus === "shared");
    // Exercise a server-side rejection while an independent document session is active.
    client.send({ type: "SHARE_WORKSPACE", roomId: client.getState().roomId, manifest: manifest([{ path: "../invalid", size: 0 }]) });
    await waitFor(() => errors.length === 1);
    assert.match(errors[0], /workspace/i);
    assert.equal(client.getState().sharedDocumentPath, "selected.txt");
    document.text = "still live";
    documentChanges.fire({ document, contentChanges: [{ text: "still live" }] });
    await waitFor(() => !client.documentEditInFlight);
    assert.ok(received.some((message) => message.type === "DOCUMENT_EDIT" && message.text === "still live"));
    errors.length = 0;
    await commands.get("codemesh.endSharing")();
    assert.equal(server.workspaces.size, 1, "ending a document must preserve the separate workspace publication");
    commands.get("codemesh.endWorkspaceSharing")();
    await waitFor(() => server.workspaces.size === 0);
    assert.equal(client.getState().workspaceManifest, undefined);
    folders = [folders[1]];
    await commands.get("codemesh.shareWorkspace")();
    await waitFor(() => client.getState().ownsWorkspaceManifest);
    client.leaveRoom();
    await waitFor(() => server.workspaces.size === 0);
    assert.equal(client.getState().workspaceManifest, undefined);
    assert.equal(getWorkspaceViewModel(client.getState()).label, "Not shared");
    await client.createRoom();
    await waitFor(() => client.getState().roomId);
    const scan = client.shareWorkspace(folders[0]);
    client.leaveRoom();
    await assert.rejects(scan, /cancelled/);
    assert.equal(server.workspaces.size, 0, "late scanner cannot publish after leave");
    await client.createRoom();
    await waitFor(() => client.getState().roomId);
    await client.shareWorkspace(folders[0]);
    await waitFor(() => client.getState().ownsWorkspaceManifest);
    client.dispose();
    await waitFor(() => server.workspaces.size === 0);
    assert.equal(client.getState().workspaceManifest, undefined);
    assert.deepEqual(errors, []);
    console.log("PASS: opt-in command, multiple-folder choice/cancel, selected workspace UI, client boundary, end/leave/dispose and cancelled-scan cleanup");
  } finally {
    client.dispose(); tree.dispose();
    for (const socket of server.server.clients) socket.terminate();
    await new Promise((resolve) => server.server.close(resolve));
  }
}

async function main() {
  boundaries();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codemesh-manifest-"));
  const workspace = await scanner(root);
  await clientFlow(root, workspace);
  console.log("PASS: extension workspace manifest");
  console.log("Manifest fixtures: " + root);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
