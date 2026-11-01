# Reviewed workspace batch import

Implemented 2026-10-23. Production remains on DOCUMENT_EDIT / DOCUMENT_ACK /
DOCUMENT_CONFLICT. No automatic multi-file live sync was added; prototypes/yjs
was left untouched. Physical two-PC and 15-minute stability checks remain OPEN.

Use CodeMesh: Import Workspace Files from the Command Palette or Room Actions.
A recipient selects files from another member's explicitly shared manifest, picks
an open local destination workspace, then reviews all relative destinations,
per-file sizes and total bytes before Confirm Import. The path layout is preserved.
Limits: 50 files, 10 MiB (10,485,760 bytes) total, 256 KiB (262,144 bytes) per file.
Only one content request runs at a time, using the existing FILE_REQUEST flow.
There are no content requests or local filesystem writes before confirmation.

Each owner request uses the existing publication identity, stat, ignore, path,
symlink and content checks. Each destination uses containment, full-chain link
checks, root/file identity, local default/gitignore exclusions and dirty-editor
checks before staging and committing. A local rule change during confirmation
can block the write. New files use no-clobber commit; existing files need their
own explicit Overwrite approval. Declining keeps the file unchanged.

The cancellable progress notification processes files sequentially. Individual
failures continue to the next eligible file; cancellation, disconnect or manifest
refresh invalidate remaining work. Completed writes remain imported. CodeMesh
Import Results retains a row for every selected file: imported, declined, failed
or cancelled, with the reason/destination. No rollback or local file deletion is
performed. Temporary staging artifacts are cleaned up using the existing helper.
No editor drafts are saved and no live sharing starts. Share Current File is still
required on each PC for live edits to the corresponding file.

Validation (commands run from codemesh):

| Check | Exact final result |
| --- | --- |
| `npm run compile` | Server and extension passed; extension recompiled after final production fix |
| `npm run test:import -w extension` | 9 existing single-file groups + 11 batch groups passed |
| `npm run test:files -w extension` | 11 groups passed, including real production client/server batch requests, binary failure, declined overwrite, progress cancellation and manifest refresh |
| `npm run test:files -w server` | 3 protocol/authorization/cancellation groups passed |
| `npm run test:manifest -w extension` | Passed: validation, scanner/ignore and client/command lifecycle coverage |
| `npm run test:acceptance -w extension` | All 9 production acceptance criteria passed after final production fix |
| Native batch editor suite | INCOMPLETE; no completed passing run claimed |

Focused batch coverage includes nested UTF-8 paths/content, mixed successes and
failures, cancellation during requests and after a commit, manifest invalidation
during requests and after a commit, malicious/excluded paths, case collisions,
existing-file approvals/declines, dirty editors, junctions, changing ignore rules,
size mismatches, exact batch limits, and zero requests/writes before approval.

Five native launch attempts were made. The first was blocked before execution by
Windows sandbox ACLs. The second timed out during a harness workspace-folder
change. Two later runs reached real multi-selection, destination/size review,
Cancel and per-file result output; they stalled because the production command
awaited dismissal of its final information notification. Native DOM inspection
showed all four files cancelled, zero requests and no imported directory. That
production wait was fixed to send the notification without awaiting dismissal.
The final attempt, using the fixed build, was blocked at startup by VS Code's
active update mutex ("Code is currently being updated"). Consequently the full
native mixed-result/overwrite/dirty-editor flow is still unverified. Isolated
native profiles now disable auto-updates; installed editor settings were not
changed. The harness models the owner's separate workspace through a workspace
folder API proxy, while using real owner disk files, both production clients,
the real production server, and native recipient documents/dialogs.

Native failure artifact for the fixed-build attempt:
`C:\Users\danee\AppData\Local\Temp\codemesh-editor-4153YC`.
Earlier observed review/cancel UI artifacts:
`C:\Users\danee\AppData\Local\Temp\codemesh-editor-mEIwqg`.

Rerun after the installed VS Code update completes (PowerShell, from codemesh):

```powershell
$env:CODEMESH_VSCODE_PATH = 'C:\Users\danee\Documents\Microsoft VS Code\Code.exe'
$env:CODEMESH_EDITOR_SUITE = (Resolve-Path extension/test/editor-batch-import-host.cjs).Path
npm.cmd run test:editor -w extension
```

Still OPEN: completed native batch editor suite, physical two-PC import/live-share
pilot, and 15-minute physical two-host stability check. Automated two-client
acceptance is not evidence that those physical checks passed.
