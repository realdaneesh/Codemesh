# Same-LAN two-PC pilot — physical test OPEN

Goal: two users in desktop VS Code on separate Windows PCs, connected to one
CodeMesh room. **The physical two-PC pilot and 15-minute stability test are OPEN.**
Automated tests on one computer do not establish cross-PC reachability.

Use a trusted private LAN and disposable test files. This server has no
authentication, authorization boundary between trusted room members, or transport
encryption. A room ID is not a password. Do not forward TCP 3977 in the router,
use a public tunnel, or deploy this server to the public internet. No public
deployment or firewall changes are performed by the automated tests.

## 1. PC A: build the server and installable extension

Install desktop VS Code **1.96 or newer on both PCs**. PC A also needs Node.js/npm
(packaging was checked with Node 24.13.1 and npm 11.8.0). PC B needs only VS Code
and the VSIX; do not copy node_modules or install the source project there.

On PC A, copy this `codemesh` source folder to its own local disk, for example
`C:\CodeMesh\codemesh`, including package-lock.json and both workspace packages.
Open normal PowerShell (not Administrator) and run:

```powershell
Set-Location C:\CodeMesh\codemesh
npm ci
npm run compile
npm run package:lan-vsix
```

Stop if any command reports an error. The last command recompiles the extension,
creates `artifacts\codemesh-0.0.1-lan-pilot.vsix`, extracts it to a temporary folder,
and checks its compiled modules and runtime dependencies in isolation. Expect
`VSIX archive and isolated runtime check passed`. To check the archive again:

```powershell
npm run verify:lan-vsix
Get-FileHash .\artifacts\codemesh-0.0.1-lan-pilot.vsix -Algorithm SHA256
```

The VSIX includes `dist/extension.js`, the other compiled `dist` modules,
`resources/codemesh.svg`, package metadata, README, and the complete pure-JS
runtime packages `ws` and `ignore` (with licenses). It excludes extension source,
tests, server and Yjs prototype. Packaging does not publish to the Marketplace.
The verifier loads modules using a stub for the VS Code API; it does not activate
the extension in a real editor or establish two-PC behavior.

Copy that one VSIX to PC B using a USB drive or other trusted transfer, for
example to `C:\CodeMeshPilotInstall\codemesh-0.0.1-lan-pilot.vsix`. Keep the same
file for PC A. On PC B, optionally compare its SHA256 with PC A's output:

```powershell
Get-FileHash C:\CodeMeshPilotInstall\codemesh-0.0.1-lan-pilot.vsix -Algorithm SHA256
```

Different hashes mean the files differ; copy again before installing.

Use independent collaboration roots, **not a network share, common OneDrive
folder, or the extension source checkout**. On PC A:

```powershell
New-Item -ItemType Directory -Force C:\CodeMeshPilot-A\src | Out-Null
Set-Content -LiteralPath C:\CodeMeshPilot-A\src\shared.txt -Value 'CodeMesh LAN pilot baseline' -Encoding ascii
```

On PC B create an empty independent workspace:

```powershell
New-Item -ItemType Directory -Force C:\CodeMeshPilot-B | Out-Null
```

## 2. Find the LAN addresses and check the network profile

On **both PCs**, in PowerShell:

```powershell
Get-NetIPConfiguration | Select-Object InterfaceIndex, InterfaceAlias, @{Name='IPv4';Expression={$_.IPv4Address.IPAddress}}, @{Name='Gateway';Expression={$_.IPv4DefaultGateway.NextHop}}
Get-NetConnectionProfile
```

Select the active Ethernet/Wi-Fi LAN interface, not a VPN, virtual adapter or
public/WAN address. Write down both IPv4 addresses. Examples below assume PC A
is **192.168.1.10** and PC B is **192.168.1.11**; replace them with the real values.
The PCs must be on the same reachable subnet. Guest Wi-Fi/client isolation can
prevent peer connections even on the same router.

