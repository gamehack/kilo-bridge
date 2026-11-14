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

## Operational status (2026-11-14)

- **Completed:** database host-routing migration applied to agent-coordination
  (`xnndeqrduxkdlwcdklbc`); 21 legacy sessions and 362 legacy commands
  retained on `silicon-valley-01`, with 2 existing approvals unaffected.
- **Completed:** Silicon Valley legacy `health_check` succeeded after migration;
  existing Bridge service has not been replaced.
- **Completed:** `kilo-host-broker` Edge Function v3 deployed (JWT verification
  disabled because it validates a dedicated Bearer token internally).
- **Completed:** MacBook's secret authenticated; authorized broker read returned HTTP 200
  and an invalid token was rejected with HTTP 401.
- **Completed:** MacBook worker claimed a dedicated health_check (succeeded),
  created a session, ran read-only `pwd`/`uname`, and returned the final response.
- **Completed:** out-of-workspace session create failed closed; a test file write
  required explicit `once` approval and subsequently succeeded.
- **Completed:** Intel MacBook local `npm run check` and all 20 tests passed;
  Linux + Intel macOS GitHub Actions matrix CI passed on commit `2cbdcb3`.
- **Completed:** realpath workspace guard (including symlink escape), revalidation
  of active sessions, and disabling `always` approvals for MacBook were deployed
  locally by restarting the worker process.
- **Completed:** attended stop/restart recovery test. Existing worker PID 3427
  stopped via SIGINT; macbook-01 health_check
  `96602982-4e36-4018-a609-58da48d0f618` remained queued with zero claims
  while stopped. New worker PID 16766 claimed it exactly once and completed
  at 2026-11-14 07:35:23 UTC with `kilo_connected=true`.
- **Remaining risk:** no OS-level sandbox; the Kilo process retains Mac account
  privileges. Do not use with untrusted prompts, secrets, or production data.
- **Not deployed:** MacBook persistent launchd, auto-start, or production workloads.

The migration/Edge deployment is a deliberate exception to the original staging
checklist below. Keep the PR as Draft until MacBook end-to-end verification.

MacBook attended check and start (no secrets in terminal arguments):

```sh
cd "$HOME/kilo-workspaces/kilo-bridge"
git pull --ff-only
node scripts/macbook-worker.js check \
  https://xnndeqrduxkdlwcdklbc.supabase.co/functions/v1/kilo-host-broker
node scripts/macbook-worker.js start \
  https://xnndeqrduxkdlwcdklbc.supabase.co/functions/v1/kilo-host-broker
```

`check` must reject an invalid token with HTTP 401 and authenticate the local
token with HTTP 200. `start` keeps the worker in the foreground until Ctrl+C;
do not close it during the end-to-end test. The local Kilo server must also
remain running.

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

## Operator recovery procedure (attended only)

1. In the MacBook Bridge terminal press `Ctrl+C` to stop the Bridge. Leave the
   local `kilo serve` process running in its separate terminal.
2. Update code and run tests while stopped:
   `cd ~/kilo-workspaces/kilo-bridge && git pull --ff-only && npm run check && npm test`.
3. Start the Bridge again using the documented `node scripts/macbook-worker.js start ...`
   command; keep it in the foreground. The server will pick up pending
   Mac-targeted tasks without consuming Silicon Valley work.
4. A new read-only health_check queued during the stop must succeed only after
   the Bridge has restarted. Do not automatically replay an uncertain task;
   review `needs_reconciliation` records first.

The realpath guard is **not an OS sandbox**. The Kilo process retains the
privileges of the Mac user; its shell tools may still read outside the workspace
if instructed or compromised. Until an OS-level sandbox or dedicated restricted
account is deployed, keep the worker attended and use only reviewed test tasks.

## Unattended system boot services (installed 2026-11-14)

