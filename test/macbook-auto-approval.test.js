import test from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../src/bridge.js";
import { loadConfig } from "../src/config.js";
import { validateCommand } from "../src/commands.js";
import { createBrokerStore } from "../src/broker-store.js";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";

const host = "macbook-01";
const root = realpathSync(tmpdir());
function harness(options = {}) {
  let session = { id: "s", host_id: host, directory: root, kilo_session_id: "ks", current_command_id: "c", status: "running" };
  let command = { id: "c", session_id: "s", target_host: host, status: "running", result: {} };
  let live = [{ id: "p", sessionID: "ks", permission: "bash" }];
  const rows = new Map(), replies = [], events = [];
  const store = {
    async session() { return { ...session }; },
    async command() { return { ...command }; },
    async updateSession(_, patch) { session = { ...session, ...patch }; },
    async updateCommand(_, patch) { command = { ...command, ...patch }; },
    async event(e) { events.push(e); },
    async upsertApproval(row) { if (!rows.has(row.kilo_request_id)) rows.set(row.kilo_request_id, { ...row, id: row.kilo_request_id }); },
    async approvalForRequest(id,s,c) { const row = rows.get(id); return row && row.session_id === s && row.command_id === c ? structuredClone(row) : null; },
    async claimApproval(row,claim) { const a = rows.get(row.id); if (a.status !== "pending" || a.detail._bridge_resolution) return false; a.detail = { ...a.detail, _bridge_resolution: claim }; return true; },
    async updateApproval(id,patch) { Object.assign(rows.get(id), patch); },
    async orphanMissingApprovals(s,c,ids) { for (const a of rows.values()) if (a.session_id === s && a.command_id === c && a.status === "pending" && !ids.includes(a.kilo_request_id)) a.status = "orphaned"; }
  };
  const kilo = {
    async pendingPermissions() { return structuredClone(live); },
    async pendingQuestions() { return []; },
    async status() { return { ks: { type: "busy" } }; },
    async replyPermission(_,id,reply) {
      replies.push([id,reply]);
      if (options.replyError) {
        if (options.disappear) live = live.filter(p => p.id !== id);
        throw options.replyError;
      }
      if (!options.keepLive) live = options.cascade ? [] : live.filter(p => p.id !== id);
      return true;
    }
  };
  const bridge = new Bridge({ bridgeHostId: host, defaultDirectory: root, autoApprove: options.auto !== false }, store,kilo,{warn(){},info(){},error(){}});
  return { bridge,store,rows,replies,events,getSession:()=>session,getCommand:()=>command,setLive:v=>{live=v;},setHost:v=>{session.host_id=v;} };
}

test("auto approval requires explicit host and remains opt-in", () => {
  const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test" };
  assert.equal(loadConfig(env).autoApprove,false);
  assert.throws(()=>loadConfig({...env,BRIDGE_AUTO_APPROVE:"true"}),/BRIDGE_HOST_ID/);
  assert.equal(loadConfig({...env,BRIDGE_AUTO_APPROVE:"true",BRIDGE_HOST_ID:host}).autoApprove,true);
});

test("all live permission types receive always, with audit", async () => {
  const h=harness();
  h.setLive(["bash","read","edit","external_directory","unknown"].map((permission,i)=>({id:String(i),sessionID:"ks",permission})));
  await h.bridge.reconcile(h.getSession());
  assert.equal(h.replies.length,5);
  for (const [id,decision] of h.replies) {
    assert.equal(decision,"always");
    assert.equal(h.rows.get(id).status,"approved");
    assert.equal(h.rows.get(id).decision,"always");
  }
  assert.equal(h.events.filter(e=>e.event_type==="approval.auto_decision").length,5);
});

test("manual mode retains pending approvals", async()=>{
  const h=harness({auto:false}); await h.bridge.reconcile(h.getSession());
  assert.equal(h.replies.length,0);
  assert.equal(h.getCommand().status,"awaiting_approval");
});

test("foreign session requests and foreign hosts are ignored",async()=>{
  const h=harness(); h.setLive([{id:"foreign",sessionID:"other",permission:"bash"}]);
  await h.bridge.reconcile(h.getSession()); assert.equal(h.replies.length,0);
  h.setLive([{id:"p",sessionID:"ks",permission:"bash"}]); h.setHost("silicon-valley-01");
  await h.bridge.reconcile(h.getSession()); assert.equal(h.replies.length,0);
});

