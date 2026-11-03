import test from "node:test";
import assert from "node:assert/strict";
import { KiloClient } from "../src/kilo-client.js";

test("asynchronous prompt pins provider and fixed model", async () => {
  const original = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(null, { status: 204 });
  };
  try {
    const client = new KiloClient({ kiloServerUrl: "http://127.0.0.1:4096", requestTimeoutMs: 1000,
      kiloPassword: "" });
    await client.promptAsync("/tmp/project", "ses_123", "Fix tests", "nvidia/nemotron-3.5-super-vl:free");
    assert.match(request.url, /\/session\/ses_123\/prompt_async$/);
    assert.equal(request.options.headers["x-kilo-directory"], "/tmp/project");
    const body = JSON.parse(request.options.body);
    assert.deepEqual(body.model, { providerID: "kilocode", modelID: "nvidia/nemotron-3.5-super-vl:free" });
    assert.deepEqual(body.parts, [{ type: "text", text: "Fix tests" }]);
  } finally { globalThis.fetch = original; }
});

test("HTTP failure is not silently accepted", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("not found", { status: 404 });
  try {
    const client = new KiloClient({ kiloServerUrl: "http://127.0.0.1:4096", requestTimeoutMs: 1000, kiloPassword: "" });
    await assert.rejects(client.health(), /HTTP 404/);
  } finally { globalThis.fetch = original; }
});