The trusted LAN profile on PC A must be **Private** for the scoped firewall rule
below. If it is Public, only on a network you control and trust, use Windows
Settings → Network & internet → the active connection → Network profile → Private.
Do not change an untrusted network to Private just to make the pilot work.

## 3. PC A: allow only PC B to reach the Node listener

Open **PowerShell as Administrator on PC A**. Use the actual LAN addresses and
the same Node installation used by `npm start`:

```powershell
$pilotLanIp = '192.168.1.10'
$pilotPeerIp = '192.168.1.11'
$pilotNodeExe = (Get-Command node.exe).Source
New-NetFirewallRule -Name 'CodeMesh-LAN-Pilot-3977' -DisplayName 'CodeMesh LAN pilot from PC B' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3977 -LocalAddress $pilotLanIp -RemoteAddress $pilotPeerIp -Profile Private -Program $pilotNodeExe -EdgeTraversalPolicy Block
```

This rule is restricted to TCP 3977, PC A's chosen interface, PC B's IP, the Node
executable and the Private profile. Do not add a Public/Any-profile rule or disable
Windows Firewall. Cancel a generic Node firewall prompt instead of granting
broader access. Review existing broad Node allow rules in Windows Defender
Firewall with Advanced Security; another allow rule can also permit traffic.
If the named rule already exists, remove that pilot rule using the cleanup
command below before recreating it with the correct addresses.

Reference: Microsoft's [New-NetFirewallRule documentation](https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule).

## 4. PC A: explicitly bind the server to its private LAN IP

In a **normal PowerShell** terminal on PC A, keep the following process running:

```powershell
Set-Location C:\CodeMesh\codemesh
$env:CODEMESH_HOST = '192.168.1.10'
$env:CODEMESH_PORT = '3977'
npm run start -w server
```

Wait for `listening on ws://192.168.1.10:3977`. The host setting is explicit:

| Setting | Behavior |
| --- | --- |
| CODEMESH_HOST unset | Binds only 127.0.0.1; usable locally, not from PC B |
| CODEMESH_HOST = a specific private IPv4 | Opts into this LAN-interface listener |
| Wildcard/public address | Rejected by this pilot server |
| CODEMESH_PORT unset | 3977; explicit runtime values must be 1–65535 |

Accepted LAN IPv4 ranges are 10.x.x.x, 172.16–31.x.x and 192.168.x.x. The selected
address must actually belong to PC A. `::1` is also supported for IPv6 loopback;
this pilot's LAN instructions use IPv4. Binding a LAN address does not also bind
localhost: **PC A's extension must use the LAN URL too** during this pilot.

On **PC B**, verify the network path before opening a room:

```powershell
Test-NetConnection -ComputerName 192.168.1.10 -Port 3977
```

Require `TcpTestSucceeded : True`. If false, check the server process, IP, Private
profile, firewall scope and Wi-Fi isolation. A successful ping alone is insufficient.
`EADDRNOTAVAIL` on PC A means the chosen address is not assigned to it;
`EADDRINUSE` means another process already occupies that listener/port.

## 5. Install the VSIX and configure both VS Code windows

Use normal desktop VS Code windows on each PC. Close old CodeMesh Extension
Development Host windows so the pilot uses the installed build.

On **PC B**:

1. Open VS Code. Press **Ctrl+Shift+X** to open Extensions.
2. Click the **...** menu at the top of the Extensions panel and choose
   **Install from VSIX...**.
3. Select `C:\CodeMeshPilotInstall\codemesh-0.0.1-lan-pilot.vsix` and click Install.
   Confirm the publisher trust prompt only for this file you built and transferred.
4. Press **Ctrl+Shift+P**, run **Developer: Reload Window**.
5. In Extensions, search `@installed CodeMesh`. Confirm **CodeMesh 0.0.1** is
   installed and enabled in this VS Code profile.
