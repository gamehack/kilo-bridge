// Local Kilo CLI server HTTP API. This does not spawn kilo run/CLI commands.
export class KiloClient {
  constructor(config) {
    this.baseUrl = config.kiloServerUrl;
    this.timeoutMs = config.requestTimeoutMs;
    this.credentials = config.kiloPassword
      ? `Basic ${Buffer.from(`${config.kiloUsername}:${config.kiloPassword}`).toString("base64")}`
      : null;
  }

  headers(directory, json = false) {
    const headers = {};
    if (this.credentials) headers.Authorization = this.credentials;
    if (directory) headers["x-kilo-directory"] = directory;
    if (json) headers["Content-Type"] = "application/json";
    return headers;
  }

  async request(method, route, { directory, body, timeoutMs } = {}) {
    const url = new URL(route, this.baseUrl);
    const response = await fetch(url, {
      method,
      headers: this.headers(directory, body !== undefined),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs)
    });
    const raw = await response.text();
    if (!response.ok) {
      const error = new Error(`Kilo ${method} ${url.pathname} returned HTTP ${response.status}: ${raw.slice(0, 500)}`);
      error.status = response.status;
      throw error;
    }
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch { return raw; }
  }

  health() { return this.request("GET", "/global/health"); }
  createSession(directory, title) { return this.request("POST", "/session", { directory, body: { title } }); }
  status(directory) { return this.request("GET", `/session/status?directory=${encodeURIComponent(directory)}`); }
  messages(directory, sessionID) {
    return this.request("GET", `/session/${encodeURIComponent(sessionID)}/message?directory=${encodeURIComponent(directory)}`);
  }
  pendingPermissions(directory) { return this.request("GET", `/permission?directory=${encodeURIComponent(directory)}`); }
  pendingQuestions(directory) { return this.request("GET", `/question?directory=${encodeURIComponent(directory)}`); }
  replyPermission(directory, requestID, reply) {
    return this.request("POST", `/permission/${encodeURIComponent(requestID)}/reply`, { directory, body: { reply } });
  }
  abort(directory, sessionID) {
    return this.request("POST", `/session/${encodeURIComponent(sessionID)}/abort`, { directory, body: {} });
  }
  promptAsync(directory, sessionID, text, modelID) {
    return this.request("POST", `/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      directory,
      body: {
        // `kilo models` lists this as kilo/nvidia/nemotron-3.5-super-vl:free.
        model: { providerID: "kilo", modelID },
        agent: "code",
        parts: [{ type: "text", text }]
      }
    });
  }

  // SSE is a wake-up hint; periodic state reconciliation remains authoritative.
  async streamEvents(onEvent, signal) {
    const response = await fetch(new URL("/global/event", this.baseUrl), {
      headers: { ...this.headers(), Accept: "text/event-stream" }, signal
    });
    if (!response.ok || !response.body) throw new Error(`Kilo SSE returned HTTP ${response.status}`);
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let separator;
      while ((separator = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, separator);
        const match = /^data:\s*(.*)$/gm;
        const data = Array.from(block.matchAll(match), (m) => m[1]).join("\n");
        buffer = buffer.slice(separator + (buffer[separator] === "\r" ? 4 : 2));
        if (!data) continue;
        try { await onEvent(JSON.parse(data)); } catch { /* malformed/unhandled event */ }
      }
      if (buffer.length > 1024 * 1024) buffer = "";
    }
  }
}
