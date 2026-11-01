# CodeMesh

CodeMesh's core pilot is two desktop VS Code users on separate PCs in one room.

Start with the [same-LAN two-PC pilot](docs/two-pc-lan-pilot.md). The physical
two-PC test is **OPEN** until actually performed. Production uses
DOCUMENT_EDIT / DOCUMENT_ACK / DOCUMENT_CONFLICT; the Yjs prototype is separate.

The server defaults to loopback only. An explicit `CODEMESH_HOST` private LAN
address enables the trusted-LAN pilot. Do not publish this unauthenticated server
on the public internet, forward its port, or expose it through a tunnel.

Share Workspace publishes a file listing for explicit preview/import. Live edits
require **Share Current File on both PCs**, using the same workspace-relative
file path. It does not automatically live-share every workspace file.

Recipients can run **CodeMesh: Import Workspace Files** (also in Room Actions),
select published files, and review paths, destination workspace and total bytes
before **Confirm Import**. Limits are **50 files, 10 MiB total, 256 KiB per file**;
requests run one at a time. Existing files require a separate **Overwrite**
approval. Cancel stops remaining work and retains completed imports. The
**CodeMesh Import Results** output lists every imported, declined, failed or
cancelled file. Import respects ignore rules and protects dirty editors; it
creates a local project copy and does not save drafts or start live sharing.

## Local Development

Install dependencies:

```bash
npm install
```

Run the WebSocket server:

```bash
npm run server
```

Compile everything:

```bash
npm run compile
```

Compile only the VS Code extension:

```bash
npm run compile -w extension
```

Launch the extension:

1. Open `codemesh/extension` in VS Code.
2. Press `F5` to start an Extension Development Host.
3. Run `CodeMesh: Create Room`.

To verify two clients:

1. Keep the server running with `npm run server`.
2. Start one Extension Development Host and run `CodeMesh: Create Room`.
3. Copy the room ID shown in the CodeMesh sidebar.
4. Start a second Extension Development Host from another VS Code window.
5. Run `CodeMesh: Join Room` and enter the copied room ID.
6. Both sidebars should show the same room and both members.
7. Run `CodeMesh: Leave Room` in the second window. The first window should update to show only its own member.
