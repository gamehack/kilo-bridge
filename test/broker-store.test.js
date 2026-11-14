import test from "node:test";
import assert from "node:assert/strict";
import { createBrokerStore } from "../src/broker-store.js";

test("broker claims only through authenticated HTTPS POST", async () => {
  const original = globalThis.fetch;
  let received;
  globalThis.fetch = async (url, options) => {
    received = { url: String(url), options };
    return Response.json({ data: { id: "mac-only-command", target_host: "macbook-01" } });
  };
  try {
    const store = createBrokerStore({
      brokerUrl: "https://example.supabase.co/functions/v1/kilo-host-broker",
      brokerToken: "test-token-not-a-real-secret",
      requestTimeoutMs: 5000
    });
    assert.equal(store.subscribe(() => {}), null);
    const claimed = await store.claim("worker-1", 60);
    assert.equal(claimed.target_host, "macbook-01");
    assert.equal(received.options.headers.authorization, "Bearer test-token-not-a-real-secret");
    assert.equal(JSON.parse(received.options.body).action, "claim");
    assert.deepEqual(JSON.parse(received.options.body).args, { worker: "worker-1", lease: 60 });
  } finally { globalThis.fetch = original; }
});

test("broker refuses failed HTTP requests", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
  try {
    const store = createBrokerStore({ brokerUrl: "https://example.com/broker",
      brokerToken: "long-secret", requestTimeoutMs: 5000 });
    await assert.rejects(store.sessionsActive(), /HTTP 401/);
  } finally { globalThis.fetch = original; }
});