6. Choose **File > Open Folder...**, select `C:\CodeMeshPilot-B`, and open it.
   Trust this disposable folder if VS Code asks; use a local window, not WSL/SSH.

On **PC A**, repeat Install from VSIX using
`C:\CodeMesh\codemesh\artifacts\codemesh-0.0.1-lan-pilot.vsix`, reload, then open
`C:\CodeMeshPilot-A`. Both PCs should now run the exact same packaged build.

If `code` is available on PATH, these are alternatives to the installation UI
(run each pair on the indicated PC):

```powershell
# PC A
code --install-extension "C:\CodeMesh\codemesh\artifacts\codemesh-0.0.1-lan-pilot.vsix" --force
code --new-window "C:\CodeMeshPilot-A"
```

```powershell
# PC B
code --install-extension "C:\CodeMeshPilotInstall\codemesh-0.0.1-lan-pilot.vsix" --force
code --new-window "C:\CodeMeshPilot-B"
```

Reload existing windows after replacing an installed build. The CLI commands
above are instructions for the physical PCs; installation was not performed by
the automated package check. See VS Code's
[VSIX installation instructions](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix).

In **each pilot window**, open Settings (**Ctrl+,**), select the **User** tab,
search **`@id:codemesh.serverUrl`**, and put **`ws://192.168.1.10:3977`** in
the Server Url text box, replacing the example IP with PC A's real private IPv4.
Enter only the URL in that text box. If editing User settings JSON instead, add
this property inside the existing braces (with commas between properties):

```json
"codemesh.serverUrl": "ws://192.168.1.10:3977"
```

PC B must use **ws://<PC-A-LAN-IP>:3977**, never its own localhost. The default
remains `ws://localhost:3977` for ordinary single-PC development and local tests.
Set different `codemesh.displayName` values, such as PC A and PC B. URL changes
do not redirect an existing socket: **Leave Room, change the User setting, then
run Developer: Reload Window** before reconnecting. Do not put PC-specific URLs
in a shared workspace settings file. ws:// and wss:// URLs are accepted; malformed
URLs, credentials, queries, fragments and wildcard destinations are rejected.
wss:// support in the client does not add TLS or authentication to this server.

Before Create/Join Room, run **Developer: Reload Window** on each PC, then reopen
Settings and confirm the URL still points to PC A. Open the CodeMesh activity-bar
icon. If CodeMesh commands/settings are missing, check that the VSIX is installed
and enabled in the active profile, then reload.

## 6. Join one room; preview/import one saved file

1. PC A: run **CodeMesh: Create Room** and copy its six-character room ID.
2. PC B: run **CodeMesh: Join Room**, enter that exact ID, and verify both members
   appear in both sidebars. Both must use PC A's server, not separate servers.
3. PC A: run **CodeMesh: Share Workspace** for `C:\CodeMeshPilot-A`.
4. PC B: run **CodeMesh: Preview Workspace File**, select `src/shared.txt`, and
   confirm its read-only preview matches PC A's saved baseline. Preview alone
   must not create a local file.
5. PC B: with the preview active, run **CodeMesh: Import Previewed File** (or its
   editor toolbar button). Keep destination `src/shared.txt`, review the exact
   `C:\CodeMeshPilot-B\src\shared.txt` path, and choose **Import**.
6. PC B: verify that file now exists on its own disk. Import is an explicit disk
   write; it must not start live editing. If a destination already exists, Cancel
   preserves it; Overwrite is a separate explicit choice. Dirty destinations are
   protected. Prefer the empty pilot folder rather than overwriting real work.

**Share Workspace is a listing for explicit saved-file preview/import. It does
not automatically live-edit every file, clone the project, or synchronize unsaved
buffers.** Each file preview/import is explicit. Only the next step enables
production live editing of one relative file path.

## 7. Explicitly share the same relative file on each PC