Install as the regular \`gamehack\` login with one interactive administrator
authorization. Two separate **system** LaunchDaemons are installed under
\`/Library/LaunchDaemons\` (not LaunchAgents):

- \`org.primalflow.kilo-server\` -> \`kilo serve --hostname 127.0.0.1 --port 4096\`
- \`org.primalflow.kilo-bridge\` -> \`node scripts/macbook-worker.js service <broker URL>\`

Both set \`RunAtLoad=true\`, \`KeepAlive=true\`, and \`ThrottleInterval=20\` seconds.
Both run under \`UserName=gamehack\`, **not root**. Plists are installed as
\`root:wheel\` mode \`0644\` and contain no passwords or Supabase service keys.
The Bridge reads its node-specific Bearer token from
\`~/.config/primalflow/macbook-worker-token\` each start; it still uses the
\`macbook-01\`-only Edge Function. Log files are under
\`~/Library/Logs/PrimalFlow\`.

A one-time interactive installation on the Mac:

\`\`\`sh
cd "$HOME/kilo-workspaces/kilo-bridge"
git pull --ff-only
npm run check && npm test
bash scripts/install-macos-daemons.sh install
bash scripts/install-macos-daemons.sh status
\`\`\`

The installer requests \`sudo\` once for root-owned plists and launchctl only.
It gracefully stops the old foreground Kilo and Bridge processes before
starting managed instances. It can be rerun for updating the plists. **Do not
run the installer itself through Kilo Bridge**: it would stop its own control
channel. Never paste the token into a command or a plist.

Inspect logs (no passwords should ever appear):

\`\`\`sh
tail -n 50 "$HOME/Library/Logs/PrimalFlow/kilo-server.stderr.log"
tail -n 50 "$HOME/Library/Logs/PrimalFlow/kilo-bridge.stdout.log"
\`\`\`

Restart or test process supervision:

\`\`\`sh
sudo launchctl kickstart -k system/org.primalflow.kilo-server
sudo launchctl kickstart -k system/org.primalflow.kilo-bridge
bash scripts/install-macos-daemons.sh status
\`\`\`

Removal (does not erase state, logs, or tokens):

\`\`\`sh
bash scripts/install-macos-daemons.sh uninstall
\`\`\`

**Unverified until tested on hardware:** Mac Kilo provider authentication under
a system LaunchDaemon may depend on a user-login keychain; FileVault may require
a human to unlock the disk after full power-off. Neither launchd nor any worker
can run while the machine is asleep or powered off. Closed-lid sleep and
thermals on the worn battery also require explicit power management decisions.
A successful manual start does **not** prove pre-login automatic operation.
Verify a physical reboot, a daemon crash-restart, and remote health checks.

**Important:** process supervision is not an OS security sandbox. The service
runs as the existing Mac user; do not process untrusted tasks, personal
secrets, or production data. Approval decisions stay scoped to \`once\` or
\`reject\` for the MacBook; no broad automatic privileged approval is enabled.

### Installation verification — 2026-11-14

- Installer completed on Intel macOS 12.7.6; 23/23 local tests passed.
- Both root-owned LaunchDaemons were registered under the `system` domain,
  as user `gamehack` (not root): Kilo started as PID 20454; Bridge initially
  spawned as PID 20457.
- Bridge's initial `exit 1` was confirmed by its own error log as
  `ECONNREFUSED 127.0.0.1:4096`: startup race while local Kilo Server was
  still binding its port. Launchd restarted the Bridge as PID 20484.
- Cloud health_check `05d7db3d-50de-4486-9fb6-265a911c148f` was
  processed by PID 20484 exactly once, succeeded, `kilo_connected=true`.
- Cloud read-only `pwd`/`uname -sm` task
  `ebd7751a-1f64-4396-a088-5f88ef402a70` succeeded via PID 20484,
  returned workspace path and `Darwin x86_64`. This verifies actual
  model/tool execution as a background LaunchDaemon.
- Read-only power check: running on battery, 94%, discharging, approx 4h59
  reported; battery-power `sleep=5`. AC-power `sleep=0`. FileVault off.
  Must connect AC, maintain adequate cooling, and avoid lid-close sleep
  for an unattended online worker. Battery health previously reported
  `Service Recommended`, 1055 cycles.
- **Not yet verified:** cold reboot before GUI login, offline/wake networking
  recovery, and multiple-day stability. Do not claim permanent 24/7 uptime.
