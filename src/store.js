import { createClient } from "@supabase/supabase-js";

function checked({ data, error }, operation) {
  if (error) throw new Error(operation + ": " + error.message);
  return data;
}

export function createStore(config, logger) {
  const client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { headers: { "x-client-info": "primalflow-kilo-bridge/0.1.0" } },
    realtime: { params: { eventsPerSecond: 5 } }
  });
  // coord is deliberately private. Service-role-only public security-invoker views/RPC.
  const db = client.schema("public");
  const hostId = config.bridgeHostId || "silicon-valley-01";
  return {
    subscribe(wake) {
      return client.channel("kilo-bridge-commands")
        .on("postgres_changes", { event: "INSERT", schema: "coord", table: "kilo_commands" }, () => wake())
        .subscribe((status, error) => {
          if (status === "SUBSCRIBED") wake();
          if (error) logger.warn("realtime.error", { message: error.message });
        });
    },
    async unsubscribe(channel) {
      if (channel) await client.removeChannel(channel);
      client.realtime.disconnect();
    },
    async claim(worker, lease) {
      const data = checked(await db.rpc("kilo_claim_host_command", {
        p_host_id: hostId, p_worker_id: worker, p_lease_seconds: lease
      }), "claim");
      return Array.isArray(data) ? data[0] || null : data;
    },
    async createSession(values) {
      return checked(await db.from("kilo_sessions").insert({ ...values, host_id: hostId })
        .select("*").single(), "createSession");
    },
    async session(id) {
      return checked(await db.from("kilo_sessions").select("*").eq("id", id)
        .eq("host_id", hostId).maybeSingle(), "session");
    },
    async sessionsActive() {
      return checked(await db.from("kilo_sessions").select("*")
        .in("status", ["running", "awaiting_approval", "needs_reconciliation"])
        .eq("host_id", hostId).limit(100), "sessionsActive") || [];
    },
    async updateSession(id, values) {
      return checked(await db.from("kilo_sessions").update({ ...values, updated_at: new Date().toISOString() })
        .eq("id", id).eq("host_id", hostId).select("*").single(), "updateSession");
    },
    async updateCommand(id, values) {
      return checked(await db.from("kilo_commands").update({ ...values, updated_at: new Date().toISOString() })
        .eq("id", id).eq("target_host", hostId).select("*").single(), "updateCommand");
    },
    async command(id) {
      return checked(await db.from("kilo_commands").select("*").eq("id", id)
        .eq("target_host", hostId).maybeSingle(), "command");
    },
    async expiredClaims() {
      return checked(await db.from("kilo_commands").update({ status: "needs_reconciliation",
        error: { name: "LeaseExpired", message: "Claim state is uncertain; do not replay" },
        finished_at: new Date().toISOString() })
        .eq("status", "claimed").eq("target_host", hostId)
        .lt("lease_expires_at", new Date().toISOString()).select("*"), "expiredClaims") || [];
    },
    async event(values) { checked(await db.from("kilo_events").insert(values), "event"); },
    async upsertApproval(values) {
      // Polling must never reset an operator's approved/rejected decision to pending.
      checked(await db.from("kilo_approvals").upsert(values,
        { onConflict: "kilo_request_id", ignoreDuplicates: true }), "upsertApproval");
    },
    async approvalForRequest(requestId, sessionId, commandId) {
      let query = db.from("kilo_approvals").select("*")
        .eq("kilo_request_id", requestId).eq("session_id", sessionId);
      query = commandId == null ? query.is("command_id", null) : query.eq("command_id", commandId);
      return checked(await query.maybeSingle(), "approvalForRequest");
    },
    async approval(id, sessionId) {
      return checked(await db.from("kilo_approvals").select("*")
        .eq("id", id).eq("session_id", sessionId).maybeSingle(), "approval");
    },
    async claimApproval(approval, claim) {
      const previous = approval.detail && typeof approval.detail === "object" && !Array.isArray(approval.detail)
        ? approval.detail : {};
      const detail = {
        ...previous,
        _bridge_resolution_claim_id: claim.claimId,
        _bridge_resolution_kind: claim.kind,
        _bridge_resolution_decision: claim.decision,
        _bridge_resolution_reason: claim.reason,
        _bridge_resolution_claimed_at: claim.claimedAt,
        _bridge_resolution_command_id: claim.resolverCommandId
      };
      let query = db.from("kilo_approvals").update({ detail })
        .eq("id", approval.id).eq("session_id", approval.session_id).eq("status", "pending");
      query = approval.command_id == null ? query.is("command_id", null) : query.eq("command_id", approval.command_id);
      const data = checked(await query
        .filter("detail->>_bridge_resolution_claim_id", "is", "null")
        .select("id"), "claimApproval") || [];
      return data.length === 1;
    },
    async updateApproval(id, sessionId, values) {
      return checked(await db.from("kilo_approvals").update(values)
        .eq("id", id).eq("session_id", sessionId).select("*").single(), "updateApproval");
    },
    async approvalDecisionEvent(commandId, approvalId, eventType) {
      const data = checked(await db.from("kilo_events").select("id")
        .eq("command_id", commandId).eq("event_type", eventType)
        .contains("payload", { approval_id: approvalId }).limit(1), "approvalDecisionEvent") || [];
      return data.length > 0;
    }
  };
}
