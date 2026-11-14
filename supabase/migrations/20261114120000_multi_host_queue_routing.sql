-- Add multi-host routing without changing where legacy queued work runs.
-- PRECONDITION: the existing single Linux worker handles the legacy queue.
-- Existing commands and sessions remain assigned to silicon-valley-01.
-- Deploy this migration before launching any host-aware Worker.

alter table coord.kilo_sessions
  add column host_id text not null default 'silicon-valley-01'
    check (host_id ~ '^[a-z][a-z0-9_-]{1,63}$');
alter table coord.kilo_commands
  add column target_host text not null default 'silicon-valley-01'
    check (target_host ~ '^[a-z][a-z0-9_-]{1,63}$');

-- A turn/approval can never target a different host than its parent session.
create unique index kilo_sessions_id_host_idx on coord.kilo_sessions(id, host_id);
alter table coord.kilo_commands
  add constraint kilo_commands_session_host_fk
  foreign key (session_id, target_host)
  references coord.kilo_sessions(id, host_id);
create index kilo_commands_target_queue_idx
  on coord.kilo_commands(target_host, created_at) where status = 'queued';
create index kilo_sessions_host_status_idx
  on coord.kilo_sessions(host_id, status);

-- Preserve old RPC for the already-running Linux worker, and only let it claim
-- legacy-targeted commands. This is critical while old binaries are running.
create or replace function coord.kilo_claim_next_command(
  p_worker_id text, p_lease_seconds integer default 60)
returns setof coord.kilo_commands
language plpgsql security definer
set search_path = pg_catalog, coord, pg_temp
as $$
declare v_command coord.kilo_commands%rowtype;
begin
  if p_worker_id is null or length(btrim(p_worker_id)) < 1 or length(p_worker_id) > 180 then
    raise exception 'invalid worker id';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 15 or p_lease_seconds > 300 then
    raise exception 'invalid lease';
  end if;
  with candidate as (
    select id from coord.kilo_commands
    where status = 'queued' and target_host = 'silicon-valley-01'
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

-- New host-targeted RPC for v0.2+ workers. Host is a routing selector rather than
-- an authentication identity; keep service_role secret on trusted server machines only.
create function coord.kilo_claim_host_command(
  p_host_id text, p_worker_id text, p_lease_seconds integer default 60)
returns setof coord.kilo_commands
language plpgsql security definer
set search_path = pg_catalog, coord, pg_temp
as $$
declare v_command coord.kilo_commands%rowtype;
begin
  if p_host_id is null or p_host_id !~ '^[a-z][a-z0-9_-]{1,63}$' then
    raise exception 'invalid host id';
  end if;
  if p_worker_id is null or length(btrim(p_worker_id)) < 1 or length(p_worker_id) > 180 then
    raise exception 'invalid worker id';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 15 or p_lease_seconds > 300 then
    raise exception 'invalid lease';
  end if;
  with candidate as (
    select id from coord.kilo_commands
    where status = 'queued' and target_host = p_host_id
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

revoke all on function coord.kilo_claim_host_command(text,text,integer)
  from public,anon,authenticated;
grant execute on function coord.kilo_claim_host_command(text,text,integer) to service_role;

-- PostgreSQL views defined with SELECT * do not auto-expose columns added later.
create or replace view public.kilo_sessions
  with (security_invoker = true) as select * from coord.kilo_sessions;
create or replace view public.kilo_commands
  with (security_invoker = true) as select * from coord.kilo_commands;

create function public.kilo_claim_host_command(
  p_host_id text, p_worker_id text, p_lease_seconds integer default 60)
returns setof public.kilo_commands
language sql security invoker
set search_path = pg_catalog, pg_temp
as $$ select * from coord.kilo_claim_host_command(p_host_id,p_worker_id,p_lease_seconds); $$;

revoke all on function public.kilo_claim_host_command(text,text,integer)
  from public,anon,authenticated;
grant execute on function public.kilo_claim_host_command(text,text,integer) to service_role;

notify pgrst, 'reload schema';
