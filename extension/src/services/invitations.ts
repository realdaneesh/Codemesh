import { validateServerUrl } from "./serverConnection";

export function createInviteLink(base: string, server: string, token: string): string {
  const url = new URL(base);
  if (!["vscode:", "vscode-insiders:"].includes(url.protocol) || url.host !== "codemesh.codemesh" || url.username || url.password || url.pathname !== "/join" || url.search || url.hash) {
    throw new Error("Invitation URL base must target codemesh.codemesh/join using vscode:// or vscode-insiders://");
  }
  url.searchParams.set("server", secureRelay(server));
  url.searchParams.set("token", token);
  return url.toString();
}

export function secureRelay(value: string): string {
  const server = validateServerUrl(value);
  if (!server.startsWith("wss://")) throw new Error("Cloud collaboration requires wss://");
  return server;
}

export function parseInviteLink(value: string): { server: string; token: string } {
  if (value.length > 4096) throw new Error("Invalid invitation");
  const url = new URL(value);
  if (!["vscode:", "vscode-insiders:"].includes(url.protocol) || url.host !== "codemesh.codemesh" || url.username || url.password || url.pathname !== "/join" || url.hash
    || [...url.searchParams.keys()].sort().join(",") !== "server,token") throw new Error("Invalid invitation");
  const token = url.searchParams.get("token") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid invitation");
  return { server: secureRelay(url.searchParams.get("server") ?? ""), token };
}