test("repeated polling cannot reply twice",async()=>{
  const h=harness({keepLive:true}); await h.bridge.reconcile(h.getSession());
  await h.bridge.reconcile(h.getSession()); assert.deepEqual(h.replies,[["p","always"]]);
});

test("always can remove other requests without a false approval",async()=>{
  const h=harness({cascade:true});
  h.setLive([{id:"p",sessionID:"ks",permission:"bash"},{id:"p2",sessionID:"ks",permission:"bash"}]);
  await h.bridge.reconcile(h.getSession());
  assert.deepEqual(h.replies,[["p","always"]]); assert.equal(h.rows.get("p2").status,"orphaned");
});

test("404 vanished request is orphaned, not approved",async()=>{
  const h=harness({replyError:Object.assign(new Error("gone"),{status:404}),disappear:true});
  await h.bridge.reconcile(h.getSession());
  assert.equal(h.rows.get("p").status,"orphaned");
  assert.notEqual(h.getCommand().status,"needs_reconciliation");
});

test("uncertain reply is not replayed",async()=>{
  const h=harness({replyError:new Error("timeout")});
  await h.bridge.reconcile(h.getSession()); assert.equal(h.getCommand().status,"needs_reconciliation");
  await h.bridge.reconcile(h.getSession()); assert.equal(h.replies.length,1);
});

test("cancelled task cannot resolve approval",async()=>{
  const h=harness(); await h.store.updateCommand("c",{status:"cancelled"});
  await h.bridge.reconcile(h.getSession()); assert.equal(h.replies.length,0);
});

test("persisted resolution claim cannot be replayed",async()=>{
  const h=harness(); await h.store.upsertApproval({session_id:"s",command_id:"c",kilo_request_id:"p",status:"pending",detail:{_bridge_resolution:{claimedAt:new Date(Date.now()-180000).toISOString()}}});
  await h.bridge.reconcile(h.getSession()); assert.equal(h.replies.length,0); assert.equal(h.getCommand().status,"needs_reconciliation");
});

test("MB1 broker configuration and always are explicit opt-in", () => {
  const env = { KILO_BROKER_URL: "https://example.supabase.co/functions/v1/kilo-host-broker", KILO_BROKER_TOKEN: "a".repeat(64), BRIDGE_HOST_ID: host, KILO_DEFAULT_DIRECTORY: root };
  const off = loadConfig(env), on = loadConfig({...env, BRIDGE_AUTO_APPROVE:"true"});
  const command = {command_type:"approval_decision",session_id:"00000000-0000-4000-8000-000000000001",payload:{approval_id:"00000000-0000-4000-8000-000000000002",decision:"always"}};
  assert.equal(off.autoApprove,false);
  assert.throws(()=>validateCommand(command,off),/Persistent approvals/);
  assert.equal(validateCommand(command,on).decision,"always");
  assert.equal(on.supabaseServiceRoleKey,undefined);
});
test("broker adapter sends scoped claim and lookup, no local service-role key", async (t) => {
  const calls=[];
  t.mock.method(globalThis,"fetch",async (_, opts)=>{
    const req=JSON.parse(opts.body); calls.push(req);
    return new Response(JSON.stringify({data:req.action==="claimApproval"?true:null}),{status:200});
  });
  const store=createBrokerStore({brokerUrl:"https://example.supabase.co/functions/v1/kilo-host-broker",brokerToken:"test",requestTimeoutMs:1000});
  await store.approvalForRequest("p","s","c");
  assert.equal(await store.claimApproval({id:"a",session_id:"s",command_id:"c",detail:{private:"not forwarded"}},{id:"claim",source:"auto",decision:"always",claimedAt:new Date().toISOString()}),true);
  await store.orphanMissingApprovals("s","c",["p"]);
  assert.deepEqual(calls.map(x=>x.action),["approvalForRequest","claimApproval","orphanMissingApprovals"]);
  assert.equal(calls[1].args.sessionId,"s");
  assert.equal(calls[1].args.commandId,"c");
  assert.equal(calls[1].args.detail,undefined);
});
test("uncertain session cannot be revived by a live approval", async()=>{
  const h=harness();
  await h.store.updateSession("s",{status:"needs_reconciliation"});
  await h.bridge.reconcile(h.getSession());
  assert.equal(h.replies.length,0);
});
