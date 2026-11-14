import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertHostDirectory, validateCommand } from "../src/commands.js";

test("MacBook confines sessions to real existing directories under workspace", () => {
  const tmp = mkdtempSync(join(tmpdir(), "kilo-workspace-"));
  try {
    const root = join(tmp, "root");
    const safe = join(root, "safe");
    const outside = join(tmp, "outside");
    mkdirSync(safe, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(root, "escape"), "dir");
    const config = { bridgeHostId: "macbook-01", defaultDirectory: root };
    assert.equal(assertHostDirectory(safe, config), safe);
    assert.equal(assertHostDirectory(root, config), root);
    assert.throws(() => assertHostDirectory(outside, config), /escapes/);
    assert.throws(() => assertHostDirectory(join(root, "escape"), config), /escapes/);
    assert.throws(() => assertHostDirectory(join(root, "does-not-exist"), config), /already exist/);
    assert.throws(() => validateCommand({ command_type: "create_session",
      payload: { directory: outside, title: "Outside" } }, config), /escapes/);
    assert.throws(() => validateCommand({ command_type: "create_session",
      payload: { directory: join(root, "escape"), title: "Linked" } }, config), /escapes/);
    const valid = validateCommand({ command_type: "create_session",
      payload: { directory: safe, title: "Safe", workspace_key: "macbook_smoke" } }, config);
    assert.equal(valid.directory, safe);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("legacy Linux worker retains absolute-directory support", () => {
  const config = { bridgeHostId: "silicon-valley-01", defaultDirectory: "/home/ubuntu" };
  const input = validateCommand({ command_type: "create_session",
    payload: { directory: "/tmp", workspace_key: "host" } }, config);
  assert.equal(input.directory, "/tmp");
});


test("MacBook prevents persistent approvals while permitting once/reject", () => {
  const approvalID = "0469e80a-71ff-4565-8195-4a313acbb6af";
  const sessionID = "7c95c1b7-af1b-4df9-bacc-21b76a2bf69e";
  const make = (decision) => ({ command_type: "approval_decision", session_id: sessionID,
    payload: { approval_id: approvalID, decision } });
  const mac = { bridgeHostId: "macbook-01" };
  assert.throws(() => validateCommand(make("always"), mac), /Persistent approvals/);
  assert.equal(validateCommand(make("once"), mac).decision, "once");
  assert.equal(validateCommand(make("reject"), mac).decision, "reject");
  assert.equal(validateCommand(make("always"),
    { bridgeHostId: "silicon-valley-01" }).decision, "always");
});
