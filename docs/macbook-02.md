# mb2 (macbook-02) — isolated MacBook Kilo worker

Status: **staged, NOT ENROLLED**. This guide is for the 2015 Intel MacBook running macOS 12.7.6, username `username`, Node 24.14.0 and Kilo 7.8.27. The existing guigu (`silicon-valley-01`) and mb1 (`macbook-01`) workers must remain unchanged.

## Routing, credentials and limits

- Host ID: `macbook-02`; workspace: `/Users/username/kilo-workspaces`.
- Edge endpoint: `https://xnndeqrduxkdlwcdklbc.supabase.co/functions/v1/kilo-host-broker-mb2`.
- Edge secret name: `MACBOOK02_WORKER_TOKEN` (different from mb1's `MACBOOK_WORKER_TOKEN`).
- Local credential: `/Users/username/.config/primalflow/macbook-02-worker-token` mode 0600.
- Broker only claims/reads/updates commands for `macbook-02` and enforces an allowed root for session creation; client realpath guard blocks symlink traversal; persistent `always` approvals are rejected.
- Use non-sensitive test data only. The guard is NOT an OS sandbox; Kilo inherits the privileges of `username`. This machine runs an old macOS and is not approved as a production executor.

## 1. Prepare source (mb2 Terminal)

```sh
mkdir -p "$HOME/kilo-workspaces"
git clone --branch feat/mb2-worker-routing https://github.com/gamehack/kilo-bridge.git "$HOME/kilo-workspaces/kilo-bridge"
cd "$HOME/kilo-workspaces/kilo-bridge"
npm ci
npm run check
npm test
```

If the directory already exists, inspect it before replacing or recloning.

## 2. Provision a separate secret (mb2 + Supabase dashboard)

Run on mb2:

```sh
mkdir -p "$HOME/.config/primalflow"
chmod 700 "$HOME/.config/primalflow"
umask 077
openssl rand -hex 32 > "$HOME/.config/primalflow/macbook-02-worker-token"
chmod 600 "$HOME/.config/primalflow/macbook-02-worker-token"
```

On the mb2 desktop only, copy the secret to clipboard using `pbcopy < "$HOME/.config/primalflow/macbook-02-worker-token"`. In the Supabase project `agent-coordination`, navigate to Edge Functions → Secrets and set **`MACBOOK02_WORKER_TOKEN`** to that value. Do not paste it into ChatGPT, Notion, GitHub, shell command arguments, or logs. Never reuse the mb1 token. The function rejects every request until this secret is configured.

This workflow requires the user to enter their own secret in the dashboard. Do **not** copy mb1's credential or give mb2 a `service_role` key.

## 3. Attended local check

In terminal A:

```sh
kilo serve --hostname 127.0.0.1 --port 4096
```

In terminal B:

```sh
curl --max-time 3 -fsS http://127.0.0.1:4096/global/health
cd "$HOME/kilo-workspaces/kilo-bridge"
MACBOOK_WORKER_HOST_ID=macbook-02 node scripts/macbook-worker.js check \
  https://xnndeqrduxkdlwcdklbc.supabase.co/functions/v1/kilo-host-broker-mb2
```

Expected: Kilo health PASS, bad token HTTP 401, authorized token HTTP 200, `MacBook worker preflight: PASS`. If credentials are missing, the check fails closed; do not install daemons yet.

## 4. Persist under launchd — only after successful check

Stop the foreground Kilo server in terminal A with Ctrl+C, then on mb2:

```sh
cd "$HOME/kilo-workspaces/kilo-bridge"
MACBOOK_WORKER_HOST_ID=macbook-02 bash scripts/install-macos-daemons.sh install
bash scripts/install-macos-daemons.sh status
```

Two system LaunchDaemons are installed under `/Library/LaunchDaemons`, run as `username` not root, listen on loopback port 4096, keep `RunAtLoad=true` and `KeepAlive=true`. Installer requests interactive sudo for launchd and plist installation only. It stops an existing foreground Kilo server; do not execute it through the Bridge itself.

Logs:

```sh
tail -n 50 "$HOME/Library/Logs/PrimalFlow/kilo-bridge.stderr.log"
tail -n 50 "$HOME/Library/Logs/PrimalFlow/kilo-server.stderr.log"
```

Removal (preserves logs and secret):

```sh
bash scripts/install-macos-daemons.sh uninstall
```

## 5. ChatGPT-side verification

After daemon startup, enqueue a `health_check` whose `target_host` is exactly `macbook-02` and verify it reaches `succeeded`, with one claim and `kilo_connected=true`. Then create a session with directory `/Users/username/kilo-workspaces`, perform a read-only `pwd` / `uname -sm` turn, inspect the final answer and approve only `once` when necessary.

Verify that an mb2 task is not claimed by mb1 or guigu. Verify restart and queue reconciliation separately; do not replay uncertain side-effecting tasks.

**Not yet proved:** reboot without GUI login, long-term uptime, sleep/wake recovery, thermal safety, network availability and compatibility of this old macOS with security requirements. Keep on AC power with lid open and adequate cooling while testing.
