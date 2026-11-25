// Scoped backend for macbook-01; configure verify_jwt=false.
// SUPABASE_SERVICE_ROLE_KEY remains in Supabase, never on the MacBook.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const HOST = "macbook-01";
const ROOT = "/Users/gamehack/kilo-workspaces";
// The CLI reads its token file with trim(). Dashboard pastes may preserve a trailing newline.
const expectedToken = (Deno.env.get("MACBOOK_WORKER_TOKEN") || "").trim();
const url = Deno.env.get("SUPABASE_URL") || "";
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const database = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false }
}).schema("public");

async function authorized(candidate: string) {
  if (expectedToken.length < 40 || candidate.length < 40) return false;
  const hash = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const a = await hash(candidate), b = await hash(expectedToken);
  let delta = 0;
  for (let i = 0; i < a.length; i++) delta |= a[i] ^ b[i];
  return delta === 0;
}

const sessionFields = new Set(["status", "current_command_id", "kilo_session_id", "updated_at"]);
const commandFields = new Set(["status", "session_id", "started_at", "finished_at", "lease_expires_at", "error", "result", "updated_at"]);
const approvalFields = new Set(["status", "decision", "resolved_at"]);
function patch(value: unknown, permitted: Set<string>) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid patch");
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some((name) => !permitted.has(name))) throw Error("disallowed patch field");
  return fields;
}
function checked<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw Error(res.error.message);
  return res.data;
}
function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}
async function ownSession(id: unknown) {
  if (typeof id !== "string") return null;
  return checked(await database.from("kilo_sessions").select("*")
    .eq("id", id).eq("host_id", HOST).maybeSingle());
}
async function ownCommand(id: unknown) {
  if (typeof id !== "string") return null;
  return checked(await database.from("kilo_commands").select("*")
    .eq("id", id).eq("target_host", HOST).maybeSingle());
}
async function ownApproval(id: unknown) {
  if (typeof id !== "string") return null;
  const approval = checked(await database.from("kilo_approvals")
    .select("*").eq("id", id).maybeSingle());
  return approval && await ownSession(approval.session_id) ? approval : null;
}

