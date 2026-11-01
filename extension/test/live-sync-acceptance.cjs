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
  const documents = [];
  const applications = [];
  const prompts = [];
  const errors = [];
  const comparisons = [];
  const providers = new Map();
  let saves = 0;
  const adapter = {
    applications, prompts, errors, changes, closes, documents, comparisons, providers,
    async open(documentPath, text) {
      const fsPath = path.join(root, documentPath);
      await fs.mkdir(path.dirname(fsPath), { recursive: true });
      const initial = canonical(text).replace(/\n/g, eol);
      await fs.writeFile(fsPath, initial);
      const document = {
        documentPath, initial, text: initial, isDirty: false, eol: eol === "\r\n" ? 2 : 1,
        uri: { fsPath, toString: () => `file:///${fsPath.replace(/\\/g, "/")}` },
        getText() { return this.text; },
        positionAt(offset) { return { offset }; },
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
      changes.fire({ document, contentChanges: [{ text: document.text }] });
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
    commands: { executeCommand: async (command, ...args) => { assert.equal(command, 'vscode.diff'); comparisons.push(args); } },
    EventEmitter, WorkspaceEdit, EndOfLine: { LF: 1, CRLF: 2 },
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
    const connection = { front, back, up: [], down: [], holdUp: false, gateDown: undefined, blockedDown: false, closed: false };
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
    front.on("message", (raw) => {
      upstream.push(JSON.parse(raw.toString()));
      connection.up.push(raw);
      flushUp();
    });
    back.on("open", flushUp);
    back.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      downstream.push(message);
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codemesh-acceptance-"));
  const server = new CollaborationServer(0);
  server.start();
  await listening(server.server);
  const proxies = [];
  const clients = [];
  const editors = [];
  try {
    const target = `ws://127.0.0.1:${server.server.address().port}`;
    for (const [name, eol] of [["A", "\n"], ["B", "\r\n"]]) {
      const proxy = await createProxy(target);
      const editor = await createEditor(path.join(root, name), eol);
      const client = new editor.Client({ serverUrl: proxy.url, reconnectDelayMs: 15, documentAckTimeoutMs: 500, self: { memberId: name, displayName: name } });
      proxies.push(proxy); editors.push(editor); clients.push(client);
    }
    const [a, b] = clients;
    const [ea, eb] = editors;
    const [pa, pb] = proxies;
    const da = await ea.open("src/shared.txt", "start\nline");
    const db = await eb.open("src/shared.txt", "start\nline");
    assert.notEqual(path.dirname(da.uri.fsPath), path.dirname(db.uri.fsPath), 'clients must use independent workspace roots');
    await a.createRoom();
    await waitFor(() => a.getState().roomId, "A creates room");
    const roomId = a.getState().roomId;
    await b.joinRoom(roomId);
    await waitFor(() => b.getState().roomId === roomId && a.getState().members.length === 2, "both room members");
    assert.deepEqual(a.getState().sharedFiles, []);
    assert.deepEqual(b.getState().sharedFiles, []);
    await a.collaborateDocument(da);
    await waitFor(() => a.getState().documentStatus === "shared", "A initial sync");
    await waitFor(() => b.getState().sharedFiles.some((file) => file.memberId === "A" && file.documentPath === "src/shared.txt"), "A's file presence");
    await b.collaborateDocument(db);
    await waitFor(() => b.getState().documentStatus === "shared", "B initial sync");
    await waitFor(() => a.getState().sharedFiles.length === 2 && b.getState().sharedFiles.length === 2, "both shared-file paths");
    const unrelated = await eb.open("src/unshared.txt", "unshared tab");
    assert.ok(unrelated);
    assert.equal(b.getState().sharedDocumentPath, "src/shared.txt", "opening another tab must not share it");
    assert.equal(pb.upstream.some((message) => message.type === "SET_SHARED_FILE" && message.documentPath === "src/unshared.txt"), false);
    b.stopDocumentCollaboration();
    await waitFor(() => a.getState().sharedFiles.length === 1, "B ends sharing");
    assert.equal(b.getState().sharedDocumentPath, undefined);
    assert.equal(a.getState().sharedFiles.some((file) => file.memberId === "B"), false);
    await b.collaborateDocument(db);
    await waitFor(() => a.getState().sharedFiles.length === 2 && b.getState().documentStatus === "shared", "B explicitly re-shares");
    assert.equal(a.getState().sharedDocumentPath, 'src/shared.txt');
    assert.equal(b.getState().sharedDocumentPath, 'src/shared.txt');
    for (const proxy of proxies) {
      for (const message of proxy.upstream.filter((entry) => entry.type === "SET_SHARED_FILE")) {
        assert.deepEqual(Object.keys(message).sort(), ["documentPath", "presenceSessionId", "roomId", "sequence", "type"].sort(), "presence sends no text, cursor or absolute path");
      }
    }
    console.log("PASS: two-client active shared-file presence starts only on explicit share, clears on end, and ignores unrelated tabs");

    for (const [sender, receiver, source, destination, text] of [
      [ea, eb, da, db, "A unsaved\n\u4e2d\u6587 \ud83d\ude80"],
      [eb, ea, db, da, "B unsaved\nnext line"]
    ]) {
      const up = proxies.map((proxy) => edits(proxy.upstream).length);
      const down = proxies.map((proxy) => edits(proxy.downstream).length);
      const applies = editors.map((editor) => editor.applications.length);
      sender.type(source, text);
      await waitFor(() => canonical(destination.getText()) === text, "unsaved edit received");
      await settled(clients);
      const senderIndex = sender === ea ? 0 : 1;
      const receiverIndex = 1 - senderIndex;
      assert.equal(edits(proxies[senderIndex].upstream).length - up[senderIndex], 1);
      assert.equal(edits(proxies[receiverIndex].upstream).length - up[receiverIndex], 0, "no remote echo");
      assert.equal(edits(proxies[receiverIndex].downstream).length - down[receiverIndex], 1);
      assert.equal(edits(proxies[senderIndex].downstream).length - down[senderIndex], 0);
      assert.equal(receiver.applications.length - applies[receiverIndex], 1, "apply exactly once");
      assert.equal(sender.applications.length - applies[senderIndex], 0);
      assert.ok(source.isDirty && destination.isDirty);
      assert.equal(da.eol, 1); assert.equal(db.eol, 2);
      assert.ok(!da.getText().includes("\r"));
      assert.equal(db.getText(), text.replace(/\n/g, "\r\n"));
      await ea.assertUnsaved(); await eb.assertUnsaved();
    }
    console.log("PASS: A -> B and B -> A once, no echo, LF/CRLF equivalence, both buffers dirty and disks unchanged");

    if (process.argv.includes("--soak")) {
      const soakStarted = Date.now();
      const soakEnds = soakStarted + 10 * 60 * 1000;
      let round = 0;
      while (Date.now() < soakEnds) {
        round += 1;
        for (const [editor, source, destination, name] of [
          [ea, da, db, "A"], [eb, db, da, "B"]
        ]) {
          let final = "";
          for (let burst = 0; burst < 8; burst += 1) {
            final = `soak ${name} round ${round} edit ${burst}\nline`;
            editor.type(source, final);
            await delay(4);
          }
          await waitFor(() => canonical(destination.getText()) === final, `soak ${name} -> peer round ${round}`);
          await settled(clients);
        }
        await ea.assertUnsaved(); await eb.assertUnsaved();
        if (Date.now() < soakEnds) await delay(Math.min(40000, soakEnds - Date.now()));
      }
      assert.equal(canonical(da.getText()), canonical(db.getText()), "soak final texts converge");
      assert.ok(clients.every((client) => client.getState().documentStatus === "shared" && !client.documentEditInFlight));
      console.log(`PASS: ${Math.round((Date.now() - soakStarted) / 1000)}s two-client WebSocket soak, ${round} alternating rapid-edit rounds with 40s idle intervals; converged and unsaved`);
    }

    pa.current().gateDown = "DOCUMENT_ACK";
    const stalledDraft = "accepted but unacknowledged draft\nkeep local";
    ea.type(da, stalledDraft);
    await waitFor(() => canonical(db.getText()) === stalledDraft, "server accepts edit while sender ACK is withheld");
    await waitFor(() => a.getState().documentStatus === "paused", "missing ACK pauses sender");
    assert.equal(canonical(da.getText()), stalledDraft, "sender's unsaved draft is preserved");
    assert.equal(a.getState().documentError, "The server did not confirm the last edit");
    assert.equal(a.getState().sharedFiles.some((file) => file.memberId === "A"), false, "paused file is no longer advertised as shared");
    const pausedEditCount = edits(pa.upstream).length;
    ea.type(da, stalledDraft + " plus later local typing");
    await delay(30);
    assert.equal(edits(pa.upstream).length, pausedEditCount, "paused edits remain local");
    assert.equal(canonical(da.getText()), stalledDraft + " plus later local typing");
    pa.current().releaseDown();
    await delay(30);
    assert.equal(a.getState().documentStatus, "paused", "late ACK cannot silently resume sync");
    assert.equal(canonical(da.getText()), stalledDraft + " plus later local typing", "late network frames cannot replace the draft");
    await a.collaborateDocument(da);
    await waitFor(() => a.getState().documentStatus === "conflict", "explicit re-share requires draft reconciliation");
    assert.equal(canonical(da.getText()), stalledDraft + " plus later local typing");
    ea.choose("Retry Mine");
    await waitFor(() => canonical(db.getText()) === stalledDraft + " plus later local typing", "explicit retry reconciles the preserved draft");
    await settled(clients);
    ea.dismissPrompts();
    await ea.assertUnsaved(); await eb.assertUnsaved();
    console.log("PASS: withheld accepted-edit ACK pauses sync, removes stale file presence, preserves local draft, ignores late ACK and requires explicit re-share/conflict choice");

    for (const [editor, source, destination, proxy] of [[ea, da, db, pa], [eb, db, da, pb]]) {
      proxy.current().gateDown = "DOCUMENT_ACK";
      const sent = edits(proxy.upstream).length;
      const received = edits((proxy === pa ? pb : pa).downstream).length;
      editor.type(source, "rapid 0\nline");
      await waitFor(() => proxy.current().blockedDown && canonical(destination.getText()) === "rapid 0\nline", "accepted first edit with delayed ACK");
      for (let i = 1; i <= 60; i += 1) editor.type(source, `rapid ${i}\nline`);
      await delay(60);
      assert.equal(edits(proxy.upstream).length - sent, 1, "one in flight despite 60 further changes");
      assert.equal(canonical(destination.getText()), "rapid 0\nline");
      proxy.current().releaseDown();
      await waitFor(() => canonical(destination.getText()) === "rapid 60\nline", "final coalesced text");
      await settled(clients);
      assert.equal(edits(proxy.upstream).length - sent, 2);
      assert.equal(edits((proxy === pa ? pb : pa).downstream).length - received, 2);
      assert.equal(canonical(source.getText()), canonical(destination.getText()));
    }
    console.log("PASS: delayed ACKs in both directions coalesce 61 changes into 2 edits and converge");

    // Delay B's outgoing draft and all incoming frames until A's competing edit wins.
    for (const choice of ["Retry Mine", "Use Room Text"]) {
      const promptsBefore = eb.prompts.length;
      pb.current().holdUp = true;
      pb.current().gateDown = "*";
      const before = edits(pb.upstream).length;
      eb.type(db, `B rejected draft ${choice}\nlocal`);
      await waitFor(() => edits(pb.upstream).length === before + 1, "held B draft");
      ea.type(da, `A winner ${choice}\nroom`);
      await settled([a]);
      const conflicts = pb.downstream.filter((message) => message.type === "DOCUMENT_CONFLICT").length;
      pb.current().releaseUp();
      await waitFor(() => pb.downstream.filter((message) => message.type === "DOCUMENT_CONFLICT").length > conflicts, "real server stale-revision rejection");
      pb.current().releaseDown();
      await waitFor(() => b.getState().documentStatus === "conflict" && eb.prompts.some((prompt) => !prompt.resolved), "explicit conflict choice");
      const preserved = canonical(db.getText());
      assert.equal(preserved, `B rejected draft ${choice}\nlocal`);
      await delay(60);
      assert.equal(eb.prompts.length - promptsBefore, 1, "one competing edit must require only one conflict choice");
      assert.equal(edits(pb.upstream).length, before + 1, "no automatic conflict retry");
      eb.type(db, preserved + " while deciding");
      await delay(60);
      assert.equal(edits(pb.upstream).length, before + 1, "typing cannot resolve conflict implicitly");
      eb.choose('Inspect Differences');
      await waitFor(() => eb.comparisons.length && eb.prompts.some(prompt => !prompt.resolved), 'read-only conflict inspection');
      const [mine, room] = eb.comparisons.at(-1);
      const provider = eb.providers.get('codemesh-conflict');
      assert.equal(canonical(provider.provideTextDocumentContent(mine)), preserved + ' while deciding');
      assert.equal(provider.provideTextDocumentContent(room), `A winner ${choice}\nroom`);
      assert.equal(edits(pb.upstream).length, before + 1, 'inspection sends no edit');
      await eb.assertUnsaved();
      eb.choose(choice);
      const expected = choice === "Retry Mine" ? preserved + " while deciding" : `A winner ${choice}\nroom`;
      await waitFor(() => canonical(da.getText()) === expected && canonical(db.getText()) === expected, "explicit conflict resolution converges");
      await settled(clients);
      assert.equal(edits(pb.upstream).length, before + (choice === "Retry Mine" ? 2 : 1));
      assert.equal(b.getState().documentStatus, "shared");
      eb.dismissPrompts();
      await ea.assertUnsaved(); await eb.assertUnsaved();
    }
    console.log("PASS: real competing edits preserve rejected draft; typing stays paused; explicit Retry Mine/Use Room Text converge without saving");

    // A confirmed common base, two competing separated replacements, and a
    // proposal that is rejected once and shared only on explicit approval.
    const common = 'alpha\nbeta\ngamma\ndelta\nepsilon\n';
    ea.type(da, common);
    await settled(clients);
    pb.current().holdUp = true;
    pb.current().gateDown = '*';
    const proposalEdits = edits(pb.upstream).length;
    eb.type(db, common.replace('alpha', 'mine 🚀'));
    await waitFor(() => edits(pb.upstream).length === proposalEdits + 1, 'B held separated change');
    ea.type(da, common.replace('epsilon', 'room 中文'));
    await settled([a]);
    pb.current().releaseUp();
    await waitFor(() => pb.downstream.some(message => message.type === 'DOCUMENT_CONFLICT' && message.text === common.replace('epsilon', 'room 中文')), 'real separated-edit rejection');
    pb.current().releaseDown();
    await waitFor(() => b.getState().documentStatus === 'conflict' && eb.prompts.some(prompt => !prompt.resolved), 'combined candidate conflict');
    eb.choose('Preview Combined Text');
    await waitFor(() => eb.prompts.some(prompt => !prompt.resolved && prompt.choices.includes('Apply and Share Combined Text')), 'combined approval prompt');
    const savedDraft = db.getText();
    eb.choose('Reject Proposal');
    await delay(30);
    assert.equal(db.getText(), savedDraft);
    assert.equal(edits(pb.upstream).length, proposalEdits + 1);
    await ea.assertUnsaved(); await eb.assertUnsaved();
    const reopen = b.previewCombinedText();
    await waitFor(() => eb.prompts.some(prompt => !prompt.resolved && prompt.choices.includes('Apply and Share Combined Text')), 'fresh combined preview');
    eb.choose('Apply and Share Combined Text');
    await reopen;
    const expectedCombined = common.replace('alpha', 'mine 🚀').replace('epsilon', 'room 中文');
    await waitFor(() => canonical(da.getText()) === expectedCombined && canonical(db.getText()) === expectedCombined, 'explicit combined proposal converges');
    await settled(clients);
    assert.equal(edits(pb.upstream).length, proposalEdits + 2, 'exactly one approved combined edit');
    await ea.assertUnsaved(); await eb.assertUnsaved();
    console.log('PASS: production combined proposal uses confirmed common base, rejection preserves both drafts, explicit approval sends once and converges without saving');

    ea.type(da, common);
    await settled(clients);
    pb.current().holdUp = true; pb.current().gateDown = '*';
    const recoveryEdits = edits(pb.upstream).length;
    eb.type(db, common.replace('alpha', 'recovery mine'));
    await waitFor(() => edits(pb.upstream).length === recoveryEdits + 1, 'held recovery draft');
    const recoveryRoom = common.replace('epsilon', 'recovery room');
    ea.type(da, recoveryRoom); await settled([a]);
    pb.current().releaseUp();
    await waitFor(() => pb.downstream.some(message => message.type === 'DOCUMENT_CONFLICT' && message.text === recoveryRoom), 'recovery conflict from real server');
    pb.current().releaseDown();
    await waitFor(() => eb.prompts.some(prompt => !prompt.resolved), 'recovery conflict prompt');
    eb.choose('Preview Combined Text');
    await waitFor(() => eb.prompts.some(prompt => !prompt.resolved && prompt.choices.includes('Apply and Share Combined Text')), 'recovery approval prompt');
    let finishRecoveryApply;
    eb.applyCompletion = new Promise(resolve => { finishRecoveryApply = resolve; });
    eb.choose('Apply and Share Combined Text');
    const recoveryCombined = common.replace('alpha', 'recovery mine').replace('epsilon', 'recovery room');
    await waitFor(() => canonical(db.getText()) === recoveryCombined, 'proposal applied locally');
    const recoveryRevision = b.conflict.revision;
    const latestRoom = recoveryRoom.replace('delta', 'newer room revision');
    ea.type(da, latestRoom); await settled([a]);
    await waitFor(() => b.conflict.revision > recoveryRevision, 'new revision while B apply is unresolved');
    finishRecoveryApply();
    await waitFor(() => eb.prompts.some(prompt => !prompt.resolved && prompt.message.includes('unsaved editor') && prompt.message.includes('NOT shared')), 'explicit local-only recovery notice');
    eb.dismissPrompts();
    const recovery = b.conflict.recovery;
    const recoveryProvider = eb.providers.get('codemesh-conflict');
    assert.equal(canonical(recoveryProvider.provideTextDocumentContent(recovery.original)), common.replace('alpha', 'recovery mine'));
    assert.equal(recoveryProvider.provideTextDocumentContent(recovery.proposed), recoveryCombined);
    assert.equal(recoveryProvider.provideTextDocumentContent(recovery.room), latestRoom);
    assert.equal(canonical(db.getText()), recoveryCombined);
    assert.equal(canonical(da.getText()), latestRoom);
    assert.equal(edits(pb.upstream).length, recoveryEdits + 1, 'unsent proposal never reaches room');
    assert.match(b.getState().documentError, /NOT shared/);
    await b.inspectRecoveryVersions();
    await ea.assertUnsaved(); await eb.assertUnsaved();
    console.log('PASS: production apply/revision recovery distinguishes editor from room, preserves three versions after dismissal, sends no stale edit and saves nothing');

    const connections = pb.connections.length;
    const opens = pb.upstream.filter((message) => message.type === "OPEN_DOCUMENT").length;
    const previousPresenceSession = b.presenceSessionId;
    pb.current().close();
    await waitFor(() => pb.connections.length > connections && b.getState().roomId === roomId, "room restoration");
    assert.equal(b.getState().sharedDocumentPath, undefined);
    await waitFor(() => a.getState().sharedFiles.length === 1 && b.getState().sharedFiles.length === 1, "reconnect clears B file presence");
    assert.notEqual(b.presenceSessionId, previousPresenceSession);
    pb.current().front.send(JSON.stringify({ type: "SHARED_FILES", roomId, presenceSessionId: previousPresenceSession,
      revision: 999999, files: [{ memberId: "B", documentPath: "src/shared.txt" }] }));
    await delay(30);
    assert.equal(b.getState().sharedFiles.some((file) => file.memberId === "B"), false, "old-session snapshot cannot restore B's file");
    pb.current().front.send(JSON.stringify({ type: "SHARED_FILES", roomId, presenceSessionId: b.presenceSessionId,
      revision: b.presenceRevision + 1, files: [{ memberId: "B", documentPath: "C:\\private.txt" }] }));
    await delay(30);
    assert.equal(b.getState().sharedFiles.some((file) => file.memberId === "B"), false, "invalid absolute path cannot enter client presence");
    assert.equal(eb.changes.listeners.size, 0);
    eb.type(db, "offline local draft\npreserved");
    ea.type(da, "room changed while B unshared\nserver");
    await settled([a]);
    assert.equal(canonical(db.getText()), "offline local draft\npreserved");
    assert.equal(pb.upstream.filter((message) => message.type === "OPEN_DOCUMENT").length, opens);
    const editsBeforeReshare = edits(pb.upstream).length;
    await b.collaborateDocument(db);
    await waitFor(() => b.getState().documentStatus === "conflict", "explicit re-share detects divergent draft");
    await waitFor(() => a.getState().sharedFiles.length === 2, "presence returns only after explicit re-share");
    assert.equal(canonical(db.getText()), "offline local draft\npreserved");
    assert.equal(edits(pb.upstream).length, editsBeforeReshare);
    eb.choose("Use Room Text");
    await waitFor(() => canonical(db.getText()) === canonical(da.getText()), "re-share resolved explicitly");
    await settled(clients);
    eb.dismissPrompts();
    console.log("PASS: disconnect restores room membership only; explicit re-share and conflict choice required for stale local file");

    const other = await eb.open("src/other.txt", "other path");
    await b.collaborateDocument(other);
    await waitFor(() => b.getState().documentStatus === "shared", "B switches shared document explicitly");
    await waitFor(() => a.getState().sharedFiles.some((file) => file.memberId === "B" && file.documentPath === "src/other.txt"), "explicit file switch updates presence");
    const staleBText = db.getText();
    const aText = da.getText();
    const aIncoming = edits(pa.downstream).length;
    const bIncoming = edits(pb.downstream).length;
    ea.type(da, "A path isolated\ntext");
    eb.type(other, "B other path isolated\ntext");
    await settled(clients);
    assert.equal(db.getText(), staleBText);
    assert.equal(canonical(da.getText()), "A path isolated\ntext");
    assert.equal(canonical(other.getText()), "B other path isolated\ntext");
    assert.equal(edits(pa.downstream).length, aIncoming);
    assert.equal(edits(pb.downstream).length, bIncoming);

    eb.closes.fire(other);
    await waitFor(() => a.getState().sharedFiles.length === 1, "closing B's shared editor clears presence");
    assert.equal(b.getState().sharedDocumentPath, undefined);

    await b.createRoom();
    await waitFor(() => b.getState().roomId && b.getState().roomId !== roomId, "B creates different room");
    assert.deepEqual(b.getState().sharedFiles, []);
    assert.equal(a.getState().sharedFiles.some((file) => file.memberId === "B"), false);
    await b.collaborateDocument(db);
    await waitFor(() => b.getState().documentStatus === "shared", "same document path in different room");
    ea.type(da, "A room isolated\ntext");
    eb.type(db, "B room isolated\ntext");
    await settled(clients);
    assert.equal(canonical(da.getText()), "A room isolated\ntext");
    assert.equal(canonical(db.getText()), "B room isolated\ntext");
    assert.equal(edits(pa.downstream).length, aIncoming);
    assert.equal(edits(pb.downstream).length, bIncoming);
    assert.notEqual(aText, da.getText());
    console.log("PASS: separate document paths in one room and identical paths in different rooms exchange no text");

    for (const editor of editors) await editor.assertUnsaved();
    assert.deepEqual(editors[0].errors, ["CodeMesh paused live sync for src/shared.txt: The server did not confirm the last edit. Your unsaved draft is unchanged. Re-share explicitly to reconcile it with room text."]);
    assert.deepEqual(editors[1].errors, []);
    for (const proxy of proxies) assert.deepEqual(proxy.failures, []);
    console.log("PASS: production two-client live-sync acceptance, all 9 criteria");
  } finally {
    for (const client of clients) client.dispose();
    for (const editor of editors) editor.dismissPrompts();
    for (const proxy of proxies) await proxy.close();
    for (const socket of server.server.clients) socket.terminate();
    await new Promise((resolve) => server.server.close(resolve));
    console.log(`Acceptance disk fixtures: ${root}`);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
