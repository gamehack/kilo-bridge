import { randomUUID } from "node:crypto";
import { errorObject, validateCommand } from "./commands.js";
import { evaluateApproval, validateApprovalGrants } from "./approval-policy.js";

const now = () => new Date().toISOString();
const isTerminal = (status) => ["succeeded", "failed", "cancelled", "needs_reconciliation"].includes(status);
function lastAssistant(messages, command) {
  const previousId = command.result?.last_message_id_before;
  let newMessages;
  if (previousId) {
    const index = messages.findIndex((message) => message?.info?.id === previousId);
    // The Kilo message endpoint may truncate older history in a long session.
    // If our anchor is missing, use the command timestamp, never an old answer.
    newMessages = index < 0
      ? messages.filter((m) => (m?.info?.time?.created ?? 0) >= Date.parse(command.started_at || ""))
      : messages.slice(index + 1);
  } else {
    newMessages = messages.slice(command.result?.message_count_before ?? 0);
  }
  return newMessages.filter((message) => message?.info?.role === "assistant").at(-1);
}
const finalText = (message) => (message?.parts || []).filter((part) => part.type === "text")
  .map((part) => part.text || "").join("\n").slice(0, 50000);

export class Bridge {
  constructor(config, store, kilo, logger) {
    this.config = config;
    this.store = store;
    this.kilo = kilo;
    this.logger = logger;
    this.busy = false;
    this.stopped = false;
    this.timer = null;
    this.channel = null;
    this.sseAbort = null;
    this.ssePromise = null;
  }

  async start() {
    await this.kilo.health();
    this.channel = this.store.subscribe(() => this.wake());
    this.timer = setInterval(() => this.wake(), this.config.pollIntervalMs);
    this.sseAbort = new AbortController();
    this.ssePromise = this.listenSse(this.sseAbort.signal);
    this.wake();
    this.logger.info("bridge.started", { bridge_id: this.config.bridgeId, model: this.config.kiloModel,
      default_directory: this.config.defaultDirectory });
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.sseAbort?.abort();
    await this.store.unsubscribe(this.channel);
    await this.ssePromise?.catch(() => {});
    this.logger.info("bridge.stopped");
  }

  wake() {
    if (this.stopped || this.busy) return;
    void this.tick().catch((error) => this.logger.error("bridge.tick_failed", { error: errorObject(error) }));
  }

  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const expired = await this.store.expiredClaims();
      for (const command of expired) await this.store.event({ command_id: command.id,
        session_id: command.session_id, event_type: "command.lease_expired", payload: {} });

