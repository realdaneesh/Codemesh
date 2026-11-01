const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { CollaborationServer } = require("../../server/dist/websocket/CollaborationServer");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, description) {
  for (let index = 0; index < 600; index += 1) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`Timed out: ${description}`);
}

class Emitter {
  constructor() { this.listeners = new Set(); this.event = (callback) => {
    this.listeners.add(callback); return { dispose: () => this.listeners.delete(callback) };
  }; }
  fire(value) { for (const callback of [...this.listeners]) callback(value); }
  dispose() { this.listeners.clear(); }
}

function adapter(name, eol, sharedPath = "src/shared.txt") {
  const changes = new Emitter(), closes = new Emitter(), selections = new Emitter(), visible = new Emitter();
  const decorations = new Map();
  const commands = new Map();
  const warnings = [];
  let saves = 0;
  const document = {
    documentPath: sharedPath, text: `first${eol}second`, isDirty: false, version: 1, eol: eol === "\n" ? 1 : 2,
    uri: { fsPath: `C:\\${name}\\${sharedPath.replace(/\//g, "\\")}`, toString: () => `file:///${name}/${sharedPath}` },
    getText() { return this.text; },
    get lineCount() { return this.text.split(/\r?\n/).length; },
    lineAt(line) { return { text: this.text.split(/\r?\n/)[line] }; },
    positionAt(offset) {
      const lines = this.text.slice(0, offset).split(/\r?\n/);
      return { line: lines.length - 1, character: lines.at(-1).length };
    },
    async save() { saves += 1; return true; }
  };
  const editor = {
    document, selection: { anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } },
    setDecorations(type, ranges) { decorations.set(type, ranges); }
  };
  editor.selections = [editor.selection];
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range { constructor(start, end) { this.start = start; this.end = end; } }
  class WorkspaceEdit {
    constructor() { this.entries = []; }
    replace(uri, range, text) { this.entries.push({ uri, range, text }); }
  }
  const vscode = {
    EventEmitter: Emitter, Position, Range, WorkspaceEdit,
    DecorationRangeBehavior: { ClosedClosed: 1 }, EndOfLine: { LF: 1, CRLF: 2 },
    commands: {
      registerCommand(id, callback) { if (commands.has(id)) throw new Error(`Command already registered: ${id}`);
        commands.set(id, callback); return { dispose: () => commands.delete(id) }; },
      async executeCommand(id, args) {
        if (id === "default:type") {
          const target = vscode.window.activeTextEditor?.document;
          if (!target) return;
          target.text += args.text;
          target.version += 1;
          target.isDirty = true;
          changes.fire({ document: target, contentChanges: [{ text: args.text }], reason: undefined });
          return;
        }
        return commands.get(id)?.(args);
      }
    },
    workspace: {
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      getWorkspaceFolder: () => ({ uri: { fsPath: `C:\\${name}` } }),
      asRelativePath: (uri) => uri.toString().split(`/${name}/`)[1],
      onDidChangeTextDocument: changes.event, onDidCloseTextDocument: closes.event,
      applyEdit: async (edit) => {
        for (const entry of edit.entries) {
          document.text = entry.text.replace(/\r?\n/g, eol);
          document.version += 1;
          document.isDirty = true;
          changes.fire({ document, contentChanges: [{ text: document.text }] });
        }
        return true;
      }
    },
    window: {
      activeTextEditor: editor, visibleTextEditors: [editor],
      onDidChangeTextEditorSelection: selections.event,
      onDidChangeVisibleTextEditors: visible.event,
      createTextEditorDecorationType: (options) => {
        const type = { options, disposed: false, dispose() { this.disposed = true; decorations.delete(this); } };
        return type;
      },
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      showInformationMessage: () => Promise.resolve(undefined),
      showWarningMessage: (message) => { warnings.push(message); return Promise.resolve(undefined); },
      showErrorMessage: () => Promise.resolve(undefined)
    }
  };
  const filename = require.resolve("../dist/services/CodeMeshClient");
  const isolated = new Module(filename, module);
  isolated.filename = filename;
  isolated.paths = Module._nodeModulePaths(path.dirname(filename));
  isolated.require = (request) => request === "vscode" ? vscode : Module.prototype.require.call(isolated, request);
  isolated._compile(fs.readFileSync(filename, "utf8"), filename);
  return {
    Client: isolated.exports.CodeMeshClient, vscode, document, editor, decorations, changes, closes, selections, warnings,
    get saves() { return saves; },
    select(line, character) { this.selectRanges([{ anchor: { line, character }, active: { line, character } }]); },
    selectRanges(ranges) { editor.selections = ranges.map(({ anchor, active }) => ({ anchor, active }));
      editor.selection = editor.selections[0]; selections.fire({ textEditor: editor }); },
    type(text) { document.text = text.replace(/\r?\n/g, eol); document.version += 1; document.isDirty = true;
      changes.fire({ document, contentChanges: [{ text: document.text }], reason: undefined }); },
    userType(text) { return vscode.commands.executeCommand("type", { text }); }
  };
}

