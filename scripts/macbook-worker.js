// macOS worker preflight, foreground start, and launchd-managed service.
// Usage: node scripts/macbook-worker.js check|start|service BROKER_URL
// Does not print credentials or store service_role on the MacBook.
import { readFileSync, statSync } from "node:fs";
import { homedir, platform, arch } from "node:os";
import path from "node:path";

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const HOSTS = Object.freeze({
  "macbook-01": { brokerPath: "/functions/v1/kilo-host-broker", tokenFile: "macbook-worker-token" },
  "macbook-02": { brokerPath: "/functions/v1/kilo-host-broker-mb2", tokenFile: "macbook-02-worker-token" }
});
const hostId = process.env.MACBOOK_WORKER_HOST_ID || "macbook-01";
const host = HOSTS[hostId];
requireCondition(host, "Unknown MacBook host ID");

const mode = process.argv[2];
const urlString = process.argv[3];
requireCondition(["check", "start", "service"].includes(mode), "Usage: macbook-worker.js check|start|service BROKER_URL");
requireCondition(urlString, "BROKER_URL argument is required");
const brokerUrl = new URL(urlString);
requireCondition(brokerUrl.protocol === "https:" &&
  brokerUrl.hostname === "xnndeqrduxkdlwcdklbc.supabase.co" &&
  brokerUrl.pathname === host.brokerPath &&
  !brokerUrl.username && !brokerUrl.password && !brokerUrl.search && !brokerUrl.hash,
  "Broker URL must match the approved agent-coordination endpoint");
requireCondition(platform() === "darwin" && arch() === "x64", "This helper targets the Intel MacBook");
requireCondition(!process.env.SUPABASE_SERVICE_ROLE_KEY,
  "Remove the production SUPABASE_SERVICE_ROLE_KEY from this shell before continuing");

const tokenFile = path.join(homedir(), ".config", "primalflow", host.tokenFile);
const fileMode = statSync(tokenFile).mode;
requireCondition((fileMode & 0o077) === 0, "Worker token file must be private (chmod 600)");
const token = readFileSync(tokenFile, "utf8").trim();
requireCondition(/^[a-fA-F0-9]{64}$/.test(token), "Worker token file must contain 32 random bytes as hex");

const localHealth = await fetch("http://127.0.0.1:4096/global/health", {
  signal: AbortSignal.timeout(5000)
});
requireCondition(localHealth.ok, "Local Kilo server unavailable");
const health = await localHealth.json();
requireCondition(health?.healthy === true, "Local Kilo health is not healthy");
console.log(`Kilo local health: PASS (version ${health.version || "unknown"})`);

async function brokerRequest(secret) {
  return fetch(brokerUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ action: "sessionsActive", args: {} }),
    signal: AbortSignal.timeout(15000)
  });
}
if (mode !== "service") {
  const denied = await brokerRequest("definitely-invalid-macbook-token");
  requireCondition(denied.status === 401,
    `Invalid-token check failed (expected 401, got ${denied.status})`);
  console.log("Broker invalid-token rejection: PASS (HTTP 401)");
}
const accepted = await brokerRequest(token);
requireCondition(accepted.status === 200,
  `Broker authentication failed (HTTP ${accepted.status}); check secret value and deployment`);
const json = await accepted.json();
requireCondition(Array.isArray(json?.data), "Broker returned unexpected sessionsActive payload");
console.log(`Broker authorized read: PASS (${json.data.length} MacBook active sessions)`);
console.log("MacBook worker preflight: PASS");

if (mode === "start" || mode === "service") {
  process.env.BRIDGE_HOST_ID = hostId;
  process.env.KILO_BROKER_URL = brokerUrl.href;
  process.env.KILO_BROKER_TOKEN = token;
  process.env.KILO_DEFAULT_DIRECTORY = path.join(homedir(), "kilo-workspaces");
  process.env.KILO_SERVER_URL = "http://127.0.0.1:4096";
  process.env.KILO_MODEL = "nvidia/nemotron-3.5-super-vl:free";
  process.env.BRIDGE_POLL_INTERVAL_MS = "10000";
  console.log(mode === "service" ? "Starting launchd-managed MacBook Bridge" : "Starting attended MacBook Bridge in foreground; Ctrl+C to stop.");
  await import("../src/index.js");
}
