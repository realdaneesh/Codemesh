const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const WebSocket = require("ws");
const { CollaborationServer } = require("../../server/dist/websocket/CollaborationServer");
const { buildWorkspacePublication } = require("../dist/services/workspaceManifest");
const { readPublishedText } = require("../dist/services/fileContent");
const { MAX_FILE_BYTES } = require("../dist/types/fileTransfer");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for file-transfer state");
    await pause(5);
  }
}
class EventEmitter {
  constructor() { this.listeners = new Set(); this.event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
  fire(event) { for (const listener of [...this.listeners]) listener(event); }
  dispose() { this.listeners.clear(); }
}
const changes = new EventEmitter(), closes = new EventEmitter();
const activeEditors = new EventEmitter();
const documents = [], previews = [], commands = new Map(), notifications = [];
let folders = [], pickerIndex, provider, writes = 0;
const previewProviders = new Set();
let previewGate, previewWaiting = false;
let importPath, importChoice, confirmHook, batchSelection, batchReview, batchProgress, cancelBatch;
const importPrompts = [];
let importEnabled = false;
function uri(scheme, fsPath, query = "") {
  return { scheme, fsPath, path: fsPath, query, toString: () => scheme + ":" + fsPath + "?" + query };
}
const vscode = {
  ProgressLocation: { Notification: 15 },
  EventEmitter, EndOfLine: { LF: 1, CRLF: 2 },
  Uri: { from: (value) => uri(value.scheme, value.path, value.query) },
  Range: class { constructor(start, end) { this.start = start; this.end = end; } },
  WorkspaceEdit: class {
    constructor() { this.entries = []; }
    replace(uri, range, text) { this.entries.push({ uri, range, text }); }
  },
  commands: {
    registerCommand: (name, callback) => { commands.set(name, callback); return { dispose() {} }; },
    executeCommand: async (command, key, value) => { if (command === "setContext" && key === "codemesh.canImportPreview") importEnabled = value; }
  },
  workspace: {
    get workspaceFolders() { return folders; }, textDocuments: documents,
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    getWorkspaceFolder: (uri) => folders.find((folder) => uri.fsPath.startsWith(folder.uri.fsPath + path.sep)),
    asRelativePath: (uri) => path.relative(folders.find((folder) => uri.fsPath.startsWith(folder.uri.fsPath + path.sep)).uri.fsPath, uri.fsPath),
    onDidChangeTextDocument: changes.event, onDidCloseTextDocument: closes.event,
    registerTextDocumentContentProvider: (scheme, value) => {
      assert.equal(scheme, "codemesh-preview");
      provider = value;
      previewProviders.add(value);
      return { dispose() { previewProviders.delete(value); provider = undefined; } };
    },
    openTextDocument: async (uri) => {
      assert.equal(uri.scheme, "codemesh-preview", "never open a file or untitled destination for a preview");
      // Each production client represents its own editor host and provider registration.
      const text = [...previewProviders].map((candidate) => candidate.provideTextDocumentContent(uri))
        .find((text) => text !== "Preview is no longer available");
      assert.notEqual(text, undefined);
      if (previewGate) {
        const gate = previewGate;
        previewGate = undefined;
        previewWaiting = true;
        await gate;
        previewWaiting = false;
      }
      return { uri, isDirty: false, getText: () => text, save: async () => { writes += 1; return false; } };
    },
    applyEdit: async (edit) => {
      for (const entry of edit.entries) {
        const document = documents.find((candidate) => candidate.uri.toString() === entry.uri.toString());
        document.text = entry.text;
        changes.fire({ document, contentChanges: [{ text: entry.text }] });
      }
      return true;
    },
    saveAll: async () => { writes += 1; return true; },
    fs: { writeFile: async () => { writes += 1; } }
  },
  window: {
    onDidChangeActiveTextEditor: activeEditors.event,
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    withProgress: async (_options, task) => {
      let cancelled = false, callback;
      cancelBatch = () => { cancelled = true; callback?.(); };
      return task({ report(value) { batchProgress?.(value); } }, { get isCancellationRequested() { return cancelled; },
        onCancellationRequested: listener => { callback = listener; return { dispose() { callback = undefined; } }; } });
    },
    showInformationMessage() {},
    showInputBox: async (options) => { assert.equal(options.value, "ok.txt"); return importPath; },
    showWarningMessage: async (message, options, action) => {
      if (action === "Confirm Import") return batchReview?.(message);
      if (action === "Import" || action === "Overwrite") {
        importPrompts.push({ message, action });
        if (confirmHook) await confirmHook();
        return importChoice;
      }
    },
    showErrorMessage: (message) => notifications.push(message),
    showTextDocument: async (document) => {
      previews.push({ uri: document.uri, text: document.getText() });
      vscode.window.activeTextEditor = { document };
      activeEditors.fire(vscode.window.activeTextEditor);
    },
    showQuickPick: async (items, options) => options?.canPickMany ? items.filter(item => batchSelection?.includes(item.label)) : items[pickerIndex]
  }
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) { return request === "vscode" ? vscode : originalLoad.call(this, request, parent, isMain); };
const { CodeMeshClient } = require("../dist/services/CodeMeshClient");
const { registerCommands } = require("../dist/commands/registerCommands");
Module._load = originalLoad;

async function proxy(target) {
  const server = new WebSocket.WebSocketServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const connections = [], received = [], sent = [];
  server.on("connection", (front) => {
    const back = new WebSocket(target);
    const connection = { front, back, up: [], down: [], holdRequest: false, blocked: false };
    connections.push(connection);
    const flush = () => { if (back.readyState === WebSocket.OPEN) for (const raw of connection.up.splice(0)) back.send(raw); };
    front.on("message", (raw) => { sent.push(JSON.parse(raw.toString())); connection.up.push(raw); flush(); });
    back.on("open", flush);
    back.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      received.push(message);
      if (connection.holdRequest && message.type === "FILE_REQUEST") connection.blocked = true;
      if (connection.blocked) connection.down.push(raw);
      else if (front.readyState === WebSocket.OPEN) front.send(raw);
    });
    connection.release = () => {
      connection.holdRequest = false; connection.blocked = false;
      if (front.readyState === WebSocket.OPEN) for (const raw of connection.down.splice(0)) front.send(raw);
    };
    connection.close = () => { front.terminate(); back.terminate(); connection.down.length = 0; };
    front.on("close", () => back.terminate());
    back.on("close", () => front.terminate());
    front.on("error", () => undefined); back.on("error", () => undefined);
  });
  return {
    url: "ws://127.0.0.1:" + server.address().port, received, sent, current: () => connections.at(-1),
    async close() { for (const connection of connections) connection.close(); await new Promise((resolve) => server.close(resolve)); }
  };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codemesh-content-"));
  const ownerRoot = path.join(root, "owner"), requesterRoot = path.join(root, "requester");
  await fs.mkdir(ownerRoot); await fs.mkdir(requesterRoot);
  const fixtures = {
    "ok.txt": "hello \u4e2d\u6587 \ud83d\ude80\r\nsecond line",
    "changed.txt": "before", "removed.txt": "remove", "ignored.txt": "ignore",
    "binary.bin": Buffer.from([0, 1, 2, 3]), "invalid.txt": Buffer.from([255, 254]),
    "grown.txt": "small", "large.txt": "x".repeat(MAX_FILE_BYTES + 1),
    "boundary.txt": "x".repeat(MAX_FILE_BYTES), "empty.txt": "", "bom.txt": "\ufeffhello",
    "linked/file.txt": "safe", "live.txt": "live start"
  };
  for (const [file, text] of Object.entries(fixtures)) {
    await fs.mkdir(path.dirname(path.join(ownerRoot, file)), { recursive: true });
    await fs.writeFile(path.join(ownerRoot, file), text);
  }
  await fs.writeFile(path.join(requesterRoot, "ok.txt"), "existing local file must not be overwritten");
  await fs.writeFile(path.join(requesterRoot, "live.txt"), "live start");
  const requesterBefore = await fs.readFile(path.join(requesterRoot, "ok.txt"));
  const ownerFolder = { name: "Owner", uri: uri("file", ownerRoot) };
  const requesterFolder = { name: "Requester", uri: uri("file", requesterRoot) };
  folders = [ownerFolder, requesterFolder];
  const publication = await buildWorkspacePublication(ownerRoot, "Owner");
  assert.equal(await readPublishedText(publication, "empty.txt"), "");
  assert.equal(await readPublishedText(publication, "bom.txt"), fixtures["bom.txt"]);
  await assert.rejects(readPublishedText(publication, "../escape"), /path/);
  await assert.rejects(readPublishedText(publication, "unknown.txt"), /not listed/);
  console.log("PASS: owner reader UTF-8/BOM/empty text and listed-path validation");

  const server = new CollaborationServer(0, { fileRequestTimeoutMs: 500 });
  server.start();
  await new Promise((resolve) => server.server.once("listening", resolve));
  const target = "ws://127.0.0.1:" + server.server.address().port;
  const ownerProxy = await proxy(target);
  const owner = new CodeMeshClient({ serverUrl: ownerProxy.url, reconnectDelayMs: 15, self: { memberId: "owner", displayName: "Owner" } });
  const requesterOptions = { serverUrl: target, reconnectDelayMs: 15, fileRequestTimeoutMs: 800, self: { memberId: "requester", displayName: "Requester" } };
  const requester = new CodeMeshClient(requesterOptions);
  const incoming = [];
  const bystander = new WebSocket(target);
  bystander.on("message", (raw) => incoming.push(JSON.parse(raw.toString())));
  await new Promise((resolve) => bystander.once("open", resolve));
  registerCommands({ subscriptions: [] }, requester);
  const publish = async () => {
    const oldId = owner.getState().workspaceManifestId;
    await owner.shareWorkspace(ownerFolder);
    await waitFor(() => owner.getState().workspaceManifestId && owner.getState().workspaceManifestId !== oldId
      && requester.getState().workspaceManifestId === owner.getState().workspaceManifestId);
  };
  try {
    await owner.createRoom(); await waitFor(() => owner.getState().roomId);
    const roomId = owner.getState().roomId;
    await requester.joinRoom(roomId); await waitFor(() => requester.getState().roomId === roomId);
    bystander.send(JSON.stringify({ type: "JOIN_ROOM", roomId, member: { memberId: "bystander", displayName: "Bystander" } }));
    await waitFor(() => owner.getState().members.length === 3);
    await publish();
    batchSelection = ["empty.txt", "binary.bin", "linked/file.txt", "ok.txt"];
    pickerIndex = 1;
    batchReview = async message => {
      assert.ok(message.includes(requesterRoot)); assert.ok(message.includes("linked/file.txt"));
      assert.equal(ownerProxy.sent.filter(message => message.type === "FILE_RESPONSE").length, 0);
      assert.deepEqual((await fs.readdir(requesterRoot)).sort(), ["live.txt", "ok.txt"]);
      return undefined;
    };
    assert.ok((await requester.importWorkspace()).every(result => result.status === "cancelled"));
    batchReview = async () => "Confirm Import";
    importChoice = undefined;
    const batch = await requester.importWorkspace();
    const byPath = Object.fromEntries(batch.map(result => [result.path, result.status]));
    assert.deepEqual(byPath, { "binary.bin": "failed", "empty.txt": "imported", "linked/file.txt": "imported", "ok.txt": "declined" });
    assert.equal(await fs.readFile(path.join(requesterRoot,"linked/file.txt"),"utf8"), "safe");
    assert.deepEqual(await fs.readFile(path.join(requesterRoot,"ok.txt")),requesterBefore);
    assert.equal(requester.getState().sharedDocumentPath, undefined);
    await fs.unlink(path.join(requesterRoot,"empty.txt"));
    await fs.unlink(path.join(requesterRoot,"linked/file.txt")); await fs.rmdir(path.join(requesterRoot,"linked"));
    await publish();
    batchSelection = ["empty.txt", "ok.txt"];
    batchProgress = value => { if (value.increment > 0) cancelBatch(); };
    const cancelledBatch = await requester.importWorkspace();
    assert.deepEqual(cancelledBatch.map(result => result.status), ["imported", "cancelled"]);
    assert.equal(await fs.readFile(path.join(requesterRoot,"empty.txt"),"utf8"), "");
    assert.deepEqual(await fs.readFile(path.join(requesterRoot,"ok.txt")),requesterBefore);
    await fs.unlink(path.join(requesterRoot,"empty.txt"));
    batchProgress = undefined;
    await publish();
    let refresh;
    batchProgress = value => { if (value.increment > 0 && !refresh) refresh = owner.refreshWorkspace(); };
    const originalRequest = requester.requestWorkspaceText.bind(requester);
    requester.requestWorkspaceText = async (...args) => {
      if (refresh) { await refresh; await waitFor(() => owner.getState().workspaceManifestId === requester.getState().workspaceManifestId); }
      return originalRequest(...args);
    };
    const refreshed = await requester.importWorkspace();
    assert.equal(refreshed.find(result=>result.path === "empty.txt").status,"imported");
    assert.equal(refreshed.find(result=>result.path === "ok.txt").status,"cancelled");
    requester.requestWorkspaceText = originalRequest; batchProgress = undefined;
    await fs.unlink(path.join(requesterRoot,"empty.txt"));
    await publish();
    console.log("PASS: batch production clients: review has zero requests/writes, nested import, binary failure, declined overwrite, progress cancellation and refresh preserve completed files and cancel remainder");
    ownerProxy.sent.length = 0;
    assert.equal(ownerProxy.sent.filter((message) => message.type === "FILE_RESPONSE").length, 0);
    assert.equal(previews.length, 0, "publication does not transfer or preview contents");
    assert.equal(importEnabled, false);
    requester.handleServerMessage(JSON.stringify({
      type: "FILE_RESPONSE", requestId: "unsolicited", roomId, manifestId: requester.getState().workspaceManifestId,
      path: "ok.txt", text: fixtures["ok.txt"]
    }));
    assert.equal(previews.length, 0, "unsolicited inbound text cannot open a preview");
    pickerIndex = undefined;
    await commands.get("codemesh.requestFile")();
    assert.equal(previews.length, 0, "cancelled explicit request shares nothing");
    const previewUri = await requester.requestFile("ok.txt");
    assert.equal(previewUri.scheme, "codemesh-preview");
    assert.equal(previews.at(-1).text, fixtures["ok.txt"]);
    assert.equal(previews.at(-1).uri.query.length, 36);
    await requester.requestFile("boundary.txt");
    assert.equal(previews.at(-1).text.length, MAX_FILE_BYTES);
    assert.deepEqual(await fs.readFile(path.join(requesterRoot, "ok.txt")), requesterBefore);
    assert.deepEqual((await fs.readdir(requesterRoot)).sort(), ["live.txt", "ok.txt"]);
    assert.equal(writes, 0);
    assert.ok(!incoming.some((message) => message.type === "FILE_RESPONSE"));
    console.log("PASS: two production clients explicitly preview Unicode/CRLF text and exact 256 KiB boundary; requester-only response and no disk writes");

    await assert.rejects(requester.importFile(previewUri), /current workspace preview/);
    const importUri = await requester.requestFile("ok.txt");
    assert.equal(importEnabled, true);
    const activePreviewEditor = vscode.window.activeTextEditor;
    vscode.window.activeTextEditor = undefined; activeEditors.fire(undefined);
    assert.equal(importEnabled, false, "switching away hides the import action");
    vscode.window.activeTextEditor = activePreviewEditor; activeEditors.fire(activePreviewEditor);
    assert.equal(importEnabled, true);
    pickerIndex = undefined;
    assert.equal(await requester.importFile(importUri), undefined, "cancelling destination workspace selection does nothing");
    pickerIndex = 1;
    importPath = "imported/ok.txt"; importChoice = "Import";
    await commands.get("codemesh.importFile")(importUri);
    assert.equal(await fs.readFile(path.join(requesterRoot, "imported", "ok.txt"), "utf8"), fixtures["ok.txt"], "multi-folder command imports only into the chosen workspace");
    await fs.unlink(path.join(requesterRoot, "imported", "ok.txt")); await fs.rmdir(path.join(requesterRoot, "imported"));
    folders = [requesterFolder];
    importPath = undefined;
    assert.equal(await requester.importFile(importUri), undefined);
    importPath = "imported/ok.txt"; importChoice = undefined;
    assert.equal(await requester.importFile(importUri), undefined);
    assert.equal(await fs.stat(path.join(requesterRoot, "imported")).catch(() => undefined), undefined);
    importChoice = "Import";
    const imported = await requester.importFile(importUri);
    assert.equal(imported, path.join(requesterRoot, "imported", "ok.txt"));
    assert.equal(await fs.readFile(imported, "utf8"), fixtures["ok.txt"]);
    assert.ok(importPrompts.at(-1).message.includes(imported));
    assert.equal(requester.getState().sharedDocumentPath, undefined, "import does not start live sharing");
    importPath = "ok.txt";
    importChoice = "Import";
    assert.equal(await requester.importFile(importUri), undefined, "Import is not an explicit Overwrite choice");
    assert.deepEqual(await fs.readFile(path.join(requesterRoot, "ok.txt")), requesterBefore);
    const dirtyDocument = { uri: uri("file", path.join(requesterRoot, "ok.txt")), isDirty: true, text: "unsaved draft" };
    documents.push(dirtyDocument);
    await assert.rejects(requester.importFile(importUri), /unsaved changes/);
    assert.equal(dirtyDocument.text, "unsaved draft");
    documents.splice(documents.indexOf(dirtyDocument), 1);
    importChoice = "Overwrite";
    await requester.importFile(importUri);
    assert.equal(await fs.readFile(path.join(requesterRoot, "ok.txt"), "utf8"), fixtures["ok.txt"]);
    confirmHook = async () => { requester.stopWorkspaceSharing(); };
    await assert.rejects(requester.importFile(importUri), /stale/);
    confirmHook = undefined;
    assert.equal(requester.canImportPreview(importUri), false);
    assert.equal(importEnabled, false, "ending sharing disables the import action");
    await assert.rejects(requester.importFile(importUri), /current workspace preview/);
    folders = [ownerFolder, requesterFolder];
    await publish();
    assert.equal(requester.canImportPreview(importUri), false, "replacement publication never revives an old preview");
    assert.equal(writes, 0, "import never calls document.save, saveAll or workspace edits");
    await fs.writeFile(path.join(requesterRoot, "ok.txt"), requesterBefore);
    const endedPreview = await requester.requestFile("ok.txt");
    owner.stopWorkspaceSharing();
    await waitFor(() => !requester.getState().workspaceManifest);
    assert.equal(requester.canImportPreview(endedPreview), false);
    await assert.rejects(requester.importFile(endedPreview), /current workspace preview/);
    await publish();
    const leftPreview = await requester.requestFile("ok.txt");
    requester.leaveRoom();
    await requester.joinRoom(roomId);
    await waitFor(() => requester.getState().workspaceManifestId === owner.getState().workspaceManifestId);
    assert.equal(requester.canImportPreview(leftPreview), false, "same room and publication cannot revive a completed preview after leave");
    const disconnectedPreview = await requester.requestFile("ok.txt");
    const disconnectedSocket = requester.socket;
    const disconnected = new Promise((resolve) => disconnectedSocket.once("close", resolve));
    disconnectedSocket.terminate();
    await disconnected;
    await waitFor(() => requester.socket !== disconnectedSocket && requester.getState().roomId === roomId
      && requester.getState().workspaceManifestId === owner.getState().workspaceManifestId);
    assert.equal(requester.canImportPreview(disconnectedPreview), false, "room restoration cannot revive a completed preview");
    await assert.rejects(requester.importFile(disconnectedPreview), /current workspace preview/);
    console.log("PASS: production preview import binding, cancel, exact destination, new file, explicit overwrite, dirty draft, stale preview and no auto-sharing or editor save");

    const count = previews.length;
    await assert.rejects(requester.requestFile("../escape"), /path/);
    await assert.rejects(requester.requestFile("unknown.txt"), /not listed/);
    await assert.rejects(requester.requestFile("large.txt"), /256 KiB/);
    await assert.rejects(requester.requestFile("binary.bin"), /binary/);
    await assert.rejects(requester.requestFile("invalid.txt"), /UTF-8/);
    await fs.writeFile(path.join(ownerRoot, "changed.txt"), "after!");
    await assert.rejects(requester.requestFile("changed.txt"), /changed after publication/);
    await fs.unlink(path.join(ownerRoot, "removed.txt"));
    await assert.rejects(requester.requestFile("removed.txt"), /removed/);
    await fs.writeFile(path.join(ownerRoot, ".gitignore"), "ignored.txt\n");
    await assert.rejects(requester.requestFile("ignored.txt"), /ignored/);
    await fs.writeFile(path.join(ownerRoot, "grown.txt"), "x".repeat(MAX_FILE_BYTES + 1));
    await assert.rejects(requester.requestFile("grown.txt"), /256 KiB/);
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "file.txt"), "private external contents");
    await fs.rename(path.join(ownerRoot, "linked"), path.join(ownerRoot, "saved-linked"));
    await fs.symlink(outside, path.join(ownerRoot, "linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(requester.requestFile("linked/file.txt"), /symlink/);
    assert.equal(previews.length, count, "rejections never open a preview");
    assert.ok(!JSON.stringify(ownerProxy.sent).includes("private external contents"));
    folders = [requesterFolder];
    await assert.rejects(requester.requestFile("ok.txt"), /no longer open/);
    folders = [ownerFolder, requesterFolder];
    console.log("PASS: same-size changed, removed, newly ignored, symlink replacement, grown/oversized, binary/invalid UTF-8, and closed workspace all reject without preview");

    let releasePreview;
    previewGate = new Promise((resolve) => { releasePreview = resolve; });
    const opening = requester.requestFile("ok.txt").then(() => ({ ok: true }), (error) => ({ error }));
    await waitFor(() => previewWaiting);
    await assert.rejects(requester.requestFile("ok.txt"), /one file request/);
    const oldManifestId = requester.getState().workspaceManifestId;
    requester.leaveRoom();
    await requester.joinRoom(roomId);
    await waitFor(() => requester.getState().workspaceManifestId === oldManifestId);
    releasePreview();
    assert.match((await opening).error.message, /cancelled/);
    assert.equal(previews.length, count, "leaving and rejoining the same room cannot revive an opening preview");
    console.log("PASS: one request includes preview-opening phase; leave/rejoin invalidates delayed preview completion");

    const makeDocument = (folder) => ({
      uri: uri("file", path.join(folder.uri.fsPath, "live.txt")), text: "live start", eol: 1,
      getText() { return this.text; }, positionAt(offset) { return { offset }; }
    });
    const aDoc = makeDocument(ownerFolder), bDoc = makeDocument(requesterFolder);
    documents.push(aDoc, bDoc);
    await owner.collaborateDocument(aDoc);
    await waitFor(() => owner.getState().documentStatus === "shared");
    await requester.collaborateDocument(bDoc);
    await waitFor(() => requester.getState().documentStatus === "shared");
    await assert.rejects(requester.requestFile("binary.bin"), /binary/);
    bDoc.text = "live edit after transfer rejection";
    changes.fire({ document: bDoc, contentChanges: [{ text: bDoc.text }] });
    await waitFor(() => aDoc.text === bDoc.text && !requester.documentEditInFlight);
    assert.equal(requester.getState().sharedDocumentPath, "live.txt");
    assert.equal(writes, 0);
    console.log("PASS: file errors remain separate from active unsaved live text sync");

    // Hold the owner's incoming request and every subsequent frame in FIFO order.
    const begin = () => {
      ownerProxy.current().holdRequest = true;
      const promise = requester.requestFile("ok.txt");
      return promise.then(() => ({ ok: true }), (error) => ({ error }));
    };
    const repliesBeforeCancellation = ownerProxy.sent.filter((message) => message.type === "FILE_RESPONSE").length;
    let forgedOutcome = begin();
    await waitFor(() => ownerProxy.current().blocked && server.fileRequests.size === 1);
    const registered = requester.filePreviews.values().next().value.key;
    requester.handleServerMessage(JSON.stringify({ type: "FILE_RESPONSE", ...registered, roomId: "ABC234", text: fixtures["ok.txt"] }));
    assert.match((await forgedOutcome).error.message, /mismatched/);
    await waitFor(() => server.fileRequests.size === 0);
    ownerProxy.current().release();
    await pause(80);
    let outcome = begin();
    await waitFor(() => ownerProxy.current().blocked && server.fileRequests.size === 1);
    const timeout = await outcome;
    assert.match(timeout.error.message, /timed out/);
    assert.equal(server.fileRequests.size, 0);
    ownerProxy.current().release();
    await pause(80);
    assert.equal(previews.length, count);
    requesterOptions.fileRequestTimeoutMs = 50;
    outcome = begin();
    await waitFor(() => ownerProxy.current().blocked);
    assert.match((await outcome).error.message, /timed out/);
    await waitFor(() => server.fileRequests.size === 0);
    ownerProxy.current().release();
    await pause(80);
    requesterOptions.fileRequestTimeoutMs = 800;
    outcome = begin();
    await waitFor(() => ownerProxy.current().blocked);
    requester.leaveRoom();
    assert.match((await outcome).error.message, /cancelled/);
    await waitFor(() => server.fileRequests.size === 0);
    ownerProxy.current().release();
    await requester.joinRoom(roomId);
    await waitFor(() => requester.getState().workspaceManifestId === owner.getState().workspaceManifestId);
    outcome = begin();
    await waitFor(() => ownerProxy.current().blocked);
    owner.stopWorkspaceSharing();
    assert.match((await outcome).error.message, /cancelled|manifest/);
    ownerProxy.current().release();
    await waitFor(() => !requester.getState().workspaceManifest);
    await publish();
    outcome = begin();
    await waitFor(() => ownerProxy.current().blocked);
    ownerProxy.current().close();
    assert.match((await outcome).error.message, /disconnect|manifest|cancelled/);
    await waitFor(() => owner.getState().roomId === roomId && !requester.getState().workspaceManifest);
    assert.equal(owner.getState().ownsWorkspaceManifest, false);
    assert.equal(previews.length, count, "cancelled and stale replies never produce previews");
    assert.equal(ownerProxy.sent.filter((message) => message.type === "FILE_RESPONSE").length, repliesBeforeCancellation, "late delivery cannot publish text for cancelled requests");
    assert.equal(server.fileRequests.size, 0);
    assert.equal(writes, 0);
    assert.deepEqual(await fs.readFile(path.join(requesterRoot, "ok.txt")), requesterBefore);
    assert.deepEqual(notifications, []);
    console.log("PASS: FIFO delayed delivery, server timeout, client fallback timeout, leave/end/disconnect cancellation, no stale preview or disk writes");
    await publish();
    await owner.requestFile("ok.txt");
    assert.equal(previews.at(-1).text, fixtures["ok.txt"], "owner can request its own publication through the same broker");
    assert.equal(writes, 0);
    assert.deepEqual(await fs.readFile(path.join(requesterRoot, "ok.txt")), requesterBefore);
    console.log("PASS: manifest owner self-request uses the same bounded preview flow without disk writes");

    const refreshRoot = path.join(root, "refresh-owner");
    await fs.mkdir(refreshRoot);
    const refreshFolder = { name: "Refresh Owner", uri: uri("file", refreshRoot) };
    folders = [refreshFolder, requesterFolder];
    const refreshFixtures = { "same.txt": "before", "edit.txt": "old", "delete.txt": "remove", "ignored.txt": "private", ".gitignore": "" };
    for (const [name, text] of Object.entries(refreshFixtures)) await fs.writeFile(path.join(refreshRoot, name), text);
    const localRefreshFiles = { "same.txt": "different local text", "delete.txt": "keep this local file", "ignored.txt": "local private file", "added.txt": "do not overwrite on addition" };
    for (const [name, text] of Object.entries(localRefreshFiles)) await fs.writeFile(path.join(requesterRoot, name), text);
    const localRefreshDraft = { uri: uri("file", path.join(requesterRoot, "same.txt")), isDirty: true, text: "unsaved local refresh draft" };
    documents.push(localRefreshDraft);
    const requesterDiskBefore = await fs.readFile(path.join(requesterRoot, "ok.txt"));
    const requesterNamesBefore = (await fs.readdir(requesterRoot)).sort();
    const oldPublication = owner.getState().workspaceManifestId;
    await owner.shareWorkspace(refreshFolder);
    await waitFor(() => owner.getState().workspaceManifestId !== oldPublication && requester.getState().workspaceManifestId === owner.getState().workspaceManifestId);
    const refreshId = owner.getState().workspaceManifestId;
    const stalePreview = await requester.requestFile("same.txt");
    await assert.rejects(requester.refreshWorkspace(), /current workspace owner/);
    bystander.send(JSON.stringify({ type: "CREATE_ROOM", member: { memberId: "isolated", displayName: "Isolated" } }));
    await waitFor(() => incoming.some((message) => message.type === "ROOM_CREATED"));
    const isolatedRoom = incoming.find((message) => message.type === "ROOM_CREATED").roomId;
    bystander.send(JSON.stringify({ type: "SHARE_WORKSPACE", roomId: isolatedRoom, manifest: { workspaceName: "Isolated", files: [{ path: "same.txt", size: 6 }] } }));
    await waitFor(() => incoming.some((message) => message.type === "WORKSPACE_MANIFEST" && message.roomId === isolatedRoom && message.manifest));
    const isolatedId = server.workspaces.get(isolatedRoom).id;
    const isolatedMessages = incoming.length;

    ownerProxy.current().holdRequest = true;
    const racing = requester.requestFile("edit.txt").then(() => ({ ok: true }), (error) => ({ error }));
    await waitFor(() => ownerProxy.current().blocked);
    const racingKey = ownerProxy.received.filter((message) => message.type === "FILE_REQUEST").at(-1);
    await fs.writeFile(path.join(refreshRoot, "same.txt"), "after!");
    await fs.writeFile(path.join(refreshRoot, "edit.txt"), "a longer edit");
    await fs.writeFile(path.join(refreshRoot, "added.txt"), "new content");
    await fs.unlink(path.join(refreshRoot, "delete.txt"));
    await fs.writeFile(path.join(refreshRoot, ".gitignore"), "ignored.txt\n");
    assert.equal(requester.getState().workspaceManifestId, refreshId, "disk changes never publish without an explicit action");
    registerCommands({ subscriptions: [] }, owner);
    await commands.get("codemesh.refreshWorkspace")();
    assert.match((await racing).error.message, /manifest changed/);
    await waitFor(() => requester.getState().workspaceChanges);
    const nextId = requester.getState().workspaceManifestId;
    assert.notEqual(nextId, refreshId);
    const expectedChanges = { added: ["added.txt"], changed: [".gitignore", "edit.txt", "same.txt"], removed: ["delete.txt", "ignored.txt"] };
    assert.deepEqual(requester.getState().workspaceChanges, expectedChanges);
    assert.equal(server.fileRequests.size, 0);
    assert.equal(requester.canImportPreview(stalePreview), false);
    await assert.rejects(requester.importFile(stalePreview), /current workspace preview/);
    const previewCount = previews.length;
    owner.send({ type: "FILE_RESPONSE", requestId: racingKey.requestId, roomId: racingKey.roomId, manifestId: racingKey.manifestId, path: racingKey.path, text: "old" });
    await pause(40);
    assert.equal(previews.length, previewCount, "delayed old responses cannot open a preview");
    ownerProxy.current().release();
    await waitFor(() => owner.getState().workspaceManifestId === nextId && owner.ownedPublication?.manifestId === nextId);
    assert.deepEqual(owner.getState().workspaceChanges, expectedChanges);
    assert.equal(server.workspaces.get(isolatedRoom).id, isolatedId);
    assert.ok(!incoming.slice(isolatedMessages).some((message) => ["WORKSPACE_MANIFEST", "WORKSPACE_CHANGES", "FILE_RESPONSE"].includes(message.type) && message.roomId === roomId));
    assert.deepEqual(await fs.readFile(path.join(requesterRoot, "ok.txt")), requesterDiskBefore);
    assert.deepEqual((await fs.readdir(requesterRoot)).sort(), requesterNamesBefore);
    for (const [name, text] of Object.entries(localRefreshFiles)) assert.equal(await fs.readFile(path.join(requesterRoot, name), "utf8"), text);
    assert.equal(localRefreshDraft.text, "unsaved local refresh draft");
    assert.equal(localRefreshDraft.isDirty, true);
    await requester.requestFile("same.txt");
    assert.equal(previews.at(-1).text, "after!");
    await requester.requestFile("edit.txt");
    assert.equal(previews.at(-1).text, "a longer edit");
    await requester.requestFile("added.txt");
    assert.equal(previews.at(-1).text, "new content");
    await assert.rejects(requester.requestFile("delete.txt"), /not listed/);
    await assert.rejects(requester.requestFile("ignored.txt"), /not listed/);
    console.log("PASS: explicit owner refresh add/edit/same-size/delete/newly ignored paths; both members receive exact summary, new requests required, old race/preview rejected, local disks and other rooms unchanged");

    const acceptedPublication = owner.ownedPublication;
    await fs.writeFile(path.join(refreshRoot, ".gitignore"), "x".repeat(64 * 1024 + 1));
    await assert.rejects(owner.refreshWorkspace(), /64 KiB/);
    assert.equal(owner.getState().workspaceManifestId, nextId);
    assert.equal(owner.ownedPublication, acceptedPublication, "failed scan keeps the accepted publication intact");
    await fs.writeFile(path.join(refreshRoot, ".gitignore"), "ignored.txt\n");
    folders = [requesterFolder];
    await assert.rejects(owner.refreshWorkspace(), /no longer open/);
    folders = [refreshFolder, requesterFolder];
    const savedRefreshRoot = path.join(root, "saved-refresh-owner");
    await fs.rename(refreshRoot, savedRefreshRoot);
    await fs.symlink(outside, refreshRoot, process.platform === "win32" ? "junction" : "dir");
    try { await assert.rejects(owner.refreshWorkspace(), /changed location/); }
    finally { await fs.unlink(refreshRoot); await fs.rename(savedRefreshRoot, refreshRoot); }
    assert.equal(owner.ownedPublication, acceptedPublication);
    assert.equal(server.workspaces.get(roomId).id, nextId, "rebound workspace root cannot publish outside files");
    owner.send({ type: "SHARE_WORKSPACE", roomId, manifest: acceptedPublication.publication.manifest, baseManifestId: refreshId, changedPaths: [] });
    await waitFor(() => notifications.some((message) => message.includes("changed before refresh")));
    assert.equal(server.workspaces.get(roomId).id, nextId, "stale base rejected atomically");
    owner.stopWorkspaceSharing();
    await waitFor(() => !requester.getState().workspaceManifest);
    assert.equal(requester.getState().workspaceChanges, undefined);
    assert.equal(owner.ownedPublication, undefined);
    assert.equal(server.workspaces.has(roomId), false);
    await owner.shareWorkspace(refreshFolder);
    await waitFor(() => requester.getState().workspaceManifestId === owner.getState().workspaceManifestId && owner.getState().workspaceManifestId);
    owner.leaveRoom();
    await waitFor(() => !requester.getState().workspaceManifest);
    assert.equal(server.workspaces.has(roomId), false);
    assert.equal(writes, 0);
    console.log("PASS: failed refresh and stale base preserve publication atomically; end and leave clear refreshed publication and summary without importing or saving");
    const lateKey = { requestId: "late-after-dispose", roomId, manifestId: owner.getState().workspaceManifestId, path: "ok.txt" };
    owner.dispose();
    await assert.doesNotReject(owner.serveFileRequest(lateKey), "late requests on a closed client are ignored safely");
    console.log("Content fixtures: " + root);
  } finally {
    owner.dispose(); requester.dispose(); bystander.terminate();
    await ownerProxy.close();
    for (const socket of server.server.clients) socket.terminate();
    await new Promise((resolve) => server.server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
