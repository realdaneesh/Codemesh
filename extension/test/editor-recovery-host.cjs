const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const Module = require('node:module');
const path = require('node:path');
const vscode = require('vscode');
const WebSocket = require('ws');
const { CollaborationServer } = require('../../server/dist/websocket/CollaborationServer');
const { CodeMeshTreeProvider } = require('../dist/providers/CodeMeshTreeProvider');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
  const deadline = Date.now() + 7000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Native recovery condition timed out'); await delay(15); }
}

exports.run = async () => {
  const passed = [];
  const server = new CollaborationServer(0);
  let client, peer, ui, finishApply, error;
  let gateNextApply = false, saves = 0, applyCount = 0;
  const subscriptions = [];
  try {
    server.start();
    await new Promise(resolve => server.server.once('listening', resolve));
    const filename = require.resolve('../dist/services/CodeMeshClient');
    const isolated = new Module(filename, module);
    isolated.filename = filename; isolated.paths = Module._nodeModulePaths(path.dirname(filename));
    const wrappedApply = async edit => {
        applyCount++;
        const gate = gateNextApply; gateNextApply = false;
        const completion = gate ? new Promise(resolve => { finishApply = resolve; }) : undefined;
        const result = await vscode.workspace.applyEdit(edit);
        if (completion) await completion;
        return result;
      };
    // Do not enumerate workspace getters: some belong to guarded proposed APIs.
    const workspaceApi = new Proxy(vscode.workspace, { get: (target, key) => key === 'applyEdit' ? wrappedApply : Reflect.get(target, key) });
    const editorApi = new Proxy(vscode, { get: (target, key) => key === 'workspace' ? workspaceApi : Reflect.get(target, key) });
    isolated.require = id => id === 'vscode' ? editorApi : Module.prototype.require.call(isolated, id);
    isolated._compile(require('node:fs').readFileSync(filename, 'utf8'), filename);
    const url = `ws://127.0.0.1:${server.server.address().port}`;
    client = new isolated.exports.CodeMeshClient({ serverUrl: url, self: { memberId: 'editor', displayName: 'Editor' } });
    const sends = [];
    const originalSend = client.send.bind(client);
    let holdDraft = false;
    client.send = message => {
      sends.push(message);
      if (message.type === 'DOCUMENT_EDIT' && holdDraft) { holdDraft = false; return; }
      return originalSend(message);
    };
    await client.createRoom();
    await waitFor(() => client.getState().roomId);
    const roomId = client.getState().roomId;
    peer = new WebSocket(url);
    const messages = [];
    peer.on('message', raw => messages.push(JSON.parse(raw.toString())));
    await new Promise(resolve => peer.once('open', resolve));
    const send = message => peer.send(JSON.stringify(message));
    const take = async type => {
      await waitFor(() => messages.some(message => message.type === type));
      return messages.splice(messages.findIndex(message => message.type === type), 1)[0];
    };
    send({ type: 'JOIN_ROOM', roomId, member: { memberId: 'peer', displayName: 'Peer' } });
    await take('ROOM_JOINED');
    const documentPath = 'recovery.txt';
    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, documentPath);
    const base = 'alpha\nbeta\ngamma\ndelta\nepsilon\n';
    const mine = base.replace('alpha', 'mine 🚀');
    const room = base.replace('epsilon', 'room 中文');
    const proposed = mine.replace('epsilon', 'room 中文');
    await vscode.workspace.fs.writeFile(uri, Buffer.from(base));
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => saves++));
    await client.collaborateDocument(doc);
    await waitFor(() => client.getState().documentStatus === 'shared');
    send({ type: 'OPEN_DOCUMENT', roomId, documentPath, text: base }); await take('DOCUMENT_SYNC');
    holdDraft = true;
    await editor.edit(edit => edit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), mine));
    send({ type: 'DOCUMENT_EDIT', roomId, documentPath, baseRevision: 0, text: room }); await take('DOCUMENT_ACK');
    await waitFor(() => client.getState().documentStatus === 'conflict');
    ui = await require('./editor-ui.cjs').connect();
    await ui.choose('Preview Combined Text');
    gateNextApply = true;
    await ui.choose('Apply and Share Combined Text');
    await waitFor(() => doc.getText() === proposed && finishApply);
    const applies = applyCount;
    const editSends = sends.filter(message => message.type === 'DOCUMENT_EDIT').length;
    send({ type: 'DOCUMENT_EDIT', roomId, documentPath, baseRevision: 1, text: room.replace('delta', 'latest 2') });
    await take('DOCUMENT_ACK'); await waitFor(() => client.conflict.revision === 2);
    finishApply();
    const noticeVisible = "[...document.querySelectorAll('.monaco-dialog-box')].some(e=>e.offsetWidth>0 && e.innerText.includes('unsaved editor') && e.innerText.includes('NOT shared'))";
    await ui.wait(noticeVisible);
    assert.equal(doc.getText(), proposed); assert.equal(doc.isDirty, true);
    assert.equal(sends.filter(message => message.type === 'DOCUMENT_EDIT').length, editSends);
    const tree = new CodeMeshTreeProvider(client);
    assert.ok(tree.getChildren().some(node => node.label === 'Live Sync' && node.description.includes('NOT shared')));
    tree.dispose();
    passed.push('race: real unsaved editor contains approved proposal; notice and sidebar say NOT shared; no stale edit sent');
    await ui.choose('Cancel');
    await client.inspectRecoveryVersions();
    const recovery = client.conflict.recovery;
    const originalDoc = await vscode.workspace.openTextDocument(recovery.original);
    const proposedDoc = await vscode.workspace.openTextDocument(recovery.proposed);
    const roomDoc = await vscode.workspace.openTextDocument(recovery.room);
    assert.equal(originalDoc.getText(), mine); assert.equal(proposedDoc.getText(), proposed);
    assert.equal(roomDoc.getText(), room.replace('delta', 'latest 2'));
    await vscode.window.showTextDocument(originalDoc);
    await vscode.commands.executeCommand('type', { text: 'forbidden overwrite' });
    assert.equal(originalDoc.getText(), mine);
    assert.ok(vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputTextDiff).length >= 2);
    passed.push('dismissal: all three versions remain accessible through readonly native diff tabs; original draft cannot be typed over');
    for (const revision of [3, 4]) {
      send({ type: 'DOCUMENT_EDIT', roomId, documentPath, baseRevision: revision - 1, text: room.replace('delta', `latest ${revision}`) });
      await take('DOCUMENT_ACK'); await waitFor(() => client.conflict.revision === revision);
      await ui.wait(noticeVisible); await ui.choose('Cancel');
    }
    await client.inspectRecoveryVersions();
    assert.equal((await vscode.workspace.openTextDocument(client.conflict.recovery.room)).getText(), room.replace('delta', 'latest 4'));
    assert.equal(client.conflict.recovery.original.toString(), recovery.original.toString());
    passed.push('repeated revisions: latest room snapshot advances to revision 4; original and applied proposal remain preserved');
    await client.inspectConflictDifferences();
    await ui.wait("[...document.querySelectorAll('.monaco-dialog-box')].some(e=>e.offsetWidth>0 && e.innerText.includes('in your editor has NOT been shared'))");
    await ui.choose('Cancel');
    passed.push('fresh comparison: native dialog still distinguishes editor proposal from shared text; dismissal remains paused');
    client.stopDocumentCollaboration();
    await client.inspectRecoveryVersions();
    assert.equal(doc.getText(), proposed); assert.equal(client.hasRecoveryVersions(), true);
    passed.push('session end: preserved versions remain inspectable without resuming sharing or restoring the editor');
    assert.equal(applyCount, applies); assert.equal(saves, 0);
    assert.equal((await vscode.workspace.fs.readFile(uri)).toString(), base);
    assert.equal(sends.filter(message => message.type === 'DOCUMENT_EDIT').length, editSends);
    passed.push('no side effects: zero recovery edits, zero native saves, unchanged source disk, zero proposal sends');
  } catch (caught) { error = caught.stack || String(caught); }
  finally {
    finishApply?.(); ui?.close(); for (const subscription of subscriptions) subscription.dispose();
    client?.dispose(); peer?.terminate();
    for (const socket of server.server.clients) socket.terminate();
    await new Promise(resolve => server.server.close(resolve));
    await fs.writeFile(process.env.CODEMESH_EDITOR_RESULT, JSON.stringify({ passed, error }, null, 2));
  }
  if (error) throw new Error(error);
};
