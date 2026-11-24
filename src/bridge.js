import { randomUUID } from "node:crypto";
import { errorObject, validateCommand } from "./commands.js";

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
      if (this.config.bridgeHostId && command.target_host !== this.config.bridgeHostId) {
        this.logger.error("command.host_mismatch", { command_id: command.id });
        return;
      }
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
    const session = await this.store.createSession({ workspace_key: workspaceKey, directory, title, status: "creating" });
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
    const result = { message_count_before: messages.length,
      last_message_id_before: messages.at(-1)?.info?.id || null, kilo_session_id: session.kilo_session_id,
      model: this.config.kiloModel };
    await this.store.updateSession(session.id, { status: "running", current_command_id: command.id });
    await this.store.updateCommand(command.id, { status: "running", started_at: now(), lease_expires_at: null, result });
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

  async approvalUncertain(session, command, approval, error) {
    await this.store.updateCommand(command.id, { status: "needs_reconciliation",
      error: { name: "ApprovalReplyUncertain", message: "Approval reply or audit persistence uncertain" },
      finished_at: now(), lease_expires_at: null });
    await this.store.updateSession(session.id, { status: "needs_reconciliation" });
    await this.store.event({ command_id: command.id, session_id: session.id,
      event_type: "approval.needs_reconciliation", payload: { approval_id: approval?.id || null } });
    this.logger.warn("approval.needs_reconciliation", { approval_id: approval?.id, error: errorObject(error) });
  }

  // Both resolvers share the same durable claim. A claimed request is never blindly replayed.
  async resolveLiveApproval(session, command, approval, decision, source) {
    const currentSession = await this.store.session(session.id);
    const currentCommand = await this.store.command(command.id);
    const host = this.config.bridgeHostId;
    if (!currentSession || !currentCommand || currentSession.current_command_id !== command.id ||
        currentCommand.session_id !== session.id ||
        !["running", "awaiting_approval"].includes(currentSession.status) ||
        !["running", "awaiting_approval"].includes(currentCommand.status) ||
        (host && (currentSession.host_id !== host || currentCommand.target_host !== host))) return "inactive";
    if (!approval || approval.session_id !== session.id || approval.command_id !== command.id) {
      await this.approvalUncertain(session, command, approval, new Error("Approval identity mismatch"));
      return "uncertain";
    }
    if (approval.status !== "pending") return "resolved";
    const live = await this.kilo.pendingPermissions(currentSession.directory);
    if (!Array.isArray(live)) throw new Error("Invalid permission list");
    if (!live.some(p => p.id === approval.kilo_request_id && p.sessionID === currentSession.kilo_session_id)) {
      // An earlier always reply may have resolved other matching requests.
      await this.store.orphanMissingApprovals(session.id, command.id,
        live.filter(p => p.sessionID === currentSession.kilo_session_id).map(p => p.id));
      return "gone";
    }
    const existing = approval.detail?._bridge_resolution;
    if (existing) {
      if (!existing.claimedAt || Date.now() - Date.parse(existing.claimedAt) >= 120000) {
        await this.approvalUncertain(session, command, approval, new Error("Stale approval claim"));
        return "uncertain";
      }
      return "claimed";
    }
    const claim = { id: randomUUID(), source, decision, claimedAt: now() };
    if (!await this.store.claimApproval(approval, claim)) return "claimed";
    try {
      await this.store.event({ command_id: command.id, session_id: session.id,
        event_type: "approval." + source + "_intent", payload: { approval_id: approval.id, decision, claim_id: claim.id } });
      try {
        const reply = await this.kilo.replyPermission(currentSession.directory, approval.kilo_request_id, decision);
        if (reply === false) throw new Error("Kilo did not accept permission reply");
      } catch (error) {
        if (error.status !== 404) throw error;
        const remaining = await this.kilo.pendingPermissions(currentSession.directory);
        if (!Array.isArray(remaining) || remaining.some(p => p.id === approval.kilo_request_id && p.sessionID === currentSession.kilo_session_id)) throw error;
        await this.store.orphanMissingApprovals(session.id, command.id,
          remaining.filter(p => p.sessionID === currentSession.kilo_session_id).map(p => p.id));
        await this.store.event({ command_id: command.id, session_id: session.id,
          event_type: "approval.request_gone", payload: { approval_id: approval.id, claim_id: claim.id } });
        return "gone";
      }
      await this.store.updateApproval(approval.id, { status: decision === "reject" ? "rejected" : "approved",
        decision, resolved_at: now() });
      await this.store.event({ command_id: command.id, session_id: session.id,
        event_type: "approval." + source + "_decision", payload: { approval_id: approval.id, decision, claim_id: claim.id } });
      return "resolved";
    } catch (error) {
      await this.approvalUncertain(session, command, approval, error);
      return "uncertain";
    }
  }

  async decideApproval(command, { approvalId, decision }) {
    const approval = await this.store.approval(approvalId);
    if (!approval || approval.session_id !== command.session_id || approval.status !== "pending") {
      throw new Error("Approval is not pending in this session");
    }
    const session = await this.store.session(approval.session_id);
    if (!session || !session.current_command_id || session.current_command_id !== approval.command_id) {
      throw new Error("Approval is not attached to the current turn");
    }
    const parent = await this.store.command(session.current_command_id);
    if (!parent) throw new Error("Approval parent command is missing");
    const outcome = await this.resolveLiveApproval(session, parent, approval, decision, "manual");
    await this.finish(command, outcome === "resolved" ? "succeeded" :
      outcome === "uncertain" ? "needs_reconciliation" : "failed", { approval_id: approval.id, decision, outcome });
  }

  async health(command) {
    const response = await this.kilo.health();
    await this.finish(command, "succeeded", { kilo_connected: true, kilo_health: response,
      model: this.config.kiloModel });
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
    if (this.config.bridgeHostId && (session.host_id !== this.config.bridgeHostId || command.target_host !== this.config.bridgeHostId)) return;
    const permissions = await this.kilo.pendingPermissions(directory);
    if (!Array.isArray(permissions)) throw new Error("Invalid permission list");
    const pending = permissions.filter((p) => p.sessionID === session.kilo_session_id && typeof p.id === "string" && p.id);
    if (this.config.autoApprove) {
      await this.store.orphanMissingApprovals(session.id, command.id, pending.map(p => p.id));
    }
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
      if (this.config.autoApprove) {
        for (const request of pending) {
          const approval = await this.store.approvalForRequest(request.id, session.id, command.id);
          const outcome = await this.resolveLiveApproval(session, command, approval, "always", "auto");
          if (outcome === "uncertain" || outcome === "inactive") break;
        }
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
    if (!assistant || !assistant.info?.time?.completed || assistant.info.finish === "tool-calls") return; // Avoid declaring success on an empty idle observation.
    const failed = Boolean(assistant.info.error);
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
