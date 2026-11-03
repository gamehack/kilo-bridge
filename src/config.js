import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

function positiveInt(value, defaultValue, name) {
  const number = value === undefined ? defaultValue : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

export function loadConfig(env = process.env) {
  const supabaseUrl = new URL(env.SUPABASE_URL || "https://example.supabase.co");
  if (supabaseUrl.protocol !== "https:") throw new Error("SUPABASE_URL must be HTTPS");
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");

  const kiloUrl = new URL(env.KILO_SERVER_URL || "http://127.0.0.1:4096");
  if (kiloUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(kiloUrl.hostname)) {
    throw new Error("KILO_SERVER_URL must be an HTTP loopback address");
  }

  let workspaces;
  try { workspaces = JSON.parse(env.KILO_WORKSPACES_JSON || "{}"); }
  catch { throw new Error("KILO_WORKSPACES_JSON must contain valid JSON"); }
  if (!workspaces || Array.isArray(workspaces) || typeof workspaces !== "object" || !Object.keys(workspaces).length) {
    throw new Error("KILO_WORKSPACES_JSON needs at least one workspace");
  }
  const appDir = path.resolve(env.BRIDGE_APP_DIR || process.cwd());
  for (const [key, directory] of Object.entries(workspaces)) {
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(key) || typeof directory !== "string" || !path.isAbsolute(directory)) {
      throw new Error("Invalid workspace key or absolute path");
    }
    const workspace = path.resolve(directory);
    if (workspace === appDir || appDir.startsWith(workspace + path.sep)) {
      throw new Error("Workspace must not contain the Bridge application directory");
    }
    if (workspace === path.parse(workspace).root) throw new Error("Filesystem root cannot be a workspace");
    workspaces[key] = workspace;
  }
  const kiloModel = env.KILO_MODEL || "nvidia/nemotron-3.5-super-vl:free";
  if (kiloModel !== "nvidia/nemotron-3.5-super-vl:free") {
    throw new Error("KILO_MODEL is pinned to nvidia/nemotron-3.5-super-vl:free for the MVP");
  }

  return {
    supabaseUrl: supabaseUrl.origin,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    kiloServerUrl: kiloUrl.origin,
    kiloUsername: env.KILO_SERVER_USERNAME || "kilo",
    kiloPassword: env.KILO_SERVER_PASSWORD || "",
    kiloModel,
    workspaces,
    bridgeId: env.BRIDGE_ID || `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    pollIntervalMs: positiveInt(env.BRIDGE_POLL_INTERVAL_MS, 10000, "BRIDGE_POLL_INTERVAL_MS"),
    requestTimeoutMs: positiveInt(env.BRIDGE_REQUEST_TIMEOUT_MS, 30000, "BRIDGE_REQUEST_TIMEOUT_MS"),
    claimLeaseSeconds: positiveInt(env.BRIDGE_CLAIM_LEASE_SECONDS, 60, "BRIDGE_CLAIM_LEASE_SECONDS"),
    logLevel: env.LOG_LEVEL || "info"
  };
}
