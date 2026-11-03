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
