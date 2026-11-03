-- Kilo Bridge MVP. Independent of the existing coord.codex_* and coord.kilo_run_* tables.
-- ChatGPT uses its existing Supabase SQL connector to access private coord tables.
-- Only the server-side service_role may access public views/RPC.

create schema if not exists coord;

create table coord.kilo_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 160),
  workspace_key text not null check (workspace_key ~ '^[a-z][a-z0-9_-]{1,63}$'),
  kilo_session_id text unique,
  status text not null default 'creating'
    check (status in ('creating','ready','running','awaiting_approval','error','needs_reconciliation','archived')),
  current_command_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table coord.kilo_commands (
  id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null unique,
  command_type text not null
    check (command_type in ('create_session','start_turn','interrupt_turn','approval_decision','health_check')),
  session_id uuid references coord.kilo_sessions(id) on delete restrict,
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 262144),
  status text not null default 'queued'
    check (status in ('queued','claimed','running','awaiting_approval','succeeded','failed','cancelled','needs_reconciliation')),
  worker_id text,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  result jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object'),
  error jsonb check (error is null or jsonb_typeof(error) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  check (command_type in ('create_session','health_check') or session_id is not null)
);

alter table coord.kilo_sessions add constraint kilo_sessions_current_command_fk
  foreign key (current_command_id) references coord.kilo_commands(id) on delete set null;

create table coord.kilo_events (
  id bigint generated always as identity primary key,
  command_id uuid references coord.kilo_commands(id) on delete set null,
  session_id uuid references coord.kilo_sessions(id) on delete set null,
  event_type text not null check (length(btrim(event_type)) between 3 and 100),
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536),
  created_at timestamptz not null default now()
);

create table coord.kilo_approvals (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references coord.kilo_sessions(id) on delete cascade,
  command_id uuid references coord.kilo_commands(id) on delete set null,
  kilo_request_id text not null unique,
  status text not null default 'pending' check (status in ('pending','approved','rejected','orphaned')),
  decision text check (decision is null or decision in ('once','always','reject')),
  detail jsonb not null default '{}'::jsonb check (octet_length(detail::text) <= 65536),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index kilo_commands_queue_idx on coord.kilo_commands(created_at) where status = 'queued';
create index kilo_commands_session_idx on coord.kilo_commands(session_id,created_at desc);
create index kilo_events_session_idx on coord.kilo_events(session_id,id desc);
create index kilo_approvals_pending_idx on coord.kilo_approvals(session_id,created_at) where status = 'pending';

alter table coord.kilo_sessions enable row level security;
alter table coord.kilo_commands enable row level security;
alter table coord.kilo_events enable row level security;
alter table coord.kilo_approvals enable row level security;

revoke all on table coord.kilo_sessions,coord.kilo_commands,coord.kilo_events,coord.kilo_approvals
  from public,anon,authenticated;
grant usage on schema coord to service_role;
grant select,insert,update,delete on table coord.kilo_sessions,coord.kilo_commands,coord.kilo_events,coord.kilo_approvals
  to service_role;
grant usage,select on sequence coord.kilo_events_id_seq to service_role;

create function coord.kilo_claim_next_command(p_worker_id text,p_lease_seconds integer default 60)
returns setof coord.kilo_commands
language plpgsql security definer
set search_path = pg_catalog,coord,pg_temp
as $$
declare
  v_command coord.kilo_commands%rowtype;
begin
  if p_worker_id is null or length(btrim(p_worker_id)) < 1 or length(p_worker_id) > 180 then
    raise exception 'invalid worker id';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 15 or p_lease_seconds > 300 then
    raise exception 'invalid lease';
  end if;
  with candidate as (
    select id from coord.kilo_commands where status = 'queued'
    order by created_at for update skip locked limit 1
  )
  update coord.kilo_commands command
  set status = 'claimed', worker_id = p_worker_id,
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      attempts = command.attempts + 1, updated_at = clock_timestamp()
  from candidate where command.id = candidate.id
  returning command.* into v_command;
  if found then return next v_command; end if;
end;
$$;

revoke all on function coord.kilo_claim_next_command(text,integer) from public,anon,authenticated;
grant execute on function coord.kilo_claim_next_command(text,integer) to service_role;

-- Updatable PostgREST views; coord itself must stay OUT of exposed schemas.
create view public.kilo_sessions with (security_invoker = true) as select * from coord.kilo_sessions;
create view public.kilo_commands with (security_invoker = true) as select * from coord.kilo_commands;
create view public.kilo_events with (security_invoker = true) as select * from coord.kilo_events;
create view public.kilo_approvals with (security_invoker = true) as select * from coord.kilo_approvals;

revoke all on table public.kilo_sessions,public.kilo_commands,public.kilo_events,public.kilo_approvals
  from public,anon,authenticated;
grant select,insert,update,delete on table public.kilo_sessions,public.kilo_commands,public.kilo_events,public.kilo_approvals
  to service_role;

create function public.kilo_claim_next_command(p_worker_id text,p_lease_seconds integer default 60)
returns setof public.kilo_commands
language sql security invoker set search_path = pg_catalog,pg_temp
as $$ select * from coord.kilo_claim_next_command(p_worker_id,p_lease_seconds); $$;
revoke all on function public.kilo_claim_next_command(text,integer) from public,anon,authenticated;
grant execute on function public.kilo_claim_next_command(text,integer) to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table coord.kilo_commands;
  end if;
end;
$$;

notify pgrst, 'reload schema';
