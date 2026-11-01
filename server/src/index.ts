import { CollaborationServer } from "./websocket/CollaborationServer";
import { readListenConfig } from "./listenConfig";

try {
  const mode = process.env.CODEMESH_MODE ?? "lan";
  if (mode !== "lan" && mode !== "cloud") throw new Error("CODEMESH_MODE must be lan or cloud");
  let server: CollaborationServer;
  if (mode === "cloud") {
    const value = process.env.PORT ?? "";
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error("Cloud PORT must be 1-65535");
    if (process.env.CODEMESH_HOST || process.env.CODEMESH_PORT) throw new Error("Remove LAN listener settings in cloud mode");
    server = new CollaborationServer(Number(value), { cloud: { hostKey: process.env.CODEMESH_HOST_KEY ?? "" } });
    server.start(() => console.log("[server] Authenticated cloud relay ready; health endpoint /health"));
  } else {
    if (process.env.RENDER === "true" || process.env.NODE_ENV === "production") throw new Error("Hosted production requires explicit CODEMESH_MODE=cloud");
    const { port, host } = readListenConfig(process.env);
    server = new CollaborationServer(port, { host });
    server.start(() => console.log(`[server] CodeMesh WebSocket server listening on ws://${host.includes(":") ? `[${host}]` : host}:${port}`));
  }
  process.once("SIGTERM", () => server.shutdown());
  process.once("SIGINT", () => server.shutdown());
  process.on("uncaughtException", (error: NodeJS.ErrnoException) => {
    const code = /^[A-Z0-9_]+$/.test(error.code ?? "") ? error.code : "runtime failure";
    console.error(`[server] Fatal listener/runtime failure (${code}); shutting down`);
    server.shutdown(); process.exitCode = 1;
  });
} catch (error) { console.error("[server] Startup rejected:", (error as Error).message); process.exitCode = 1; }