// Additional approval operations are scoped to this host's current active turn.
async function activeApprovalContext(sessionId: unknown, commandId: unknown) {
  const s = await ownSession(sessionId);
  const c = await ownCommand(commandId);
  requireValid(s && c && s.current_command_id === c.id && c.session_id === s.id &&
    ["running", "awaiting_approval"].includes(s.status) &&
    ["running", "awaiting_approval"].includes(c.status), "approval is not in current host turn");
  return { s, c };
}
async function dispatch(action: string, args: Record<string, unknown>) {
  switch (action) {
    case "claim": {
      requireValid(typeof args.worker === "string" && args.worker.length <= 180, "invalid worker");
      requireValid(Number.isInteger(args.lease) && Number(args.lease) >= 15 && Number(args.lease) <= 300, "invalid lease");
      const rows = checked(await database.rpc("kilo_claim_host_command", {
        p_host_id: HOST, p_worker_id: args.worker, p_lease_seconds: args.lease
      }));
      return Array.isArray(rows) ? rows[0] || null : rows;
    }
    case "createSession": {
      const v = args.values as Record<string, unknown>;
      requireValid(v && v.host_id === HOST, "host mismatch");
      requireValid(typeof v.directory === "string" &&
        (v.directory === ROOT || v.directory.startsWith(ROOT + "/")) &&
        !v.directory.split("/").includes(".."), "directory outside approved workspace");
      requireValid(typeof v.title === "string" && typeof v.workspace_key === "string", "invalid session");
      return checked(await database.from("kilo_sessions").insert({
        host_id: HOST, title: v.title, workspace_key: v.workspace_key,
        directory: v.directory, status: "creating"
      }).select("*").single());
    }
    case "session": return ownSession(args.id);
    case "sessionsActive": return checked(await database.from("kilo_sessions")
      .select("*").eq("host_id", HOST)
      .in("status", ["running", "awaiting_approval", "needs_reconciliation"]).limit(100));
    case "updateSession": {
      requireValid(await ownSession(args.id), "session not owned by host");
      const v = patch(args.values, sessionFields);
      if (Object.hasOwn(v, "current_command_id") && v.current_command_id !== null)
        requireValid(await ownCommand(v.current_command_id), "command not owned by host");
      return checked(await database.from("kilo_sessions").update(v)
        .eq("id", args.id).eq("host_id", HOST).select("*").single());
    }
    case "command": return ownCommand(args.id);
    case "updateCommand": {
      requireValid(await ownCommand(args.id), "command not owned by host");
      const v = patch(args.values, commandFields);
      if (Object.hasOwn(v, "session_id") && v.session_id !== null)
        requireValid(await ownSession(v.session_id), "session not owned by host");
      return checked(await database.from("kilo_commands").update(v)
        .eq("id", args.id).eq("target_host", HOST).select("*").single());
    }
    case "expiredClaims": return checked(await database.from("kilo_commands")
      .update({ status: "needs_reconciliation",
        error: { name: "LeaseExpired", message: "Claim state is uncertain; do not replay" },
        finished_at: new Date().toISOString()
      }).eq("status", "claimed").eq("target_host", HOST)
      .lt("lease_expires_at", new Date().toISOString()).select("*"));
    case "event": {
      const v = args.values as Record<string, unknown>;
      requireValid(v && typeof v.event_type === "string", "invalid event");
      if (v.session_id != null) requireValid(await ownSession(v.session_id), "session not owned by host");
      if (v.command_id != null) requireValid(await ownCommand(v.command_id), "command not owned by host");
      return checked(await database.from("kilo_events").insert({
        session_id: v.session_id || null, command_id: v.command_id || null,
        event_type: v.event_type, payload: v.payload || {}
      }));
    }
    case "upsertApproval": {
      const v = args.values as Record<string, unknown>;
      requireValid(v && await ownSession(v.session_id), "session not owned by host");
      if (v.command_id != null) requireValid(await ownCommand(v.command_id), "command not owned by host");
      return checked(await database.from("kilo_approvals").upsert({
        session_id: v.session_id, command_id: v.command_id || null,
        kilo_request_id: v.kilo_request_id, status: "pending", detail: v.detail || {}
      }, { onConflict: "kilo_request_id", ignoreDuplicates: true }));
    }
    case "approvalForRequest": {
      const { s, c } = await activeApprovalContext(args.sessionId, args.commandId);
      requireValid(typeof args.requestId === "string" && args.requestId.length > 0 && args.requestId.length <= 256, "invalid request ID");
      return checked(await database.from("kilo_approvals").select("*")
        .eq("kilo_request_id", args.requestId).eq("session_id", s.id).eq("command_id", c.id).maybeSingle());
    }
    case "claimApproval": {
      const { s, c } = await activeApprovalContext(args.sessionId, args.commandId);
      const a = await ownApproval(args.id);
      requireValid(a && a.session_id === s.id && a.command_id === c.id, "approval identity mismatch");
      if (a.status !== "pending") return false;
      const claim = args.claim as Record<string, unknown>;
      requireValid(claim && typeof claim.id === "string" && /^[0-9a-f-]{36}$/i.test(claim.id) &&
        ["auto", "manual"].includes(String(claim.source)) &&
        ["once", "always", "reject"].includes(String(claim.decision)) &&
        (claim.source !== "auto" || claim.decision === "always") &&
        typeof claim.claimedAt === "string" && Number.isFinite(Date.parse(claim.claimedAt)), "invalid approval claim");
      const detail = { ...a.detail, _bridge_resolution: { id: claim.id, source: claim.source,
        decision: claim.decision, claimedAt: new Date().toISOString() } };
      const rows = checked(await database.from("kilo_approvals").update({ detail })
        .eq("id", a.id).eq("session_id", s.id).eq("command_id", c.id).eq("status", "pending")
        .filter("detail->>_bridge_resolution", "is", "null").select("id")) || [];
      return rows.length === 1;
    }
    case "orphanMissingApprovals": {
      const { s, c } = await activeApprovalContext(args.sessionId, args.commandId);
      const liveIds = args.liveIds;
      requireValid(Array.isArray(liveIds) && liveIds.every(id => typeof id === "string"), "invalid live request IDs");
      const rows = checked(await database.from("kilo_approvals").select("id,kilo_request_id")
        .eq("session_id", s.id).eq("command_id", c.id).eq("status", "pending")) || [];
      for (const row of rows) {
        if (!liveIds.includes(row.kilo_request_id)) {
          checked(await database.from("kilo_approvals").update({ status: "orphaned", resolved_at: new Date().toISOString() })
            .eq("id", row.id).eq("session_id", s.id).eq("command_id", c.id).eq("status", "pending"));
        }
      }
      return null;
    }
    case "approval": return ownApproval(args.id);
    case "updateApproval": {
      requireValid(await ownApproval(args.id), "approval not owned by host");
      return checked(await database.from("kilo_approvals").update(patch(args.values, approvalFields))
        .eq("id", args.id).select("*").single());
    }
    default: throw Error("unsupported action");
  }
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("not found", { status: 404 });
  const header = request.headers.get("authorization") || "";
  if (!(await authorized(header.startsWith("Bearer ") ? header.slice(7) : ""))) {
    // Log diagnostic categories only: never write the secret, its hash, or the request header.
    const secretStatus = !expectedToken ? "missing"
      : !/^[a-fA-F0-9]{64}$/.test(expectedToken) ? "invalid_format" : "mismatch";
    console.warn("kilo-host-broker.auth_rejected", { secret_status: secretStatus });
    return new Response("unauthorized", { status: 401 });
  }
  try {
    if (Number(request.headers.get("content-length") || "0") > 131072)
      return new Response("request too large", { status: 413 });
    const raw = await request.text();
    if (raw.length > 131072) return new Response("request too large", { status: 413 });
    const input = JSON.parse(raw);
    if (!input || typeof input.action !== "string" || !input.args ||
        typeof input.args !== "object" || Array.isArray(input.args))
      return new Response("invalid request", { status: 400 });
    return Response.json({ data: await dispatch(input.action, input.args) ?? null });
  } catch (error) {
    console.error("kilo-host-broker.error", error instanceof Error ? error.name : "unknown");
    return new Response("broker request failed", { status: 400 });
  }
});
