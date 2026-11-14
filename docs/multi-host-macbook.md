# MacBook worker admission — staging checklist

This document covers MacBookPro12,1 running macOS 12.7.6, Node 24.18.0,
and Kilo's localhost headless server at `127.0.0.1:4096`.
It is **not** an authorization to enroll a second worker into the live queue.

## Existing state

- Silicon Valley's old, already-running bridge consumes `coord.kilo_commands`.
- Local MacBook Kilo `GET /global/health` returned
  `{"healthy":true,"version":"7.8.27"}` on 2026-11-14.
- An earlier `kilo --version` returned 7.4.11; resolve this discrepancy before deployment.
- The MacBook battery is marked **Service Recommended** at 1055 cycles.
  Keep tests attended, with the lid open and adequate cooling.

## Rollout order

1. Review and test this PR; do **not** deploy to Silicon Valley yet.
2. Review the SQL migration with a current database snapshot in staging. Verify
   all existing commands and sessions default to `silicon-valley-01`, and that
   the legacy RPC can claim only legacy work after the migration.
3. Apply migration during an approved maintenance window, then confirm the
   legacy Silicon Valley Bridge still handles a read-only health check.
4. On Mac, confirm Kilo server identity and model access:
   `kilo --version`, `ps -axo pid,command | grep '[k]ilo serve'`,
   `kilo models`. Run a localhost HTTP session smoke test.
5. A host-specific Supabase Edge Function broker is included in this PR at
   `supabase/functions/kilo-host-broker/index.ts`. Before MacBook enrollment,
   review its authorization, host scoping and working-directory restrictions,
   deploy it with JWT verification disabled and set a high-entropy secret
   `MACBOOK_WORKER_TOKEN` in Supabase Edge Function secrets. Generate a token
   locally (`openssl rand -hex 32`), never paste it into chat or GitHub.
   The endpoint validates its own Bearer token; without one it returns 401.
   Verify a bad token is rejected before testing a good token.
6. For a Mac-only development run with an approved test Supabase deployment,
   use a private environment file readable only by the service account:
   - `BRIDGE_HOST_ID=macbook-01`
   - `KILO_SERVER_URL=http://127.0.0.1:4096`
   - `KILO_DEFAULT_DIRECTORY=/Users/gamehack/kilo-workspaces`
   - `KILO_MODEL=nvidia/nemotron-3.5-super-vl:free`
   - `KILO_BROKER_URL=https://<PROJECT>.supabase.co/functions/v1/kilo-host-broker`
   - `KILO_BROKER_TOKEN=<SAME_RANDOM_TOKEN_CONFIGURED_ON_SERVER>`
   - Remove `SUPABASE_SERVICE_ROLE_KEY`; broker mode rejects this variable.
   The MacBook does not connect directly to PostgREST and does not receive
   unrestricted database credentials. The broker remains a privileged service
   and must be audited before deployment.
7. Initially launch the Bridge in the foreground using `npm ci && npm test`
   then `npm start`. Do not install persistent launchd jobs until routing,
   crash recovery, permission gating and local safety are verified.
8. Test host-targeted `health_check`, session creation, read-only task, and
   interruption. After disconnect/restart, verify session ownership and that
   Silicon Valley and Mac commands never cross hosts.

## Commands and host affinity

Host IDs:
- `silicon-valley-01` — old production queue (default/backfill)
- `macbook-01` — MacBook test node

When using the approved host-aware database schema:

```sql
-- Mac-only heartbeat, consumed only by macbook-01.
insert into coord.kilo_commands (idempotency_key, command_type, target_host, payload)
values (gen_random_uuid(), 'health_check', 'macbook-01', '{}'::jsonb)
returning id, status, target_host;

-- Mac-only session, tied permanently to the target host.
insert into coord.kilo_commands (idempotency_key, command_type, target_host, payload)
values (
  gen_random_uuid(), 'create_session', 'macbook-01',
  jsonb_build_object('directory','/Users/gamehack/kilo-workspaces',
                     'title','Mac read-only test')
)
returning id,status,target_host;

-- For start_turn, interruption, and approval, always provide target_host
-- matching the parent session's host_id; DB enforces this with a composite FK.
```

No command should be queued for macbook-01 before an authorized, tested,
restricted-credential worker is ready. Test tasks must not inspect
secrets, private documents or production customer data.

## Security and operations

- Keep `kilo serve` bound to loopback. No router port forwards.
- Restrict the OS account and working directory; no sudo or broad personal
  file access for the agent. A workspace label is **not** an access boundary.
- Fixed free inference model may see source files; use non-sensitive test code.
- Never commit service keys. Never paste keys or full env files into ChatGPT.
- A complete shutdown/restart verification is required before unattended use.
- With a worn battery and an older unsupported macOS, do not leave the laptop
  operating unattended until power, security and thermal risks are addressed.