On both PCs open the **local file** `src/shared.txt` in the pilot workspace,
not PC B's read-only preview, and run **CodeMesh: Share Current File**.
The absolute roots differ; the shared relative path must be exactly
`src/shared.txt` on both. Match spelling and case. Use a single-root pilot
workspace. Switching tabs or importing another file does not live-share it.

Take turns typing. PC A adds a line without saving; PC B must see it in its local
editor. Then PC B edits without saving; PC A must see it. Both editors should be
dirty. Check the two disk files separately: each should still contain the original
baseline. Live edits do not call Save; turn off VS Code Auto Save for the pilot
so an independent editor setting does not save the fixture during this check.

For reconnect/draft preservation, leave the server running and briefly disconnect
PC B's network. Type a disposable local draft on B and edit on A while B is
disconnected. Restore B's network. Membership should reconnect to the same room,
but the file must **not automatically resume sharing**. B's draft must survive.
Explicitly Share Current File again on B; divergent text must produce a conflict,
not an overwrite. Inspect Differences, then dismiss the prompt: sharing remains
paused and the local draft remains recoverable. End Sharing is also explicit.

If the **server restarts**, rooms and shared state are lost because they are in
memory. Create a new room and join it explicitly; do not expect the old ID to work.
DHCP address changes require updating the listener, firewall rule and client URLs.

## Short physical checklist — all OPEN until two people perform it

- [ ] PC A's private-IP listener starts; PC B's TCP check succeeds.
- [ ] Identical installed VSIX builds with independent roots join one room and show both members.
- [ ] A publishes; B previews without a file write, then explicitly imports.
- [ ] Both explicitly Share Current File at `src/shared.txt`.
- [ ] Unsaved A → B and B → A edits arrive; neither disk file changes.
- [ ] B disconnects/reconnects; membership returns, sharing requires re-share,
      the offline draft survives, and dismissing a conflict preserves it.
- [ ] **15-minute physical two-host stability test** completed with alternating
      edits, at least one disconnect/reconnect and a recorded outcome.
- [ ] **Narrow-window visual review** of conflict/recovery labels completed.

Record the date, PCs/VS Code/Node versions, LAN interface/IPs, elapsed time,
pass/fail for each item, and any disconnect/error. No physical outcome is recorded
by the automated tests; these boxes remain unchecked.

## Cleanup

On both PCs run **CodeMesh: Leave Room**. PC A: stop the server by pressing
**Ctrl+C in its server terminal**. In **Administrator PowerShell on PC A**,
inspect the exact pilot rule first, then remove only that rule:

```powershell
Get-NetFirewallRule -Name 'CodeMesh-LAN-Pilot-3977' -ErrorAction SilentlyContinue | Format-List Name, DisplayName, Enabled, Profile
Remove-NetFirewallRule -Name 'CodeMesh-LAN-Pilot-3977' -ErrorAction Stop
Get-NetFirewallRule -Name 'CodeMesh-LAN-Pilot-3977' -ErrorAction SilentlyContinue
```

The final query should print nothing. If the rule was never created or already
removed, the remove command can report it was not found; confirm with the query.
If removal reports Access denied, reopen PowerShell as Administrator and retry.
Do not delete other Node rules or use wildcards. If the pilot is interrupted or
fails, perform this cleanup anyway; the rule does not expire automatically.

In the server terminal clear the session-only environment settings before later
local development:

```powershell
Remove-Item Env:CODEMESH_HOST -ErrorAction SilentlyContinue
Remove-Item Env:CODEMESH_PORT -ErrorAction SilentlyContinue
```

On both PCs Leave Room, restore `codemesh.serverUrl` to `ws://localhost:3977` if
returning to local development, and reload the window. Decide explicitly whether
to save or discard each disposable dirty editor; CodeMesh will not decide for you.

## Automated validation — not a physical pilot

On 2026-10-18, each affected compile and test command below ran **once** and
passed. There were no retries or skipped tests in the two new focused suites.

