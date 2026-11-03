# PrimalFlow Kilo Bridge

Small, open-source, persistent task bridge between ChatGPT's Supabase SQL connector and a local [Kilo](https://kilo.ai/) Agent Server. **Not** a Slack bot or a wrapper around `kilo run`.

## Purpose

When Codex quotas are exhausted, ChatGPT can enqueue coding tasks for Kilo. Kilo's own `kilo serve` runtime continues executing after ChatGPT disconnects. This bridge stores session IDs, task state, compact events and approval requests so ChatGPT can inspect and continue the same session later.

```text
ChatGPT -> Supabase SQL -> coord.kilo_commands -> kilo-bridge
                                                 |
                                             HTTP + SSE
                                                 |
                                          local kilo serve
```

No dependency on `codex-bridge`, Slack, OpenClaw, a public listening port, or a paid model. The current MVP explicitly pins `nvidia/nemotron-3.5-super-vl:free` and does **not** automatically fall back to a paid model.

## Features (v0.1)

- Durable commands: `create_session`, `start_turn`, `interrupt_turn`, `approval_decision`, `health_check`
- Kilo HTTP `prompt_async`, `session/status`, `session/message`, `permission`, `question` and global SSE integration
- Supabase Realtime wake-up with polling fallback; idempotency keys and atomic claims
- Reconciliation of in-progress sessions after Bridge restart, without automatic replay
- Logical workspace allowlist (the task cannot supply an arbitrary filesystem path)
- Separate Supabase tables and service-role-only views

## Requirements

- Node.js 24+, Kilo CLI version providing `kilo serve` and `prompt_async`
- Existing private Supabase `coord` schema and a service-role key
- Ubuntu/Linux with a persistent local Kilo server on loopback
- An authorized fixed free model accessible through the Kilo account

## Install

1. Apply `supabase/migrations/*_kilo_bridge_initial.sql` to your **agent-coordination** Supabase project. Do not expose the `coord` schema in PostgREST.
2. Run `npm ci` and `npm test`.
3. Configure the `.env.example` values in a private systemd `EnvironmentFile` such as `/etc/kilo-bridge/bridge.env` (mode `0600`).
4. Run a separately managed `kilo serve --hostname 127.0.0.1 --port 4096` (or point the Bridge at an already running local Kilo server).
5. Install/start the `kilo-bridge.service` as `ubuntu`. See [deployment](docs/deployment.md).
6. Submit a SQL `health_check`, then create a session and start a read-only turn; see [ChatGPT operations](docs/chatgpt-operations.md).

## State and recovery

Supabase stores command metadata and final assistant text, not raw token deltas, complete transcripts, or all tool outputs. Kilo owns the local session history. `prompt_async` is fire-and-forget; a successful HTTP response means accepted, **not completed**.

Pending permissions are surfaced as `awaiting_approval`; decisions must be explicit. If Kilo asks a question that this MVP cannot answer, the task is flagged `needs_reconciliation`. An ambiguous claim or network failure is never automatically resent. Only one Bridge instance should handle this queue in v0.1.

## Safety

Use Kilo only on authorized, non-sensitive workspaces. NVIDIA free inference endpoints may log prompts and results and are designated for trial use. Never mount secrets, credentials, private customer data, or production databases into an accessible workspace. The server must listen only on `127.0.0.1`. Docker access through the `ubuntu` user is powerful: use isolated test workspaces first.

MIT licensed. See `LICENSE`.
