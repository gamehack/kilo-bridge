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

Set `BRIDGE_APPROVAL_MODE=auto` and `BRIDGE_APPROVAL_TIMEOUT_SECONDS=60` in the private Bridge environment. Existing manual SQL commands still work. Known read-only diagnostics are approved once; sensitive paths and known protected operations are rejected. Other requests wait for manual approval until the deadline, then reject. Timeouts survive restarts through approval creation timestamps. Audit events include decision and reason, never permanent wildcard approvals.

A trusted dispatcher may attach exact, task-scoped grants to the existing start_turn payload:

```json
{"text":"Inspect Paperclip and report status.","approval_grants":[{"permission":"bash","command":"docker compose -f /opt/paperclip/docker-compose.yml ps"},{"permission":"read","patterns":["opt/paperclip/README.md"]}]}
```

Grants are exact request matches, not prefixes or globs; they do not override protected-operation checks. Do not allow an agent to mint its own grants. `manual` preserves the legacy indefinite review flow; `full_auto` requires an explicitly isolated worker and immediately rejects ungranted actions, rather than blindly approving them. Do not enable it on the production host. Permission filters are not a sandbox: exact grants can still cause arbitrary effects, and the OS account and isolation are the real boundary. Review each grant, especially shell commands and writes. Do not send secrets to the free model. If the tool reply is uncertain or the model ends without a final answer, inspect the session before retrying.
