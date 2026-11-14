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
