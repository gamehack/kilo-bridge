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
      const data = checked(await db.rpc("kilo_claim_next_command", { p_worker_id: worker, p_lease_seconds: lease }), "claim");
      return Array.isArray(data) ? data[0] || null : data;
    },
    async createSession(values) {
      return checked(await db.from("kilo_sessions").insert(values).select("*").single(), "createSession");
    },
    async session(id) {
      return checked(await db.from("kilo_sessions").select("*").eq("id", id).maybeSingle(), "session");
    },
    async sessionsActive() {
      return checked(await db.from("kilo_sessions").select("*")
        .in("status", ["running", "awaiting_approval", "needs_reconciliation"])
        .limit(100), "sessionsActive") || [];
    },
    async updateSession(id, values) {
      return checked(await db.from("kilo_sessions").update({ ...values, updated_at: new Date().toISOString() })
        .eq("id", id).select("*").single(), "updateSession");
    },
    async updateCommand(id, values) {
      return checked(await db.from("kilo_commands").update({ ...values, updated_at: new Date().toISOString() })
        .eq("id", id).select("*").single(), "updateCommand");
    },
    async command(id) {
      return checked(await db.from("kilo_commands").select("*").eq("id", id).maybeSingle(), "command");
    },
    async expiredClaims() {
      return checked(await db.from("kilo_commands").update({ status: "needs_reconciliation",
        error: { name: "LeaseExpired", message: "Claim state is uncertain; do not replay" },
        finished_at: new Date().toISOString() })
        .eq("status", "claimed").lt("lease_expires_at", new Date().toISOString()).select("*"), "expiredClaims") || [];
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
    async updateApproval(id, values) {
      return checked(await db.from("kilo_approvals").update(values).eq("id", id).select("*").single(), "updateApproval");
    }
  };
}
