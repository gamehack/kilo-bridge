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

  const defaultDirectory = env.KILO_DEFAULT_DIRECTORY || "/home/ubuntu";
  if (!path.isAbsolute(defaultDirectory) || defaultDirectory.includes("\0")) {
    throw new Error("KILO_DEFAULT_DIRECTORY must be an absolute path");
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
    defaultDirectory: path.resolve(defaultDirectory),
    bridgeId: env.BRIDGE_ID || `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    pollIntervalMs: positiveInt(env.BRIDGE_POLL_INTERVAL_MS, 10000, "BRIDGE_POLL_INTERVAL_MS"),
    requestTimeoutMs: positiveInt(env.BRIDGE_REQUEST_TIMEOUT_MS, 30000, "BRIDGE_REQUEST_TIMEOUT_MS"),
    claimLeaseSeconds: positiveInt(env.BRIDGE_CLAIM_LEASE_SECONDS, 60, "BRIDGE_CLAIM_LEASE_SECONDS"),
    logLevel: env.LOG_LEVEL || "info"
  };
}
