const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { CollaborationServer } = require("../../server/dist/websocket/CollaborationServer");

const canonical = (text) => text.replace(/\r\n/g, "\n");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, description) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await delay(5);
  }
}
const listening = (server) => new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }
  fire(event) { for (const listener of [...this.listeners]) listener(event); }
  dispose() { this.listeners.clear(); }
}

async function createEditor(root, eol) {
  await fs.mkdir(root);
  const changes = new EventEmitter();
  const closes = new EventEmitter();
  const selections = new EventEmitter();
  const visibleEditors = new EventEmitter();
  const activeEditors = new EventEmitter();
  const documents = [];
  const applications = [];
  const prompts = [];
  const errors = [];
  const comparisons = [];
  const providers = new Map();
  const registeredCommands = new Map();
  const decorations = [];
  let saves = 0;
  const adapter = {
    applications, prompts, errors, changes, closes, selections, visibleEditors, activeEditors,
    documents, comparisons, providers, registeredCommands, decorations,
    quickPicks: [],
    async open(documentPath, text) {
      const fsPath = path.join(root, documentPath);
      await fs.mkdir(path.dirname(fsPath), { recursive: true });
      const initial = canonical(text).replace(/\n/g, eol);
      await fs.writeFile(fsPath, initial);
      const document = {
        documentPath, initial, text: initial, isDirty: false, version: 1, eol: eol === "\r\n" ? 2 : 1,
        uri: { fsPath, toString: () => `file:///${fsPath.replace(/\\/g, "/")}` },
        getText() { return this.text; },
        positionAt(offset) { return { offset }; },
        get lineCount() { return this.text.split(/\r?\n/).length; },
        lineAt(line) { return { text: this.text.split(/\r?\n/)[line] }; },
        async save() {
          saves += 1;
          await fs.writeFile(fsPath, this.text);
          this.isDirty = false;
          return true;
        }
      };
      documents.push(document);
      return document;
    },
    type(document, text) {
      document.text = canonical(text).replace(/\n/g, eol);
      document.isDirty = true;
      document.version += 1;
      changes.fire({ document, contentChanges: [{ text: document.text }] });
    },
    show(document) {
      const editor = { document, selections: [], selection: { active: { line: 0, character: 0 } },
        setDecorations(decoration, ranges) { decoration.rendered.set(document.documentPath, ranges); } };
      editor.selections = [editor.selection];
      vscode.window.activeTextEditor = editor;
      vscode.window.visibleTextEditors = [...new Set([...(vscode.window.visibleTextEditors ?? []), editor])];
      activeEditors.fire(editor);
      visibleEditors.fire(vscode.window.visibleTextEditors);
      return editor;
    },
    choose(choice) {
      const prompt = prompts.find((candidate) => !candidate.resolved);
      assert.ok(prompt, "expected an explicit conflict prompt");
      assert.ok(prompt.choices.includes(choice));
      prompt.resolved = true;
      prompt.resolve(choice);
    },
    dismissPrompts() {
      for (const prompt of prompts) {
        if (!prompt.resolved) { prompt.resolved = true; prompt.resolve(undefined); }
      }
    },
    async assertUnsaved() {
      assert.equal(saves, 0, "no document.save, saveAll, or workspace disk write");
      for (const document of documents) {
        assert.equal(await fs.readFile(document.uri.fsPath, "utf8"), document.initial, "disk text must remain unchanged");
      }
    }
  };
  class WorkspaceEdit {
    constructor() { this.entries = []; }
    replace(uri, range, text) { this.entries.push({ uri, range, text }); }
  }
  const vscode = {
    Uri: { parse: (value) => ({ toString: () => value }) },
    commands: {
      registerCommand: (id, callback) => { registeredCommands.set(id, callback); return { dispose: () => registeredCommands.delete(id) }; },
      executeCommand: async (command, ...args) => {
        if (command === "vscode.diff") { comparisons.push(args); return; }
        if (command === "default:type") {
          const document = vscode.window.activeTextEditor?.document;
          if (document) adapter.type(document, document.getText() + (args[0]?.text ?? ""));
          return;
        }
        const callback = registeredCommands.get(command);
        if (callback) return callback(...args);
      }
    },
    EventEmitter, WorkspaceEdit, EndOfLine: { LF: 1, CRLF: 2 },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    TreeItem: class { constructor(label) { this.label = label; } },
    TreeItemCollapsibleState: { None: 0 },
    StatusBarAlignment: { Left: 1 },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    DecorationRangeBehavior: { ClosedClosed: 1 },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    workspace: {
      registerTextDocumentContentProvider: (scheme, provider) => { providers.set(scheme, provider); return { dispose() { providers.delete(scheme); } }; },
      textDocuments: documents,
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      getWorkspaceFolder: (uri) => uri.fsPath.startsWith(root + path.sep) ? { uri: { fsPath: root } } : undefined,
      asRelativePath: (uri) => path.relative(root, uri.fsPath).replace(/\\/g, "/"),
      onDidChangeTextDocument: changes.event,
      onDidCloseTextDocument: closes.event,
      applyEdit: async (edit) => {
        const completion = adapter.applyCompletion;
        adapter.applyCompletion = undefined;
        for (const entry of edit.entries) {
          const document = documents.find((candidate) => candidate.uri.toString() === entry.uri.toString());
          assert.ok(document, "remote edit must target this editor's own document");
          assert.equal(entry.range.start.offset, 0);
          assert.equal(entry.range.end.offset, document.text.length);
          applications.push({ documentPath: document.documentPath, text: canonical(entry.text) });
          adapter.type(document, entry.text);
        }
        if (completion) await completion;
        return true;
      },
      saveAll: async () => { saves += 1; return true; },
      fs: { writeFile: async (uri, bytes) => { saves += 1; await fs.writeFile(uri.fsPath, bytes); } }
    },
    window: {
      activeTextEditor: undefined, visibleTextEditors: [],
      onDidChangeTextEditorSelection: selections.event,
      onDidChangeVisibleTextEditors: visibleEditors.event,
      onDidChangeActiveTextEditor: activeEditors.event,
      createTextEditorDecorationType: (options) => { const decoration = { options, rendered: new Map(), disposed: false,
        dispose() { this.disposed = true; } }; decorations.push(decoration); return decoration; },
      createStatusBarItem: () => ({ show() {}, dispose() {}, text: "", tooltip: "" }),
      showQuickPick: async (options, config) => {
        adapter.quickPicks.push({ options, config });
        return adapter.nextQuickPick ? options.find(option => adapter.nextQuickPick(option)) : undefined;
      },
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      showInformationMessage: () => Promise.resolve(undefined),
      showErrorMessage: (message) => { errors.push(message); return Promise.resolve(undefined); },
      showWarningMessage: (message, options, ...choices) => {
        if (!choices.length) return Promise.resolve(undefined);
        return new Promise((resolve) => prompts.push({ message, options, choices, resolve, resolved: false }));
      }
    }
  };
  // Each client module gets its own VS Code API and listeners, without a global require hook.
  const filename = require.resolve("../dist/services/CodeMeshClient");
  const isolated = new Module(filename, module);
  isolated.filename = filename;
  isolated.paths = Module._nodeModulePaths(path.dirname(filename));
  isolated.require = (request) => request === "vscode" ? vscode : Module.prototype.require.call(isolated, request);
  isolated._compile(fsSync.readFileSync(filename, "utf8"), filename);
  adapter.Client = isolated.exports.CodeMeshClient;
  adapter.vscode = vscode;
  return adapter;
}

