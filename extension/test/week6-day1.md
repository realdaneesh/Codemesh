# Week 6 Day 1: production conflict inspection

The production single-file protocol remains DOCUMENT_EDIT / DOCUMENT_ACK /
DOCUMENT_CONFLICT. No automatic merge was added. No files under prototypes/yjs
were changed.

Choose **Inspect Differences** in the conflict dialog to open a read-only VS Code
diff with **My unsaved draft** on the left and **Room text** on the right. Its
title includes the shared relative path and room revision. Cancel leaves the
draft in its original editor and keeps synchronization blocked. To inspect again
after dismissal, run **CodeMesh: Inspect Differences** from the Command Palette
or select **Inspect Differences** in **CodeMesh: Room Actions**.

New room text invalidates the existing comparison and adds a STALE banner to
both snapshot documents. A fresh inspection is required before Retry Mine or
Use Room Text. Choices are bound to a conflict object, room, relative path and
local share-session generation. Editing the draft after inspecting also requires
a fresh inspection before applying a text choice. End Sharing remains available.
Opening and closing comparisons do not apply edits, save files or resume sync.
Snapshot text stays in the local content provider, outside logs and presence.

Validation completed on 2026-10-18:

- `npm run compile`: server and extension passed.
- `node extension/test/sync.cjs`: passed, including dismissal recovery, immutable
  snapshots, stale room/draft choices, repeated conflicts, explicit End Sharing,
  delayed choices after re-share/leave/disconnect, and no inspection edit/apply.
- `node server/test/document-sync.cjs`: passed.
- `node extension/test/live-sync-acceptance.cjs`: passed against the production
  server, including inspection before Retry Mine and Use Room Text, competing
  edits, no echo and unchanged disk.
- `server/test/smoke.cjs`: passed against a fresh production server on an
  ephemeral port.
- `npm run test:editor -w extension`: **31 native checks executed and passed**,
  including **7 conflict checks**. Native checks verify readonly content,
  canceled dialogs, real diff tabs, stale content-provider refresh, explicit
  resolution, leave/disconnect invalidation, unchanged source disk and zero
  save events. The installed editor required launch outside the filesystem
  sandbox; the initial sandbox launch failed before executing any checks.

Native report: `C:\Users\danee\AppData\Local\Temp\codemesh-editor-U6QQcB\result.json`.

Remaining manual visual check: inspect the side-by-side diff labels, path/revision
title and STALE banner for readability at narrow window widths and in the user's
theme. Native automation verified content and behavior, but no human visual
review was performed.
