// Permission policy is not an OS sandbox. The trusted task producer, not the
// model's prompt, supplies exact grants. Never persist an "always" decision.
const sensitive = /(?:^|[\s/'"=])(?:\.env(?:[.\w-]*)(?![\w-])|\.ssh(?:\/|$)|\.aws(?:\/|$)|\.kube(?:\/|$)|\.config\/(?:kilo|claude|codex)(?:\/|$)|\.codex(?:\/|$)|\.claude(?:\/|$)|id_(?:rsa|ed25519)|credentials(?:\.[\w-]+)?|(?:server|bridge)\.env|shadow)(?=$|[\s/'"=:;])/i;
const dangerous = /(?:^|[\s;&|])(?:sudo|su|reboot|shutdown|poweroff|halt|iptables|nft|ufw|mkfs(?:\.\w+)?|fdisk|wipefs|dd|rm)(?:\s|$)|docker\s+(?:system\s+prune|volume\s+(?:rm|prune)|network\s+prune|container\s+prune)|(?:systemctl|service)\s+(?:stop|restart|disable|mask)/i;
const safeShell = new Set([
  "free -h", "nproc", "df -h", "df -h /opt /", "docker version",
  "docker compose version", "docker ps", "docker ps -a", "docker network ls",
  "docker stats --no-stream", "ss -lntp",
  'free -h; echo "---DISK---"; df -h /opt / 2>/dev/null; echo "---CPU---"; nproc',
  'docker version 2>/dev/null; echo "---INFO---"; docker info 2>/dev/null | head -60'
]);
const plain = (value) => typeof value === "string" && value.length > 0 && value.length <= 12000
  && !/[\x00-\x1f\x7f]/.test(value);
const literalPath = (value) => plain(value) && !/[*?[\]{}]/.test(value)
  && !value.split("/").includes("..");

export function validateApprovalGrants(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid approval_grants");
  return value.map((g) => {
    if (!g || typeof g !== "object" || Array.isArray(g)) throw new Error("Invalid approval grant");
    if (g.permission === "bash" && plain(g.command)) return { permission: "bash", command: g.command };
    if (["read", "edit", "write", "glob", "grep", "list"].includes(g.permission) &&
        Array.isArray(g.patterns) && g.patterns.length > 0 && g.patterns.length <= 30 &&
        g.patterns.every(literalPath)) return { permission: g.permission, patterns: [...g.patterns].sort() };
    throw new Error("Approval grants require exact command or literal patterns");
  });
}

export function evaluateApproval(request, config, grants = [], createdAt, nowMs = Date.now()) {
  const mode = config.approvalMode || "manual";
  const wait = { decision: null, reason: "manual_review" };
  if (mode === "manual") return wait;
  const perm = request?.permission;
  const command = request?.metadata?.command;
  const patterns = request?.patterns;
  const inspected = [command, ...(Array.isArray(patterns) ? patterns : [])].filter(x => typeof x === "string");
  if (inspected.some(x => sensitive.test(x))) return { decision: "reject", reason: "sensitive_path" };
  if (perm === "bash" && plain(command)) {
    if (dangerous.test(command)) return { decision: "reject", reason: "protected_operation" };
    if (safeShell.has(command)) return { decision: "once", reason: "read_only_allowlist" };
    if (grants.some(g => g.permission === "bash" && g.command === command))
      return { decision: "once", reason: "exact_task_grant" };
  } else if (["read", "edit", "write", "glob", "grep", "list"].includes(perm) &&
      Array.isArray(patterns) && patterns.length && patterns.every(literalPath)) {
    const sorted = [...patterns].sort();
    if (grants.some(g => g.permission === perm && Array.isArray(g.patterns) &&
      g.patterns.length === sorted.length && g.patterns.every((p, i) => p === sorted[i])))
      return { decision: "once", reason: "exact_task_grant" };
  }
  // Deliberately no wildcard host shell approval, even in full_auto. Only an
  // explicitly isolated worker may opt in to this mode; unknown requests reject.
  if (mode === "full_auto" && config.approvalIsolated === true)
    return { decision: "reject", reason: "ungranted_isolated_request" };
  const since = Date.parse(createdAt || "");
  if (Number.isFinite(since) && nowMs - since >= (config.approvalTimeoutSeconds || 60) * 1000)
    return { decision: "reject", reason: "approval_timeout" };
  return wait;
}
