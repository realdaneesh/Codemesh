import { isIP } from "node:net";

export const DEFAULT_LISTEN_HOST = "127.0.0.1";

// This unauthenticated pilot accepts only loopback or a specific RFC1918 IPv4
// interface. In particular, wildcard and public-address binding are not options.
export function validateListenHost(host: string): string {
  if (host === "127.0.0.1" || host === "::1") return host;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return host;
  }
  throw new Error("CODEMESH_HOST must be loopback (127.0.0.1 or ::1) or a specific private LAN IPv4 address (10.x, 172.16-31.x, 192.168.x). Wildcard and public listeners are disabled for this unauthenticated pilot.");
}

export function readListenConfig(env: NodeJS.ProcessEnv): { port: number; host: string } {
  const value = env.CODEMESH_PORT ?? "3977";
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CODEMESH_PORT must be an integer between 1 and 65535");
  }
  return { port, host: validateListenHost(env.CODEMESH_HOST ?? DEFAULT_LISTEN_HOST) };
}