async function createProxy(target) {
  const server = new WebSocket.WebSocketServer({ port: 0 });
  await listening(server);
  const connections = [];
  const upstream = [];
  const downstream = [];
  const failures = [];
  server.on("connection", (front) => {
    const back = new WebSocket(target);
    const connection = { front, back, up: [], down: [], heldAcks: [], holdAckPath: undefined, holdUp: false, gateDown: undefined, blockedDown: false, closed: false };
    connections.push(connection);
    const flushUp = () => {
      if (connection.holdUp || back.readyState !== WebSocket.OPEN) return;
      for (const raw of connection.up.splice(0)) back.send(raw);
    };
    connection.releaseUp = () => { connection.holdUp = false; flushUp(); };
    connection.releaseDown = () => {
      connection.gateDown = undefined;
      connection.blockedDown = false;
      if (front.readyState === WebSocket.OPEN) {
        for (const raw of connection.down.splice(0)) front.send(raw);
      }
    };
    connection.releaseAcks = () => {
      for (const raw of connection.heldAcks.splice(0)) if (front.readyState === WebSocket.OPEN) front.send(raw);
      connection.holdAckPath = undefined;
    };
    front.on("message", (raw) => {
      upstream.push(JSON.parse(raw.toString()));
      connection.up.push(raw);
      flushUp();
    });
    back.on("open", flushUp);
    back.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      downstream.push(message);
      if (message.type === "DOCUMENT_ACK" && message.documentPath === connection.holdAckPath) {
        connection.heldAcks.push(raw);
        return;
      }
      if (connection.gateDown === "*" || connection.gateDown === message.type) connection.blockedDown = true;
      // A delayed ACK also holds subsequent frames, preserving WebSocket/TCP order.
      if (connection.blockedDown) connection.down.push(raw);
      else if (front.readyState === WebSocket.OPEN) front.send(raw);
    });
    const close = () => {
      if (connection.closed) return;
      connection.closed = true;
      connection.up.length = 0;
      connection.down.length = 0;
      front.terminate();
      back.terminate();
    };
    connection.close = close;
    front.on("close", close);
    back.on("close", close);
    front.on("error", (error) => failures.push(error));
    back.on("error", (error) => failures.push(error));
  });
  return {
    upstream, downstream, connections, failures,
    url: `ws://127.0.0.1:${server.address().port}`,
    current: () => connections.at(-1),
    async close() {
      for (const connection of connections) connection.close();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

const edits = (messages) => messages.filter((message) => message.type === "DOCUMENT_EDIT");
async function settled(clients) {
  await waitFor(() => clients.every((client) => !client.documentEditInFlight && client.pendingDocumentText === undefined && !client.applyingRemoteDocumentPath), "document edit acknowledgements and applies");
  await delay(60);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codemesh-multi-client-"));
  const server = new CollaborationServer(0);
  server.start();
  await listening(server.server);
  const clients = [], editors = [], proxies = [];
  const session = (client, documentPath) => client.getDocumentSessions().find(value => value.path === documentPath);
  try {
    const target = `ws://127.0.0.1:${server.server.address().port}`;
    for (const [name, eol] of [["a", "\n"], ["b", "\r\n"]]) {
      const proxy = await createProxy(target);
      const editor = await createEditor(path.join(root, name), eol);
      const client = new editor.Client({ serverUrl: proxy.url, reconnectDelayMs: 20, documentAckTimeoutMs: 180,
        self: { memberId: name, displayName: name } });
      proxies.push(proxy); editors.push(editor); clients.push(client);
    }
    const [a, b] = clients, [ea, eb] = editors, [pa] = proxies;
    const aA = await ea.open("A.txt", "A0"), aB = await ea.open("B.txt", "B0");
    const bA = await eb.open("A.txt", "A0"), bB = await eb.open("B.txt", "B0");
    await a.createRoom();
    await waitFor(() => a.getState().roomId, "room created");
    const roomId = a.getState().roomId;
    await b.joinRoom(roomId);
    await waitFor(() => b.getState().roomId === roomId, "room joined");
    await a.shareDocumentForService(aA);
    await b.shareDocumentForService(bA);
    await waitFor(() => session(a, "A.txt")?.status === "shared" && session(b, "A.txt")?.status === "shared", "A shared");
    await a.shareDocumentForService(aB);
    await b.shareDocumentForService(bB);
    await waitFor(() => session(a, "B.txt")?.status === "shared" && session(b, "B.txt")?.status === "shared", "B shared");
    assert.deepEqual(a.getDocumentSessions().map(value => value.path).sort(), ["A.txt", "B.txt"]);
    assert.equal(a.getState().sharedDocumentPath, "A.txt", "one-file UI remains on A");
    const unopened = await ea.open("C.txt", "C0");
    assert.equal(unopened.getText(), "C0");
    assert.equal(pa.upstream.some(value => value.type === "OPEN_DOCUMENT" && value.documentPath === "C.txt"), false);
    await assert.rejects(a.shareDocumentForService(unopened), /At most two files/);
    console.log("PASS: two service sessions open explicitly without changing the one-file UI state");

    for (const [editor, local, remote, text] of [
      [ea, aA, bA, "A1"], [eb, bB, aB, "B1"], [eb, bA, aA, "A2"], [ea, aB, bB, "B2"]
    ]) {
      editor.type(local, text);
      await waitFor(() => canonical(remote.getText()) === text, `alternating ${local.documentPath}`);
      await waitFor(() => session(a, local.documentPath)?.revision === session(b, local.documentPath)?.revision,
        `revision settled for ${local.documentPath}`);
    }
    assert.equal(session(a, "A.txt").revision, 2);
    assert.equal(session(a, "B.txt").revision, 2);
    console.log("PASS: alternating bidirectional A/B edits keep independent revisions and do not echo");

    pa.current().holdAckPath = "B.txt";
    ea.type(aB, "B delayed ACK");
    await waitFor(() => canonical(bB.getText()) === "B delayed ACK", "B accepted before ACK");
    eb.type(bA, "A while B ACK delayed");
    await waitFor(() => canonical(aA.getText()) === "A while B ACK delayed" && session(a, "A.txt").revision === 3,
      "A progresses while B ACK delayed");
    pa.current().releaseAcks();
    await waitFor(() => session(a, "B.txt").revision === 3, "B ACK released");
    console.log("PASS: delayed ACK in B does not stall A's remote edits");

    const oldA = session(a, "A.txt").shareSessionId;
    pa.current().holdAckPath = "A.txt";
    ea.type(aA, "A unconfirmed draft");
    await waitFor(() => canonical(bA.getText()) === "A unconfirmed draft", "A accepted without ACK");
    eb.type(bB, "B during A ACK delay");
    await waitFor(() => canonical(aB.getText()) === "B during A ACK delay" && session(a, "B.txt").revision === 4,
      "B progresses during A ACK delay");
    await waitFor(() => session(a, "A.txt")?.status === "paused", "A pauses on lost ACK");
    pa.current().releaseAcks();
    assert.equal(aA.getText(), "A unconfirmed draft");
    assert.equal(session(a, "B.txt").status, "shared");
    console.log("PASS: lost ACK pauses only A; B continues and A's unsaved draft survives");

    eb.type(bA, "A changed in room");
    await waitFor(() => session(b, "A.txt")?.revision === 5, "peer A revision advances");
    await a.shareDocumentForService(aA);
    await waitFor(() => session(a, "A.txt")?.status === "conflict", "A initial conflict on re-share");
    assert.equal(aA.getText(), "A unconfirmed draft");
    eb.type(bB, "B during A conflict");
    await waitFor(() => canonical(aB.getText()) === "B during A conflict" && session(a, "B.txt").revision === 5,
      "B progresses during A conflict");
    console.log("PASS: conflict in A preserves its draft while B continues syncing");

    const reopenedA = session(a, "A.txt").shareSessionId;
    assert.notEqual(reopenedA, oldA);
    a.handleServerMessage(JSON.stringify({ type: "DOCUMENT_ACK", roomId, documentPath: "A.txt", revision: 99, shareSessionId: oldA }));
    a.handleServerMessage(JSON.stringify({ type: "DOCUMENT_EDIT", roomId, documentPath: "A.txt", revision: 99, text: "stale", shareSessionId: oldA }));
    a.handleServerMessage(JSON.stringify({ type: "ERROR", roomId, documentPath: "A.txt", shareSessionId: oldA, message: "older share session" }));
    assert.equal(session(a, "A.txt").revision, 5);
    assert.equal(aA.getText(), "A unconfirmed draft");
    assert.equal(session(a, "B.txt").status, "shared");
    a.handleServerMessage(JSON.stringify({ type: "ERROR", roomId, documentPath: "B.txt", shareSessionId: "00000000-0000-4000-8000-000000000000", message: "older share session" }));
    assert.equal(session(a, "A.txt").status, "conflict");
    assert.equal(session(a, "B.txt").status, "shared");
    ea.closes.fire(aA);
    assert.equal(session(a, "A.txt"), undefined);
    eb.type(bB, "B after A close");
    await waitFor(() => canonical(aB.getText()) === "B after A close", "B after close");
    console.log("PASS: stale same-path frames are ignored; closing A leaves B active");

    await a.shareDocumentForService(aA);
    await waitFor(() => session(a, "A.txt")?.status === "conflict", "A reopened conflict");
    await a.createRoom();
    await waitFor(() => a.getDocumentSessions().length === 0, "room switch cleans both");
    assert.equal(aA.getText(), "A unconfirmed draft");
    await ea.assertUnsaved(); await eb.assertUnsaved();
    console.log("PASS: room switch cleans both sessions and no implicit saves occur");

    await a.joinRoom(roomId);
    await waitFor(() => a.getState().roomId === roomId, "rejoin original room");
    await a.shareDocumentForService(aA);
    await a.shareDocumentForService(aB);
    await waitFor(() => a.getDocumentSessions().length === 2 && session(a, "B.txt")?.status === "shared", "two sessions before disconnect");
    pa.current().close();
    await waitFor(() => a.getDocumentSessions().length === 0, "disconnect clears both sessions");
    await waitFor(() => a.getState().roomId === roomId, "room restored after disconnect");
    assert.deepEqual(a.getDocumentSessions(), [], "reconnect must not re-share either file");
    await a.shareDocumentForService(aA);
    await a.shareDocumentForService(aB);
    await waitFor(() => a.getDocumentSessions().length === 2 && session(a, "B.txt")?.status === "shared", "explicit re-share after reconnect");
    let finishApply;
    ea.applyCompletion = new Promise(resolve => { finishApply = resolve; });
    eb.type(bB, "B remote during apply");
    await waitFor(() => canonical(aB.getText()) === "B remote during apply", "B remote apply begins");
    ea.type(aB, "B local draft during apply");
    finishApply(true);
    await waitFor(() => session(a, "B.txt")?.status === "conflict", "local B edit preserved as conflict");
    assert.equal(aB.getText(), "B local draft during apply");
    console.log("PASS: local B edit during asynchronous remote apply becomes a preserved conflict");
    a.dispose();
    assert.deepEqual(a.getDocumentSessions(), []);
    await ea.assertUnsaved(); await eb.assertUnsaved();
    console.log("PASS: disconnect and disposal clean both sessions; reconnect requires explicit per-file re-share, with zero saves");
  } finally {
    for (const client of clients) client.dispose();
    for (const editor of editors) editor.dismissPrompts();
    for (const proxy of proxies) await proxy.close();
    for (const socket of server.server.clients) socket.terminate();
    await new Promise(resolve => server.server.close(resolve));
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { createEditor, createProxy, waitFor, delay, canonical, listening };

