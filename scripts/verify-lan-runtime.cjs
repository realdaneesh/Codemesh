// Runs against the extracted VSIX, outside this checkout's node_modules tree.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = fs.realpathSync(process.argv[2]);
const inside = filename => {
  const relative = path.relative(root, filename);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const file of [manifest.main, 'resources/codemesh.svg', 'README.md',
  'node_modules/ws/index.js', 'node_modules/ws/lib/websocket.js', 'node_modules/ws/LICENSE',
  'node_modules/ignore/index.js', 'node_modules/ignore/LICENSE-MIT']) {
  assert.ok(fs.statSync(path.join(root, file)).isFile(), `Missing runtime file: ${file}`);
}
assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['ignore', 'ws']);
for (const file of ['src', 'test', '.vscode', 'server', 'prototypes']) {
  assert.ok(!fs.existsSync(path.join(root, file)), `Unexpected development content: ${file}`);
}
const originalLoad = Module._load;
// VS Code provides this API. Stub it only to load the compiled entry point;
// activation and native editor behavior still require a real VS Code test.
Module._load = function(id, parent, isMain) {
  if (id === 'vscode') return {};
  if (!Module.isBuiltin(id)) {
    const resolved = Module._resolveFilename(id, parent, isMain);
    assert.ok(inside(resolved), `Runtime escaped VSIX: ${id} -> ${resolved}`);
  }
  return originalLoad.call(this, id, parent, isMain);
};
try {
  const runtime = require(path.resolve(root, manifest.main));
  assert.equal(typeof runtime.activate, 'function');
  assert.equal(typeof runtime.deactivate, 'function');
  const isolatedRequire = Module.createRequire(path.join(root, 'package.json'));
  assert.equal(typeof isolatedRequire('ws'), 'function');
  assert.ok(isolatedRequire('ignore')().add('secret.txt').ignores('secret.txt'));
  const files = fs.readdirSync(path.join(root, 'dist'), { recursive: true }).filter(f => f.endsWith('.js'));
  for (const file of files) require(path.join(root, 'dist', file));
  console.log(`Verified ${files.length} compiled JS modules, entry point, icon, ws and ignore inside extracted VSIX.`);
} finally {
  Module._load = originalLoad;
}