      for (let n = 0; n < 5; n++) {
        const command = await this.store.claim(this.config.bridgeId, this.config.claimLeaseSeconds);
        if (!command) break;
        await this.execute(command);
      }
      for (const session of await this.store.sessionsActive()) {
        await this.reconcile(session).catch((error) => this.logger.warn("session.poll_failed",
          { session_id: session.id, error: errorObject(error) }));
      }
    } finally {
      this.busy = false;
    }
  }

  async execute(command) {
    try {
      const hostId = this.config.bridgeHostId || "silicon-valley-01";
      if (command.target_host !== hostId) throw new Error("Command host mismatch");
      const input = validateCommand(command, this.config);
      switch (command.command_type) {
        case "create_session": return await this.createSession(command, input);
        case "start_turn": return await this.startTurn(command, input);
        case "interrupt_turn": return await this.interrupt(command);
        case "approval_decision": return await this.decideApproval(command, input);
        case "health_check": return await this.health(command);
      }
    } catch (error) {
      const uncertain = Boolean(command.dispatched);
      await this.store.updateCommand(command.id, { status: uncertain ? "needs_reconciliation" : "failed",
        error: errorObject(error), finished_at: now(), lease_expires_at: null });
      if (uncertain && command.session_id) await this.store.updateSession(command.session_id,
        { status: "needs_reconciliation" });
      await this.store.event({ command_id: command.id, session_id: command.session_id,
        event_type: uncertain ? "command.needs_reconciliation" : "command.failed", payload: errorObject(error) });
      this.logger.warn("command.error", { command_id: command.id, error: errorObject(error) });
    }
  }

  async createSession(command, { workspaceKey, directory, title }) {
    const session = await this.store.createSession({ workspace_key: workspaceKey, directory, title, host_id: this.config.bridgeHostId || "silicon-valley-01", status: "creating" });
    await this.store.updateCommand(command.id, { session_id: session.id });
    command.session_id = session.id;
    command.dispatched = true;
    const created = await this.kilo.createSession(directory, title);
    if (!created?.id) throw new Error("Kilo createSession response has no id");
    await this.store.updateSession(session.id, { kilo_session_id: created.id, status: "ready" });
    await this.finish(command, "succeeded", { session_id: session.id, kilo_session_id: created.id,
      workspace_key: workspaceKey, directory });
  }

  async startTurn(command, { text }) {
    const session = await this.store.session(command.session_id);
    if (!session || !session.kilo_session_id || session.status !== "ready") {
      throw new Error("Kilo session is not ready");
    }
    const directory = session.directory;
    if (!directory) throw new Error("Session directory is missing");
    const messages = await this.kilo.messages(directory, session.kilo_session_id);
    if (!Array.isArray(messages)) throw new Error("Kilo messages response was not an array");
    const startedAt = now();
    const approvalMode = this.config.approvalMode || "manual";
    const result = {
      message_count_before: messages.length,
      last_message_id_before: messages.at(-1)?.info?.id || null,
      kilo_session_id: session.kilo_session_id,
      model: this.config.kiloModel,
      approval_mode: approvalMode,
      approval_policy_version: 2,
      approval_policy_host_id: this.config.bridgeHostId || "silicon-valley-01",
      approval_policy_started_at: startedAt
    };
    await this.store.updateSession(session.id, { status: "running", current_command_id: command.id });
    await this.store.updateCommand(command.id, {
      status: "running", started_at: startedAt, lease_expires_at: null, result
    });
    command.dispatched = true;
    await this.kilo.promptAsync(directory, session.kilo_session_id, text, this.config.kiloModel);
    await this.store.event({ command_id: command.id, session_id: session.id,
      event_type: "turn.accepted", payload: { kilo_session_id: session.kilo_session_id, model: this.config.kiloModel } });
    this.logger.info("turn.accepted", { command_id: command.id, session_id: session.id });
  }

  async interrupt(command) {
    const session = await this.store.session(command.session_id);
    if (!session?.kilo_session_id || !["running", "awaiting_approval"].includes(session.status)) {
      throw new Error("Session has no active turn");
    }
    command.dispatched = true;
    await this.kilo.abort(session.directory, session.kilo_session_id);
    if (session.current_command_id) await this.store.updateCommand(session.current_command_id,
      { status: "cancelled", finished_at: now(), lease_expires_at: null });
    await this.store.updateSession(session.id, { status: "ready", current_command_id: null });
    await this.finish(command, "succeeded", { interrupt_accepted: true });
  }

  async decideApproval(command, { approvalId, decision }) {
    const approval = await this.store.approval(approvalId, command.session_id);
    if (!approval || approval.status !== "pending") {
      throw new Error("Approval is not pending in this session");
    }
    const session = await this.store.session(approval.session_id);
    if (!session?.kilo_session_id) throw new Error("Approval session is unavailable on this host");
    const claim = {
      claimId: randomUUID(), kind: "manual", decision, reason: "operator_decision",
      claimedAt: now(), resolverCommandId: command.id
    };
    const claimed = await this.store.claimApproval(approval, claim);
    if (!claimed) {
      const latest = await this.store.approval(approvalId, session.id);
      const resolutionState = latest
        ? await this.handleExistingApprovalClaim(session, latest, command.id, [command.id])
        : null;
      if (resolutionState !== "reconciliation") {
        await this.finish(command, "failed", { approval_id: approval.id, reason: "already_claimed" });
      }
      return;
    }
    command.dispatched = true;
    try {
      await this.store.event({ command_id: command.id, session_id: session.id,
        event_type: "approval.manual_intent", payload: { approval_id: approval.id,
          decision, claim_id: claim.claimId } });
      await this.kilo.replyPermission(session.directory, approval.kilo_request_id, decision);
      await this.store.updateApproval(approval.id, session.id, {
        status: decision === "reject" ? "rejected" : "approved", decision, resolved_at: now()
      });
      await this.store.updateSession(session.id, { status: "running" });
      if (session.current_command_id) {
        await this.store.updateCommand(session.current_command_id, { status: "running" });
      }
      await this.store.event({ command_id: command.id, session_id: session.id,
        event_type: "approval.manual_decision", payload: { approval_id: approval.id,
          decision, claim_id: claim.claimId } });
      await this.finish(command, "succeeded", { approval_id: approval.id, decision });
    } catch (error) {
      await this.markApprovalNeedsReconciliation(session, approval, claim, error, [command.id]);
    }
  }

  async handleExistingApprovalClaim(session, approval, fallbackCommandId, extraCommandIds = []) {
    const detail = approval.detail && typeof approval.detail === "object" ? approval.detail : {};
    const claimId = detail._bridge_resolution_claim_id;
    if (!claimId) return null;
    const claim = {
      claimId,
      kind: detail._bridge_resolution_kind || "auto",
      decision: detail._bridge_resolution_decision || null,
      reason: detail._bridge_resolution_reason || "previous_resolution",
      claimedAt: detail._bridge_resolution_claimed_at || null,
      resolverCommandId: detail._bridge_resolution_command_id || fallbackCommandId || session.current_command_id
    };
    if (["approved", "rejected"].includes(approval.status)) {
      let audited = false;
      try {
        audited = await this.store.approvalDecisionEvent(
          claim.resolverCommandId, approval.id, "approval." + claim.kind + "_decision"
        );
      } catch {}
      if (audited) return "complete";
      await this.markApprovalNeedsReconciliation(session, approval, claim,
        new Error("Final approval audit event is missing"), extraCommandIds, "final_audit_missing");
      return "reconciliation";
    }
    if (approval.status === "pending") {
      const claimedAt = Date.parse(claim.claimedAt || "");
      if (Number.isFinite(claimedAt) && Date.now() - claimedAt < 120000) return "in_progress";
      await this.markApprovalNeedsReconciliation(session, approval, claim,
        new Error("Approval resolution claim is stale"), extraCommandIds, "stale_claim");
      return "reconciliation";
    }
    if (approval.status === "orphaned") {
      await this.markApprovalNeedsReconciliation(session, approval, claim,
        new Error("Approval was orphaned while a resolution claim exists"), extraCommandIds, "orphaned_claim");
      return "reconciliation";
    }
    return null;
  }

  async markApprovalNeedsReconciliation(session, approval, claim, error, extraCommandIds = [], phase = "reply_or_audit") {
    const patch = {
      status: "needs_reconciliation",
      error: { name: "ApprovalReplyUncertain",
        message: "Permission reply or audit persistence is uncertain; manual reconciliation required" },
      finished_at: now(),
      lease_expires_at: null
    };
    const commandIds = new Set([
      session.current_command_id,
      claim?.resolverCommandId,
      ...extraCommandIds
    ].filter(Boolean));
    const operations = [
      ...[...commandIds].map((id) => this.store.updateCommand(id, patch)),
      this.store.updateSession(session.id, { status: "needs_reconciliation" }),
      this.store.event({
        command_id: claim?.resolverCommandId || session.current_command_id || null,
        session_id: session.id,
        event_type: "approval.needs_reconciliation",
        payload: { approval_id: approval.id, claim_id: claim?.claimId || null, phase }
      })
    ];
    const results = await Promise.allSettled(operations);
    results.forEach((result, index) => {
      if (result.status === "rejected") this.logger.error("approval.reconciliation_persist_failed", {
        session_id: session.id, approval_id: approval.id, operation_index: index,
        error: errorObject(result.reason)
      });
    });
    this.logger.error("approval.needs_reconciliation", {
      session_id: session.id, approval_id: approval.id, phase, error: errorObject(error)
    });
  }

  async resolveAutomaticApproval(session, command, request) {
    const mode = this.config.approvalMode || "manual";
    const hostId = this.config.bridgeHostId || "silicon-valley-01";
    // Existing turns are deliberately never migrated into auto mode. Only a turn
    // started by V2 while auto was enabled can have its permissions auto-resolved.
    if (!["auto", "full_auto"].includes(mode) ||
        command.result?.approval_mode !== mode ||
        command.result?.approval_policy_version !== 2 ||
        command.result?.approval_policy_host_id !== hostId ||
        (mode === "full_auto" && this.config.approvalIsolated !== true)) return;

    const approval = await this.store.approvalForRequest(request.id, session.id, command.id);
    if (!approval) return;
    const startedAt = Date.parse(command.started_at || command.result.approval_policy_started_at || "");
    const approvalCreatedAt = Date.parse(approval.created_at || "");
    if (!Number.isFinite(startedAt) || !Number.isFinite(approvalCreatedAt) || approvalCreatedAt < startedAt) return;

    if (approval.status !== "pending") {
      await this.handleExistingApprovalClaim(session, approval, command.id);
      return;
    }
    const existingClaim = await this.handleExistingApprovalClaim(session, approval, command.id);
    if (existingClaim) return;

    const grants = validateApprovalGrants(command.payload?.approval_grants);
    const policy = evaluateApproval(request, this.config, grants, approval.created_at);
    if (!policy.decision) return;
    const claim = {
      claimId: randomUUID(), kind: "auto", decision: policy.decision, reason: policy.reason,
      claimedAt: now(), resolverCommandId: command.id
    };
    const claimed = await this.store.claimApproval(approval, claim);
    if (!claimed) {
      const latest = await this.store.approvalForRequest(request.id, session.id, command.id);
      if (latest) await this.handleExistingApprovalClaim(session, latest, command.id);
      return;
    }

    try {
      await this.store.event({ command_id: command.id, session_id: session.id,
        event_type: "approval.auto_intent", payload: { approval_id: approval.id,
          decision: policy.decision, reason: policy.reason, claim_id: claim.claimId } });
      await this.kilo.replyPermission(session.directory, request.id, policy.decision);
      await this.store.updateApproval(approval.id, session.id, {
        status: policy.decision === "reject" ? "rejected" : "approved",
        decision: policy.decision, resolved_at: now()
      });
      await this.store.event({ command_id: command.id, session_id: session.id,
        event_type: "approval.auto_decision", payload: { approval_id: approval.id,
          decision: policy.decision, reason: policy.reason, claim_id: claim.claimId } });
    } catch (error) {
      await this.markApprovalNeedsReconciliation(session, approval, claim, error, [],
        error?.message === "event: audit unavailable" ? "decision_audit_failed" : "reply_or_persist_failed");
    }
  }

  async health(command) {
    const response = await this.kilo.health();
    await this.finish(command, "succeeded", { kilo_connected: true, kilo_health: response,
      model: this.config.kiloModel, approval_mode: this.config.approvalMode || "manual",
      approval_timeout_seconds: this.config.approvalTimeoutSeconds || 60 });
  }

  async finish(command, status, result) {
    await this.store.updateCommand(command.id, { status, result,
      error: null, finished_at: now(), lease_expires_at: null });
    await this.store.event({ command_id: command.id, session_id: command.session_id,
      event_type: `command.${status}`, payload: { status } });
  }

  async reconcile(session) {
    if (!session.kilo_session_id || !session.current_command_id) return;
    const directory = session.directory;
    if (!directory) return;
    const command = await this.store.command(session.current_command_id);
    if (!command || isTerminal(command.status)) return;
    const permissions = await this.kilo.pendingPermissions(directory);
    const pending = (Array.isArray(permissions) ? permissions : []).filter((p) => p.sessionID === session.kilo_session_id);
    if (pending.length) {
      for (const request of pending) {
        await this.store.upsertApproval({ session_id: session.id, command_id: command.id,
          kilo_request_id: request.id, status: "pending", detail: request });
      }
      if (session.status !== "awaiting_approval") {
        await this.store.updateSession(session.id, { status: "awaiting_approval" });
        await this.store.updateCommand(command.id, { status: "awaiting_approval" });
        await this.store.event({ command_id: command.id, session_id: session.id,
          event_type: "approval.requested", payload: { count: pending.length } });
      }
      if ((this.config.approvalMode || "manual") !== "manual") {
        for (const request of pending) await this.resolveAutomaticApproval(session, command, request);
      }
      return;
    }
    // Questions also block unattended agents, but answering them is outside v0.1.
    const questions = await this.kilo.pendingQuestions(directory).catch((error) => {
      if (error.status === 404) return [];
      throw error;
    });
    if ((Array.isArray(questions) ? questions : []).some((q) => q.sessionID === session.kilo_session_id)) {
      if (session.status !== "needs_reconciliation") {
        await this.store.updateSession(session.id, { status: "needs_reconciliation" });
        await this.store.updateCommand(command.id, { status: "needs_reconciliation",
          error: { name: "QuestionPending", message: "Kilo is waiting for a question response" } });
      }
      return;
    }
    const statuses = await this.kilo.status(directory);
    const state = statuses?.[session.kilo_session_id];
    if (state && ["busy", "retry"].includes(state.type)) {
      if (session.status === "awaiting_approval") {
        await this.store.updateSession(session.id, { status: "running" });
        await this.store.updateCommand(command.id, { status: "running" });
      }
      return;
    }
    const messages = await this.kilo.messages(directory, session.kilo_session_id);
    const assistant = Array.isArray(messages) ? lastAssistant(messages, command) : null;
    if (!assistant || !assistant.info?.time?.completed) return; // Avoid declaring success on an empty idle observation.
    const failed = Boolean(assistant.info.error);
    // An idle, completed tool-call message is not a final assistant answer.
    // Give Kilo a short grace interval to emit its continuation.
    if (!failed && (assistant.info.finish === "tool-calls" || !finalText(assistant).trim())) {
      const completed = Number(assistant.info.time.completed);
      if (!Number.isFinite(completed) || Date.now() - completed < 30000) return;
      await this.store.updateCommand(command.id, { status: "needs_reconciliation",
        result: { ...command.result, assistant_message_id: assistant.info.id, finish: assistant.info.finish || null },
        error: { name: "IncompleteTurn", message: "Kilo went idle without a final assistant answer" },
        finished_at: now(), lease_expires_at: null });
      await this.store.updateSession(session.id, { status: "needs_reconciliation" });
      await this.store.event({ command_id: command.id, session_id: session.id,
        event_type: "turn.incomplete", payload: {} });
      return;
    }
    const result = { ...command.result, final_message: finalText(assistant),
      assistant_message_id: assistant.info.id, finish: assistant.info.finish || null };
    await this.store.updateCommand(command.id, { status: failed ? "failed" : "succeeded", result,
      error: failed ? assistant.info.error : null, finished_at: now(), lease_expires_at: null });
    await this.store.updateSession(session.id, { status: failed ? "error" : "ready", current_command_id: null });
    await this.store.event({ command_id: command.id, session_id: session.id,
      event_type: "turn.completed", payload: { failed, final_message_chars: result.final_message.length } });
    this.logger.info("turn.completed", { command_id: command.id, session_id: session.id, failed });
  }

  async listenSse(signal) {
    let delay = 1000;
    while (!signal.aborted) {
      try {
        await this.kilo.streamEvents(async (event) => {
          const type = event?.payload?.type || event?.type;
          if (["session.idle", "session.error", "permission.asked", "permission.replied", "session.status"].includes(type)) {
            this.wake();
          }
        }, signal);
        delay = 1000;
      } catch (error) {
        if (!signal.aborted) this.logger.warn("kilo.sse_disconnected", { error: errorObject(error) });
      }
      if (signal.aborted) break;
      await new Promise((resolve) => {
        const timeout = setTimeout(done, delay);
        function done() { clearTimeout(timeout); signal.removeEventListener("abort", done); resolve(); }
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
      delay = Math.min(30000, delay * 2);
    }
  }
}
