import path from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateCommand(command, config) {
  const payload = command?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid payload");
  switch (command.command_type) {
    case "create_session": {
      const title = String(payload.title || "Kilo session").trim();
      if (!title || title.length > 160) throw new Error("Invalid title");
      const requestedDirectory = payload.directory ?? config.defaultDirectory;
      if (typeof requestedDirectory !== "string" || !path.isAbsolute(requestedDirectory)
        || requestedDirectory.includes("\0") || requestedDirectory.length > 4096) {
        throw new Error("Session directory must be an absolute filesystem path");
      }
      const workspaceKey = payload.workspace_key ?? "host";
      if (typeof workspaceKey !== "string" || !/^[a-z][a-z0-9_-]{1,63}$/.test(workspaceKey)) {
        throw new Error("Invalid workspace label");
      }
      // workspace_key is an informational label, not an access-control list.
      return { workspaceKey, directory: path.resolve(requestedDirectory), title };
    }
    case "start_turn": {
      if (!UUID_RE.test(command.session_id || "")) throw new Error("Invalid session_id");
      if (typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > 40000) {
        throw new Error("Invalid task text");
      }
      return { text: payload.text };
    }
    case "interrupt_turn":
      if (!UUID_RE.test(command.session_id || "")) throw new Error("Invalid session_id");
      return {};
    case "approval_decision":
      if (!UUID_RE.test(command.session_id || "") || !UUID_RE.test(payload.approval_id || "")) throw new Error("Invalid approval reference");
      if (!["once", "always", "reject"].includes(payload.decision)) throw new Error("Invalid approval decision");
      return { approvalId: payload.approval_id, decision: payload.decision };
    case "health_check": return {};
    default: throw new Error("Unsupported command type");
  }
}

export function errorObject(error) {
  return { name: error?.name || "Error", message: String(error?.message || error).slice(0, 2000), code: error?.status || null };
}
