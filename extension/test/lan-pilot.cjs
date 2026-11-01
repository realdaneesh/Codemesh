const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const net = require('node:net');
const { CollaborationServer } = require('../../server/dist/websocket/CollaborationServer');
const { DEFAULT_SERVER_URL, validateServerUrl } = require('../dist/services/serverConnection');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
  const until = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > until) throw new Error('Pilot condition timed out'); await pause(5); }
}
class Emitter {
  constructor() { this.listeners = new Set(); this.event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
  fire(value) { for (const listener of [...this.listeners]) listener(value); }
  dispose() { this.listeners.clear(); }
}
function uri(scheme, fsPath, query = '') {
  return { scheme, fsPath, path: fsPath, query, toString: () => `${scheme}:${fsPath}?${query}` };
}
function editor(root, configuredUrl, options = {}) {
  const adapter = { configuredUrl, saves: 0, previews: [], confirmations: [], warnings: [] };
  const folder = { name: path.basename(root), uri: uri('file', root) };
  const changes = new Emitter(), closes = new Emitter(), documents = [];
  let provider;
  const vscode = {
    EventEmitter: Emitter, EndOfLine: { LF: 1, CRLF: 2 },
    Uri: { from: value => uri(value.scheme, value.path, value.query) },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    WorkspaceEdit: class { constructor() { this.entries = []; } replace(target, range, text) { this.entries.push({ target, range, text }); } },
    commands: { executeCommand: async () => undefined },
    workspace: {
      workspaceFolders: [folder], textDocuments: documents,
      getConfiguration: () => ({ get: (key, fallback) => key === 'serverUrl' ? (adapter.configuredUrl ?? fallback) : fallback }),
      getWorkspaceFolder: target => target.fsPath.startsWith(root + path.sep) ? folder : undefined,
      asRelativePath: target => path.relative(root, target.fsPath).replaceAll('\\', '/'),
      onDidChangeTextDocument: changes.event, onDidCloseTextDocument: closes.event,
      registerTextDocumentContentProvider: (_scheme, value) => { provider = value; return { dispose() {} }; },
      openTextDocument: async target => ({ uri: target, isDirty: false, getText: () => provider.provideTextDocumentContent(target) }),
      applyEdit: async edit => {
        for (const entry of edit.entries) {
          const doc = documents.find(candidate => candidate.uri.toString() === entry.target.toString());
          assert.ok(doc, 'edit must target this PC workspace');
          adapter.type(doc, entry.text);
        }
        return true;
      },
      saveAll: async () => { adapter.saves++; throw new Error('Unexpected saveAll'); }
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      showInformationMessage() {}, showErrorMessage() {},
      showInputBox: async value => value.value,
      showWarningMessage: async (message, _options, ...choices) => {
        adapter.warnings.push(message);
        if (choices.includes('Import')) { adapter.confirmations.push(message); return 'Import'; }
      },
      showTextDocument: async document => { adapter.previews.push(document); vscode.window.activeTextEditor = { document }; }
    }
  };
  const filename = require.resolve('../dist/services/CodeMeshClient');
  const isolated = new Module(filename, module);
  isolated.filename = filename; isolated.paths = Module._nodeModulePaths(path.dirname(filename));
  isolated.require = id => id === 'vscode' ? vscode : Module.prototype.require.call(isolated, id);
  isolated._compile(require('node:fs').readFileSync(filename, 'utf8'), filename);
  adapter.client = new isolated.exports.CodeMeshClient({ reconnectDelayMs: 15,
    self: { memberId: path.basename(root), displayName: path.basename(root) }, ...options });
  adapter.folder = folder;
  adapter.open = async relative => {
    const fullPath = path.join(root, relative);
    const doc = { uri: uri('file', fullPath), text: await fs.readFile(fullPath, 'utf8'), isDirty: false, eol: 1,
      getText() { return this.text; }, positionAt(offset) { return { offset }; },
      save: async () => { adapter.saves++; throw new Error('Unexpected save'); } };
    documents.push(doc); return doc;
  };
  adapter.type = (doc, text) => { doc.text = text; doc.isDirty = true; changes.fire({ document: doc, contentChanges: [{ text }] }); };
  return adapter;
}
async function serverFixture() {
  const server = new CollaborationServer(0); server.start();
  await new Promise((resolve, reject) => { server.server.once('listening', resolve); server.server.once('error', reject); });
  return { server, url: `ws://127.0.0.1:${server.server.address().port}`,
    async close() { for (const socket of server.server.clients) socket.terminate(); await new Promise(resolve => server.server.close(resolve)); } };
}

test('existing user setting defaults to ws://localhost:3977', () => {
  assert.equal(DEFAULT_SERVER_URL, 'ws://localhost:3977');
  assert.equal(require('../package.json').contributes.configuration.properties['codemesh.serverUrl'].default, DEFAULT_SERVER_URL);
  assert.equal(validateServerUrl(DEFAULT_SERVER_URL), 'ws://localhost:3977/');
  assert.equal(validateServerUrl('ws://192.168.1.10:3977'), 'ws://192.168.1.10:3977/');
  assert.equal(validateServerUrl('wss://lan-host.example:443/sync'), 'wss://lan-host.example/sync');
});
for (const value of ['', '192.168.1.10:3977', 'http://localhost:3977', 'ws://', 'ws://host:99999',
  'ws://user:secret@host:3977', 'ws://host?token=secret', 'ws://host/#secret', 'ws://0.0.0.0:3977', 'ws://[::]:3977']) {
  test(`invalid URL is rejected without connecting: ${value.replaceAll('secret', '[redacted]')}`, async () => {
    const adapter = editor(path.join(os.tmpdir(), 'invalid-url'), value);
    try {
      await assert.rejects(adapter.client.createRoom(), /Invalid codemesh.serverUrl/);
      assert.equal(adapter.client.socket, undefined);
      assert.equal(adapter.client.getState().connectionState, 'disconnected');
    } finally { adapter.client.dispose(); }
  });
}
test('runtime user configuration selects the server; explicit test option takes precedence', async () => {
  const fixture = await serverFixture();
  const configured = editor(path.join(os.tmpdir(), 'configured'), fixture.url);
  const overridden = editor(path.join(os.tmpdir(), 'override'), 'invalid workspace URL', { serverUrl: fixture.url });
  try {
    await configured.client.createRoom(); await waitFor(() => configured.client.getState().roomId);
    await overridden.client.joinRoom(configured.client.getState().roomId);
    await waitFor(() => overridden.client.getState().members.length === 2);
  } finally { configured.client.dispose(); overridden.client.dispose(); await fixture.close(); }
});
test('connection refusal reports actionable failure without sharing or saving a draft', async () => {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const adapter = editor(path.join(os.tmpdir(), 'offline'), `ws://127.0.0.1:${port}`);
  try {
    await assert.rejects(adapter.client.createRoom(), /Cannot connect to CodeMesh.*LAN\/firewall/);
    await waitFor(() => adapter.client.getState().connectionState === 'disconnected');
    assert.equal(adapter.client.getState().roomId, undefined); assert.equal(adapter.saves, 0);
  } finally { adapter.client.dispose(); }
});
test('unresponsive WebSocket handshake times out instead of hanging indefinitely', async () => {
  const sockets = new Set();
  const hung = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => hung.listen(0, '127.0.0.1', resolve));
  const adapter = editor(path.join(os.tmpdir(), 'timeout'), `ws://127.0.0.1:${hung.address().port}`, { connectionTimeoutMs: 50 });
  try { await assert.rejects(adapter.client.createRoom(), /Cannot connect to CodeMesh/); }
  finally { adapter.client.dispose(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => hung.close(resolve)); }
});
test('two distinct PC roots: room, preview/import, explicit single-file shares, unsaved edits and reconnect preservation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codemesh-lan-pilot-'));
  const rootA = path.join(root, 'PC-A-project'), rootB = path.join(root, 'PC-B-independent-project');
  await fs.mkdir(path.join(rootA, 'src'), { recursive: true }); await fs.mkdir(rootB);
  const relative = 'src/shared.txt', initial = 'pilot baseline\n';
  await fs.writeFile(path.join(rootA, relative), initial);
  const fixture = await serverFixture(), a = editor(rootA, fixture.url), b = editor(rootB, fixture.url);
  try {
    await a.client.createRoom(); await waitFor(() => a.client.getState().roomId);
    const room = a.client.getState().roomId;
    await b.client.joinRoom(room); await waitFor(() => b.client.getState().roomId === room);
    await a.client.shareWorkspace(a.folder); await waitFor(() => b.client.getState().workspaceManifestId);
    const preview = await b.client.requestFile(relative);
    assert.equal(b.previews.at(-1).getText(), initial);
    await assert.rejects(fs.stat(path.join(rootB, relative)), { code: 'ENOENT' });
    assert.equal(await b.client.importFile(preview), path.join(rootB, relative));
    assert.equal(b.confirmations.length, 1);
    assert.equal(b.client.getState().sharedDocumentPath, undefined, 'import is not live sharing');
    const da = await a.open(relative), db = await b.open(relative);
    assert.notEqual(da.uri.fsPath, db.uri.fsPath);
    await a.client.collaborateDocument(da); await waitFor(() => a.client.getState().documentStatus === 'shared');
    assert.equal(b.client.getState().sharedDocumentPath, undefined, 'both PCs must explicitly share');
    await b.client.collaborateDocument(db); await waitFor(() => b.client.getState().documentStatus === 'shared');
    assert.equal(a.client.getState().sharedDocumentPath, relative); assert.equal(b.client.getState().sharedDocumentPath, relative);
    a.type(da, 'A unsaved 🚀\n'); await waitFor(() => db.getText() === da.getText() && !a.client.documentEditInFlight);
    b.type(db, 'B unsaved 中文\n'); await waitFor(() => da.getText() === db.getText() && !b.client.documentEditInFlight);
    const previousSession = b.client.presenceSessionId;
    b.client.socket.terminate();
    await waitFor(() => b.client.getState().roomId === room && b.client.presenceSessionId !== previousSession);
    assert.equal(b.client.getState().sharedDocumentPath, undefined, 'reconnect restores membership only');
    b.type(db, 'B offline draft preserved\n');
    a.type(da, 'A changed while B unshared\n'); await waitFor(() => !a.client.documentEditInFlight);
    await b.client.collaborateDocument(db); await waitFor(() => b.client.getState().documentStatus === 'conflict');
    assert.equal(db.getText(), 'B offline draft preserved\n');
    assert.equal(b.client.conflict.text, da.getText());
    assert.equal(a.saves + b.saves, 0);
    assert.equal(await fs.readFile(da.uri.fsPath, 'utf8'), initial);
    assert.equal(await fs.readFile(db.uri.fsPath, 'utf8'), initial);
  } finally {
    a.client.dispose(); b.client.dispose(); await fixture.close();
    console.log('Separate-root pilot fixtures: ' + root);
  }
});

// Existing WSS LAN transports retain the legacy protocol unless explicitly opted in.
test('WSS LAN compatibility defaults to legacy admission', () => {
  const a = editor(path.join(os.tmpdir(), 'lan-wss-default'), 'wss://localhost:3977');
  assert.equal(a.client.cloudMode, false);
  assert.equal(require('../package.json').contributes.configuration.properties['codemesh.connectionMode'].default, 'lan');
  a.client.dispose();
});
