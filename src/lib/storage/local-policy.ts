/**
 * When the filesystem driver may run. Outside production it always may. In production (the
 * built app in CI) only an explicit STORAGE_ALLOW_LOCAL flag enables it, and only when APP_URL
 * points at this machine and CLOUD is unset or "local": a deployed https site can never turn it on.
 */
export type LocalPolicyInput = {
  nodeEnv: string;
  allowLocal: boolean;
  appUrl: string;
  /** process.env.CLOUD: a deployment sets it (gcp, aws...); unset or "local" means this machine. */
  cloud?: string;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackUrl(appUrl: string): boolean {
  try {
    const u = new URL(appUrl);
    // URL lowercases the host and rewrites IPv6 forms, so [::ffff:127.0.0.1] is not in the set. No credentials allowed.
    return u.protocol === "http:" && !u.username && !u.password && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export function localDriverAllowed(p: LocalPolicyInput): boolean {
  if (p.nodeEnv !== "production") return true;
  if (p.cloud && p.cloud !== "local") return false;
  return p.allowLocal && isLoopbackUrl(p.appUrl);
}
