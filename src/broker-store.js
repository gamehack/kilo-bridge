// HTTPS host-scoped store; no production Supabase service-role key on the laptop.
export function createBrokerStore(config) {
  if (!config.brokerUrl || !config.brokerToken) throw new Error("Broker URL/token required");
  const invoke = async (action, args = {}) => {
    const response = await fetch(config.brokerUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${config.brokerToken}`
      },
      body: JSON.stringify({ action, args }),
      signal: AbortSignal.timeout(config.requestTimeoutMs)
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Kilo broker ${action} HTTP ${response.status}: ${raw.slice(0, 150)}`);
    const body = raw ? JSON.parse(raw) : {};
    if (!Object.hasOwn(body, "data")) throw new Error(`Kilo broker ${action} response missing data`);
    return body.data;
  };
  return {
    // No host-broad Realtime permissions; normal Bridge polling is sufficient.
    subscribe() { return null; },
    async unsubscribe() {},
    claim(worker, lease) { return invoke("claim", { worker, lease }); },
    createSession(values) { return invoke("createSession", { values }); },
    session(id) { return invoke("session", { id }); },
    sessionsActive() { return invoke("sessionsActive"); },
    updateSession(id, values) { return invoke("updateSession", { id, values }); },
    updateCommand(id, values) { return invoke("updateCommand", { id, values }); },
    command(id) { return invoke("command", { id }); },
    expiredClaims() { return invoke("expiredClaims"); },
    event(values) { return invoke("event", { values }); },
    upsertApproval(values) { return invoke("upsertApproval", { values }); },
    approval(id) { return invoke("approval", { id }); },
    approvalForRequest(requestId, sessionId, commandId) { return invoke("approvalForRequest", { requestId, sessionId, commandId }); },
    claimApproval(approval, claim) { return invoke("claimApproval", { id: approval.id, sessionId: approval.session_id, commandId: approval.command_id, claim }); },
    orphanMissingApprovals(sessionId, commandId, liveIds) { return invoke("orphanMissingApprovals", { sessionId, commandId, liveIds }); },
    updateApproval(id, values) { return invoke("updateApproval", { id, values }); }
  };
}
