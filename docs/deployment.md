# Deployment on Ubuntu (MVP)

Use the existing `ubuntu` user, in `/opt/kilo-bridge`. No new system user, Docker container, authentication gateway, or public route.

1. Clone the public repository to `/opt/kilo-bridge` and install dependencies with Node 24 (`npm ci --omit=dev`).
2. Ensure a Kilo CLI login is available for `ubuntu`, with the exact free model `nvidia/nemotron-3.5-super-vl:free` present in its model catalog. Do not switch to Auto Free.
3. Install the Supabase migration only on `agent-coordination` (`coord`). Existing `coord.codex_*` and `coord.kilo_run_*` objects must stay untouched.
4. Start `kilo serve --hostname 127.0.0.1 --port 4096` independently of the Bridge. The optional `deploy/kilo-server.service.in` is a minimal systemd template: replace `@KILO_BIN@` with the existing `ubuntu` user's absolute Kilo executable path and `@KILO_PORT@` with the verified free loopback port. If authentication is desired, add `KILO_SERVER_PASSWORD=<secret>` to private `/etc/kilo-bridge/server.env` and set the same value in Bridge's env file. Check `GET /global/health`, `POST /session`, then `POST /session/{id}/prompt_async` with a harmless test workspace before running production tasks.
5. Create `/etc/kilo-bridge/bridge.env` from `.env.example`, owner `ubuntu`, mode `0600`. Use a real service-role key. No workspace allowlist is enforced; the `create_session` payload may specify any absolute directory. Do not place secrets in the public repository.
6. Configure the systemd unit using `deploy/install-systemd.sh`, passing the absolute Node 24 executable path as `NODE_BIN`. Run the service as `ubuntu`.

**Important:** An existing Kilo daemon may be bound to a random port. Do not stop or restart that daemon (it may be used by other tools) merely to obtain port 4096. Run an independent `kilo serve` instance on an unused loopback port or point `KILO_SERVER_URL` to the existing verified endpoint.

Before considering the MVP operational, verify all of the following:

- A health-check command succeeds through ChatGPT -> Supabase -> Bridge -> Kilo.
- A session can execute a read-only task and return a final assistant message.
- A 30-minute non-sensitive coding task continues after ChatGPT disconnects.
- Restarting only `kilo-bridge.service` does not stop an active Kilo task, and result reconciliation works.
- Permission waits are visible and not misreported as successfully completed.
- No paid models are used and no secrets appear in logs or the public repository.

**Filesystem access:** the Bridge no longer restricts directories. Kilo may operate anywhere the `ubuntu` user can access; do not confuse this with root access. Prefer explicit, reviewed task instructions for destructive system operations. The fixed free model can receive file contents selected by the agent.

Logs: `journalctl -u kilo-bridge.service -n 100 --no-pager`.

This is a single-worker MVP. If status is `needs_reconciliation`, inspect the local Kilo session and external effects before submitting new instructions.
