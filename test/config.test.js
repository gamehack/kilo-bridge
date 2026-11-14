import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("macbook-02 accepts only its own scoped broker configuration", () => {
  const token = "0123456789abcdef".repeat(4);
  const values = {
    SUPABASE_SERVICE_ROLE_KEY: "",
    BRIDGE_HOST_ID: "macbook-02",
    KILO_BROKER_URL: "https://xnndeqrduxkdlwcdklbc.supabase.co/functions/v1/kilo-host-broker-mb2",
    KILO_BROKER_TOKEN: token
  };
  const config = loadConfig(env(values));
  assert.equal(config.bridgeHostId, "macbook-02");
  assert.equal(config.brokerToken, token);
});

test("macbook-02 enforces workspace realpath and disallows permanent approvals", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "primalflow-mb2-"));
  try {
    fs.mkdirSync(path.join(root, "allowed"));
    fs.symlinkSync(os.tmpdir(), path.join(root, "escape"));
    const config = loadConfig(env({ BRIDGE_HOST_ID:"macbook-02", KILO_DEFAULT_DIRECTORY:root }));
    const command = directory => ({ command_type:"create_session", payload:{ directory } });
    assert.equal(validateCommand(command(path.join(root, "allowed")), config).directory, path.join(root, "allowed"));
    assert.throws(() => validateCommand(command(path.join(root,"escape")), config), /escapes the approved workspace/);
    assert.throws(() => validateCommand(command(os.tmpdir()), config), /escapes the approved workspace/);
    assert.throws(() => validateCommand({
      command_type:"approval_decision",
      session_id:"59929579-ac90-48c1-929c-19d536268f7f",
      payload:{ approval_id:"7324cb59-f558-4962-b112-7dfe1ce2b051",decision:"always" }
    }, config), /Persistent approvals are disabled/);
  } finally { fs.rmSync(root, { recursive:true, force:true }); }
});
