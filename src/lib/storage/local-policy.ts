/**
 * When the filesystem driver may run. Outside production it always may. In production (the
 * built app in CI) only an explicit STORAGE_ALLOW_LOCAL flag enables it, and only when APP_URL
 * points at this machine: a deployed https site can never turn it on.
 */
export type LocalPolicyInput = { nodeEnv: string; allowLocal: boolean; appUrl: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackUrl(appUrl: string): boolean {
  try {
    const u = new URL(appUrl);
    return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export function localDriverAllowed(p: LocalPolicyInput): boolean {
  if (p.nodeEnv !== "production") return true;
  return p.allowLocal && isLoopbackUrl(p.appUrl);
}
