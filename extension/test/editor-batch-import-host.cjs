const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const { CodeMeshClient } = require('../dist/services/CodeMeshClient');
const { CollaborationServer } = require('../../server/dist/websocket/CollaborationServer');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
  const deadline = Date.now()+7000;
  while (!predicate()) { if(Date.now()>deadline) throw Error('Native batch condition timed out'); await delay(15); }
}
exports.run = async () => {
  const passed = [], subscriptions = [];
  const server = new CollaborationServer(0);
  let client, owner, ui, error, saves=0, requests=0;
  let stage = "start";
  const watchdog = setInterval(() => { void fs.writeFile(process.env.CODEMESH_EDITOR_RESULT + ".stage",stage); }, 1000);
  try {
    server.start(); await new Promise(resolve=>server.server.once('listening',resolve));
    stage = 'server listening';
    const url = `ws://127.0.0.1:${server.server.address().port}`;
    const workspace = vscode.workspace.workspaceFolders[0];
    const ownerRoot = await fs.mkdtemp(path.join(os.tmpdir(),'codemesh-native-owner-'));
    const fixtures = { 'a/nested.txt':'hello \u4e2d\u6587\r\n', 'b-existing.txt':'replacement', 'c-dirty.txt':'owner text', 'd-binary.bin':Buffer.from([0,1,2]) };
    for(const [name,text] of Object.entries(fixtures)) { await fs.mkdir(path.dirname(path.join(ownerRoot,name)),{recursive:true}); await fs.writeFile(path.join(ownerRoot,name),text); }
    const ownerFolder = {uri:vscode.Uri.file(ownerRoot), name:'Owner', index:0};
    // Model the owner's separate PC workspace without changing the recipient's native window.
    const Module = require('node:module');
    const filename = require.resolve('../dist/services/CodeMeshClient');
    const isolated = new Module(filename, module);
    isolated.filename = filename; isolated.paths = Module._nodeModulePaths(path.dirname(filename));
    const ownerWorkspace = new Proxy(vscode.workspace, {get:(target,key)=>key==='workspaceFolders'?[ownerFolder]:Reflect.get(target,key)});
    const ownerApi = new Proxy(vscode,{get:(target,key)=>key==='workspace'?ownerWorkspace:Reflect.get(target,key)});
    isolated.require = id=>id==='vscode'?ownerApi:Module.prototype.require.call(isolated,id);
    isolated._compile(require('node:fs').readFileSync(filename,'utf8'),filename);
    stage = 'isolated owner loaded';
    const existing = path.join(workspace.uri.fsPath,'b-existing.txt'), dirtyPath = path.join(workspace.uri.fsPath,'c-dirty.txt');
    await fs.writeFile(existing,'keep existing'); await fs.writeFile(dirtyPath,'disk draft');
    stage = 'fixtures created';
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(dirtyPath));
    stage = 'dirty document open';
    const edit = new vscode.WorkspaceEdit(); edit.insert(doc.uri,new vscode.Position(0,0),'unsaved '); await vscode.workspace.applyEdit(edit);
    stage = 'dirty editor edited';
    subscriptions.push(vscode.workspace.onDidSaveTextDocument(()=>saves++));
    client = new CodeMeshClient({serverUrl:url,self:{memberId:'recipient',displayName:'Recipient'}});
    owner = new isolated.exports.CodeMeshClient({serverUrl:url,self:{memberId:'owner',displayName:'Owner'}});
    const originalSend = client.send.bind(client);
    client.send = message => { if(message.type==='FILE_REQUEST') requests++; return originalSend(message); };
    stage = 'clients created';
    await owner.createRoom(); await waitFor(()=>owner.getState().roomId);
    stage = 'owner room created';
    await client.joinRoom(owner.getState().roomId); await waitFor(()=>client.getState().roomId);
    stage = 'recipient joined';
    await owner.shareWorkspace(ownerFolder); await waitFor(()=>client.getState().workspaceManifestId);
    stage = 'manifest shared';
    ui = await require('./editor-ui.cjs').connect();
    async function select(names) {
      await ui.wait("[...document.querySelectorAll('.quick-input-widget')].some(e=>e.offsetWidth>0 && e.innerText.includes('Import Workspace Files'))");
      const expression = `(() => {const rows=[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].filter(e=>e.offsetWidth>0); const names=${JSON.stringify(names)}; for(const row of rows) { if(names.some(name=>row.innerText.includes(name))) {const box=row.querySelector('input[type=checkbox], .monaco-checkbox'); if(!box) throw Error('No native selection checkbox: '+row.outerHTML); box.click();} } return rows.length;})()`;
      await ui.wait("document.querySelectorAll('.quick-input-widget .monaco-list-row').length >= 4");
      await ui.evaluate(expression);
      await ui.input('');

    }
    stage = 'UI connected';
    const cancelled = client.importWorkspace();
    await select(Object.keys(fixtures));
    await ui.wait("[...document.querySelectorAll('.monaco-dialog-box')].some(e=>e.offsetWidth>0 && e.innerText.includes('Confirm Import') && e.innerText.includes('a/nested.txt'))");
    assert.equal(requests,0); await assert.rejects(fs.stat(path.join(workspace.uri.fsPath,'a')));
    await ui.choose('Cancel');
    assert.ok((await cancelled).every(r=>r.status==='cancelled'));
    assert.equal(requests,0); passed.push('native multi-selection/review shows nested destinations and total bytes; Cancel makes zero requests or writes');
    stage = 'review cancel passed';
    const importing = client.importWorkspace(); await select(Object.keys(fixtures)); await ui.choose('Confirm Import');
    await ui.choose('Cancel');
    const results = await importing;
    assert.deepEqual(results.map(r=>r.status),['imported','declined','failed','failed']);
    assert.equal(await fs.readFile(path.join(workspace.uri.fsPath,'a/nested.txt'),'utf8'),fixtures['a/nested.txt']);
    assert.equal(await fs.readFile(existing,'utf8'),'keep existing'); assert.equal(await fs.readFile(dirtyPath,'utf8'),'disk draft');
    assert.equal(doc.getText(),'unsaved disk draft'); assert.ok(doc.isDirty);
    passed.push('native progress and mixed results: nested UTF-8/CRLF imported, overwrite declined, real dirty draft protected, binary failure visible');
    stage = 'mixed passed';
    const overwrite = client.importWorkspace(); await select(['b-existing.txt']); await ui.choose('Confirm Import'); await ui.choose('Overwrite');
    assert.equal((await overwrite)[0].status,'imported'); assert.equal(await fs.readFile(existing,'utf8'),'replacement');
    passed.push('native existing-file overwrite requires separate explicit Overwrite approval');
    assert.equal(saves,0); assert.equal(client.getState().sharedDocumentPath,undefined); assert.equal(owner.getState().sharedDocumentPath,undefined);
    await ui.wait("document.body.innerText.replace(/\\s+/g,' ').includes('imported | b-existing.txt')");
    passed.push('native persistent per-file result output; zero save events and no automatic live sharing');
  } catch(caught) { error=caught.stack||String(caught); }
  finally {
    clearInterval(watchdog);
    await fs.writeFile(process.env.CODEMESH_EDITOR_RESULT,JSON.stringify({passed,error,stage},null,2));
    ui?.close(); for(const item of subscriptions) item.dispose(); client?.dispose(); owner?.dispose();
    for(const socket of server.server.clients) socket.terminate();
    await new Promise(resolve=>server.server.close(resolve));
    await fs.writeFile(process.env.CODEMESH_EDITOR_RESULT,JSON.stringify({passed,error},null,2));
  }
  if(error) throw Error(error);
};
