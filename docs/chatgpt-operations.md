# ChatGPT SQL Operations

Use the connected Supabase SQL tool against the private `coord` schema. Do not use the public REST API with anon/authenticated credentials.

## 1. Health check

```sql
insert into coord.kilo_commands (idempotency_key,command_type,payload)
values (gen_random_uuid(),'health_check','{}'::jsonb)
returning id,status;
```

Query by the returned command ID:

```sql
select id,status,result,error from coord.kilo_commands where id = 'COMMAND_UUID';
```

## 2. Create a session

Specify any absolute session directory. There is no Bridge workspace allowlist.
The optional `workspace_key` is only a human-readable label (defaults to `host`).

```sql
insert into coord.kilo_commands (idempotency_key,command_type,payload)
values (gen_random_uuid(),'create_session',
        '{"directory":"/opt/qjai-cms","title":"Kilo coding task"}'::jsonb)
returning id,status;
```

Read `result.session_id` after success. Save the session ID.

## 3. Start a long task

```sql
insert into coord.kilo_commands (idempotency_key,command_type,session_id,payload)
values (gen_random_uuid(),'start_turn','SESSION_UUID',
        jsonb_build_object('text','Inspect this repository and report its test status. Do not modify files.'))
returning id,status;
```

Inspect progress and final result:

```sql
select id,status,result,error,started_at,finished_at
from coord.kilo_commands where session_id='SESSION_UUID'
order by created_at desc limit 10;

select id,created_at,event_type,payload
from coord.kilo_events where session_id='SESSION_UUID'
order by id desc limit 40;
```

To continue, insert another `start_turn` with the **same** session ID only after it returns `ready`.

## 4. Approvals

```sql
select id,session_id,status,detail from coord.kilo_approvals
where status='pending' order by created_at;
```

Review the requested action. Then either reject or approve once:

```sql
insert into coord.kilo_commands (idempotency_key,command_type,session_id,payload)
values (gen_random_uuid(),'approval_decision','SESSION_UUID',
        jsonb_build_object('approval_id','APPROVAL_UUID','decision','once'))
returning id,status;
```

Supported decisions: `once`, `always`, `reject`. Prefer `once` for ordinary use. Never approve a request blindly.

## 5. Recovery and idempotency

Each distinct instruction gets a fresh UUID `idempotency_key`. If a SQL call times out, query by the *same* key before retrying. Do not resubmit commands in `running`, `awaiting_approval` or `needs_reconciliation` states. After a restart, the Bridge checks Kilo's actual session status and transcript; uncertain work requires manual inspection.

## 6. Automatic approval (V2)

The default remains `BRIDGE_APPROVAL_MODE=manual`. Set `BRIDGE_APPROVAL_MODE=auto` and `BRIDGE_APPROVAL_TIMEOUT_SECONDS=60` only on a trusted host after V2 has passed production acceptance. Set `BRIDGE_HOST_ID=silicon-valley-01` explicitly on the Silicon Valley worker. The Bridge uses the host-specific `kilo_claim_host_command` RPC and applies the same host predicate to session scans, command reads/updates, and expired-lease recovery.

**Legacy work is never auto-approved by a config change.** At `start_turn`, V2 persists the approval mode, policy version, host ID, and policy activation timestamp in the command result. Automatic resolution requires all markers to match the running host and current mode, and requires the approval row to have been created no earlier than that turn's start. Commands created by older Bridge versions, pre-existing active turns, and pre-existing pending approvals remain in the manual workflow.

A trusted dispatcher may attach exact, task-scoped grants to the existing `start_turn` payload:

```json
{"text":"Inspect Paperclip and report status.","approval_grants":[{"permission":"bash","command":"docker compose -f /opt/paperclip/docker-compose.yml ps"},{"permission":"read","patterns":["opt/paperclip/README.md"]}]}
```

Grants are exact request matches, not prefixes or globs; they do not override protected-operation checks. Do not allow an agent to mint its own grants. Known read-only diagnostics are approved once; sensitive paths and protected operations are rejected. Unknown requests wait for manual approval until the configured deadline, then reject. `full_auto` requires an explicitly isolated worker and rejects ungranted actions; it is not a wildcard allow mode.

Approval replies use a compare-and-set claim stored in the approval detail. Only the process that wins the pending-row claim may call Kilo's permission-reply API. A durable intent event is written before the external reply; a final decision event follows the approval-row update. If the reply outcome or final audit persistence is uncertain, the parent command and session move to `needs_reconciliation`. The claim is deliberately not replayed automatically; inspect the Kilo request, approval detail, and audit events before any manual recovery. A stale claim also fails closed into reconciliation.

Permission filters are not an OS sandbox: exact shell grants can still have arbitrary effects. The OS account and isolation are the real boundary. Review each grant, especially shell commands and writes. Do not send secrets to the free model. Never treat a command in `tool-calls` state as a completed assistant turn.
