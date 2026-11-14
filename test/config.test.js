import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { validateCommand } from "../src/commands.js";

function env(overrides = {}) {
  return { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test-key", ...overrides };
}

test("accepts fixed free model and loopback Kilo server", () => {
  const config = loadConfig(env());
  assert.equal(config.kiloModel, "nvidia/nemotron-3.5-super-vl:free");
  assert.equal(config.kiloServerUrl, "http://127.0.0.1:4096");
  assert.equal(config.bridgeHostId, "silicon-valley-01");
});
test("accepts a Mac host ID and rejects malformed names", () => {
  assert.equal(loadConfig(env({ BRIDGE_HOST_ID: "macbook-01" })).bridgeHostId, "macbook-01");
  assert.throws(() => loadConfig(env({ BRIDGE_HOST_ID: "../../other" })), /Invalid BRIDGE_HOST_ID/);
  assert.throws(() => loadConfig(env({ BRIDGE_HOST_ID: "MAC" })), /Invalid BRIDGE_HOST_ID/);
});

test("Mac broker mode does not accept privileged Supabase credentials", () => {
  const token = "0123456789abcdef".repeat(4);
  const base = { KILO_BROKER_URL: "https://example.supabase.co/functions/v1/kilo-host-broker",
    KILO_BROKER_TOKEN: token, BRIDGE_HOST_ID: "macbook-01" };
  const config = loadConfig(env({ ...base, SUPABASE_SERVICE_ROLE_KEY: "" }));
  assert.equal(config.brokerToken, token);
  assert.equal(config.bridgeHostId, "macbook-01");
  assert.throws(() => loadConfig(env(base)), /must not carry/);
  assert.throws(() => loadConfig(env({ ...base, SUPABASE_SERVICE_ROLE_KEY: "", BRIDGE_HOST_ID: "silicon-valley-01" })), /supports only/);
  assert.throws(() => loadConfig(env({ ...base, SUPABASE_SERVICE_ROLE_KEY: "", KILO_BROKER_URL: "http://remote.example/broker" })), /HTTPS/);
});

test("rejects paid/auto models", () => {
  assert.throws(() => loadConfig(env({ KILO_MODEL: "kilo-auto/free" })), /pinned/);
  assert.throws(() => loadConfig(env({ KILO_MODEL: "openai/gpt-5.4" })), /pinned/);
  assert.throws(() => loadConfig(env({ KILO_MODEL: "another/model:free" })), /pinned/);
});
test("rejects public server and relative default directory", () => {
  assert.throws(() => loadConfig(env({ KILO_SERVER_URL: "http://0.0.0.0:4096" })), /loopback/);
  assert.throws(() => loadConfig(env({ KILO_DEFAULT_DIRECTORY: "relative/project" })), /absolute path/);
});
test("accepts arbitrary absolute session directories, including filesystem root", () => {
  const config = loadConfig(env());
  assert.deepEqual(validateCommand({ command_type: "create_session", payload: { directory: "/" } }, config),
    { workspaceKey: "host", directory: "/", title: "Kilo session" });
  assert.deepEqual(validateCommand({ command_type: "create_session", payload: { directory: "/etc/../opt/qjai-cms" } }, config),
    { workspaceKey: "host", directory: "/opt/qjai-cms", title: "Kilo session" });
  assert.deepEqual(validateCommand({ command_type: "create_session", payload: {} }, config),
    { workspaceKey: "host", directory: "/home/ubuntu", title: "Kilo session" });
  assert.throws(() => validateCommand({ command_type: "create_session", payload: { directory: "relative/project" } }, config), /absolute/);
});
