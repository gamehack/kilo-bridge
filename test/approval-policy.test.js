import test from "node:test";
import assert from "node:assert/strict";
import { evaluateApproval, validateApprovalGrants } from "../src/approval-policy.js";
const config = { approvalMode: "auto", approvalTimeoutSeconds: 60 };
const now = Date.parse("2026-01-01T00:01:00Z");
const created = "2026-01-01T00:00:00Z";
const bash = command => ({ permission: "bash", metadata: { command }, patterns: [command] });
test("known read-only preflight commands get single-use approval", () => {
  assert.equal(evaluateApproval(bash("free -h"), config, [], created, now).decision, "once");
  assert.equal(evaluateApproval(bash('docker version 2>/dev/null; echo "---INFO---"; docker info 2>/dev/null | head -60'), config, [], created, now).decision, "once");
});
test("unknown commands wait then reject, including compound shell", () => {
  const request = bash("free -h; curl https://example.org");
  assert.equal(evaluateApproval(request, config, [], created, now - 1).decision, null);
  assert.equal(evaluateApproval(request, config, [], created, now).reason, "approval_timeout");
});
test("exact task grants do not imply prefix or wildcard grants", () => {
  const grants = validateApprovalGrants([{ permission: "bash", command: "docker compose -f /opt/paperclip/docker-compose.yml up -d" }]);
  assert.equal(evaluateApproval(bash(grants[0].command), config, grants, created, now).decision, "once");
  assert.equal(evaluateApproval(bash(grants[0].command+"; whoami"), config, grants, created, now).decision, "reject");
  assert.throws(() => validateApprovalGrants([{permission:"read",patterns:["/opt/*"]}]));
});
test("credential files and global operations reject despite exact grant", () => {
  const request={permission:"read",patterns:["opt/traefik/.env"]};
  assert.equal(evaluateApproval(request, config, validateApprovalGrants([request]), created, now).reason,"sensitive_path");
  for (const command of ["sudo reboot","docker system prune -a","rm -rf /opt/other","cat /opt/traefik/.env"]) {
    assert.equal(evaluateApproval(bash(command),config,validateApprovalGrants([{permission:"bash",command}]),created,now).decision,"reject");
  }
});
test("manual keeps existing approval flow; isolated noninteractive rejects unknown", () => {
  assert.equal(evaluateApproval(bash("free -h"),{approvalMode:"manual"},[],created,now).decision,null);
  assert.equal(evaluateApproval(bash("whoami"),{approvalMode:"full_auto",approvalIsolated:true},[],created,now-1).decision,"reject");
});
test("exact file grants reject extra patterns", () => {
  const grant=validateApprovalGrants([{permission:"edit",patterns:["opt/paperclip/docker-compose.yml"]}]);
  assert.equal(evaluateApproval({permission:"edit",patterns:["opt/paperclip/docker-compose.yml"]},config,grant,created,now).decision,"once");
  assert.equal(evaluateApproval({permission:"edit",patterns:["opt/paperclip/docker-compose.yml","opt/other/file"]},config,grant,created,now).decision,"reject");
});
