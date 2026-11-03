const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateCommand(command, config) {
  const payload = command?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid payload");
  switch (command.command_type) {
    case "create_session": {
      if (!Object.hasOwn(config.workspaces, payload.workspace_key)) throw new Error("Unknown workspace key");
      const title = String(payload.title || "Kilo session").trim();
      if (!title || title.length > 160) throw new Error("Invalid title");
      return { workspaceKey: payload.workspace_key, title };
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
