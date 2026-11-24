import test from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../src/bridge.js";

const sessionID = "59929579-ac90-48c1-929c-19d536268f7f";
const commandID = "7324cb59-f558-4962-b112-7dfe1ce2b051";

function harness(configOverrides = {}) {
  let session = { id: sessionID, title: "Demo", workspace_key: "demo", kilo_session_id: "ses_demo",
    directory: "/opt/project", status: "ready", current_command_id: null, host_id: "silicon-valley-01" };
  let command = { id: commandID, session_id: sessionID, target_host: "silicon-valley-01",
    status: "claimed", payload: { text: "Fix bug" }, result: {} };
  let messages = [];
  let status = { ses_demo: { type: "busy" } };
  let permissions = [];
  let approval = null;
  let claimed = false;
  let failDecisionAudit = false;
  let replyCount = 0;
  const calls = [];
  const store = {
    async createSession(values) { session = { ...session, ...values, id: sessionID }; return session; },
    async session() { return { ...session }; },
    async command() { return { ...command }; },
    async updateSession(_, patch) { session = { ...session, ...patch }; return session; },
    async updateCommand(_, patch) { command = { ...command, ...patch }; return command; },
    async event(event) {
      if (failDecisionAudit && event.event_type === "approval.auto_decision") throw new Error("audit unavailable");
      calls.push(event);
    },
    async upsertApproval(values) {
      calls.push(values);
      if (!approval) approval = { ...values, id: "approval_demo", created_at: new Date().toISOString() };
    },
    async approvalForRequest() { return approval ? { ...approval, detail: { ...approval.detail } } : null; },
    async approval(id, sessionId) {
      return approval && approval.id === id && approval.session_id === sessionId
        ? { ...approval, detail: { ...approval.detail } } : null;
    },
    async claimApproval(row, claim) {
      if (claimed || row.status !== "pending" || row.detail?._bridge_resolution_claim_id) return false;
      claimed = true;
      approval.detail = {
        ...approval.detail,
        _bridge_resolution_claim_id: claim.claimId,
        _bridge_resolution_kind: claim.kind,
        _bridge_resolution_decision: claim.decision,
        _bridge_resolution_reason: claim.reason,
        _bridge_resolution_claimed_at: claim.claimedAt,
        _bridge_resolution_command_id: claim.resolverCommandId
      };
      return true;
    },
    async updateApproval(id, sessionId, patch) {
      if (!approval || approval.id !== id || approval.session_id !== sessionId) throw new Error("approval missing");
      approval = { ...approval, ...patch };
      return approval;
    },
    async approvalDecisionEvent(commandId, approvalId, eventType) {
      return calls.some((event) => event.command_id === commandId &&
        event.event_type === eventType && event.payload?.approval_id === approvalId);
    }
  };
  const kilo = {
    async createSession() { return { id: "ses_demo" }; },
    async messages() { return messages; },
    async status() { return status; },
    async pendingPermissions() { return permissions; },
    async pendingQuestions() { return []; },
    async promptAsync(...args) { calls.push({ prompt: args }); },
    async replyPermission(...args) { replyCount++; calls.push({ reply: args }); }
  };
  const logger = { info() {}, warn() {}, error() {} };
  const bridge = new Bridge({
    bridgeHostId: "silicon-valley-01",
    approvalMode: "manual",
    approvalTimeoutSeconds: 60,
    defaultDirectory: "/home/ubuntu",
    kiloModel: "nvidia/nemotron-3.5-super-vl:free",
    ...configOverrides
  }, store, kilo, logger);
  return {
    bridge, calls,
    getSession: () => ({ ...session }),
    getCommand: () => ({ ...command }),
    getApproval: () => approval ? { ...approval, detail: { ...approval.detail } } : null,
    getReplyCount: () => replyCount,
    setMessages: (value) => { messages = value; },
    setStatus: (value) => { status = value; },
    setPermissions: (value) => { permissions = value; },
    setApproval: (value) => { approval = value; claimed = Boolean(value?.detail?._bridge_resolution_claim_id); },
    setCommand: (value) => { command = { ...command, ...value }; },
    setSession: (value) => { session = { ...session, ...value }; },
    setFailDecisionAudit: (value) => { failDecisionAudit = value; }
  };
}

test("creates sessions directly in any absolute directory and binds host identity", async () => {
  const h = harness();
  await h.bridge.createSession({ id: commandID }, { workspaceKey: "host", directory: "/", title: "Root session" });
  assert.equal(h.getSession().directory, "/");
  assert.equal(h.getSession().host_id, "silicon-valley-01");
  assert.equal(h.getCommand().status, "succeeded");
});

