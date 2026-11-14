import test from "node:test";
import assert from "node:assert/strict";
import { renderDaemonPlists, LABEL_KILO, LABEL_BRIDGE, BROKER_URL, BROKER_URL_MB2 } from "../src/macos-launchd.js";

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

test("macbook-02 uses distinct account, broker and host identity", () => {
  const mb2 = {
    ...config, user:"username", home:"/Users/username", hostId:"macbook-02",
    repo:"/Users/username/kilo-workspaces/kilo-bridge",
    nodeBin:"/Users/username/.nvm/versions/node/v24.14.0/bin/node",
    kiloBin:"/Users/username/.nvm/versions/node/v24.14.0/bin/kilo",
    logDir:"/Users/username/Library/Logs/PrimalFlow"
  };
  const plists = renderDaemonPlists(mb2);
  assert.ok(plists[LABEL_BRIDGE].includes(BROKER_URL_MB2));
  assert.ok(!plists[LABEL_BRIDGE].includes("<string>"+BROKER_URL+"</string>"));
  assert.match(plists[LABEL_BRIDGE], /<key>MACBOOK_WORKER_HOST_ID<\\/key><string>macbook-02<\\/string>/);
  for (const content of Object.values(plists)) {
    assert.match(content, /<key>UserName<\\/key><string>username<\\/string>/);
    assert.doesNotMatch(content, /MACBOOK02_WORKER_TOKEN|SUPABASE_SERVICE_ROLE_KEY|macbook-02-worker-token/);
  }
  assert.throws(() => renderDaemonPlists({ ...mb2, user:"gamehack" }), /pinned/);
  assert.throws(() => renderDaemonPlists({ ...mb2, hostId:"macbook-01" }), /pinned/);
  assert.throws(() => renderDaemonPlists({ ...mb2, repo:"/tmp/kilo-bridge" }), /pinned/);
});
