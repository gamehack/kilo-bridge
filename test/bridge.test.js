import test from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../src/bridge.js";

const sessionID = "59929579-ac90-48c1-929c-19d536268f7f";
const commandID = "7324cb59-f558-4962-b112-7dfe1ce2b051";

function harness() {
  let session = { id: sessionID, title: "Demo", workspace_key: "demo", kilo_session_id: "ses_demo",
    directory: "/opt/project", status: "ready", current_command_id: null };
  let command = { id: commandID, session_id: sessionID, status: "claimed", payload: { text: "Fix bug" }, result: {} };
  let messages = [];
  let status = { ses_demo: { type: "busy" } };
  let permissions = [];
  const calls = [];
  const store = {
    async createSession(values) { session = { ...session, ...values, id: sessionID }; return session; },
    async session() { return { ...session }; },
    async command() { return { ...command }; },
    async updateSession(_, patch) { session = { ...session, ...patch }; return session; },
    async updateCommand(_, patch) { command = { ...command, ...patch }; return command; },
    async event(event) { calls.push(event); },
    async upsertApproval(approval) { calls.push(approval); }
  };
  const kilo = {
    async createSession() { return { id: "ses_demo" }; },
    async messages() { return messages; },
    async status() { return status; },
    async pendingPermissions() { return permissions; },
    async pendingQuestions() { return []; },
    async promptAsync(...args) { calls.push({ prompt: args }); }
  };
  const logger = { info() {}, warn() {}, error() {} };
  const bridge = new Bridge({ defaultDirectory: "/home/ubuntu", kiloModel: "nvidia/nemotron-3.5-super-vl:free" }, store, kilo, logger);
  return { bridge, calls, getSession: () => session, getCommand: () => command,
    setMessages: (value) => { messages = value; }, setStatus: (value) => { status = value; },
    setPermissions: (value) => { permissions = value; } };
}

test("creates sessions directly in any absolute directory", async () => {
  const h = harness();
  await h.bridge.createSession({ id: commandID }, { workspaceKey: "host", directory: "/", title: "Root session" });
  assert.equal(h.getSession().directory, "/");
  assert.equal(h.getCommand().status, "succeeded");
});

test("prompt_async does not synchronously complete the task", async () => {
  const h = harness();
  await h.bridge.startTurn({ id: commandID, session_id: sessionID }, { text: "Fix bug" });
  assert.equal(h.getCommand().status, "running");
  assert.equal(h.getSession().status, "running");
  assert.equal(h.calls.filter((item) => item.prompt).length, 1);
});

test("idle with a completed new assistant message marks success", async () => {
  const h = harness();
  await h.bridge.startTurn({ id: commandID, session_id: sessionID }, { text: "Fix bug" });
  h.setStatus({});
  h.setMessages([{ info: { role: "user" } }, { info: { id: "msg_1", role: "assistant", time: { completed: Date.now() } },
    parts: [{ type: "text", text: "Fixed and tested." }] }]);
  await h.bridge.reconcile(h.getSession());
  assert.equal(h.getCommand().status, "succeeded");
  assert.equal(h.getCommand().result.final_message, "Fixed and tested.");
  assert.equal(h.getSession().status, "ready");
});

test("pending permission is surfaced rather than mistaken for a hung task", async () => {
  const h = harness();
  await h.bridge.startTurn({ id: commandID, session_id: sessionID }, { text: "Fix bug" });
  h.setPermissions([{ id: "per_demo", sessionID: "ses_demo", permission: "bash" }]);
  await h.bridge.reconcile(h.getSession());
  assert.equal(h.getCommand().status, "awaiting_approval");
  assert.equal(h.getSession().status, "awaiting_approval");
});

test("idle without a new assistant message cannot be marked succeeded", async () => {
  const h = harness();
  await h.bridge.startTurn({ id: commandID, session_id: sessionID }, { text: "Fix bug" });
  h.setStatus({});
  await h.bridge.reconcile(h.getSession());
  assert.equal(h.getCommand().status, "running");
});

test("a truncated long-session transcript does not reuse an old completed answer", async () => {
  const h = harness();
  h.setMessages([{ info: { id: "old", role: "assistant", time: { created: 1000, completed: 1200 } } }]);
  await h.bridge.startTurn({ id: commandID, session_id: sessionID }, { text: "Fix bug" });
  h.setStatus({});
  // Simulate the API trimming the original anchor out of its response.
  h.setMessages([{ info: { id: "other_old", role: "assistant", time: { created: 1400, completed: 1500 } },
    parts: [{ type: "text", text: "Previous task" }] }]);
  await h.bridge.reconcile(h.getSession());
  assert.equal(h.getCommand().status, "running");
});
