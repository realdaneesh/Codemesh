# CodeMesh cloud relay pilot 0.0.2

Private pilot for desktop VS Code 1.96 or newer. Install the same VSIX on both
computers and reload. PC 2 needs no Node.js or local server.

Set User codemesh.connectionMode to cloud and codemesh.serverUrl to
wss://<service>.onrender.com. Default mode lan preserves existing LAN clients.
Create Room asks for the operator host key. The new room's single-use,
five-minute invitation is copied to your clipboard. Copy Invite Link creates a
replacement and revokes the previous link. Send it privately. The recipient
opens it or pastes it into Join Room, reviews the relay address and confirms
Join. Revoke Invitations cancels unused links. Host Leave Room revokes guests.

Use independent local folders. Share Workspace lists saved files for explicit
preview/import. Share Current File enables live editing when both PCs share
the same relative path. Import and conflict choices are explicit. CodeMesh does
not save live edits or run code. Existing editor tasks/extensions and Auto Save
remain your responsibility.

Reconnect restores membership while another participant keeps the room alive;
file sharing must be explicitly resumed. Drafts survive. Server restarts require
a new room and invitation. The relay can read shared content. Invitations and
clipboard/history are sensitive. Names are labels, not verified user identities.

Trusted LAN development still uses ws://localhost:3977 or a specific private
LAN listener. That mode is unauthenticated: never expose it publicly. Leave Room
and reload after changing the server setting.

See docs/cloud-relay-pilot.md in the source checkout for deployment, recovery and
acceptance steps. No deployment or physical two-PC success is claimed. Native
editor review and the physical 15-minute stability test remain OPEN.
