import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";

const config = {
  supabaseUrl: "https://example.supabase.co",
  supabaseServiceRoleKey: "test-service-role-key",
  bridgeHostId: "silicon-valley-01"
};
const logger = { warn() {} };

test("queue claim, active-session scan and lease recovery are host-scoped", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: new URL(String(url)), options });
    return Response.json([]);
  };
  try {
    const store = createStore(config, logger);
    await store.claim("worker-1", 60);
    await store.sessionsActive();
    await store.expiredClaims();

    const claim = requests.find((r) => r.url.pathname.endsWith("/rpc/kilo_claim_host_command"));
    assert.ok(claim);
    assert.deepEqual(JSON.parse(claim.options.body), {
      p_host_id: "silicon-valley-01", p_worker_id: "worker-1", p_lease_seconds: 60
    });

    const active = requests.find((r) => r.url.pathname.endsWith("/kilo_sessions") && r.options.method !== "PATCH");
    assert.equal(active.url.searchParams.get("host_id"), "eq.silicon-valley-01");

    const expired = requests.find((r) => r.url.pathname.endsWith("/kilo_commands") && r.options.method === "PATCH");
    assert.equal(expired.url.searchParams.get("target_host"), "eq.silicon-valley-01");
    assert.equal(expired.url.searchParams.get("status"), "eq.claimed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("approval resolution claim uses atomic compare-and-set on pending row", async () => {
  const originalFetch = globalThis.fetch;
  let claimed = false;
  const updates = [];
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/kilo_approvals") && options.method === "PATCH") {
      updates.push({ parsed, body: JSON.parse(options.body) });
      assert.equal(parsed.searchParams.get("status"), "eq.pending");
      assert.equal(parsed.searchParams.get("detail->>_bridge_resolution_claim_id"), "is.null");
      if (!claimed) {
        claimed = true;
        return Response.json([{ id: "approval-1" }]);
      }
      return Response.json([]);
    }
    return Response.json([]);
  };
  try {
    const store = createStore(config, logger);
    const approval = {
      id: "approval-1", session_id: "session-1", command_id: "command-1",
      status: "pending", detail: { permission: "bash", metadata: { command: "free -h" } }
    };
    const makeClaim = (claimId) => ({
      claimId, kind: "auto", decision: "once", reason: "read_only_allowlist",
      claimedAt: "2026-11-24T12:00:00.000Z", resolverCommandId: "command-1"
    });
    const results = await Promise.all([
      store.claimApproval(approval, makeClaim("claim-a")),
      store.claimApproval(approval, makeClaim("claim-b"))
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(updates.length, 2);
    const stored = updates.find((entry) => entry.body.detail._bridge_resolution_claim_id);
    assert.equal(stored.body.detail.permission, "bash");
    assert.equal(stored.body.detail._bridge_resolution_kind, "auto");
    assert.equal(stored.parsed.searchParams.get("session_id"), "eq.session-1");
    assert.equal(stored.parsed.searchParams.get("command_id"), "eq.command-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
