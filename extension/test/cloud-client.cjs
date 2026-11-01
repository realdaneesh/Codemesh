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
  const adapter = { configuredUrl, saves: 0, previews: [], confirmations: [], warnings: [], invites: [], joinAllowed: true, logs: [] };
  const folder = { name: path.basename(root), uri: uri('file', root) };
  const changes = new Emitter(), closes = new Emitter(), documents = [];
  let provider;
  const vscode = {
    env: { clipboard: { writeText: async value => adapter.invites.push(value) } },
    EventEmitter: Emitter, EndOfLine: { LF: 1, CRLF: 2 },
    Uri: { from: value => uri(value.scheme, value.path, value.query) },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    WorkspaceEdit: class { constructor() { this.entries = []; } replace(target, range, text) { this.entries.push({ target, range, text }); } },
    commands: { executeCommand: async () => undefined },
    workspace: {
      workspaceFolders: [folder], textDocuments: documents,
      getConfiguration: () => ({ get: (key, fallback) => key === 'connectionMode' ? 'cloud' : key === 'serverUrl' ? (adapter.configuredUrl ?? fallback) : fallback }),
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
      createOutputChannel: () => ({ appendLine(value) { adapter.logs.push(value); }, dispose() {} }),
      showInformationMessage() {}, showErrorMessage() {},
      showInputBox: async value => value.password ? "test-only-host-key-32-bytes-xxxxxxxx" : value.value,
      showWarningMessage: async (message, _options, ...choices) => {
        adapter.warnings.push(message);
        if (choices.includes("Join")) return adapter.joinAllowed ? "Join" : undefined;
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
  const https = require('node:https'), http = require('node:http');
  const server = new CollaborationServer(0, { host: '127.0.0.1', cloud: { hostKey: 'test-only-host-key-32-bytes-xxxxxxxx' } }); server.start();
  await new Promise(resolve => server.server.once('listening', resolve));
  const port = server.server.address().port;
  const tls = https.createServer({ key: require('node:fs').readFileSync(process.env.CODEMESH_TEST_TLS_KEY), cert: require('node:fs').readFileSync(process.env.CODEMESH_TEST_TLS_CERT) });
  const tunnels = new Set();
  tls.on('connection', socket => { tunnels.add(socket); socket.on('close', () => tunnels.delete(socket)); });
  tls.on('upgrade', (request, socket, head) => {
    const upstream = http.request({ hostname: '127.0.0.1', port, path: request.url, headers: request.headers });
    upstream.on('upgrade', (response, target, targetHead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers).map(([k,v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
      if (head.length) target.write(head); if (targetHead.length) socket.write(targetHead);
      socket.pipe(target); target.pipe(socket);
      socket.on('close', () => target.destroy()); target.on('error', () => socket.destroy());
    });
    upstream.on('error', () => socket.destroy()); upstream.end();
  });
  await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));
  return { server, url: `wss://127.0.0.1:${tls.address().port}`,
    async close() { for (const socket of tunnels) socket.destroy(); await new Promise(resolve => tls.close(resolve)); server.shutdown(); } };
}
test('cloud production clients over TLS, invitation confirmation, separate roots: room, preview/import, explicit single-file shares, unsaved edits and reconnect preservation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codemesh-lan-pilot-'));
  const rootA = path.join(root, 'PC-A-project'), rootB = path.join(root, 'PC-B-independent-project');
  await fs.mkdir(path.join(rootA, 'src'), { recursive: true }); await fs.mkdir(rootB);
  const relative = 'src/shared.txt', initial = 'pilot baseline\n';
  await fs.writeFile(path.join(rootA, relative), initial);
  const fixture = await serverFixture(), a = editor(rootA, fixture.url), b = editor(rootB, fixture.url);
  try {
    await a.client.createRoom(); await waitFor(() => a.client.getState().roomId);
    const room = a.client.getState().roomId;
    await waitFor(() => a.invites.length);
    assert.equal(a.invites.length, 1);
    b.joinAllowed = false;
    await b.client.joinInvitation(a.invites[0]);
    assert.equal(b.client.socket, undefined, 'Cancel must not connect');
    b.joinAllowed = true;
    await assert.rejects(b.client.joinRoom(room), /invitation/i);
    await b.client.joinInvitation(a.invites[0]); await waitFor(() => b.client.getState().roomId === room);
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
    assert.ok(!a.logs.concat(b.logs).join("\n").includes(a.invites[0]), 'invitation not logged');
    assert.ok(!a.logs.concat(b.logs).join("\n").includes('test-only-host-key-32-bytes-xxxxxxxx'), 'host key not logged');
    assert.equal(await fs.readFile(da.uri.fsPath, 'utf8'), initial);
    assert.equal(await fs.readFile(db.uri.fsPath, 'utf8'), initial);
  } finally {
    a.client.dispose(); b.client.dispose(); await fixture.close();
    console.log('Separate-root pilot fixtures: ' + root);
  }
});

test('explicit cloud mode refuses plaintext before opening a socket', async () => {
  const a = editor(path.join(os.tmpdir(), 'cloud-plaintext'), 'ws://127.0.0.1:3977');
  try { await assert.rejects(a.client.createRoom(), /requires wss/); assert.equal(a.client.socket, undefined); }
  finally { a.client.dispose(); }
});
