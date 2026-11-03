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

  async decideApproval(command, { approvalId, decision }) {
    const approval = await this.store.approval(approvalId);
    if (!approval || approval.session_id !== command.session_id || approval.status !== "pending") {
      throw new Error("Approval is not pending in this session");
    }
    const session = await this.store.session(approval.session_id);
    command.dispatched = true;
    await this.kilo.replyPermission(session.directory, approval.kilo_request_id, decision);
    await this.store.updateApproval(approval.id, { status: decision === "reject" ? "rejected" : "approved",
      decision, resolved_at: now() });
    await this.store.updateSession(session.id, { status: "running" });
    if (session.current_command_id) await this.store.updateCommand(session.current_command_id, { status: "running" });
    await this.finish(command, "succeeded", { approval_id: approval.id, decision });
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