test("ignores a command assigned to another host without mutating it", async () => {
  const h = harness();
  await h.bridge.execute({ id: commandID, target_host: "macbook-01", command_type: "health_check", payload: {} });
  assert.equal(h.getCommand().status, "claimed");
  assert.equal(h.calls.some((event) => event.event_type === "command.failed"), false);
});

test("prompt_async does not synchronously complete the task and records approval policy epoch", async () => {
  const h = harness({ approvalMode: "auto" });
  await h.bridge.startTurn({ id: commandID, session_id: sessionID }, { text: "Fix bug" });
  assert.equal(h.getCommand().status, "running");
  assert.equal(h.getSession().status, "running");
  assert.equal(h.getCommand().result.approval_mode, "auto");
  assert.equal(h.getCommand().result.approval_policy_version, 2);
  assert.equal(h.getCommand().result.approval_policy_host_id, "silicon-valley-01");
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
  h.setMessages([{ info: { id: "other_old", role: "assistant", time: { created: 1400, completed: 1500 } },
    parts: [{ type: "text", text: "Previous task" }] }]);
  await h.bridge.reconcile(h.getSession());
  assert.equal(h.getCommand().status, "running");
});

test("legacy pending approvals remain manual after auto mode is enabled", async () => {
  const h = harness({ approvalMode: "manual" });
  h.setCommand({ payload: { text: "Old task", approval_grants: [] } });
  await h.bridge.startTurn(h.getCommand(), { text: "Old task" });
  h.bridge.config.approvalMode = "auto";
  const request = { id: "per_old", sessionID: "ses_demo", permission: "bash",
    metadata: { command: "free -h" }, patterns: ["free -h"] };
  h.setApproval({ id: "approval_old", session_id: sessionID, command_id: commandID,
    kilo_request_id: request.id, status: "pending", created_at: new Date().toISOString(), detail: request });
  h.setPermissions([request]);
  await h.bridge.reconcile(h.getSession());
  assert.equal(h.getReplyCount(), 0);
  assert.equal(h.getApproval().status, "pending");
  assert.equal(h.getApproval().detail._bridge_resolution_claim_id, undefined);
});

test("V2 auto approval resolves a newly started task once", async () => {
  const h = harness({ approvalMode: "auto" });
  h.setCommand({ payload: { text: "Inspect host", approval_grants: [] } });
  await h.bridge.startTurn(h.getCommand(), { text: "Inspect host" });
  const request = { id: "per_auto", sessionID: "ses_demo", permission: "bash",
    metadata: { command: "free -h" }, patterns: ["free -h"] };
  h.setApproval({ id: "approval_auto", session_id: sessionID, command_id: commandID,
    kilo_request_id: request.id, status: "pending",
    created_at: new Date(Date.now() + 5).toISOString(), detail: request });
  h.setPermissions([request]);
  await h.bridge.reconcile(h.getSession());
  assert.equal(h.getReplyCount(), 1);
  assert.equal(h.getApproval().status, "approved");
  assert.ok(h.calls.some((event) => event.event_type === "approval.auto_intent"));
  assert.ok(h.calls.some((event) => event.event_type === "approval.auto_decision"));
});

test("concurrent automatic reconciliation sends only one permission reply", async () => {
  const h = harness({ approvalMode: "auto" });
  h.setCommand({ payload: { text: "Inspect host", approval_grants: [] } });
  await h.bridge.startTurn(h.getCommand(), { text: "Inspect host" });
  const request = { id: "per_race", sessionID: "ses_demo", permission: "bash",
    metadata: { command: "free -h" }, patterns: ["free -h"] };
  h.setApproval({ id: "approval_race", session_id: sessionID, command_id: commandID,
    kilo_request_id: request.id, status: "pending",
    created_at: new Date(Date.now() + 5).toISOString(), detail: request });
  await Promise.all([
    h.bridge.resolveAutomaticApproval(h.getSession(), h.getCommand(), request),
    h.bridge.resolveAutomaticApproval(h.getSession(), h.getCommand(), request)
  ]);
  assert.equal(h.getReplyCount(), 1);
});

