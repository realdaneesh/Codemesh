export const DEFAULT_SERVER_URL = "ws://localhost:3977";

export function validateServerUrl(value: unknown): string {
  const invalid = () => new Error("Invalid codemesh.serverUrl. Use ws://localhost:3977 or ws://<PC-A-LAN-IP>:3977 (ws:// or wss:// only; no credentials, query or fragment).");
  if (typeof value !== "string" || !value.trim() || /\s/.test(value.trim())) throw invalid();
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw invalid(); }
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || !url.hostname
    || url.username || url.password || url.search || url.hash
    || url.hostname === "0.0.0.0" || url.hostname === "[::]") throw invalid();
  return url.toString();
}
