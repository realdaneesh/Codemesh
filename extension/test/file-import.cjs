const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { importPreviewText } = require("../dist/services/fileImport");

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codemesh-import-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await fs.mkdir(workspace); await fs.mkdir(outside);
  const existing = path.join(workspace, "existing.txt");
  const original = "original disk text";
  await fs.writeFile(existing, original);
  const defaults = { isActive: () => true, isDirty: () => false, confirm: async () => true };
  const run = (name, options = {}, text = "received \u4e2d\u6587\r\ntext") => importPreviewText(workspace, name, text, { ...defaults, ...options });
  let confirmations = 0;
  const newFile = await run("src\\new.txt", { confirm: async (destination, exists) => {
    confirmations += 1; assert.equal(destination, path.join(workspace, "src", "new.txt"));
    assert.equal(exists, false); assert.equal(await fs.stat(path.join(workspace, "src")).catch(() => undefined), undefined);
    return true;
  } });
  assert.equal(await fs.readFile(newFile, "utf8"), "received \u4e2d\u6587\r\ntext");
  assert.equal(confirmations, 1);
  console.log("PASS: confirmed new nested file, exact destination and UTF-8/CRLF bytes");

  const before = await fs.readdir(workspace);
  assert.equal(await run("cancel/new.txt", { confirm: async () => false }), undefined);
  assert.equal(await run("existing.txt", { confirm: async (_destination, exists) => { assert.equal(exists, true); return false; } }), undefined);
  assert.deepEqual(await fs.readdir(workspace), before);
  assert.equal(await fs.readFile(existing, "utf8"), original);
  console.log("PASS: cancelled new import and cancelled overwrite leave disk unchanged");

  await run("existing.txt", { confirm: async (destination, exists) => { assert.equal(destination, existing); assert.equal(exists, true); return true; } }, "explicit overwrite");
  assert.equal(await fs.readFile(existing, "utf8"), "explicit overwrite");
  console.log("PASS: existing file changes only after explicit overwrite confirmation");

  await assert.rejects(run("existing.txt", { isDirty: () => true, confirm: async () => { throw new Error("must not prompt a dirty editor"); } }), /unsaved changes/);
  let dirty = false;
  await assert.rejects(run("existing.txt", { isDirty: () => dirty, confirm: async () => { dirty = true; return true; } }), /unsaved changes/);
  assert.equal(await fs.readFile(existing, "utf8"), "explicit overwrite");
  console.log("PASS: dirty editor before or during confirmation blocks overwrite");

  for (const invalid of ["../escape", "/absolute.txt", "C:\\escape.txt", "a/../bad", "a//b", "nul.txt"]) {
    await assert.rejects(run(invalid), /path/);
  }
  console.log("PASS: traversal, absolute, Windows reserved and invalid destination paths rejected");

  const link = path.join(workspace, "linked");
  await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(run("linked/escape.txt"), /symlink/);
  await fs.mkdir(path.join(workspace, "replace"));
  await assert.rejects(run("replace/escape.txt", { confirm: async () => {
    await fs.rmdir(path.join(workspace, "replace"));
    await fs.symlink(outside, path.join(workspace, "replace"), process.platform === "win32" ? "junction" : "dir");
    return true;
  } }), /symlink/);
  assert.deepEqual(await fs.readdir(outside), []);
  console.log("PASS: existing symlink and parent replaced during confirmation cannot escape workspace");

  let active = true;
  await assert.rejects(run("existing.txt", { isActive: () => active, confirm: async () => { active = false; return true; } }), /stale/);
  console.log("PASS: preview invalidated during confirmation cannot write");

  await assert.rejects(run("existing.txt", { confirm: async () => { await fs.writeFile(existing, "external change"); return true; } }), /changed during import/);
  assert.equal(await fs.readFile(existing, "utf8"), "external change");
  console.log("PASS: destination modified during confirmation is not overwritten");

  const rename = fs.rename;
  fs.rename = async () => { throw new Error("injected atomic commit failure"); };
  try { await assert.rejects(run("existing.txt"), /commit failure/); }
  finally { fs.rename = rename; }
  assert.equal(await fs.readFile(existing, "utf8"), "external change");
  const linkFile = fs.link;
  fs.link = async () => { throw new Error("injected new-file commit failure"); };
  try { await assert.rejects(run("failed-new.txt"), /commit failure/); }
  finally { fs.link = linkFile; }
  assert.equal(await fs.stat(path.join(workspace, "failed-new.txt")).catch(() => undefined), undefined);
  const open = fs.open;
  fs.open = async (...args) => {
    const handle = await open(...args);
    if (args[1] === "wx") handle.writeFile = async () => { await handle.write("partial staging"); throw new Error("injected staging failure"); };
    return handle;
  };
  try { await assert.rejects(run("existing.txt"), /staging failure/); }
  finally { fs.open = open; }
  assert.equal(await fs.readFile(existing, "utf8"), "external change");
  assert.ok(!(await fs.readdir(workspace)).some((name) => name.startsWith(".codemesh-import-")));
  console.log("PASS: partial staging and atomic commit failures preserve existing file and remove temporary files");
  console.log("Safe import: 9 focused groups passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