async function main() {
  const server = new CollaborationServer(0); server.start();
  await new Promise((resolve) => server.server.once("listening", resolve));
  const url = `ws://127.0.0.1:${server.server.address().port}`;
  const aEditor = adapter("A", "\n"), bEditor = adapter("B", "\r\n");
  const a = new aEditor.Client({ serverUrl: url, reconnectDelayMs: 15, self: { memberId: "A", displayName: "Alice" } });
  const b = new bEditor.Client({ serverUrl: url, reconnectDelayMs: 15, self: { memberId: "B", displayName: "Bob" } });
  try {
    await a.createRoom();
    await waitFor(() => a.getState().roomId, "room created");
    const roomId = a.getState().roomId;
    await b.joinRoom(roomId);
    await waitFor(() => b.getState().roomId === roomId, "room joined");
    await a.collaborateDocument(aEditor.document);
    await waitFor(() => a.getState().documentStatus === "shared", "A shares");
    aEditor.select(1, 2);
    await delay(70);
    assert.equal(b.remoteCursors.size, 0, "unshared recipient sees no cursor");
    await b.collaborateDocument(bEditor.document);
    await waitFor(() => b.getState().documentStatus === "shared" && b.sharedFileSessions.has("A"), "both share same file");
    const sent = [];
    const originalSend = a.socket.send.bind(a.socket);
    a.socket.send = (raw, ...rest) => {
      const message = JSON.parse(raw);
      if (message.type === "CURSOR_UPDATE") sent.push(message);
      return originalSend(raw, ...rest);
    };
    for (let index = 0; index < 30; index += 1) aEditor.select(1, index % 6);
    aEditor.select(1, 3);
    await waitFor(() => b.remoteCursors.get("A")?.position.character === 3, "rapid final position delivered");
    assert.equal(sent.length, 1, "rapid movement coalesces to one frame");
    const decoration = b.cursorDecorations.get("A");
    assert.ok(decoration.options.before.contentText.includes("Alice"), "member name labels cursor");
    assert.match(decoration.options.before.color, /^hsl\(/);
    assert.deepEqual([bEditor.decorations.get(decoration)[0].start.line, bEditor.decorations.get(decoration)[0].start.character], [1, 3]);
    assert.equal(aEditor.document.text, "first\nsecond");
    assert.equal(bEditor.document.text, "first\r\nsecond");
    assert.equal(aEditor.saves + bEditor.saves, 0);
    console.log("PASS: two real-WebSocket clients show the same-file LF/CRLF cursor, name and color; 31 rapid moves become one frame with no text writes");

    const oldCursor = { type: "CURSOR_UPDATE", roomId, documentPath: "src/shared.txt",
      presenceSessionId: b.presenceSessionId, shareId: b.sharedFileSessions.get("A"), memberId: "A",
      sequence: b.remoteCursors.get("A").sequence, position: { line: 0, character: 0 } };
    b.handleServerMessage(JSON.stringify(oldCursor));
    assert.equal(b.remoteCursors.get("A").position.character, 3, "duplicate delivery ignored");
    b.handleServerMessage(JSON.stringify({ ...oldCursor, sequence: oldCursor.sequence + 1, position: { line: 99, character: 0 } }));
    assert.deepEqual(bEditor.decorations.get(decoration), [], "invalid line is hidden");
    bEditor.type("first\nshort");
    assert.equal(b.remoteCursors.size, 0, "text change hides stale cursor until a new position arrives");
    assert.equal(bEditor.saves, 0);
    aEditor.select(1, 2);
    await waitFor(() => b.remoteCursors.get("A")?.position.character === 2, "new position after edit");
    assert.deepEqual([bEditor.decorations.get(b.cursorDecorations.get("A"))[0].start.line,
      bEditor.decorations.get(b.cursorDecorations.get("A"))[0].start.character], [1, 2]);
    const staleSession = b.presenceSessionId;
    b.stopDocumentCollaboration();
    await waitFor(() => a.remoteCursors.size === 0 && b.remoteCursors.size === 0, "end-sharing cleanup");
    assert.equal(b.cursorDecorations.size, 0);
    const sentBeforeStop = sent.length;
    aEditor.select(1, 1);
    a.stopDocumentCollaboration();
    await delay(70);
    assert.equal(sent.length, sentBeforeStop, "pending cursor is cancelled on end sharing");
    await a.collaborateDocument(aEditor.document);
    await b.collaborateDocument(bEditor.document);
    await waitFor(() => b.sharedFileSessions.has("A") && a.sharedFileSessions.has("B"), "re-share");
    aEditor.select(0, 2);
    await waitFor(() => b.remoteCursors.get("A")?.position.line === 0, "re-shared cursor");
    b.handleServerMessage(JSON.stringify({ ...oldCursor, sequence: 1000, presenceSessionId: staleSession }));
    assert.equal(b.remoteCursors.get("A").position.line, 0, "old share ID cannot restore a stale cursor");
    bEditor.closes.fire(bEditor.document);
    await waitFor(() => !b.getState().sharedDocumentPath, "document-close cleanup");
    assert.equal(b.cursorDecorations.size, 0);
    b.socket.terminate();
    await waitFor(() => b.getState().roomId === roomId && !b.getState().sharedDocumentPath, "room restored without document");
    assert.equal(b.remoteCursors.size, 0);
    b.handleServerMessage(JSON.stringify({ ...oldCursor, sequence: 1001 }));
    assert.equal(b.remoteCursors.size, 0, "old room session cannot restore a cursor after reconnect");
    await b.createRoom();
    await waitFor(() => b.getState().roomId && b.getState().roomId !== roomId, "room switch");
    assert.equal(b.remoteCursors.size, 0);
    assert.equal(b.cursorDecorations.size, 0);
    assert.equal(bEditor.saves, 0);
    console.log("PASS: duplicate/stale delivery, invalid position, edit movement, close/end/disconnect cleanup and explicit re-share; no saves");
  } finally {
    a.dispose(); b.dispose();
    await new Promise((resolve) => server.server.close(resolve));
  }
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { adapter, delay, waitFor };