test("successful permission reply followed by audit failure enters reconciliation", async () => {
  const h = harness({ approvalMode: "auto" });
  h.setCommand({ payload: { text: "Inspect host", approval_grants: [] } });
  await h.bridge.startTurn(h.getCommand(), { text: "Inspect host" });
  const request = { id: "per_audit", sessionID: "ses_demo", permission: "bash",
    metadata: { command: "free -h" }, patterns: ["free -h"] };
  h.setApproval({ id: "approval_audit", session_id: sessionID, command_id: commandID,
    kilo_request_id: request.id, status: "pending",
    created_at: new Date(Date.now() + 5).toISOString(), detail: request });
  h.setFailDecisionAudit(true);
  await h.bridge.resolveAutomaticApproval(h.getSession(), h.getCommand(), request);
  assert.equal(h.getReplyCount(), 1);
  assert.equal(h.getApproval().status, "approved");
  assert.equal(h.getCommand().status, "needs_reconciliation");
  assert.equal(h.getSession().status, "needs_reconciliation");
  assert.ok(h.calls.some((event) => event.event_type === "approval.needs_reconciliation"));
});

test("approval created before the task start is not auto-resolved", async () => {
  const h = harness({ approvalMode: "auto" });
  h.setCommand({ payload: { text: "Inspect host", approval_grants: [] } });
  await h.bridge.startTurn(h.getCommand(), { text: "Inspect host" });
  const request = { id: "per_older", sessionID: "ses_demo", permission: "bash",
    metadata: { command: "free -h" }, patterns: ["free -h"] };
  h.setApproval({ id: "approval_older", session_id: sessionID, command_id: commandID,
    kilo_request_id: request.id, status: "pending",
    created_at: new Date(Date.now() - 10000).toISOString(), detail: request });
  await h.bridge.resolveAutomaticApproval(h.getSession(), h.getCommand(), request);
  assert.equal(h.getReplyCount(), 0);
  assert.equal(h.getApproval().status, "pending");
});

test("reconciliation state is sticky and cannot be reset to awaiting approval", async () => {
  const h = harness();
  await h.bridge.startTurn({ id: commandID, session_id: sessionID }, { text: "Fix bug" });
  h.setCommand({ status: "needs_reconciliation" });
  h.setSession({ status: "needs_reconciliation" });
  h.setPermissions([{ id: "per_sticky", sessionID: "ses_demo", permission: "bash" }]);
  await h.bridge.reconcile(h.getSession());
  assert.equal(h.getCommand().status, "needs_reconciliation");
  assert.equal(h.getSession().status, "needs_reconciliation");
  assert.equal(h.getReplyCount(), 0);
});

test("manual approval still uses a single-use claim and records its decision", async () => {
  const h = harness();
  await h.bridge.startTurn({ id: commandID, session_id: sessionID }, { text: "Fix bug" });
  const request = { id: "per_manual", sessionID: "ses_demo", permission: "bash",
    metadata: { command: "free -h" }, patterns: ["free -h"] };
  h.setApproval({ id: "approval_manual", session_id: sessionID, command_id: commandID,
    kilo_request_id: request.id, status: "pending", created_at: new Date().toISOString(), detail: request });
  await h.bridge.decideApproval({
    id: "decision_command", session_id: sessionID, target_host: "silicon-valley-01"
  }, { approvalId: "approval_manual", decision: "once" });
  assert.equal(h.getReplyCount(), 1);
  assert.equal(h.getApproval().status, "approved");
  assert.ok(h.calls.some((event) => event.event_type === "approval.manual_decision"));
});

test("approved row without its final audit event is reconciled without replay", async () => {
  const h = harness({ approvalMode: "auto" });
  h.setCommand({ payload: { text: "Inspect host", approval_grants: [] } });
  await h.bridge.startTurn(h.getCommand(), { text: "Inspect host" });
  const request = { id: "per_missing_audit", sessionID: "ses_demo", permission: "bash",
    metadata: { command: "free -h" }, patterns: ["free -h"] };
  h.setApproval({ id: "approval_missing_audit", session_id: sessionID, command_id: commandID,
    kilo_request_id: request.id, status: "approved",
    created_at: new Date(Date.now() + 5).toISOString(),
    detail: { ...request, _bridge_resolution_claim_id: "claim-before-crash",
      _bridge_resolution_kind: "auto", _bridge_resolution_decision: "once",
      _bridge_resolution_reason: "read_only_allowlist",
      _bridge_resolution_claimed_at: new Date().toISOString(),
      _bridge_resolution_command_id: commandID }
  });
  await h.bridge.resolveAutomaticApproval(h.getSession(), h.getCommand(), request);
  assert.equal(h.getReplyCount(), 0);
  assert.equal(h.getCommand().status, "needs_reconciliation");
  assert.equal(h.getSession().status, "needs_reconciliation");
});