| Command from the codemesh root | Result |
| --- | --- |
| `npm run compile` | Server and extension compiles passed, once each |
| `node --test server/test/listen-config.cjs` | 10 tests passed |
| `node --test extension/test/lan-pilot.cjs` | 15 tests passed |
| `node extension/test/live-sync-acceptance.cjs` | 9 production acceptance groups passed |
| `node extension/test/file-content.cjs` | 10 preview/import/refresh groups passed |
| `node extension/test/lifecycle.cjs` | 1 extension lifecycle group passed |
| `node server/test/room-lifecycle.cjs` | 1 server lifecycle group passed |
| `node server/test/document-sync.cjs` | 2 server document-sync groups passed |

The new tests verify the existing localhost default, runtime URL configuration,
explicit test-option precedence, invalid URLs rejected before connecting,
connection refusal, bounded handshake timeout, and the actual loopback listener.
Wildcard/public listeners and invalid ports are rejected before startup. Private
LAN address validation is automated; binding/reaching the actual PC A LAN
interface is still a physical-pilot check.

The pilot integration test uses the production client and server with separate
local roots named PC-A-project and PC-B-independent-project. It creates/joins one
room, publishes a workspace, previews without writing, explicitly imports to B,
explicitly shares the same relative file on both sides, sends unsaved Unicode
edits in both directions, reconnects membership without resuming file sharing,
and preserves the offline draft when an explicit re-share conflicts. Both disks
remain at their baseline after the intentional import, with zero editor saves.
Existing production acceptance additionally asserts different absolute roots and
the same shared relative path, conflict recovery and room/path isolation.

No real firewall rule was added, no public listener was started, and no physical
two-PC or native editor run was performed for this change. The simulated editor
adapters exercise production protocol code and real independent disk fixtures;
they cannot verify Windows firewall policy, Wi-Fi isolation, real settings UI,
cross-PC reachability or visual readability. **Physical pilot, 15-minute stability
test, and narrow-window review remain OPEN.** Production stays on
DOCUMENT_EDIT / DOCUMENT_ACK / DOCUMENT_CONFLICT; prototypes/yjs is unchanged.

## Packaged handoff verification - 2026-10-28

The final `npm run package:lan-vsix` succeeded with local `@vscode/vsce` 4.0.0.
It produced `artifacts/codemesh-0.0.1-lan-pilot.vsix`: 48 ZIP entries, including
19 compiled JavaScript modules, the icon, README, manifest, and `ws`/`ignore`
runtime files and licenses. Loading every compiled module from an extracted
temporary directory passed with all non-built-in dependencies restricted to that
directory; only the VS Code API was stubbed. Initial packaging attempts failed
and were corrected before this final archive passed verification.

SHA256 for this handoff (a rebuild may have a different archive hash):

```text
19775DEBA966889F6FEB6DDBEAB488A4343515EF537BF6D1787E3D7AE38B1670
```

Commands verified from the `codemesh` root for this handoff:

| Command | Observed result |
| --- | --- |
| `npm run compile` | Server and extension TypeScript compilation passed |
| `npm run package:lan-vsix` | VSIX built; isolated archive/runtime verification passed |
| `npm run verify:lan-vsix` | Existing VSIX extracted and checked again successfully |
| `node --test server/test/listen-config.cjs extension/test/lan-pilot.cjs` | 25 passed, 0 failed, 0 skipped; local fixtures only |
| `$env:CODEMESH_HOST = '127.0.0.1'; $env:CODEMESH_PORT = '3977'; npm run start -w server` | Logged loopback listener; local `ws` client handshake passed; test server stopped afterward |

No VSIX was installed into a real VS Code profile for this verification. PC B's
installation, PC A's actual LAN binding, `Test-NetConnection` from PC B, firewall
creation/removal, two-machine editing and stability remain physical test steps.
No firewall rule was created. Production sync source and `prototypes/yjs` were
not changed. The existing TCP reachability check is the network preflight;
the archive check prevents a concrete missing-runtime-dependency setup failure.
