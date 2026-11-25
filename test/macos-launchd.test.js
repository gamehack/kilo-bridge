import test from "node:test";
import assert from "node:assert/strict";
import { renderDaemonPlists, LABEL_KILO, LABEL_BRIDGE, BROKER_URL } from "../src/macos-launchd.js";

const config = {
  user:"gamehack",group:"staff",home:"/Users/gamehack",
  repo:"/Users/gamehack/kilo-workspaces/kilo-bridge",
  nodeBin:"/usr/local/bin/node",kiloBin:"/Users/gamehack/.kilo/bin/kilo",
  logDir:"/Users/gamehack/Library/Logs/PrimalFlow"
};

test("launchd generates two independent boot jobs with restart", () => {
  const plists = renderDaemonPlists(config);
  assert.deepEqual(Object.keys(plists).sort(),[LABEL_KILO,LABEL_BRIDGE].sort());
  for(const content of Object.values(plists)){
    assert.match(content,/<key>RunAtLoad<\/key><true\/>/);
    assert.match(content,/<key>KeepAlive<\/key><true\/>/);
    assert.match(content,/<key>ThrottleInterval<\/key><integer>20<\/integer>/);
    assert.match(content,/<key>UserName<\/key><string>gamehack<\/string>/);
    assert.match(content,/<key>GroupName<\/key><string>staff<\/string>/);
    assert.match(content,/<key>Umask<\/key><integer>63<\/integer>/);
    assert.doesNotMatch(content, /MACBOOK_WORKER_TOKEN|SUPABASE_SERVICE_ROLE_KEY|KILO_BROKER_TOKEN/);
  }
  assert.match(plists[LABEL_KILO], /<string>serve<\/string>/);
  assert.match(plists[LABEL_KILO], /<string>127\.0\.0\.1<\/string>/);
  assert.match(plists[LABEL_BRIDGE], /<string>service<\/string>/);
  assert.ok(plists[LABEL_BRIDGE].includes(BROKER_URL));
  assert.match(plists[LABEL_BRIDGE], /<key>BRIDGE_AUTO_APPROVE<\/key><string>true<\/string>/);
  assert.doesNotMatch(plists[LABEL_KILO], /BRIDGE_AUTO_APPROVE/);
});

test("launchd renderer rejects alternate Mac users and target directories", () => {
  assert.throws(()=>renderDaemonPlists({...config,user:"root"}),/pinned/);
  assert.throws(()=>renderDaemonPlists({...config,repo:"/tmp/kilo-bridge"}),/pinned/);
  assert.throws(()=>renderDaemonPlists({...config,nodeBin:"node"}),/absolute/);
});

test("launchd renderer correctly escapes plist values", () => {
  const plist = renderDaemonPlists({...config,kiloBin:"/opt/bin/kilo&driver"})[LABEL_KILO];
  assert.ok(plist.includes("kilo&amp;driver"));
  assert.ok(!plist.includes("kilo&driver"));
});
