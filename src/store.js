import { createClient } from "@supabase/supabase-js";

function checked({ data, error }, operation) {
  if (error) throw new Error(`${operation}: ${error.message}`);
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
  const host = config.bridgeHostId;
  const scoped = (query, field) => host ? query.eq(field, host) : query;
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
      const data = checked(await db.rpc(host ? "kilo_claim_host_command" : "kilo_claim_next_command", { ...(host ? { p_host_id: host } : {}), p_worker_id: worker, p_lease_seconds: lease }), "claim");
      return Array.isArray(data) ? data[0] || null : data;
    },
    async createSession(values) {
      return checked(await db.from("kilo_sessions").insert({ ...values, ...(host ? { host_id: host } : {}) }).select("*").single(), "createSession");
    },
    async session(id) {
      return checked(await scoped(db.from("kilo_sessions").select("*").eq("id", id), "host_id").maybeSingle(), "session");
    },
    async sessionsActive() {
      return checked(await scoped(db.from("kilo_sessions").select("*")
        .in("status", ["running", "awaiting_approval", "needs_reconciliation"]), "host_id").limit(100), "sessionsActive") || [];
    },
    async updateSession(id, values) {
      return checked(await scoped(db.from("kilo_sessions").update({ ...values, updated_at: new Date().toISOString() })
        .eq("id", id), "host_id").select("*").single(), "updateSession");
    },
    async updateCommand(id, values) {
      return checked(await scoped(db.from("kilo_commands").update({ ...values, updated_at: new Date().toISOString() })
        .eq("id", id), "target_host").select("*").single(), "updateCommand");
    },
    async command(id) {
      return checked(await scoped(db.from("kilo_commands").select("*").eq("id", id), "target_host").maybeSingle(), "command");
    },
    async expiredClaims() {
      return checked(await scoped(db.from("kilo_commands").update({ status: "needs_reconciliation",
        error: { name: "LeaseExpired", message: "Claim state is uncertain; do not replay" },
        finished_at: new Date().toISOString() })
        .eq("status", "claimed").lt("lease_expires_at", new Date().toISOString()), "target_host").select("*"), "expiredClaims") || [];
    },
    async event(values) { checked(await db.from("kilo_events").insert(values), "event"); },
    async upsertApproval(values) {
      // Polling must never reset an operator's approved/rejected decision to pending.
      checked(await db.from("kilo_approvals").upsert(values,
        { onConflict: "kilo_request_id", ignoreDuplicates: true }), "upsertApproval");
    },
    async approval(id) {
      return checked(await db.from("kilo_approvals").select("*").eq("id", id).maybeSingle(), "approval");
    },
    async approvalForRequest(requestId, sessionId, commandId) {
      return checked(await db.from("kilo_approvals").select("*").eq("kilo_request_id", requestId)
        .eq("session_id", sessionId).eq("command_id", commandId).maybeSingle(), "approvalForRequest");
    },
    async claimApproval(approval, claim) {
      const detail = { ...approval.detail, _bridge_resolution: claim };
      const rows = checked(await db.from("kilo_approvals").update({ detail })
        .eq("id", approval.id).eq("session_id", approval.session_id).eq("command_id", approval.command_id)
        .eq("status", "pending").filter("detail->>_bridge_resolution", "is", "null")
        .select("id"), "claimApproval") || [];
      return rows.length === 1;
    },
    async orphanMissingApprovals(sessionId, commandId, liveIds) {
      const rows = checked(await db.from("kilo_approvals").select("id,kilo_request_id")
        .eq("session_id", sessionId).eq("command_id", commandId).eq("status", "pending"), "pendingApprovals") || [];
      for (const row of rows) {
        if (!liveIds.includes(row.kilo_request_id)) {
          checked(await db.from("kilo_approvals").update({ status: "orphaned", resolved_at: new Date().toISOString() })
            .eq("id", row.id).eq("status", "pending"), "orphanMissingApproval");
        }
      }
    },
    async updateApproval(id, values) {
      return checked(await db.from("kilo_approvals").update(values).eq("id", id).select("*").single(), "updateApproval");
    }
  };
}
